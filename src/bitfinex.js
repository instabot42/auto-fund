const crypto = require('node:crypto')
const config = require('config')
const axios = require('axios')
const Debug = require('debug')
const debug = Debug('autoFund:Bitfinex')

class Bitfinex {
    /**
     * set up
     */
    constructor() {
        // setting from config
        this.key = config.get('bitfinex.key')
        this.secret = config.get('bitfinex.secret')
        this.symbol = config.get('bitfinex.symbol')

        // message id / nonce
        this.msgId = Date.now()

        // should we change anything or not
        debug(`Bitfinex starting, tracking ${this.symbol}`)

        this.dryRun = !!config.get('dryRun')
        if (this.dryRun) {
            debug('\n============\nDRY RUN - WILL NOT CHANGE BORROWING\n============\n')
        }
    }

    /**
     * Get the current list of borrowed funds, sorted as most expensive first
     * @returns
     */
    async getCurrentInUseBorrows() {
        // https://docs.bitfinex.com/reference/rest-auth-funding-credits
        // POST /v2/auth/r/funding/credits/{Symbol}
        const path = `/v2/auth/r/funding/credits/${this.symbol}`
        const credits = await this.httpCall('post', path)

        return this.transformBorrows(credits)
    }

    /**
     * Get the current list of borrowed funds, sorted as most expensive first
     * @returns
     */
    async getUnusedBorrows() {
        // https://docs.bitfinex.com/reference/rest-auth-funding-loans
        // POST /v2/auth/r/funding/credits/{Symbol}
        const path = `/v2/auth/r/funding/loans/${this.symbol}`
        const loans = await this.httpCall('post', path)

        return this.transformBorrows(loans)
    }

    /**
     * Remap and sort borrowing / loan information from the API
     * @param {*} borrows
     * @returns
     */
    transformBorrows(borrows) {
        return (
            borrows
                // Just borrowing (not lending)
                .filter((c) => c[2] <= 0)
                // Name properties
                .map((c) => ({
                    id: c[0],
                    rate: c[11],
                    period: c[12],
                    createdAt: c[3],
                    updatedAt: c[4],
                    openedAt: c[13],
                    expiresAt: c[13] + c[12] * 1000 * 60 * 60 * 24,
                    amount: c[5],
                    symbol: c[1],
                    side: c[2] < 0 ? 'borrower' : c[2] > 0 ? 'lender' : 'both',
                    rateType: c[8].toLowerCase(),
                    positionPair: c[21] ? c[21] : null,
                }))
                // Sort by rate / period
                .sort((a, b) => {
                    let s = b.rate - a.rate
                    if (s === 0) {
                        s = b.period - a.period
                    }

                    return s
                })
        )
    }

    /**
     * Get the current funding book and filter it to just the funding being offered
     * @returns
     */
    async getFundingAvailableToBorrow() {
        // https://docs.bitfinex.com/reference/rest-public-book
        // GET /v2/book/{symbol}/{precision}
        const precision = 'P0'
        const params = {
            len: '25',
        }

        const book = await this.httpCallPublic('get', `/v2/book/${this.symbol}/${precision}`, params)

        // Only return the asks (amount > 0)
        return book
            .map((b) => ({
                rate: b[0],
                period: b[1],
                count: b[2],
                amount: b[3],
            }))
            .filter((b) => b.amount > 0)
    }

    /**
     * Ask to close a specific piece of funding
     * @param {*} id
     */
    async fundingClose(id) {
        // https://docs.bitfinex.com/reference/rest-auth-funding-close
        // /v2/auth/w/funding/close
        const params = { id }
        if (this.dryRun) {
            debug('DRYRUN: Would have closed funding here')
            debug(params)
            return
        }

        const r = await this.httpCall('post', '/v2/auth/w/funding/close', params)
    }

    /**
     * Attempt to borrow some funds
     * @param {*} amount
     * @param {*} rate
     * @param {*} period
     * @returns
     */
    async borrowFunds(amount, rate, period) {
        // https://docs.bitfinex.com/reference/rest-auth-submit-funding-offer
        // /v2/auth/w/funding/offer/submit
        const params = {
            type: 'LIMIT',
            symbol: this.symbol,
            amount: `${-amount}`,
            rate: `${rate}`,
            period,
            flags: 0,
        }

        if (this.dryRun) {
            debug('DRYRUN: Would have placed order for new funding')
            debug(params)
            return
        }

        const r = await this.httpCall('post', '/v2/auth/w/funding/offer/submit', params)
    }

    /**
     *
     * @param {*} m
     * @param {*} path
     * @param {*} params
     * @returns
     */
    async httpCallPublic(m, path, params = {}) {
        const endpoint = 'https://api-pub.bitfinex.com'
        const method = m.toUpperCase()
        const uri = method === 'POST' ? path : this.buildURI(path, params)
        const body = method === 'POST' ? JSON.stringify(params) : ''
        const headers = {}

        // Build the request
        const request = {
            method,
            url: `${endpoint}${uri}`,
            headers,
            data: body,
        }

        try {
            const response = await axios(request)
            return response.data
        } catch (err) {
            debug(err)
            throw err
        }
    }

    /**
     *
     * @param {*} m
     * @param {*} path
     * @param {*} params
     * @returns
     */
    async httpCall(m, path, params = {}) {
        // Check we have some keys
        if (this.key === '' || this.secret === '') {
            debug('Set up API keys in config (config/local.js) to call authenticated endpoints')
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
            const response = await axios(request)
            return response.data
        } catch (error) {
            if (error.response) {
                debug(`Bitfinex REST API error response. Status Code: ${error.response.status}`)
                debug(error.response.data)

                if (error.response.status === 500) {
                    this.msgId = Date.now()
                }
            } else if (error.request) {
                debug('Request Error making REST API request to Bitfinex (exchange down?)')
            } else {
                debug('Error making REST API request to Bitfinex')
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

    /**
     * Get the next message id. Each message is sent with a unique id in it,
     * so we can identify the response in onMessage()
     * @returns {number|*}
     */
    nextMsgId() {
        this.msgId += 1
        return this.msgId
    }

    /**
     * Builds a query string and uri for REST requests
     * @param path
     * @param params
     * @returns {string}
     */
    buildURI(path, params) {
        const qs = this.paramsToQueryString(params)
        if (qs === '') {
            return path
        }

        return `${path}?${qs}`
    }

    /**
     * Given an object of params, create a query string
     * @param params
     * @returns {string}
     */
    paramsToQueryString(params) {
        let orderedParams = ''
        Object.keys(params)
            .sort()
            .forEach((key) => {
                if (Object.prototype.hasOwnProperty.call(params, key)) {
                    const value = `${params[key]}`
                    orderedParams += `${key}=${value}&`
                }
            })

        // take off the trailing &
        return orderedParams.substring(0, orderedParams.length - 1)
    }
}

module.exports = Bitfinex
