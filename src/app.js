const config = require('config')
const Debug = require('debug')
const debug = Debug('autoFund:MainApp')

class App {
    constructor(exchange) {
        this.ex = exchange
        this.timer = null

        this.minImprovement = config.get('minImprovement')
    }

    /**
     * Start the system checking your borrowing
     */
    start() {
        const interval = config.get('interval')
        const inMinutes = interval / 1000 / 60
        debug(`Updating funding every ${interval}ms (about every ${inMinutes.toFixed(0)}m)`)

        // Process the funding book right away
        this.onTimer()

        // then update on an interval
        this.timer = setInterval(() => this.onTimer(), interval)
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
            const apr = this.toApr(orderBook[i].rate)
            debug(`>> Borrow ${toBorrow} at a rate of ${rate.toFixed(8)}  (${apr}% APR)`)
            remaining -= toBorrow
            lastRate = rate
            i += 1
        }

        debug(`>> Requesting total borrowing of ${qty}...`)
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
            const apr = this.toApr(rate)
            debug(`== Return borrowing id ${el.id}`)
            debug(`   ${el.amount} at a rate of ${rate.toFixed(8)} (${apr}% APR)`)
            await this.ex.fundingClose(el.id)
        }
    }

    /**
     * Helper - covert a rate to an annual percent rate
     * @param {*} rate
     * @returns
     */
    toApr(rate) {
        return (rate * 100 * 365).toFixed(4)
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

        // report it
        const seeking = borrows[0].rate - this.minImprovement
        debug(`Found ${i} active borrows.`)
        debug(`Most expensive Borrow  : ${borrows[0].rate.toFixed(8)} (${this.toApr(borrows[0].rate)}% APR)`)
        debug(`Seeking                : ${seeking.toFixed(8)} (${this.toApr(seeking)}% APR) or better`)
        debug(`Cheapest offered       : ${book[0].rate.toFixed(8)} (${this.toApr(book[0].rate)}% APR)`)

        if (book[0].rate > seeking) {
            debug(`                       : Too expensive for now`)
            return
        }

        // try and replace as much as we can
        while (i > 0) {
            const subset = borrows.slice(0, i)
            const cost = this.replacementCost(subset)

            const cheaperBook = this.orderBookCheaperThan(book, cost.bestRate)
            const available = cheaperBook.reduce((total, el) => total + el.amount, 0)
            if (available > cost.totalBorrowed && cost.totalBorrowed >= 150) {
                debug(`Can replace ${i} of ${borrows.length} borrows.`)
                debug(`  ${cost.totalBorrowed} borrowed`)
                debug(`  best rate: ${cost.bestRate} - ${this.toApr(cost.bestRate)}% APR`)
                debug(`Available:`)
                debug(`  ${available.toFixed(2)} from ${cheaperBook.length} lower offers`)

                // borrow funds to cover the stuff we are replacing
                await this.borrowFunds(book, cost.totalBorrowed)

                // return borrowing we can replace with cheaper
                await this.returnBorrowing(subset)

                // stop looking
                return
            }

            // try a small subset of the list
            i -= 1
        }

        debug(`                       : Couldn't find matching offers for now`)
    }

    /**
     * Called every N milliseconds
     * Will find what you have borrowed now and see if any of it can be replaced with something cheaper
     */
    async onTimer() {
        try {
            // log the time
            const now = new Date()
            debug(`\nUpdating at ${now.toString()}`)

            // Find out current borrowing (most expensive first)
            const borrows = await this.ex.getCurrentInUseBorrows()
            if (borrows.length === 0) {
                debug('no borrowing - waiting...')
                return
            }

            // get the order book
            const book = await this.ex.getFundingAvailableToBorrow()

            // see if we can replace anything
            await this.replaceBorrowingIfCheaper(borrows, book)
        } catch (err) {
            debug('Error in onTimer.')
            debug(err)
        }
    }
}

module.exports = App
