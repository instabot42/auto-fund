const App = require('./app')
const log = require('../util/log')('app-replace')

class ReplaceIfCheaperApp extends App {
    constructor(socket) {
        super(socket)

        // When switching out borrow, track the changes...
        this.pending = null
    }

    /**
     * Called when an offer is added or updated
     * @param {*} offer
     */
    onUpdateOffer(offer) {
        super.onUpdateOffer(offer)

        // we got a new offer. Can we find any borrows that are paying more than this
        this.replaceBorrowingIfCheaper()
    }

    /**
     * A new or updated order has been detected. Could be part filled for example.
     * @param {*} order
     */
    onUpdateOrder(order) {
        super.onUpdateOrder(order)

        if (this.pending) {
            this.pending.orderIds = this.pending.orderIds.filter((id) => id !== order.id)
            this.pending.orderIds.push(order.id)
        }
    }

    /**
     * Called when a trade is executed
     * @param {*} trade
     */
    onExecuteTrade(trade) {
        super.onExecuteTrade(trade)

        if (this.pending) {
            this.pending.filledCount += 1
            this.pending.filledAmount += Math.abs(trade.amount)
        }
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

            // Calculate the amount in this subset, and the best rate we are borrowing at
            // Any replacement has to be able to cover as much qty, at a better rate
            const cost = this.replacementCost(subset)

            // Find the section of the order book that offers a better rate (better by the min improvement)
            // and figure out how much liquidity is there
            const cheaperBook = this.orderBookCheaperThan(book, cost.bestRate)
            const available = cheaperBook.reduce((total, el) => total + el.amount, 0)

            // If there is enough available in the order book, and it is > min order size, have a go...
            const borrowAmount = cost.totalBorrowed
            if (borrowAmount >= this.minBorrowSize && available > borrowAmount) {
                // Find the optimal rate to try and borrow at
                const targetRate = this.findTargetRateToBorrow(cheaperBook, borrowAmount)

                // report the state of things
                this.logBorrowState()
                log('\nMatch Found...')
                log(`>> Can replace top ${i} of ${borrows.length} borrows...`)
                log(`>> Needed ${this.f2(borrowAmount)}. Found ${this.f2(available)} available`)
                log(`>> Replaces existing at ${this.apr(cost.bestRate)}% APR (${this.f8(cost.bestRate)}) or worse`)
                log(`>> With new at          ${this.apr(targetRate)}% APR (${this.f8(targetRate)}) or better\n`)

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
        this.logBorrowState()
        log(`>>>>>> END <<\n`)

        this.pauseUntil = Date.now() + 1000 * 60
        this.pending = null
    }

    /**
     * Find the list of borrows to return
     * @param {*} toReplace - is sorted by most expensive first
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

        // Something filled and we have several borrows to choose from
        // try and find an optimal combination of items to return, so we return as close
        // to the amount filled. Default to returning everything
        let toReturn = toReplace.slice()
        let smallestDiff = toReplace.reduce((a, el) => a + el.amount, 0)
        const tolerance = smallestDiff / 1000000

        // Helper function to recurse though the list of possible items
        function findBestComboOfReturns(items, target, possible = []) {
            // Sum this possible match
            const partialSum = possible.reduce((s, b) => s + b.amount, 0)
            if (partialSum >= target) {
                // this would return at least enough (maybe a little over)
                return partialSum
            }

            for (let i = 0; i < items.length; i++) {
                const remaining = items.slice(i + 1)
                const next = possible.concat([items[i]])
                const result = findBestComboOfReturns(remaining, target, next)

                if (result) {
                    // This is a possible suitable combo, so see how far off we are
                    const diff = result - target

                    // if this match it better, remember it
                    if (diff < smallestDiff) {
                        smallestDiff = diff
                        toReturn = next.slice()
                    }
                }

                // if we are close enough, we can kill the recusion
                if (smallestDiff < tolerance) {
                    return false
                }
            }

            return false
        }

        // recursive effort to find the best combination to return
        findBestComboOfReturns(toReplace, this.pending.filledAmount)

        // How much was there vs what we are returning
        const amtReturned = toReturn.reduce((sum, r) => sum + r.amount, 0)
        log(`Filled ${this.pending.filledAmount}, returning ${amtReturned} over ${toReturn.length} items`)
        return toReturn
    }
}

module.exports = ReplaceIfCheaperApp
