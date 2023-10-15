# Auto Fund

A simple bot to save your funding costs on Bitfinex.

If you have an open margin position that has borrowed funds from the funding book, you may be paying higher interest rates than are currently available in the market.

This bot will scan all the borrowings you have and compare them to the best available rates currently on the market. If your most expensive funding can be replaced with something cheaper, it will auto-borrow the cheaper funding and return the expensive funding.

Ideally this will keep your funding costs down and minimise the rates you pay.

The bot will continue to check at an interval of your choice to ensure you can make the most of any cheap funding that turns up.

By default the bot will run in 'Dry Run' mode, where it won't actually make any changes to your account. You will have to change this settings in the config to allow the bot to make changes. Useful for the initial run, or to just give you an idea of what it would be doing with your funding...

You will need to create some API keys on Bitfinex to use this.
The keys will need the following permissions from the Margin Funding section...

* 'Get Funding statuses and info' permission to get your existing funding
* 'Offer, cancel and close funding' if you want to allow the bot to replace expensive funding with cheaper offers. You don't need this permission if you are just running in 'dryRun' mode.


To use it...

```

Install dependencies with `npm ci`

Copy `config/default.js` to `config/local.js`

Edit `config/local.js` and add your Bitfinex API keys and adjust any other settings.

Start the app using `npm run debug`

The logs will show the steps being taken

```