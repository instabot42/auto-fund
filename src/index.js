const Bitfinex = require('./bitfinex')
const App = require('./app')

// The exchange
const finex = new Bitfinex()

// The app
const app = new App(finex)
app.start()
