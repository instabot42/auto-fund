const config = require('config')
const logger = require('./log')
const log = logger('app')

const apr = (v) => (v * 100 * 365).toFixed(4)
const f8 = (v) => v.toFixed(8)
const f4 = (v) => v.toFixed(4)
const f2 = (v) => v.toFixed(2)
const f0 = (v) => v.toFixed(0)

class App {
    constructor(exchange) {
        this.ex = exchange
        this.timer = null
        this.interval = config.get('interval')

        this.minImprovement = config.get('minImprovement')
        this.minBorrowSize = config.get('minBorrowSize')

        // Tracking if we need to release unused borrowing or not
        this.ticksSinceChange = 0
        this.prevTotalBorrowed = 0
    }

    /**
     * Start the system checking your borrowing
     */
    async start() {
        // Process the funding book right away
        await this.onTimer()

        // If no interval is defined, stop now
        if (this.interval === 0) {
            log('No interval defined, so stopping now.')
            return
        }

        // Say we are starting a timer
        const inMinutes = this.interval / 1000 / 60
        log(`Starting Timer. Updating funding every ${this.interval}ms (about every ${f2(inMinutes)}m)`)

        // then update on an interval
        this.timer = setInterval(() => this.onTimer(), this.interval)
    }

    /**
     * Stop the timers, so it will no longer update
     */
    stop() {
        clearInterval(this.timer)
        this.timer = null
    }

    /**
     * Given a slice of the active borrows, figure out the total borrowed and the cheapest rate paid
     * @param {*} borrows
     */
    replacementCost(borrows) {
        // Get the best rate on offer in the list we are given
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
     * Ask to borrow funds
     * @param {*} orderBook
     * @param {*} qty
     */
    async borrowFunds(orderBook, qty) {
        let remaining = qty
        let i = 0
        let lastRate = 0
        let period = 120

        while (remaining > 0 && i < orderBook.length) {
            period = Math.min(period, orderBook[i].period)
            const toBorrow = Math.min(remaining, orderBook[i].amount)
            const rate = orderBook[i].rate
            log(`++ Borrow ${toBorrow} at a rate of ${f8(rate)} (${apr(orderBook[i].rate)}% APR)`)
            remaining -= toBorrow
            lastRate = rate
            i += 1
        }

        log(`++ Requesting total borrowing of ${qty}...`)
        await this.ex.borrowFunds(qty, lastRate, period)
    }

    /**
     * Ask to return some existing borrowing
     * @param {*} toReturn
     */
    async returnBorrowing(toReturn) {
        // Attempt to return all the borrowing given to us
        for (const el of toReturn) {
            const rate = el.rate
            log(`-- Return borrowing id ${el.id}`)
            log(`   ${el.amount} at a rate of ${f8(rate)} (${apr(rate)}% APR)`)
            await this.ex.fundingClose(el.id)
        }
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
     * Try and find a set of existing borrowing that could be replaced with cheaper funding from the order book
     * @param {*} borrows
     * @param {*} book
     * @returns
     */
    async replaceBorrowingIfCheaper(borrows, book) {
        // see how many borrows we have
        let i = borrows.length
        if (i <= 0 || book.length <= 0) {
            return
        }

        // first expiries time
        const nextExpiry = this.nextExpiry(borrows)
        const timeRemaining = this.timeRemainingStr(nextExpiry)

        // top borrow
        const top = borrows[0]
        const last = borrows[borrows.length - 1]

        // report it
        const seeking = borrows[0].rate - this.minImprovement
        const lowRate = book[0].rate
        const scaledRate = borrows.reduce((sum, b) => sum + b.rate * b.amount, 0)
        const totalBorrowed = borrows.reduce((sum, b) => sum + b.amount, 0)
        const avgRate = scaledRate / totalBorrowed
        log(`Found ${i} active borrows. Next expiry in ${timeRemaining}`)
        log(`Most expensive Borrow  : ${f8(top.rate)} (${apr(top.rate)}% APR). ${f4(top.amount)} ${this.ex.symbol}`)
        log(`Best Borrow            : ${f8(last.rate)} (${apr(last.rate)}% APR). ${f4(last.amount)} ${this.ex.symbol}`)
        log(`Weighted Avg Borrow    : ${f8(avgRate)} (${apr(avgRate)}% APR). ${f4(totalBorrowed)} ${this.ex.symbol}`)
        log(`\nCheapest offered       : ${f8(lowRate)} (${apr(lowRate)}% APR). ${f4(book[0].amount)} available`)
        log(`Want <= than           : ${f8(seeking)} (${apr(seeking)}% APR).`)

        if (book[0].rate > seeking) {
            log(`                       : Too expensive for now`)
            return
        }

        // try and replace as much as we can
        while (i > 0) {
            const subset = borrows.slice(0, i)
            const cost = this.replacementCost(subset)

            const cheaperBook = this.orderBookCheaperThan(book, cost.bestRate)
            const available = cheaperBook.reduce((total, el) => total + el.amount, 0)

            log(`Attempt to replace top ${i} of ${borrows.length} borrows...`)
            log(
                `>> Found ${f2(available)} available cheaper than ${f8(cost.bestRate)} (${apr(cost.bestRate)}% APR). Need ${f2(
                    cost.totalBorrowed
                )}`
            )

            if (cost.totalBorrowed >= this.minBorrowSize) {
                if (available > cost.totalBorrowed) {
                    // Allocate a bit extra for the cost of borrowing the funds for an hour
                    const extraForFunding = (cost.totalBorrowed * top.rate) / 24

                    // borrow funds to cover the stuff we are replacing
                    await this.borrowFunds(book, cost.totalBorrowed + extraForFunding)

                    // return borrowing we can replace with cheaper
                    await this.returnBorrowing(subset)

                    // stop looking
                    this.ticksSinceChange = 0
                    return
                }
            } else {
                // too small?
                log(`- Borrowing ${cost.totalBorrowed} is below min order size of ${this.minBorrowSize}`)
            }

            // try a small subset of the list
            i -= 1
        }

        log(`== Couldn't find matching offers for now`)
    }

    /**
     * Called every N milliseconds
     * Will find what you have borrowed now and see if any of it can be replaced with something cheaper
     */
    async onTimer() {
        try {
            // log the time
            const now = new Date()
            log(`\nUpdating at ${now.toString()}`)

            // Clear any orders that have not happened
            await this.ex.cancelAllFundingOffers()

            // Find the used and unused borrowings...
            const unused = await this.ex.getUnusedBorrows()
            const borrows = await this.ex.getCurrentInUseBorrows()

            // Sun them up
            const totalUnused = unused.reduce((sum, b) => sum + b.amount, 0)
            const totalBorrowed = borrows.reduce((sum, b) => sum + b.amount, 0)
            log(`Taken Using : ${f2(totalBorrowed)}\nTaken Unused: ${f2(totalUnused)}`)

            // Has anything changed?
            if (this.prevTotalBorrowed != totalBorrowed) {
                if (this.ticksSinceChange > 0) {
                    log(`Borrowing changed. Now: ${f2(totalBorrowed)}. Was ${f2(this.prevTotalBorrowed)}`)
                    log(`Been ${this.ticksSinceChange} ticks since we changed anything, so exchange changed funding mix.`)
                    log(`Return unused borrowing...`)
                    await this.returnBorrowing(unused)
                }

                // reset the change tracker
                this.prevTotalBorrowed = totalBorrowed
                this.ticksSinceChange = 0
            }

            // pick a long time (say 2 hours) and if nothing changes in that long, anything unused must not be needed any more
            const longTime = 1000 * 60 * 60 * 2
            if (totalUnused > 0 && this.ticksSinceChange * this.interval > longTime) {
                log('Unused borrows have been left unallocated for a long time')
                log('Unlikely they are needed. Returning them...')
                await this.returnBorrowing(unused)
            }

            // Assume no changes will be made this this stage
            this.ticksSinceChange += 1

            // If we have no used borrowing, stop
            if (borrows.length === 0) {
                log('no borrowing - waiting...')
                return
            }

            // get the order book
            const book = await this.ex.getFundingAvailableToBorrow()

            // see if we can replace anything
            await this.replaceBorrowingIfCheaper(borrows, book)
            log('Updated complete')
        } catch (err) {
            log('Error in onTimer...')
            log(err.message)
            console.log(err)
        }
    }
}

module.exports = App
