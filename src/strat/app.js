const config = require('../util/config')
const log = require('../util/log')('app')

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

        this.socket.on('new-order', (order) => this.onNewOrder(order))
        this.socket.on('update-order', (order) => this.onUpdateOrder(order))
        this.socket.on('cancel-order', (order) => this.onCancelOrder(order))

        this.socket.on('execute-trade', (trade) => this.onExecuteTrade(trade))
        this.socket.on('update-trade', (trade) => this.onUpdateTrade(trade))

        this.socket.on('update-wallet', (wallet) => this.onUpdateWallet(wallet))
        this.socket.on('update-position', (position) => this.onUpdatePosition(position))

        // some settings
        this.interval = config.get('interval')
        this.minImprovement = config.get('minImprovement')
        this.minBorrowSize = config.get('minBorrowSize')
        this.showWalletPosition = config.get('showWalletPosition')
        this.symbol = config.get('bitfinex.symbol')

        // the order book and loan book
        this.borrows = []
        this.offers = []
        this.orders = []
        this.wallets = []
        this.positions = []

        this.netUsing = 0
        this.netUnused = 0

        this.pauseUntil = Date.now() + 5000
        this.eventCount = 0

        // setting to 'go bing' when we want to borrow. Will happen, even in dry run, so you can notice
        this.bell = config.get('soundOnChange') ? ' <bong>\u0007' : ''
    }

    /**
     * Called to kick start the process
     */
    start() {
        log(`Starting...${this.bell}`)
        this.pauseUntil = Date.now() + 10000
        this.socket.open()

        this.onStartup()
    }

    /**
     * Ask to stop the app from running - clean up please...
     */
    async stop() {
        // stop doing things
        this.pauseUntil = Date.now() + 100000

        // give everything a chance to stop
        await this.beforeShutdown()

        // close the socket
        this.socket.close()
        await this.sleep(1000)
    }

    /**
     * Called as the app starts
     */
    onStartup() {
        if (this.interval) {
            log(`Refresh interval ${this.interval}ms`)
            setInterval(() => this.onTimer(), this.interval)
            setTimeout(() => this.onTimer(), 8000)
        } else {
            log('State logging disabled. set `interval` in the config to enable')
        }
    }

    /**
     * Called just before the app is closed. Last chance to clean up
     */
    async beforeShutdown() {
        log(`Stopping App...`)
    }

    /**
     * CAlled when the wallet balance is updated by the exchange
     * @param {*} wallet
     */
    onUpdateWallet(wallet) {
        this.wallets = this.wallets.filter((w) => w.type !== wallet.type && w.currency !== wallet.currency)
        this.wallets.push(wallet)
    }

    /**
     * Called when the position is updated by the exchange
     * @param {*} position
     */
    onUpdatePosition(position) {
        this.positions = this.positions.filter((p) => p.id != position.id)
        this.positions.push(position)
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
    }

    onNewOrder(order) {
        this.orders = this.orders.filter((o) => o.id !== order.id)
        this.orders.push(order)
        this.eventCount += 1
    }

    /**
     * A new or updated order has been detected. Could be part filled for example.
     * @param {*} order
     */
    onUpdateOrder(order) {
        this.orders = this.orders.filter((o) => o.id !== order.id)
        this.orders.push(order)
        this.eventCount += 1
    }

    /**
     * An order has been cancelled (filled, closed etc)
     * @param {*} order
     */
    onCancelOrder(order) {
        this.orders = this.orders.filter((o) => o.id !== order.id)
        this.eventCount += 1
        log(`Offer id ${order.id} for ${this.f4(Math.abs(order.amount))} has been closed (cancelled or filled).`)
    }

    /**
     * Called when a trade is executed
     * @param {*} trade
     */
    onExecuteTrade(trade) {}

    /**
     * Called when a trade is executed
     * @param {*} trade
     */
    onUpdateTrade(trade) {}

    /**
     * Called from time to time to log out the state of things
     */
    onTimer() {
        this.logBorrowState()
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
     * Borrow some funds please
     * @param {*} amount
     * @param {*} rate
     */
    borrowFunds(amount, rate) {
        if (amount < this.minBorrowSize) {
            log(`${this.f2(amount)} is below min borrow size of ${this.minBorrowSize}`)
            return
        }

        log(`Borrow ${this.f4(amount)}. Limit Rate ${this.apr(rate)}% (${this.f8(rate)}) ${this.bell}`)
        this.socket.borrowFunds(amount, rate)
    }

    /**
     * return some borrowing
     * @param {*} items
     */
    async returnManyBorrows(items) {
        if (items.length === 0) {
            return
        }

        await this.socket.returnManyBorrows(items)
    }

    /**
     * Return a single item of borrowing
     * @param {*} borrow
     * @returns
     */
    async returnBorrow(borrow) {
        return this.socket.returnBorrow(borrow)
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

    apr(v) {
        return (v * 100 * 365).toFixed(4)
    }

    f8(v) {
        return v.toFixed(8)
    }

    f4(v) {
        return v.toFixed(4)
    }

    f2(v) {
        return v.toFixed(2)
    }

    f0(v) {
        return v.toFixed(0)
    }

    /**
     * Bundle up all the data for logging, out of the way
     */
    logBorrowState() {
        log(`\n${new Date()}`)

        if (this.showWalletPosition) {
            log('\nWallet')
            this.wallets.forEach((w) => {
                log(`${w.currency} ${w.type} : ${this.f4(w.balance)}`)
            })

            log('\nPositions')
            this.positions.forEach((p) => {
                const cost = p.amount * p.basePrice
                log(`${p.symbol} ${this.f4(p.amount)} @ ${this.f2(p.basePrice)}, cost ${this.f2(cost)}`)
            })

            const sumOfBalances = this.wallets.reduce((sum, w) => sum + w.balance, 0)
            const sumOfPositions = this.positions.reduce((sum, p) => sum + p.amount * p.basePrice, 0)
            const neededBorrowing = sumOfPositions > sumOfBalances ? sumOfPositions - sumOfBalances : 0
            log(`Sum of positions: ${this.f2(sumOfPositions)}. Expected Borrowing: ${this.f2(neededBorrowing)}`)
        }

        const borrows = this.borrows
        const book = this.offers

        // first expiries time
        const nextExpiryTime = this.nextExpiry(borrows)
        const timeRemaining = this.timeRemainingStr(nextExpiryTime)

        const top = borrows[0]
        const last = borrows[borrows.length - 1]
        const lowRate = book[0].rate
        const scaledRate = borrows.reduce((sum, b) => sum + b.rate * b.amount, 0)
        const totalBorrowed = borrows.reduce((sum, b) => sum + b.amount, 0)
        const avgRate = scaledRate / totalBorrowed

        log('\nBorrows')
        log(`${borrows.length} active borrows. Next expiry in ${timeRemaining}...`)
        log(`Worst : ${this.apr(top.rate)}% APR (${this.f8(top.rate)}). ${this.f4(top.amount)} ${this.symbol} used`)
        log(`Best  : ${this.apr(last.rate)}% APR (${this.f8(last.rate)}). ${this.f4(last.amount)} ${this.symbol} used`)
        log(`Avg   : ${this.apr(avgRate)}% APR (${this.f8(avgRate)}). ${this.f4(totalBorrowed)} ${this.symbol} total used`)
        log(`Best Offer   : ${this.apr(lowRate)}% APR (${this.f8(lowRate)}). ${this.f4(this.offers[0].amount)} available`)
        log(`Net          : Using: ${this.f2(this.netUsing)}, Unused: ${this.f2(this.netUnused)}`)
        log('')

        this.eventCount = 0
    }
}

module.exports = App
