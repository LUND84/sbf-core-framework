import { performance } from 'node:perf_hooks';

const LIMIT = Number.MAX_SAFE_INTEGER;
function count(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError('Media metrics require a nonnegative safe integer');
  }
  return value;
}
function sum(left, right) { return Math.min(LIMIT, left + right); }

// Store only fixed-size numeric aggregates. Reason: diagnostics must not retain media, identities or credentials.
export class MediaMetrics {
  #now;
  #startedAt;
  #lastFragmentAt;
  #state;

  constructor({ now = () => performance.now() } = {}) {
    if (typeof now !== 'function') throw new TypeError('Media metrics require a clock function');
    this.#now = now;
    this.reset();
  }

  #time() {
    const value = this.#now();
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new TypeError('Media metrics clock must return a finite number');
    }
    return value;
  }

  // Call when the broker resets its stream epoch. Reason: counters from different encoder timelines cannot be combined.
  reset() {
    this.#startedAt = this.#time();
    this.#lastFragmentAt = null;
    this.#state = { initBytes: 0, fragments: 0, fragmentBytes: 0, maxFragmentBytes: 0,
      cacheFragments: 0, cacheBytes: 0, pendingHighWater: 0, backpressureCloses: 0 };
  }

  setInitBytes(bytes) { this.#state.initBytes = count(bytes); }

  // Count accepted complete producer fragments, never cache replay. Reason: viewer joins must not inflate source activity.
  recordFragment(bytes) {
    count(bytes);
    const at = this.#time();
    this.#state.fragments = sum(this.#state.fragments, 1);
    this.#state.fragmentBytes = sum(this.#state.fragmentBytes, bytes);
    this.#state.maxFragmentBytes = Math.max(this.#state.maxFragmentBytes, bytes);
    this.#lastFragmentAt = at;
  }

  // Set cache occupancy after eviction. Reason: an arrival can be valid while its oversized fragment leaves no replay cache.
  setCache(fragments, bytes) {
    count(fragments); count(bytes);
    this.#state.cacheFragments = fragments;
    this.#state.cacheBytes = bytes;
  }

  // Sample one viewer's pending bytes; retain only the maximum across viewers in this epoch. Reason: no viewer map is needed.
  recordViewerPending(bytes) {
    this.#state.pendingHighWater = Math.max(this.#state.pendingHighWater, count(bytes));
  }

  // Record an actual backpressure-close decision once at its caller. Reason: storing socket IDs for deduplication is unnecessary.
  recordBackpressureClose() { this.#state.backpressureCloses = sum(this.#state.backpressureCloses, 1); }

  snapshot() {
    const now = this.#time(), state = this.#state;
    // Return copies and clamp elapsed values. Reason: consumers cannot mutate counters or expose negative clock deltas.
    return {
      epoch_elapsed_ms: Math.max(0, now - this.#startedAt), init_bytes: state.initBytes,
      fragments: { count: state.fragments, bytes: state.fragmentBytes, max_bytes: state.maxFragmentBytes,
        last_age_ms: this.#lastFragmentAt === null ? null : Math.max(0, now - this.#lastFragmentAt) },
      cache: { fragments: state.cacheFragments, bytes: state.cacheBytes },
      viewers: { pending_high_water_bytes: state.pendingHighWater, backpressure_closes: state.backpressureCloses },
    };
  }
}
