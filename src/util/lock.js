
/**
 * Simple async lock. Usage
 * const lock = new Lock()
 *
 * // start some task
 * lock.runLocked(async () => doSomeAsyncTaskThatWillNotResolveForAWhile())
 *
 * // queue up another task that will only start when the first one is done
 * lock.runLocked(async () => doSomeAsyncTaskThatWillNotResolveForAWhile())
 *
 * This can be used to serialise tasks that might otherwise overlap
 */
class Lock {
    constructor() {
        this.locked = false;
        this.waiting = [];
    }

    async runLocked(fn) {
        try {
            await this.lock();
            const res = await fn();
            await this.unlock();

            return res;
        } catch (err) {
            await this.unlock();
            throw err;
        }
    }

    async lock() {
        if (this.locked) {
            await this._waitForLock();
        }

        this.locked = true;
    }

    async unlock() {
        if (this.waiting.length > 0) {
            const resolve = this.waiting.shift();
            resolve();
        } else {
            this.locked = false;
        }
    }

    async _waitForLock() {
        return new Promise(resolve => this.waiting.push(resolve));
    }
}

module.exports = Lock;
