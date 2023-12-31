const config = require('../util/config')
const ReplaceIfCheaperApp = require('./replace-if-cheaper')
const TargetApp = require('./target')

function appFactory(socket) {
    const strat = config.get('strategy')
    switch (strat) {
        case 'replace':
            return new ReplaceIfCheaperApp(socket)

        case 'target':
            return new TargetApp(socket)

        default:
            throw new Error('Unknown strategy')
    }
}

module.exports = appFactory
