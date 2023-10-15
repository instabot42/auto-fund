
/**
 * Copy this file to config/local.js (which is not under source control)
 *
 * Add your API keys and change any other settings you like to the copy
 */

module.exports = {
    bitfinex: {
        // API key and secret
        key: '',
        secret: '',

        // The symbol that borrowing will be monitor on
        symbol: 'fUSD',
    },

    // How often should the funding be updated (in ms). Defaults to 10m
    // Should be > 1m
    interval: 19 * 60 * 1000,

    // when set to true, no new borrowing will be taken out and no existing borrowing will be returned
    // Setting this to on will ensure that the bot makes no changes to your account
    // it will still report to you, in the logs, what it would have done.
    // Ideally have this true the first time you run it, so you can see what would happen
    dryRun: true,
}
