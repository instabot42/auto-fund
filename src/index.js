const PrivateSocket = require('./exchange/bitfinex-private')
const factory = require('./strat')

// The exchange connection
const socket = new PrivateSocket()

// Build a suitable app, based off the config
const app = factory(socket)
app.start()
