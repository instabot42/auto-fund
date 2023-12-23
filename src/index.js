const PrivateSocket = require('./bitfinex-private')
const App = require('./app')

// The exchange connection
const socket = new PrivateSocket()

// The app
const app = new App(socket)
app.start()
