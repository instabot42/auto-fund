const Path = require('node:path')
const FileSystem = require('node:fs')

class Config {
    constructor() {
        this.all = {}

        // load the config here
        this._loadConfig()
    }

    /**
     * Gets the value of a property from the config
     * Returns the default value if no value is defined
     * @param {*} prop
     * @param {*} def
     * @returns
     */
    get(prop, def) {
        return this._get(this.all, prop, def)
    }

    /**
     * true if the prop has a value defined in the config
     * @param {*} prop
     * @returns
     */
    has(prop) {
        return this._get(this.all, prop) !== undefined
    }

    /**
     * Walks the config tree and recurively digs into it to try and find a specific value
     * @param {*} object
     * @param {*} prop
     * @param {*} def
     * @returns
     */
    _get(object, prop, def) {
        const parts = Array.isArray(prop) ? prop : prop.split('.')
        const name = parts[0]
        const value = object[name]

        if (parts.length <= 1) {
            return value !== undefined ? value : def
        }

        // more levels to dig into
        if (value === null || typeof value !== 'object') {
            return def
        }

        // recurse in a level
        return this._get(value, parts.slice(1), def)
    }

    /**
     * Looks for config files and tries to load them
     */
    _loadConfig() {
        // default to the project ./config path
        const defaultPath = Path.join(process.cwd(), 'config')

        // Look for an override of that and convert to an absolute path
        const dir = this._toAbsPath(this._getArg('NODE_CONFIG_DIR', defaultPath))

        // Is there an app instance defined
        const instance = this._getArg('NODE_APP_INSTANCE')

        // Build a list of possible names
        // default,js, default-1.js, local.js, local-1.js etc
        const allNames = []
        const searchNames = ['default', 'local']
        searchNames.forEach((n) => {
            allNames.push(Path.join(dir, `${n}.js`))
            if (instance) {
                allNames.push(Path.join(dir, `${n}-${instance}.js`))
            }
        })

        // For all the paths we determined, see if we can find a file and load and merge it
        allNames.forEach((f) => {
            try {
                // see if the file can be read
                FileSystem.readFileSync(f)
                const c = require(f)
                Object.assign(this.all, require(f))
            } catch (err) {
                // this file is bad
            }
        })
    }

    /**
     * Find an value in the command line, environment or use the default value give
     * @param {*} paramName
     * @param {*} defaultValue
     * @returns
     */
    _getArg(paramName, defaultValue) {
        return this._getCmdLineArg(paramName) || process.env[paramName] || defaultValue
    }

    /**
     * Look for a command line arg, like this --NAME=value, and return value (or false if there isn't one)
     * @param {*} arg
     * @returns
     */
    _getCmdLineArg(arg) {
        const all = process.argv.slice(2, process.argv.length)
        const name = `--${arg}=`

        for (let i = 0; i < all.length; i++) {
            if (all[i].indexOf(name) === 0) {
                return all[i].substring(name.length)
            }
        }

        return undefined
    }

    // Helper functions shared accross object members
    _toAbsPath(dir) {
        if (dir.indexOf('.') === 0) {
            return Path.join(process.cwd(), dir)
        }

        return dir
    }
}

const config = new Config()

module.exports = config
