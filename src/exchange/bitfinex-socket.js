const WebSocket = require('ws')
const EventEmitter = require('events')
const config = require('../util/config')
const log = require('../util/log')('bitfinex')

class BaseSocket extends EventEmitter {
    constructor() {
        super()

        // setting from config
        this.symbol = config.get('bitfinex.symbol')

        this.isClosing = false

        this.pingTimer = null
        this.pingInterval = 12000

        this.restartTimer = null
        this.restartDelay = 1000

        // message id / nonce
        this.msgId = Date.now()

        // should we change anything or not
        log(`Bitfinex socket starting, tracking ${this.symbol}`)

        this.dryRun = !!config.get('dryRun')
        if (this.dryRun) {
            log('\n============\nDRY RUN - WILL NOT CHANGE BORROWING\n============\n')
        }

        this.ws = null
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
     * Find out the address to connect to - will depend on a few factors
     */
    getAddress() {
        throw new Error('getAddress not implemented - expecting derived class to return something')
    }

    /**
     * Opens the socket connection and attaches handlers
     */
    open() {
        // open a new websocket
        const address = this.getAddress()
        log(`Opening socket to ${address}`)

        const options = {}
        this.ws = new WebSocket(address, options)
        this.loggedIn = false

        // handlers...
        this.ws.on('error', async (e) => this.onError(e))
        this.ws.on('message', async (e) => this.onMessage(e))
        this.ws.on('close', async (e) => this.onClose(e))
        this.ws.on('ping', async (e) => this.onPing(e))
        this.ws.on('pong', async (e) => this.onPong(e))
        this.ws.on('open', async () => this.onOpen())
    }

    /**
     * Called when restarting a downed connection
     */
    restartConnection() {
        clearTimeout(this.restartTimer)
        this.restartTimer = setTimeout(async () => {
            try {
                // If we are closing, don't try and do more
                if (this.isClosing) {
                    return
                }

                // Open the websocket (well, try to)
                this.open()
            } catch (err) {
                // Soak up the exception, as a new attempt will have been scheduled now
                log(err)
            }
        }, this.restartDelay)
    }

    /**
     * Ask to close the socket connection down
     */
    close() {
        this.isClosing = true
        this.clearTimers()
        if (this.ws) {
            this.ws.close()
        }
    }

    /**
     * Clears all the timers we have have running
     */
    clearTimers() {
        // stop the pings
        clearInterval(this.pingTimer)
        this.pingTimer = null

        // Clear any pending restarts
        clearTimeout(this.restartTimer)
        this.restartTimer = null
    }

    /**
     * Sends a test message over the socket
     * @param {*} msg
     */
    sendSocketRaw(msg) {
        // logger.dim(`Send Socket (${this.type}): ${msg}`)
        if (this.ws) {
            this.ws.send(msg)
        }
    }

    /**
     * Sends an object over the socket
     * @param {*} msg
     */
    sendSocketMsg(msg) {
        this.sendSocketRaw(JSON.stringify(msg))
    }

    /**
     * Called when the socket connection has been opened
     */
    async onOpen() {
        // log into the socket
        this.login()
        this.subscribeToFeeds()

        // start a ping
        clearInterval(this.pingTimer)
        this.pingTimer = setInterval(
            () =>
                this.sendSocketMsg({
                    event: 'ping',
                    cid: this.nextMsgId(),
                }),
            this.pingInterval
        )
    }

    /**
     * Called when there is an error on the socket connection
     * @param {*} e
     */
    async onError(e) {
        log(`connection error detected (closing socket)`)
        log(e)
        if (this.ws) {
            this.ws.close()
        }
    }

    /**
     * Called when the socket is closing (either cos we asked to, or because of a connection problem)
     * @param {*} e
     */
    async onClose(e) {
        log(`socket is closing...`)

        // stop the pings
        this.clearTimers()

        // clean up the socket
        if (this.ws) {
            this.ws.terminate()
            this.ws.removeAllListeners()
            this.ws = null
        }
        this.loggedIn = false

        // if we were not trying to close the connection, restart it
        if (!this.isClosing) {
            log(`socket closed while active - reconnecting...`)
            this.restartConnection()
        }
    }

    /**
     * Ping Pong keep alive stuff
     * @param {*} e
     */
    async onPing(e) {}

    /**
     * Ping pong
     * @param {*} e
     */
    async onPong(e) {}

    /**
     * A message has arrived on the socket. Decode and process it
     * @param {*} e
     * @returns
     */
    async onMessage(e) {
        try {
            // get the message as a string
            const s = Buffer.isBuffer(e) ? e.toString() : e
            if (s === 'ping' || s === 'pong') {
                return
            }

            // Attempt to decode the message
            const msg = JSON.parse(s)
            this.handleIncomingMessage(msg)
        } catch (err) {
            log(`Error processing incoming message`)
            log(err)
            log(e)
        }
    }

    /**
     * An incoming message has been decoded - handle it
     * @param {*} msg
     */
    handleIncomingMessage(msg) {
        try {
            if (Array.isArray(msg)) {
                this.handleDataMessage(msg)
            } else {
                this.handleEventMessage(msg)
            }
        } catch (err) {
            log(err)
            log(msg)
        }
    }

    /**
     * Handle event messages from the server
     * @param {*} msg
     * @returns
     */
    handleEventMessage(msg) {
        if (!msg.event) {
            return
        }

        switch (msg.event) {
            case 'auth':
                this.onAuth(msg)
                break

            case 'subscribed':
                this.onSubscribe(msg)
                break

            case 'info':
                log(msg)
                break

            case 'conf':
                log('Configuration Change from the server')
                log(msg)
                break

            case 'pong':
                // ping pong complete - do nothing...
                break

            case 'error':
                log('Error event')
                log(msg)
                break

            default:
                log(`unknown event - ${msg.event}`)
                break
        }
    }

    /**
     * Handle an incoming data message
     * @param {*} id
     * @param {*} data
     */
    handleDataMessage(data) {}

    /**
     * Called to perform any login steps needed
     */
    login() {}

    /**
     * Auth message - handled in derived class
     * @param {*} msg
     */
    onAuth(msg) {}

    /**
     * Notified that we have subscribed to a topic
     * @param {*} msg
     */
    onSubscribe(msg) {}

    /**
     * Subscribe to any required feeds
     */
    subscribeToFeeds() {}
}

module.exports = BaseSocket
