const STALL_MS = 10_000;
const COOLDOWN_MS = 15_000;

export class StreamWatchdog {
  constructor({ now = () => performance.now() } = {}) {
    this.now = now;
    this.lastRecoveryAt = -Infinity;
    this.reset();
  }

  reset() {
    this.lastBytes = null;
    this.lastProgressAt = this.now();
    this.errorSince = null;
    // Preserve recovery cooldown across reconnects and epochs to prevent retry loops.
  }

  sample({ online, streamReady, receivedBytes, bufferAheadSeconds, state }) {
    const now = this.now();
    if (!online || !streamReady || state === 'paused' || state === 'blocked'
      || !Number.isFinite(receivedBytes) || receivedBytes < 0) {
      this.reset();
      return false;
    }
    // Any counter change includes a new epoch; a single init still times out without media.
    if (receivedBytes !== this.lastBytes) {
      this.lastBytes = receivedBytes;
      this.lastProgressAt = now;
    }
    if (state === 'error') this.errorSince ??= now;
    else this.errorSince = null;
    const starved = now - this.lastProgressAt >= STALL_MS
      && Number.isFinite(bufferAheadSeconds) && bufferAheadSeconds < 0.5;
    const errored = this.errorSince !== null && now - this.errorSince >= STALL_MS;
    if ((!starved && !errored) || now - this.lastRecoveryAt < COOLDOWN_MS) return false;
    this.lastRecoveryAt = now;
    this.reset();
    return true;
  }
}
