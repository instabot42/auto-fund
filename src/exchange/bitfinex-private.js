const crypto = require('node:crypto')
const axios = require('axios')
const config = require('../util/config')
const BaseSocket = require('./bitfinex-socket')
const Lock = require('../util/lock')
const log = require('../util/log')('bitfinex-auth')

// https://docs.bitfinex.com/docs/ws-general

class PrivateSocket extends BaseSocket {
    constructor() {
        super()

        // API keys needed for private connection
        this.key = config.get('bitfinex.key')
        this.secret = config.get('bitfinex.secret')
        this.loggedIn = false

        this.orderBookChannelId = -1

        // HTTP Locking
        this.apiLock = new Lock()
    }

    /**
     * Make a request to borrow funds
     * @param {*} amount
     * @param {*} rate
     * @returns
     */
    borrowFunds(amount, rate) {
        if (this.dryRun) {
            log('DRYRUN: not requesting new borrowing')
            return
        }

        // Construct a message
        const msg = [
            0,
            'fon',
            null,
            {
                type: 'LIMIT',
                symbol: this.symbol,
                amount: `${-amount}`,
                rate: `${rate}`,
                period: 2,
                flags: 0,
            },
        ]

        this.sendSocketMsg(msg)
    }

    /**
     * Returns the listed borrows (closing the funding borrowed)
     * @param {*} ids
     */
    async returnManyBorrows(borrows) {
        for (const b of borrows) {
            await this.returnBorrow(b)
        }
    }

    /**
     * Returns the listed borrows (closing the funding borrowed)
     * @param {*} ids
     */
    async returnBorrow(borrow) {
        if (this.dryRun) {
            log(`DRYRUN: not returning loan ${borrow.id}`)
            return true
        }

        try {
            await this.apiLock.runLocked(async () => {
                // https://docs.bitfinex.com/reference/rest-auth-funding-close
                // /v2/auth/w/funding/close
                log(`==Request to return borrowing id ${borrow.id} for ${borrow.amount.toFixed(4)} ${borrow.status}`)
                await this.httpCall('post', '/v2/auth/w/funding/close', { id: borrow.id })
                return true
            })
        } catch (err) {
            // Just eat the error and log it
            log(`Error trying to return borrowing`, borrow)
            return false
        }
    }

    /**
     * Cancels a list of offers, given an array of order ids
     * @param {*} ids
     * @returns
     */
    cancelOffers(ids) {
        if (this.dryRun) {
            log('DRYRUN: not cancelling offers')
            return
        }

        if (ids.length === 0) {
            return
        }

        // For each id, send a message to cancel it
        log(`Cancelling ${ids.length} Offers...`)
        ids.forEach((id) => {
            const msg = [0, 'foc', null, { id }]
            this.sendSocketMsg(msg)
        })
    }

    /**
     * Find out the address to connect to - will depend on a few factors
     */
    getAddress() {
        // For private channels:
        return 'wss://api.bitfinex.com/ws/2'
    }

    /**
     * Called to perform any login steps needed
     * https://docs.bitfinex.com/docs/ws-auth
     */
    login() {
        // authenticate with the server
        const authNonce = `${this.nextMsgId()}`
        const authPayload = `AUTH${authNonce}`
        const authSig = this.signMessage(authPayload)

        // Send the authentication request
        log('Logging into the exchange to watch funding state')
        this.sendSocketMsg({
            apiKey: this.key,
            authSig,
            authNonce,
            authPayload,
            event: 'auth',
            filter: [
                `funding-${this.symbol}`, // Just stuff about the symbol we are working with
                'trading', // positions
                `wallet-trading-${this.quoteCurrency}`, // balance
            ],
        })
    }

    onAuth(msg) {
        if (msg.status !== 'OK') {
            log('Failed to authentication. Bad API keys probably.')
            this.close()
            return
        }

        log('Authenticated OK')
        this.loggedIn = true

        // attempt to subscribe to anything, now that we are connected
        this.subscribeToFeeds()
    }

    /**
     * Subscribe to any required feeds
     */
    subscribeToFeeds() {
        if (!this.loggedIn) {
            return
        }

        const msg = {
            event: 'subscribe',
            channel: 'book',
            symbol: this.symbol,
            length: '1',
        }

        log('Subscribe to public lending book...')
        this.sendSocketMsg(msg)
    }

    /**
     * Notified that we have subscribed to a topic
     * @param {*} msg
     */
    onSubscribe(msg) {
        log(`subscribed to channel '${msg.channel}' for ${msg.symbol} on channel ${msg.chanId}`)
        this.orderBookChannelId = msg.chanId
    }

    /**
     * Handle an incoming data message
     * @param {*} entry
     */
    handleDataMessage(data) {
        // Find the channel
        const channel = data[0]

        // System messages
        if (channel == 0) {
            return this.handleSystemMessage(data)
        }

        // Order book feed
        if (channel === this.orderBookChannelId) {
            return this.handleOrderBookMessage(data)
        }
    }

    /**
     * A data message containing updates to the order book has arrived
     * @param {*} data
     * @returns
     */
    handleOrderBookMessage(data) {
        // All the data is in the first item...
        const entry = data[1]

        // heartbeat messages can be dropped
        if (entry === 'hb') {
            return
        }

        if (!Array.isArray(entry)) {
            log('unexpected data message - expecting an array, got...')
            log(entry)
            return
        }

        if (entry.length === 0) {
            return
        }

        if (Array.isArray(entry[0])) {
            // list of entries
            entry.forEach((e) => this.broadcastOffer(e))
            return
        }

        this.broadcastOffer(entry)
    }

    /**
     * When we settle on a valid offer from the socket, remap it
     * @param {*} entry
     */
    broadcastOffer(entry) {
        // Convert the raw data to an order book entry and if it is an offer, update our copy
        // We don't track bids, so they are essentially discarded at this point
        const offer = this.rawToOrderBook(entry)
        if (offer.side === 'offer') {
            if (offer.count === 0) {
                this.emit('cancel-offer', offer)
            } else {
                this.emit('update-offer', offer)
            }
        }
    }

    /**
     * Handles a data message with system messages about open offerts
     * @param {*} data
     */
    handleSystemMessage(data) {
        const type = data[1]
        switch (type) {
            // Funding Loans (In Use)
            case 'fcs': // credits snapshot
                log('Funding Credits - Taken Using - Snapshot')
                data[2].map((f) => this.rawToBorrow(f, 'using')).forEach((f) => this.broadcastBorrow(f, 'update'))
                break

            case 'fcn': // credits new
            case 'fcu': // credits update
                this.broadcastBorrow(this.rawToBorrow(data[2], 'using'), 'update')
                break

            case 'fcc': // credits cancel
                this.broadcastBorrow(this.rawToBorrow(data[2], 'using'), 'cancel')
                break

            // Funding Loans (not being used)
            case 'fls': // loan snapshot
                log('Funding Loans - Taken Unused - Snapshot')
                data[2].map((f) => this.rawToBorrow(f, 'unused')).forEach((f) => this.broadcastBorrow(f, 'update'))
                break

            case 'fln': // loan new
            case 'flu': // loan update
                this.broadcastBorrow(this.rawToBorrow(data[2], 'unused'), 'update')
                break

            case 'flc': // loan cancel
                this.broadcastBorrow(this.rawToBorrow(data[2], 'unused'), 'cancel')
                break

            // Funding offers / Orders
            case 'fos':
                log('Funding Offers - Open orders - Snapshot')
                data[2].map((o) => this.rawToFundingOrder(o)).forEach((o) => this.broadcastOrder(o, 'update'))
                break

            case 'fon':
                this.broadcastOrder(this.rawToFundingOrder(data[2]), 'new')
                break

            case 'fou':
                this.broadcastOrder(this.rawToFundingOrder(data[2]), 'update')
                break

            case 'foc':
                this.broadcastOrder(this.rawToFundingOrder(data[2]), 'cancel')
                break

            case 'fte':
                this.broadcastTrade(this.rawToTrade(data[2]), 'execute')
                break

            case 'ftu':
                this.broadcastTrade(this.rawToTrade(data[2]), 'update')
                break

            case 'n':
                log('Notification', data)
                break

            // Heartbeat
            case 'hb':
                break

            case 'ps': // position snapshot
                data[2].map((p) => this.rawToPosition(p)).forEach((p) => this.broadcastPosition(p, 'update'))
                break

            case 'pn': // position new
            case 'pu': // position update
                this.broadcastPosition(this.rawToPosition(data[2]), 'update')
                break

            case 'ws': // Wallet snapshot
                data[2].map((w) => this.rawToWallet(w)).forEach((w) => this.broadcastWallet(w))
                break

            case 'wu': // Wallet update
                this.broadcastWallet(this.rawToWallet(data[2]))
                break

            case 'os': // order snapshot
            case 'oc': // order cancel
            case 'on': // order new
            case 'ou': // order update
                break

            // Unknown
            default:
                log('unknown type')
                log(type)
                log(data)
                break
        }
    }

    /**
     * A change in borrows is detected, we update our state of all active borrows to match
     * and emit events to inform others
     * @param {*} borrow
     * @param {*} event
     */
    broadcastBorrow(borrow, event) {
        this.emit(`${event}-borrow`, borrow)
    }

    /**
     * Broadcasts a change to an order
     * @param {*} order
     * @param {*} event
     */
    broadcastOrder(order, event) {
        this.emit(`${event}-order`, order)
    }

    /**
     * Broadcast an event for the trade
     * @param {*} trade
     * @param {*} event
     */
    broadcastTrade(trade, event) {
        this.emit(`${event}-trade`, trade)
    }

    /**
     * Broadcasts an update wallet event
     * @param {*} wallet
     */
    broadcastWallet(wallet) {
        this.emit('update-wallet', wallet)
    }

    /**
     * Broadcasts an update wallet event
     * @param {*} position
     */
    broadcastPosition(position, event) {
        this.emit(`${event}-position`, position)
    }

    /**
     * Converts raw data into a wallet balance
     * @param {*} w
     * @returns
     */
    rawToWallet(w) {
        return {
            type: w[0],
            currency: w[1],
            balance: w[2],
            unsettledInterest: w[3],
            available: w[4],
        }
    }
    /**
     * array to a Trade
     * @param {*} t
     * @returns
     */
    rawToTrade(t) {
        return {
            id: t[0] ?? null,
            currency: t[1],
            createdAt: t[2],
            offerId: t[3] ?? null,
            amount: t[4],
            rate: t[5],
            rateFixed: t[5].toFixed(8),
            ratePercent: (t[5] * 365 * 100).toFixed(4),
            period: t[6],
            maker: t[7] === 1,
            desc: t[7] === 1 ? 'Maker' : 'Taker',
        }
    }

    /**
     * Array to Funding Offer
     * @param {*} o
     * @returns
     */
    rawToFundingOrder(o) {
        const filled = o[5] - o[4]
        return {
            id: o[0],
            symbol: o[1],
            createdAt: o[2],
            updatedAt: o[3],
            amountRemaining: o[4],
            amount: o[5],
            filled,
            type: o[6].toLowerCase(),
            flags: o[9],
            status: o[10].toLowerCase(),
            rate: o[14],
            rateFixed: o[14].toFixed(8),
            ratePercent: (o[14] * 365 * 100).toFixed(4),
            period: o[15],
            createdAtHuman: this.msToHuman(o[2]),
        }
    }

    /**
     * Maps some incoming array of borrowing values into a structure we can use
     * @param {*} f
     * @param {*} type
     * @returns
     */
    rawToBorrow(f, type) {
        const rate = f[19] !== null ? f[19] : f[11]
        return {
            id: f[0],
            symbol: f[1],
            side: f[2] < 0 ? 'borrower' : f[2] > 0 ? 'lender' : 'both',
            type,
            createdAt: f[3],
            updatedAt: f[4],
            expiresAt: f[13] + f[12] * 1000 * 60 * 60 * 24,
            amount: f[5],
            status: f[7],
            rate,
            rateFixed: rate.toFixed(8),
            ratePercent: (rate * 365 * 100).toFixed(4),
            period: f[12],
            pair: f[21] ? f[21] : 'none',
            createdAtHuman: this.msToHuman(f[3]),
            expiresAtHuman: this.msToHuman(f[13] + f[12] * 1000 * 60 * 60 * 24),
        }
    }

    /**
     * Convert an array of values into an order book entry
     * @param {*} entry
     * @returns
     */
    rawToOrderBook(entry) {
        // Extract the data we want from the message
        const rate = entry[0]
        const period = entry[1]
        const count = entry[2]
        const amount = entry[3]

        // Emit a message with the changed order book details
        const side = amount > 0 ? 'offer' : 'bid'
        return {
            side,
            rate,
            period,
            count,
            amount: Math.abs(amount),
            rateFixed: rate.toFixed(8),
            ratePercent: (rate * 365 * 100).toFixed(4),
        }
    }

    /**
     * Return position data from a stream
     * @param {*} pos
     * @returns
     */
    rawToPosition(pos) {
        return {
            symbol: pos[0],
            status: pos[1].toLowerCase(),
            amount: pos[2],
            basePrice: pos[3],
            marginFundingCost: pos[4],
            marginFundingType: pos[5],
            pnl: pos[6],
            pnlPercent: pos[7],
            liquidationPrice: pos[8],
            leverage: pos[9],
            flags: pos[10],
            id: pos[11],
            createdAt: pos[12],
            updatedAt: pos[13],
            type: pos[15],
            collateral: pos[17],
            collatoralMin: pos[18],
            meta: pos[19],
            createdAtHuman: this.msToHuman(pos[12]),
        }
    }

    msToHuman(timestamp) {
        const d = new Date(timestamp)
        return d.toISOString()
    }

    /**
     * Make rest calls
     * @param {*} m
     * @param {*} path
     * @param {*} params
     * @returns
     */
    async httpCall(m, path, params = {}) {
        // Check we have some keys
        if (this.key === '' || this.secret === '') {
            log('Set up API keys in config (config/local.js) to call authenticated endpoints')
            throw new Error('No API Keys Provided')
        }

        const method = m.toUpperCase()
        const endpoint = 'https://api.bitfinex.com'

        const uri = method === 'POST' ? path : this.buildURI(path, params)
        const body = method === 'POST' ? JSON.stringify(params) : ''

        // Sign the request
        const nonce = `${this.nextMsgId()}`
        const messageToSign = `/api${path}${nonce}${body}`
        const signature = this.signMessage(messageToSign)

        // debug(`${method} ${path} - ${nonce}`)

        // put the required data in the headers
        const headers = {
            'Content-Type': 'application/json',
            'bfx-nonce': nonce,
            'bfx-apikey': this.key,
            'bfx-signature': signature,
        }

        // Build the request
        const request = {
            method,
            url: `${endpoint}${uri}`,
            headers,
            data: body,
        }

        try {
            log(`## ${m} ${path}`)
            const response = await axios(request)
            return response.data
        } catch (error) {
            if (error.response) {
                log(`Bitfinex REST API error response. Status Code: ${error.response.status}`)
                log(error.response.data)
            } else if (error.request) {
                log('Request Error making REST API request to Bitfinex (exchange down?)')
            } else {
                log('Error making REST API request to Bitfinex')
            }

            throw new Error('Bitfinex REST API Error. Call rejected')
        }
    }

    /**
     * Helper to sign the authentication message
     * @returns {string}
     */
    signMessage(message) {
        return crypto.createHmac('sha384', this.secret).update(message).digest('hex')
    }
}

module.exports = PrivateSocket
