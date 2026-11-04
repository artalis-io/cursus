/** Bounded admission includes queue wait in the caller's operation deadline. */
export class ObjectGate {
    active = 0;
    private waiters: Array<{
        grant: () => void;
    }> = [];
    constructor(private limit: number, private queueLimit: number) { }
    get pending(): number { return this.waiters.length; }
    acquire(signal: AbortSignal): Promise<() => void> {
        return new Promise((resolve, reject) => {
            if (signal.aborted) {
                reject(new Error('aborted'));
                return;
            }
            if (this.active >= this.limit && this.pending >= this.queueLimit) {
                reject(new ObjectStoreError('busy'));
                return;
            }
            const abort = () => { this.waiters = this.waiters.filter(w => w !== waiter); reject(new Error('aborted')); };
            const waiter = { grant: () => {
                    signal.removeEventListener('abort', abort);
                    this.active++;
                    let released = false;
                    resolve(() => { if (released)
                        return; released = true; this.active--; this.waiters.shift()?.grant(); });
                } };
            if (this.active < this.limit)
                waiter.grant();
            else {
                this.waiters.push(waiter);
                signal.addEventListener('abort', abort, { once: true });
            }
        });
    }
}
export type ObjectFailure = 'timeout' | 'busy' | 'unavailable' | 'integrity' | 'closed';
export class ObjectStoreError extends Error {
    readonly statusCode: number;
    constructor(readonly code: ObjectFailure) {
        super(code === 'integrity' ? 'Object checksum or immutable metadata mismatch' : `Object storage ${code}`);
        this.name = 'ObjectStoreError';
        this.statusCode = code === 'integrity' ? 502 : 503;
    }
}
