module.exports = {
    /**
     * PM2 Process Manager configuration section
     * Use `pm2 start stack.config.js`
     * https://www.npmjs.com/package/pm2
     * http://pm2.keymetrics.io/docs/usage/application-declaration/
     */
    apps: [
        {
            name: 'autofund',
            script: './src/index.js',
            env: { 'DEBUG': 'autoFund:*' },
            instances: 1,
            exec_mode: 'fork',
            min_uptime: '5s',
            max_restarts: 10,
            kill_timeout: 30000,
            args: ['--color'],
        },
    ],
}
