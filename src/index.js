const goodbye = require('graceful-goodbye')
const PrivateSocket = require('./exchange/bitfinex-private')
const factory = require('./strat')
const log = require('./util/log')('runner')

// The exchange connection
const socket = new PrivateSocket()

// Build a suitable app, based off the config
const app = factory(socket)
app.start()

// Exit handler - try a graceful shutdown and clean up
goodbye(async () => {
    try {
        await app.stop()
    } catch (err) {
        log('error while shutting down...', err)
    }
})
