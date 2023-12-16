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

        // true to cancel all pending funding offers (orders in the book to borrow)
        // This ensures the bot isn't going to see funding taken out unexpectadly.
        // Occasionally when the bot asks to borrow at a rate, the offer is removed before
        // the order can be executed, which results in the offer sitting on the book waiting to fill.
        // By having this set to true, such orders are auto cleaned up.
        // Set this to false if you intend to manually add orders to the orderbook for some reason, and want them left along
        cancelPendingOffers: true,
    },

    // How often should the funding be updated (in ms). Defaults to 1m
    // Should be >= 1m
    interval: 1 * 60 * 1000,

    // Only replace funding if we can get a better rate by at least this much
    // This will be used with the daily interest rate.
    // For example 0.018% a day (6.57% a year) is expressed at 0.00018 in the API
    // though shown as a percentage in the Bitfinex UI at 0.018
    minImprovement: 0.00000001,

    // The min amount to borrow in a single transaction (to avoid fragmenting your borrowing)
    // this is in units of the borrowing currency (eg fUSD in this config above)
    minBorrowSize: 150,

    // when set to true, no new borrowing will be taken out and no existing borrowing will be returned
    // Setting this to on will ensure that the bot makes no changes to your account
    // it will still report to you, in the logs, what it would have done.
    // Ideally have this true the first time you run it, so you can see what would happen
    dryRun: true,
}
