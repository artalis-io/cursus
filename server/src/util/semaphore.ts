/* A minimal async counting semaphore. `acquire()` resolves when a slot is free
 * (FIFO), returning a release function to call when the work is done. Used to
 * bound concurrent CPU/memory-heavy subprocess work (e.g. dataset admits, each
 * of which holds a geocode + an N^2 travel-matrix build). */
export class Semaphore {
  private slots: number;
  private readonly waiters: Array<() => void> = [];

  constructor(permits: number) { this.slots = Math.max(1, permits); }

  /** Resolves (immediately or when a slot frees) to a one-shot release fn. */
  acquire(): Promise<() => void> {
    return new Promise((resolve) => {
      const grant = (): void => {
        let released = false;
        resolve(() => {
          if (released) return;          // release is idempotent
          released = true;
          const next = this.waiters.shift();
          if (next) next();              // hand the slot straight to the next waiter
          else this.slots++;
        });
      };
      if (this.slots > 0) { this.slots--; grant(); }
      else this.waiters.push(grant);
    });
  }

  get waiting(): number { return this.waiters.length; }
}
