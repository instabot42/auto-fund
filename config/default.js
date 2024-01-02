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

    // How often should an update be logged to the console
    interval: 3 * 60 * 1000,

    // Make a sound (via ascii bell character) when attempting to borrow funds
    soundOnChange: true,

    // Only replace funding if we can get a better rate by at least this much
    // This will be used with the daily interest rate.
    // For example 0.018% a day (6.57% a year) is expressed at 0.00018 in the API
    // though shown as a percentage in the Bitfinex UI at 0.018
    minImprovement: 0.0000005,

    // The min amount to borrow in a single transaction (to avoid fragmenting your borrowing)
    // this is in units of the borrowing currency (eg fUSD in this config above)
    minBorrowSize: 150,

    // when set to true, no new borrowing will be taken out and no existing borrowing will be returned
    // Setting this to on will ensure that the bot makes no changes to your account
    // it will still report to you, in the logs, what it would have done.
    // Ideally have this true the first time you run it, so you can see what would happen
    dryRun: true,

    // Should wallet balance and position summaries be shown in output
    // set to false to skip showing the wallet and position summaries
    showWalletPosition: true,

    // Which strategy should be used to replace funds. Can be one of...
    // 'replace' - look for new funding offers that are cheaper and try and take them
    // 'target' - Aim to get all borrowing under a target rate, and then move to a cheaper rate.
    // Target is more stable. It replaces very expensive funding quickly and then works the rest down gradually.
    strategy: 'target',

    target: {
        // The target rates to reach for 'target' mode. These are floats and are annual percentage amount
        // so 8.5 is 8.5% per year, or 0.023287% per day (what you see on Bitfinex), or 0.00023287 as the raw rate used in the API
        // When in target mode, the bot will first attempt to get all borrowing below the first figure, then the next figure and so on.
        // initially this can go quickly as the funding is likely to be available. As you get to cheaper rates, it becomes less likely
        // to get your bids filled and you'll essentially end up with the best possible rates at the time
        rates: [10, 9, 8.75, 8.5, 8.4, 8.3, 8.2, 8.1, 8, 7.9, 7.5, 7, 6.5],
    }
}
