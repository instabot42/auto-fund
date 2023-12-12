const chalk = require('chalk')

const colours = {
    base: chalk.cyan,
    number: chalk.green,
    operator: chalk.whiteBright.bold,
    separator: chalk.white,
    break: chalk.whiteBright.bold,
    bool: chalk.hex('#bd93f9'),
    string: chalk.hex('#ffb86c'),
    date: chalk.yellowBright,
    prefix: chalk.hex('#ff79c6'),
    comment: chalk.gray,
}

/**
 * The formats to look for
 */
const formats = [
    {
        name: 'comment',
        regex: /(##.*$)/,
        wrap: colours.comment,
    },
    {
        name: 'date',
        regex: /([a-z]{3} [a-z]{3} [0-9]{2} [0-9]{4} [0-9:]{8} [a-z]{3}[0-9+]+)/i,
        wrap: colours.date,
    },
    {
        name: 'quote',
        regex: /("[^"]*")/,
        wrap: colours.string,
    },
    {
        name: 'operators',
        regex: /([.()%,{}[\]]+)/,
        wrap: colours.operator,
    },
    {
        name: 'maths',
        regex: /([<>!@$&+*//=-]+)/,
        wrap: colours.separator,
    },
    {
        name: 'colon',
        regex: /([:]+)/,
        wrap: colours.break,
    },
    {
        name: 'number',
        regex: /([0-9]+)/,
        wrap: colours.number,
    },
    {
        name: 'bool',
        regex: /(true|false)/i,
        wrap: colours.bool,
    },
]

/**
 * Convert a message to something we can display
 * @param msg
 * @returns {string}
 */
function toMsg(msg) {
    try {
        if (msg === undefined) {
            return '[undefined]'
        }

        if (msg === null) {
            return 'null'
        }

        if (msg instanceof Error) {
            return msg.message
        }

        if (typeof msg === 'string') {
            return msg
        }

        return JSON.stringify(msg, null, 2)
    } catch (err) {
        return `[error formatting - ${err.message}]`
    }
}

/**
 * Given a string and the format to apply, try and do that
 * @param {*} str
 * @param {*} i
 * @returns
 */
function formatString(str, i) {
    // Have we done them all?
    if (i >= formats.length) {
        return str
    }

    // Get the format we are applying now
    const fmt = formats[i]
    const out = []

    // split the text up into parts
    const parts = str.split(fmt.regex)
    parts.forEach((s) => {
        // if this part matched the regex, wrap it
        if (fmt.regex.test(s)) {
            out.push(fmt.wrap(s))
        } else {
            // No match on this part, so try and match with later formats
            out.push(formatString(s, i + 1))
        }
    })

    return out.join('')
}

/**
 * Colour code up a string and add a prefix to it
 * @param {*} prefix
 * @param {*} value
 */
function syntaxColour(prefix, value) {
    // convert to a string
    let str = toMsg(value)

    // prefix all the lines
    const lines = str.split('\n')
    console.log(
        lines
            .map((l) => formatString(l, 0))
            .map((l) => `${colours.prefix(prefix)}: ${colours.base(l)}`)
            .join('\n')
    )
}

function logger(prefix) {
    return function () {
        for (var i = 0; i < arguments.length; i++) {
            syntaxColour(prefix, arguments[i])
        }
    }
}

module.exports = logger
