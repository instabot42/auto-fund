# Auto Fund

A simple bot to save your funding costs on Bitfinex.

If you have an open margin position that has borrowed funds from the funding book, you may be paying higher interest rates than are currently available in the market.

This bot will scan all the borrowings you have and compare them to the best available rates currently on the market. If your most expensive funding can be replaced with something cheaper, it will auto-borrow the cheaper funding and return the expensive funding.

Ideally this will keep your funding costs down and minimise the rates you pay.

The bot will monitor the funding market, capturing any opportunities it can.

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

*soundOnChange* A flag (true or false). If true, a 'Bing' will sound, via the ascii bell character, whenever the bot wants to borrow some funds. This
will happen in dry run mode too, so you can use the bot as a tool to just notify you when cheaper funding is available in the order book. defaults to true.

*interval* Determines how often the bot will log out a summary. The number is in milliseconds.

*minImprovement* How much better should the funding rate be before the bot will bother trying to make a change. The bot will query your most expensive in-use funding rate and subtract this value from it, to get a target rate. It will then look for available funding at a rate lower than this target value.

*minBorrowSize* What is the smallest amount the bot is allowed to ask for when looking to change some funding. This is in units of the funding currency in use and defaults to 150. The exchange has a min order size of around $150 equivalent.


*strategy* Can be one of 'replace' or 'target'. Defaults to 'target'. This determines which method is used to lowering borrowing costs.
Replace looks out for cheap offers on the order book and trys to grab them instantly and use them to replace more expensive borrows.
Target finds existing borrows that are over some target rate, places an order to replace them all at the target rate, and waits for it to fill. See the 'rates' list below.

*target.rates* is an array of rates used by the 'target' strategy only.
These are the yearly interest rates, so 8.75 represents 8.75% a year, (0.024% a day, or around 0.00024 as used in the API).
The values should be provided in order from highest rate to lowest rate. The bot will first try and replace anything more expensive than the first rate. Only if there is nothing more expensive will it move on to the second rate, the third and so on. This way, it is possible to fairly quickly move away from very high FRR rates to something resonable, then spend time trying to ease this borrowing lower and lower.


### Running the bot

When your settings are good, you can run the bot using...

```
npm run debug
```

This will produce a fair amount of logging to show you progress.

