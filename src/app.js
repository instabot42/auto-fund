const config = require('config')
const logger = require('./log')
const log = logger('app')

const apr = (v) => (v * 100 * 365).toFixed(4)
const f8 = (v) => v.toFixed(8)
const f4 = (v) => v.toFixed(4)
const f2 = (v) => v.toFixed(2)
const f0 = (v) => v.toFixed(0)

class App {
    /**
     *
     * @param {*} socket
     */
    constructor(socket) {
        this.socket = socket

        // Set up handlers on the socket
        this.socket.on('update-offer', (offer) => this.onUpdateOffer(offer))
        this.socket.on('cancel-offer', (offer) => this.onCancelOffer(offer))

        this.socket.on('update-borrow', (borrow) => this.onUpdateBorrow(borrow))
        this.socket.on('cancel-borrow', (borrow) => this.onCancelBorrow(borrow))

        this.socket.on('update-order', (order) => this.onUpdateOrder(order))
        this.socket.on('cancel-order', (order) => this.onCancelOrder(order))

        this.socket.on('execute-trade', (trade) => this.onExecuteTrade(trade))
        this.socket.on('update-trade', (trade) => this.onUpdateTrade(trade))

        // some settings
        this.loggingInterval = config.get('interval')
        this.minImprovement = config.get('minImprovement')
        this.minBorrowSize = config.get('minBorrowSize')
        this.symbol = config.get('bitfinex.symbol')

        // the order book and loan book
        this.borrows = []
        this.offers = []
        this.orders = []

        // When switching out borrow, track the changes...
        this.pending = null

        this.netUsing = 0
        this.netUnused = 0

        this.pauseUntil = Date.now() + 5000
        this.eventCount = 0
    }

    /**
     * Called to kick start the process
     */
    start() {
        log('Starting...')
        this.pauseUntil = Date.now() + 10000
        this.socket.open()

        if (this.loggingInterval) {
            log(`Will log state every ${this.loggingInterval}ms`)
            setInterval(() => this.onTimer(), this.loggingInterval)
            setTimeout(() => this.onTimer(), 8000)
        } else {
            log('State logging disabled. set `interval` in the config to enable')
        }
    }

    /**
     * Called when an offer is added or updated
     * @param {*} offer
     */
    onUpdateOffer(offer) {
        // insert and replace the orders at this rate
        // done as delete + insert
        this.offers = this.offers.filter((o) => o.rate !== offer.rate)
        this.offers.push(offer)

        // resort the book, so the cheapest item is first (sorted by rate, then period-longest first)
        this.sortOffers()

        // we got a new offer. Can we find any borrows that are paying more than this
        this.replaceBorrowingIfCheaper()
    }

    /**
     * Called when an offer is cancelled
     * @param {*} offer
     */
    onCancelOffer(offer) {
        this.offers = this.offers.filter((o) => o.rate !== offer.rate)
        this.eventCount += 1
    }

    /**
     * Called when a borrow is added or updated
     * @param {*} borrow
     */
    onUpdateBorrow(borrow) {
        this.borrows = this.borrows.filter((b) => b.id !== borrow.id)
        this.borrows.push(borrow)
        this.sortBorrows()
        this.eventCount += 1

        if (borrow.type === 'using') {
            this.netUsing += borrow.amount
        } else {
            this.netUnused += borrow.amount
        }

        log(
            `New Borrow   : ${borrow.ratePercent}% APR (${borrow.rateFixed}). ${borrow.amount.toFixed(4)} type: ${borrow.type}, id: ${
                borrow.id
            }`
        )
    }

    /**
     * Called when a borrow is cancelled
     * @param {*} borrow
     */
    onCancelBorrow(borrow) {
        this.borrows = this.borrows.filter((b) => b.id !== borrow.id)
        this.eventCount += 1

        if (borrow.type === 'using') {
            this.netUsing -= borrow.amount
        } else {
            this.netUnused -= borrow.amount
        }

        log(
            `Return Borrow: ${borrow.ratePercent}% APR (${borrow.rateFixed}). ${borrow.amount.toFixed(4)} type: ${borrow.type}, id: ${
                borrow.id
            }`
        )
    }

    /**
     * A new or updated order has been detected. Could be part filled for example.
     * @param {*} order
     */
    onUpdateOrder(order) {
        this.orders = this.orders.filter((o) => o.id !== order.id)
        this.orders.push(order)
        this.eventCount += 1

        if (this.pending) {
            this.pending.orderIds = this.pending.orderIds.filter((id) => id !== order.id)
            this.pending.orderIds.push(order.id)
        }
        log(`New/Updated Order Detected, ${order.amountRemaining} of ${order.amount} at ${order.ratePercent}% id:${order.id}`)
    }

    /**
     * An order has been cancelled (filled, closed etc)
     * @param {*} order
     */
    onCancelOrder(order) {
        this.orders = this.orders.filter((o) => o.id !== order.id)
        this.eventCount += 1
        log(`Cancelled/Filled Order Detected, ${order.amountRemaining} of ${order.amount} at ${order.ratePercent}% id:${order.id}`)
    }

    /**
     * Called when a trade is executed
     * @param {*} trade
     */
    onExecuteTrade(trade) {
        log(`Trade Executed : ${trade.ratePercent}% APR (${trade.rate}). ${trade.amount.toFixed(4)} for ${trade.period} days.`)
        log(`Trade Executed : id: ${trade.id}, offerId: ${trade.offerId}. ${trade.desc}`)
        if (this.pending) {
            this.pending.filledCount += 1
            this.pending.filledAmount += Math.abs(trade.amount)
        }
    }

    /**
     * Called when a trade is executed
     * @param {*} trade
     */
    onUpdateTrade(trade) {
        log(`Trade Updated : id: ${trade.id}, offerId: ${trade.offerId}. ${trade.desc}`)
    }

    /**
     * Called from time to time to log out the state of things
     */
    onTimer() {
        this.logBorrowStateLite()
    }

    /**
     * Try and find a set of existing borrowing that could be replaced with cheaper funding from the order book
     * @param {*} borrows
     * @param {*} book
     * @returns
     */
    replaceBorrowingIfCheaper() {
        // Only continue if we are not in the middle of
        // changing some borrowing already or paused
        const now = Date.now()
        if (now < this.pauseUntil || this.pending !== null) {
            return
        }

        // get these as local values
        const borrows = this.borrows
        const book = this.offers

        // see how many borrows we have
        let i = borrows.length
        if (i <= 0 || book.length <= 0) {
            return
        }

        // Too expensive?
        const seeking = borrows[0].rate - this.minImprovement
        if (book[0].rate > seeking) {
            return
        }

        // try and replace as much as we can
        while (i > 0) {
            // Get a slice of the borrows to try and replace
            // Start with all of them, and gradually work back until we are testing against only the most expensive borrow
            const subset = borrows.slice(0, i)

            // Figure out the replace cost and how much we'd need to borrow here
            const cost = this.replacementCost(subset)
            const borrowAmount = cost.totalBorrowed
            const cheaperBook = this.orderBookCheaperThan(book, cost.bestRate)
            const available = cheaperBook.reduce((total, el) => total + el.amount, 0)

            // If there is enough available in the order book, and it is > min order size, have a go...
            if (borrowAmount >= this.minBorrowSize && available > borrowAmount) {
                // Find the optimal rate
                const targetRate = this.findTargetRateToBorrow(cheaperBook, borrowAmount)

                // report the state of things
                this.logBorrowState()
                log('Match Found...')
                log(`>> Can replace top ${i} of ${borrows.length} borrows...`)
                log(`>> Needed ${f2(borrowAmount)}. Found ${f2(available)}`)
                log(`>> Replaces existing at ${apr(cost.bestRate)}% APR (${f8(cost.bestRate)}) or worse`)
                log(`>> With new at          ${apr(targetRate)}% APR (${f8(targetRate)}) or better\n`)

                // borrow funds to cover the stuff we are replacing
                this.replaceBorrowing(borrowAmount, targetRate, subset)

                // once we have replaced a set of borrowing, we are done
                // we can try again in a few seconds.
                return
            }

            // try a small subset of the list
            i -= 1
        }
    }

    /**
     * Whats the best rate we could offer that would still have enough liquidity to fill our order
     * @param {*} book
     * @param {*} amount
     * @returns
     */
    findTargetRateToBorrow(book, amount) {
        // track the rate to borrow at and how much is left to fill
        let rate = book[0].rate
        let balance = amount

        // simulate filling all the orders, finding the target rate (eg slippage needed to fill amount)
        book.forEach((b) => {
            if (balance > 0) {
                rate = b.rate
            }

            balance -= b.amount
        })

        return rate
    }

    /**
     * Trigger the pricess of replacing a set of borrowing with new borrowing
     * @param {*} amount
     * @param {*} rate
     * @param {*} toReplace
     */
    async replaceBorrowing(amount, rate, toReplace) {
        // wait at least as long as the timer
        const waitFor = 15000
        this.pauseUntil = Date.now() + waitFor

        // Set up the pending state
        this.pending = {
            orderIds: [],
            amount,
            filledCount: 0,
            filledAmount: 0,
        }

        // Ask to borrow funds
        log(`>>>>>> BEGIN >>`)
        this.borrowFunds(amount, rate)
        this.totalBorrowed += amount

        // Wait a bit a see if we have any fills
        let tries = 0
        while (tries < 10 && this.pending.filledCount === 0) {
            // wait a while
            log('...waiting for fill...')
            await this.sleep(5000)
            tries += 1
        }

        // cancel any of the order ids that are still active
        this.socket.cancelOffers(this.pending.orderIds)
        if (this.pending.filledCount > 0) {
            // we got some trades against our order, so return all the borrows we are trying to replace
            // we might not have filled all of it, but the exchange will take care of that by re-borrowing if needed
            const toReturn = this.borrowsToReturn(toReplace)
            await this.borrowReturn(toReturn)
        }

        // wait for everything to settle.
        await this.sleep(5000)

        // Avoid doing anything for a few seconds and release pending
        this.logBorrowStateLite()
        log(`>>>>>> END <<\n`)

        this.pauseUntil = Date.now() + 1000 * 60
        this.pending = null
    }

    /**
     * Find the list of borrows to return
     * @param {*} toReplace
     * @returns
     */
    borrowsToReturn(toReplace) {
        // Nothing filled, nothing to return
        if (!this.pending || this.pending.filledCount === 0) {
            log('no fills seen. returning nothing')
            return []
        }

        if (toReplace.length === 1) {
            // if we are only replacing a single item,
            // and we have had a fill, return it
            log(`Filled ${this.pending.filledAmount}, returning ${toReplace[0].amount}`)
            return toReplace
        }

        // Something filled. find what we can return and what we need to keep
        let ret = []
        let amt = this.pending.filledAmount
        toReplace.forEach((r) => {
            if (amt > 0) {
                amt -= r.amount
                ret.push(r)
            }
        })

        // How much was there vs what we are returning
        const amtReturned = ret.reduce((sum, r) => sum + r.amount, 0)
        log(`Filled ${this.pending.filledAmount}, returning ${amtReturned}`)

        return ret
    }

    /**
     * Borrow some funds please
     * @param {*} amount
     * @param {*} rate
     */
    borrowFunds(amount, rate) {
        log(`Borrow ${amount}. Limit Rate ${apr(rate)}% (${rate})`)

        this.socket.borrowFunds(amount, rate)
    }

    /**
     * return some borrowing
     * @param {*} items
     */
    async borrowReturn(items) {
        if (items.length === 0) {
            return
        }

        const ids = items.map((b) => b.id)
        await this.socket.borrowReturn(ids)
    }

    /**
     * Given a slice of the active borrows, figure out the total borrowed and the cheapest rate paid
     * @param {*} borrows
     */
    replacementCost(borrows) {
        // Get the best rate (lowest) on offer in the list we are given
        let bestRate = borrows[0].rate
        bestRate = borrows.reduce((best, el) => (el.rate < best ? el.rate : best), bestRate)

        // and how much was borrowed in total
        const totalBorrowed = borrows.reduce((total, el) => total + el.amount, 0)

        return {
            bestRate,
            totalBorrowed,
        }
    }

    /**
     * Given the current order book, find all the offers cheaper than the given rate
     * @param {*} orderBook
     * @param {*} rate
     * @returns
     */
    orderBookCheaperThan(orderBook, rate) {
        // adjust the rate to ensure we find something cheaper by enough to bother
        const targetRate = rate - this.minImprovement
        return orderBook.filter((el) => el.rate <= targetRate)
    }

    /**
     * Find the timestamp of the first borrow to be returned
     * @param {*} borrows
     * @returns
     */
    nextExpiry(borrows) {
        // pick a start point 120 days in the future
        const future = Date.now() + 1000 * 60 * 60 * 24 * 120

        // find the borrow that will expire the soonest
        return borrows.reduce((soonest, b) => (b.expiresAt < soonest ? b.expiresAt : soonest), future)
    }

    /**
     * Time for humans
     * @param {*} t
     * @returns
     */
    timeRemainingStr(t) {
        const now = Date.now()
        const timeRemaining = (t - now) / 1000
        if (timeRemaining < 60) {
            return 'a few seconds'
        } else if (timeRemaining < 60 * 60) {
            return `${Math.floor(timeRemaining / 60)} m`
        } else if (timeRemaining < 60 * 60 * 24 * 3) {
            return `${Math.ceil(timeRemaining / (60 * 60))} hr`
        }

        return `${Math.ceil(timeRemaining / (60 * 60 * 24))} d`
    }

    /**
     * Sorts the offers into best first
     * Cheapest offers first, longest period offers first
     */
    sortOffers() {
        this.offers.sort((a, b) => {
            const s = a.rate - b.rate
            return s === 0 ? b.period - a.period : s
        })
    }

    /**
     * Sorts the borrows table into order. Worst borrow first
     * So, high interest, short period first, low interest, long period last
     */
    sortBorrows() {
        this.borrows.sort((a, b) => {
            const s = b.rate - a.rate
            return s === 0 ? a.period - b.period : s
        })
    }

    /**
     * Just wait a bit
     * @param {*} ms
     * @returns
     */
    sleep(ms) {
        return new Promise((resolve) => {
            setTimeout(() => resolve(), ms)
        })
    }

    /**
     * Bundle up all the data for logging, out of the way
     */
    logBorrowState() {
        const borrows = this.borrows
        const book = this.offers

        // first expiries time
        const nextExpiryTime = this.nextExpiry(borrows)
        const timeRemaining = this.timeRemainingStr(nextExpiryTime)

        const top = borrows[0]
        const last = borrows[borrows.length - 1]

        const seeking = borrows[0].rate - this.minImprovement

        const lowRate = book[0].rate
        const scaledRate = borrows.reduce((sum, b) => sum + b.rate * b.amount, 0)
        const totalBorrowed = borrows.reduce((sum, b) => sum + b.amount, 0)
        const avgRate = scaledRate / totalBorrowed
        log(`\n${new Date()}`)
        log(`${this.eventCount} events since last update`)
        log(`${borrows.length} active borrows. Next expiry in ${timeRemaining}...`)
        log(`Worst : ${apr(top.rate)}% APR (${f8(top.rate)}). ${f4(top.amount)} ${this.symbol} used`)
        log(`Best  : ${apr(last.rate)}% APR (${f8(last.rate)}). ${f4(last.amount)} ${this.symbol} used`)
        log(`Avg   : ${apr(avgRate)}% APR (${f8(avgRate)}). ${f4(totalBorrowed)} ${this.symbol} total used`)

        log('\nOffers...')
        log(`Best  : ${apr(lowRate)}% APR (${f8(lowRate)}). ${f4(book[0].amount)} available`)
        log(`Need  : ${apr(seeking)}% APR (${f8(seeking)}).\n`)

        this.eventCount = 0
    }

    /**
     * Log out some basic info to show progress
     */
    logBorrowStateLite() {
        const nextExpiryTime = this.nextExpiry(this.borrows)
        const timeRemaining = this.timeRemainingStr(nextExpiryTime)
        const lowRate = this.offers[0].rate
        const top = this.borrows[0]

        log(`${new Date()}`)
        log(`${this.eventCount} events since last update`)
        log(`${this.borrows.length} active borrows. Next expiry in ${timeRemaining}...`)
        if (this.borrows.length > 0) {
            log(`Worst Borrow : ${apr(top.rate)}% APR (${f8(top.rate)}). ${f4(top.amount)}`)
        }
        log(`Best Offer   : ${apr(lowRate)}% APR (${f8(lowRate)}). ${f4(this.offers[0].amount)} available`)
        log(`Net          : Using: ${f2(this.netUsing)}, Unused: ${f2(this.netUnused)}`)

        this.eventCount = 0
    }
}

module.exports = App
