import { rawFetchNumbers } from '../shared/raw-fetch-fields.js';

// Require a sustained observed outage, not low playback reserve or one late sample.
// Reason: startup, tab resumption and main-thread throttling can delay statistics delivery.
export const FLV_INGEST_WATCHDOG_POLICY = Object.freeze({
  startupGraceMs: 15000, stallMs: 10000, resumeGraceMs: 5000, maxObservationGapMs: 3000,
});

export class FlvIngestWatchdog {
  constructor(now) { this.now = now; this.clear(); }
  clear() {
    this.active = false; this.fired = false; this.mode = 'unavailable';
    this.lastCounters = null; this.lastObservationAt = null; this.progressAt = null; this.graceUntil = null;
  }
  attach() {
    this.clear(); this.active = true;
    this.progressAt = this.now(); this.graceUntil = this.progressAt + FLV_INGEST_WATCHDOG_POLICY.startupGraceMs;
  }
  defer(at = this.now()) {
    if (!this.active) return;
    this.progressAt = at; this.lastObservationAt = at;
    this.graceUntil = Math.max(this.graceUntil, at + FLV_INGEST_WATCHDOG_POLICY.resumeGraceMs);
  }
  observe(input, { suppressed = false } = {}) {
    if (!this.active || this.fired) return false;
    const at = this.now();
    if (!Number.isFinite(at)) return false;
    if (this.lastObservationAt !== null && (at < this.lastObservationAt
      || at - this.lastObservationAt > FLV_INGEST_WATCHDOG_POLICY.maxObservationGapMs)) this.defer(at);
    this.lastObservationAt = at;
    const raw = rawFetchNumbers(input);
    // Without pinned raw counters, retain the library's normal error/EOF recovery.
    // Reason: cached speed, repeated statistics and MSE activity cannot prove ingress health or failure.
    if (!raw) { this.lastCounters = null; this.progressAt = at; this.mode = 'unavailable'; return false; }
    const prior = this.lastCounters;
    if (!prior || raw.count < prior.count || raw.totalBytes < prior.totalBytes) this.defer(at);
    // Only actual received bytes advance liveness; empty reads and frozen read-age do not.
    // Reason: the reported failure kept publishing the same cached statistics while receiving no media.
    else if (raw.totalBytes > prior.totalBytes) this.progressAt = at;
    this.lastCounters = { count: raw.count, totalBytes: raw.totalBytes }; this.mode = 'raw';
    if (suppressed) { this.defer(at); return false; }
    if (at < this.graceUntil || at - this.progressAt < FLV_INGEST_WATCHDOG_POLICY.stallMs) return false;
    // Fire once per engine; only replacement attach rearms this guard.
    // Reason: a stuck worker must not accumulate reconnect timers or discard session failure counters.
    this.fired = true; this.mode = 'recovering'; return true;
  }
}
