const App = require('./app')
const config = require('../util/config')
const Lock = require('../util/lock')
const logger = require('../util/log')
const log = logger('app-replace')

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
                log(`Fill Detected: ${this.f4(executed)}. ${this.f4(remains)} still to fill of ${this.f4(amt)}`)

                // Update what we know about how much as been filled so far
                this.filledSoFar = filled

                // see the executed amount
                this.pendingReturn += executed
                log(`Pending return ${this.pendingReturn}`)
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
                log(`Return borrow of ${borrow.amount}`)
                qtyReturned += borrow.amount
                this.pendingReturn -= borrow.amount
                this.tooExpensive = this.tooExpensive.filter((b) => b.id !== borrow.id)
                await this.borrowReturn([borrow])

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

        this.fillLock.runLocked(async () => {
            // cancel any open orders
            await this.cancelAllOrders()

            // reset the list of borrows etc
            this.tooExpensive = []
            this.filledSoFar = 0

            // stop if not borrowing anything
            if (this.borrows.length === 0) {
                return
            }

            for (const ratePercent of this.targetRates) {
                const rate = ratePercent / 365 / 100
                this.tooExpensive = this.borrows.filter((b) => b.rate > rate)
                log(`Found ${this.tooExpensive.length} borrows > ${this.apr(rate)}% (${this.f8(rate)})`)

                if (this.tooExpensive.length > 0) {
                    // Find out how much is too expensive
                    const amountToReplace = this.tooExpensive.reduce((s, b) => s + b.amount, 0)
                    const toBorrow = amountToReplace - this.pendingReturn
                    log(`>> Want to replace: ${this.f4(amountToReplace)}`)
                    log(`>> Unspent fills:   ${this.f4(this.pendingReturn)}`)
                    log(`>> Borrow Now:      ${this.f4(toBorrow)}`)

                    // place an order to borrow that much at that rate
                    if (toBorrow > 0) {
                        this.borrowFunds(toBorrow, rate)
                    }

                    return
                }
            }

            log('Nothing to do yet...')
        })
    }

    /**
     * Cancels all open orders and waits for them to complete (well, waits a bit anyway)
     */
    async cancelAllOrders() {
        // cancel any open orders
        this.socket.cancelOffers(this.orders.map((o) => o.id))

        let tries = 0
        while (tries < 10 && this.orders.length > 0) {
            tries += 1
            await this.sleep(1000)
        }
    }
}

module.exports = TargetApp
