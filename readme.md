# Auto Fund

A simple bot to save your funding costs on Bitfinex.

If you have an open margin position that has borrowed funds from the funding book, you may be paying higher interest rates than are currently available in the market.

This bot will scan all the borrowings you have and compare them to the best available rates currently on the market. If your most expensive funding can be replaced with something cheaper, it will auto-borrow the cheaper funding and return the expensive funding.

Ideally this will keep your funding costs down and minimise the rates you pay.

The bot will continue to check at an interval of your choice to ensure you can make the most of any cheap funding that turns up.

### Setup

Clone the repo and switch to the repos folder...

```
git clone https://github.com/instabot42/auto-fund.git
cd auto-fund
```

Install dependencies...

```
npm ci
```

Set up your config...

```
cp config/default.js config/local.js
```

edit `config/local.js` in any editor. You will need a set of API keys from Bitfinex, so the bot can manage your funding. These API keys only need very limited permissions, so create the keys with only the following permissions...

* 'Get Funding statuses and info' permission so the bot can find out about your current open funding.
* 'Offer, cancel and close funding', so the bot can adjust your funding. Note: this permission is not needed if you are running in 'dry run' mode (see below)

Put the new key and secret into the `local.js` config file.

### Dry Run Mode

By default the bot will operate in Dry Run mode. When this mode is enabled, the bot will not make any changes to your account. It is essentially in read only mode (and you can use API keys that only have read permission). When running in this mode it will report the status of your funding and indicate what it would have done if it had permission, so you can review it.

When you want to run the bot for real, edit `local.js` and change `dryRun` to false.

### Other Settings

*interval* Determines how often the bot will attempt to adjust your funding. It defaults to once a minute. The number is in milliseconds.

*minImprovement* How much better should the funding rate be before the bot will bother trying to make a change.

### Running the bot

When your settings are good, you can run the bot using...

```
npm run debug
```

This will produce a fair amount of logging to show you progress.

