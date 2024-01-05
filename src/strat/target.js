const App = require('./app')
const config = require('../util/config')
const Lock = require('../util/lock')
const log = require('../util/log')('app-target')

class TargetApp extends App {
    constructor(socket) {
        super(socket)

        this.targetRates = config.get('target.rates')

        this.tooExpensive = []
        this.pendingReturn = 0
        this.filledSoFar = 0

        // Lock on overlapping fills
        this.fillLock = new Lock()
    }

    /**
     * New order detected
     * @param {*} order
     */
    onNewOrder(order) {
        super.onNewOrder(order)
        this.onFillOrder(order)
    }

    /**
     * A new or updated order has been detected. Could be part filled for example.
     * @param {*} order
     */
    onUpdateOrder(order) {
        super.onUpdateOrder(order)
        this.onFillOrder(order)
    }

    /**
     * An order has been cancelled (filled, closed etc)
     * @param {*} order
     */
    onCancelOrder(order) {
        super.onCancelOrder(order)
        this.onFillOrder(order)
    }

    /**
     * Called when a fill has been detected on an order
     * Will derive the executed amount and try and return expensive borrows that are covered by the fill
     * @param {*} order
     */
    onFillOrder(order) {
        // as these fills can flood in, then can end up overlapping, so we serialise it here
        this.fillLock.runLocked(async () => {
            const filled = Math.abs(order.filled)
            if (filled > this.filledSoFar) {
                const executed = filled - this.filledSoFar
                const remains = Math.abs(order.amountRemaining)
                const amt = Math.abs(order.amount)
                log(`Fill Detected: ${this.f4(executed)}.\n${this.f4(remains)} still to fill of ${this.f4(amt)}`)

                // Update what we know about how much as been filled so far
                this.filledSoFar = filled

                // see the executed amount
                this.pendingReturn += executed
                log(`Pending return ${this.f4(this.pendingReturn)}\n`)
                await this.returnExcessBorrows()
            }
        })
    }

    /**
     * Try and find a borrow that is smaller than the unspent fills we have so far
     * If we find any, return them
     */
    async returnExcessBorrows() {
        let qtyReturned = 0
        let keepLooking = true
        while (keepLooking) {
            keepLooking = false
            const borrow = this.tooExpensive.find((b) => b.amount <= this.pendingReturn + 1)
            if (borrow) {
                // return this borrowing
                qtyReturned += borrow.amount
                this.pendingReturn -= borrow.amount
                if (this.pendingReturn < 0) {
                    this.pendingReturn = 0
                }

                // remove it from the set
                this.tooExpensive = this.tooExpensive.filter((b) => b.id !== borrow.id)

                // As the borrows can change (moving from unused to using for example)
                // we actually just look for any borrow of the same size and rate in the active list, and discard that one
                const returnMe = this.borrows.find(
                    (b) => b.rateFixed === borrow.rateFixed && b.amount === borrow.amount && b.period === borrow.period
                )
                if (returnMe) {
                    await this.returnBorrow(returnMe)
                    await this.sleep(100)
                } else {
                    log('unable to find a borrow that matches. Seeking:', borrow)
                }

                if (this.pendingReturn > 0 && this.tooExpensive.length > 0) {
                    keepLooking = true
                }
            }
        }

        log(`Returned ${this.f2(qtyReturned)}. ${this.f2(this.pendingReturn)} still outstanding...`)
    }

    /**
     * Called on the interval
     * We cancel existing orders and place a new order at a rate that might get filled
     */
    async onTimer() {
        super.onTimer()

        await this.fillLock.runLocked(async () => {
            // cancel any open orders
            await this.cancelAllOrders()
            log('')
        })

        // Cancelling orders can queue up fill locked work,
        // so wait a moment so all that can be cleared
        await this.sleep(2000)

        // Next try and borrow something to replace existing expensive stuff
        await this.fillLock.runLocked(async () => {
            // reset the list of borrows etc
            this.tooExpensive = []
            this.filledSoFar = 0

            // stop if not borrowing anything
            if (this.borrows.length === 0) {
                return
            }

            log('Looking for borrows that exceed our target rates list...')
            for (const ratePercent of this.targetRates) {
                const rate = ratePercent / 365 / 100
                this.tooExpensive = this.borrows.filter((b) => b.rate > rate)
                const amountToReplace = this.tooExpensive.reduce((s, b) => s + b.amount, 0)
                log(
                    `Found ${this.tooExpensive.length} borrows > ${this.apr(rate)}% (${this.f8(rate)}) for ${this.f2(amountToReplace)} ${
                        this.symbol
                    }`
                )

                if (this.tooExpensive.length > 0) {
                    // Find out how much is too expensive
                    const toBorrow = amountToReplace - this.pendingReturn
                    log(`>> Want to replace: ${this.f4(amountToReplace)}`)
                    this.tooExpensive.forEach((b) => log(` [${b.id}] for ${this.f2(b.amount)} @ ${b.ratePercent}`))
                    log(`>> Unspent fills:   ${this.f4(this.pendingReturn)}`)
                    log(`>> Borrow Now:      ${this.f4(toBorrow)}\n`)

                    // place an order to borrow that much at that rate
                    if (toBorrow > 0 && toBorrow >= this.minBorrowSize) {
                        this.borrowFunds(toBorrow, rate)
                        return
                    }
                }
            }

            log('Nothing to do yet...\n')
        })
    }

    /**
     * App is closing, so cancel my open funding offers
     */
    async beforeShutdown() {
        super.beforeShutdown()
        await this.cancelAllOrders()
    }

    /**
     * Cancels all open orders and waits for them to complete (well, waits a bit anyway)
     */
    async cancelAllOrders() {
        if (this.orders.length === 0) {
            return
        }

        // cancel any open orders
        this.socket.cancelOffers(this.orders.map((o) => o.id))

        // Wait around for them to be cleared out
        let tries = 0
        while (tries < 10 && this.orders.length > 0) {
            tries += 1
            await this.sleep(100)
        }
    }
}

module.exports = TargetApp
