const STATES = new Set(['live', 'stopped', 'unavailable']);

export class LivePlaybackControl {
  constructor({ player, video, fetchImpl = (...args) => fetch(...args), onState = () => {},
    onUnauthorized = () => {}, canPlay = () => true, intervalMs = 1000, timeoutMs = 1500,
    setTimer = (fn, delay) => setTimeout(fn, delay), clearTimer = id => clearTimeout(id) }) {
    Object.assign(this, { player, video, fetchImpl, onState, onUnauthorized, canPlay,
      intervalMs, timeoutMs, setTimer, clearTimer });
    this.state = 'unavailable'; this.checkedAtMs = null; this.timer = null;
    this.running = false; this.generation = 0; this.pending = null; this.abort = null;
  }
  snapshot() { return { state: this.state, checkedAtMs: this.checkedAtMs }; }
  isLive() { return this.running && this.state === 'live' && this.canPlay(); }
  clearMedia() {
    if (typeof this.player.setBroadcastLive === 'function') this.player.setBroadcastLive(false);
    else this.player.clear();
    this.video.pause?.();
    if ('srcObject' in this.video) this.video.srcObject = null;
    this.video.removeAttribute?.('src');
    this.video.load?.();
  }
  apply(state, checkedAtMs = null) {
    const previous = this.state;
    this.state = state; this.checkedAtMs = checkedAtMs;
    this.onState(this.snapshot());
    if (state !== 'live' || !this.canPlay()) {
      if (previous === 'live' || this.player.started !== null || this.video.src || this.video.srcObject) this.clearMedia();
      if (typeof this.player.setBroadcastLive === 'function') this.player.setBroadcastLive(false);
      return;
    }
    this.player.setBroadcastLive?.(true);
    if (previous !== 'live') this.player.start?.();
  }
  start() {
    if (this.running) return;
    this.running = true; this.generation++; this.clearMedia();
    this.onState(this.snapshot());
    void this.refresh();
  }
  refresh() {
    if (!this.running) return Promise.resolve(this.snapshot());
    if (this.pending) return this.pending;
    const generation = this.generation;
    this.clearTimer(this.timer); this.timer = null;
    const controller = new AbortController(); this.abort = controller;
    let timeout;
    const operation = (async () => {
      try {
        const response = await Promise.race([
          this.fetchImpl('/api/flv/status', { method: 'GET', credentials: 'same-origin', cache: 'no-store', signal: controller.signal }),
          new Promise((_, reject) => { timeout = this.setTimer(() => {
            controller.abort(); reject(new Error('LIVE_STATUS_TIMEOUT'));
          }, this.timeoutMs); }),
        ]);
        if (generation !== this.generation || !this.running) return this.snapshot();
        if (response.status === 401) this.onUnauthorized();
        if (!response.ok) throw new Error('LIVE_STATUS_UNAVAILABLE');
        const value = await response.json();
        if (generation !== this.generation || !this.running) return this.snapshot();
        if (value?.schema !== 'sbf-live-playback-v1' || !STATES.has(value.state)
          || !Number.isSafeInteger(value.checkedAtMs) || value.checkedAtMs < 0) throw new Error('LIVE_STATUS_INVALID');
        this.apply(value.state, value.checkedAtMs);
      } catch {
        if (generation === this.generation && this.running) this.apply('unavailable');
      } finally {
        this.clearTimer(timeout);
        if (this.abort === controller) this.abort = null;
        if (generation === this.generation && this.running) {
          this.timer = this.setTimer(() => { this.timer = null; void this.refresh(); }, this.intervalMs);
        }
      }
      return this.snapshot();
    })();
    this.pending = operation;
    void operation.finally(() => { if (this.pending === operation) this.pending = null; });
    return operation;
  }
  close() {
    this.running = false; this.generation++; this.abort?.abort(); this.abort = null;
    this.clearTimer(this.timer); this.timer = null; this.pending = null;
    this.state = 'unavailable'; this.clearMedia();
  }
}
