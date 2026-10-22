export const PlaybackWork = Object.freeze({ POLICY: 1, MEDIA: 2, PLAY: 4, LIVE: 8,
  NATIVE_PLAY: 16, PLAYING: 32, WAITING: 64, PAUSE: 128 });

// One owner and a fixed bitmask, never an unbounded callback queue.
// Reason: reentrant native/MSE events must merge work instead of nesting pause/play/append operations.
export class PlaybackScheduler {
  #run;
  #enqueue;
  #yieldTask;
  #cancelTask;
  #yieldHandle = null;
  #ticket = 0;
  #pending = 0;
  #running = false;
  #scheduled = false;
  #generation = 0;
  #notifications = 0;
  #turns = 0;
  // Preserve the browser host receiver at every deferred-work boundary.
  // Reason: private-field calls bind this to the scheduler, which Window APIs reject.
  constructor(run, { enqueue = callback => globalThis.queueMicrotask(callback),
    yieldTask = callback => globalThis.setTimeout(callback, 0),
    cancelTask = handle => globalThis.clearTimeout(handle) } = {}) {
    this.#run = run; this.#enqueue = enqueue; this.#yieldTask = yieldTask; this.#cancelTask = cancelTask;
  }
  dispatch(work, deferred = false) {
    if (!Number.isInteger(work) || work <= 0 || work & ~255) throw new RangeError('PLAYBACK_WORK');
    this.#notifications += 1; this.#pending |= work;
    if (this.#running) return;
    if (deferred) this.#schedule();
    else this.#drain();
  }
  #schedule(yieldToBrowser = false) {
    if (this.#scheduled && (!yieldToBrowser || this.#scheduled === 'task')) return;
    this.#scheduled = yieldToBrowser ? 'task' : 'microtask';
    const generation = this.#generation;
    const ticket = ++this.#ticket;
    const callback = () => {
      if (generation !== this.#generation || ticket !== this.#ticket) return;
      this.#scheduled = false; this.#yieldHandle = null; this.#drain();
    };
    if (yieldToBrowser) this.#yieldHandle = this.#yieldTask(callback);
    else this.#enqueue(callback);
  }
  #drain() {
    if (this.#running || !this.#pending) return;
    this.#running = true;
    const generation = this.#generation;
    try {
      // Bound synchronous work even if an adapter emits events inline.
      // Reason: MSE ordering is serial, but a long ready queue must still yield to the browser.
      for (let budget = 0; budget < 2 && this.#pending && generation === this.#generation; budget++) {
        const work = this.#pending; this.#pending = 0; this.#turns += 1; this.#run(work);
      }
    } finally {
      this.#running = false;
      if (this.#pending) this.#schedule(true);
    }
  }
  reset() {
    this.#generation += 1; this.#pending = 0; this.#scheduled = false;
    this.#ticket += 1;
    if (this.#yieldHandle !== null) this.#cancelTask(this.#yieldHandle);
    this.#yieldHandle = null;
    this.#notifications = this.#turns = 0;
  }
  snapshot() { return { notifications: this.#notifications, turns: this.#turns, pendingMask: this.#pending }; }
}
