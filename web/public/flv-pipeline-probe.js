// Observe numeric receipts at existing 1.8.2 worker boundaries, without another stream.
// Reason: HTTP speed alone cannot distinguish stash/remux from MSE delivery stalls.
export class FlvPipelineProbe {
  constructor(video, now, ahead) { Object.assign(this, { video, now, ahead }); this.reset(); }
  detach() {
    this.worker?.removeEventListener('message', this.listener);
    this.worker = null; this.listener = null;
  }
  reset() {
    this.detach(); this.started = this.now(); this.mode = 0; this.events = []; this.rawFetch = null;
    const stage = () => ({ count: 0, lastMs: null, maxGapMs: 0, gapsOver750Ms: 0 });
    this.statistics = { ...stage(), downloadMbps: null };
    this.transmux = { ...stage(), endDtsMs: null };
    this.mse = { ...stage(), bufferFullCount: 0 };
    this.playable = { ...stage(), endSeconds: null };
  }
  attach(engine) {
    this.detach(); this.mode = 2; this.rawFetch = null;
    // This private seam is pinned to 1.8.2 and must fail visibly when unavailable.
    // Reason: customLoader functions cannot be structured-cloned into dedicated MSE workers.
    const worker = engine?._player_engine?._worker;
    if (typeof worker?.addEventListener !== 'function' || typeof worker?.removeEventListener !== 'function') return;
    this.worker = worker; this.mode = 1;
    this.listener = event => {
      const packet = event.data;
      if (packet?.msg === 'buffered_position_changed'
        && Number.isFinite(packet.buffered_position_milliseconds) && packet.buffered_position_milliseconds >= 0) {
        this.transmux.endDtsMs = Math.max(this.transmux.endDtsMs ?? 0, packet.buffered_position_milliseconds);
        this.observe(this.transmux, 2);
      } else if (packet?.msg === 'mse_event' && packet.event === 'update_end') {
        this.observe(this.mse, 3); this.observePlayable();
      } else if (packet?.msg === 'mse_event' && packet.event === 'buffer_full') {
        this.mse.bufferFullCount++; this.mark(5);
      }
    };
    worker.addEventListener('message', this.listener);
  }
  elapsed() { return Math.max(0, this.now() - this.started); }
  observe(target, stage) {
    const atMs = this.elapsed();
    if (target.lastMs !== null) {
      const gapMs = Math.max(0, atMs - target.lastMs);
      target.maxGapMs = Math.max(target.maxGapMs, gapMs);
      if (gapMs > 750) { target.gapsOver750Ms++; this.mark(stage); }
    }
    target.count++; target.lastMs = atMs;
  }
  recordStatistics(info) {
    // The opt-in packed loader uses this existing statistics message only.
    // Reason: an uninstrumented or replaced loader must remain explicitly unavailable.
    this.rawFetch = rawFetchNumbers(info?.rawFetch);
    this.statistics.downloadMbps = Number.isFinite(info?.speed) && info.speed >= 0 ? info.speed * 1024 * 8 / 1e6 : null;
    this.observe(this.statistics, 1);
    this.observePlayable();
  }
  observePlayable() {
    const ahead = this.ahead(), position = this.video.currentTime;
    if (!Number.isFinite(ahead) || ahead <= 0 || !Number.isFinite(position)) return;
    const end = position + ahead;
    if (this.playable.endSeconds === null || end > this.playable.endSeconds + .0005) {
      this.playable.endSeconds = end; this.observe(this.playable, 6);
    }
  }
  mark(stage) {
    const numeric = value => Number.isFinite(value) && value >= 0 ? value : null;
    // Retain only sixteen numeric boundary observations; never worker media/log payloads.
    // Reason: diagnostics must stay bounded and cannot disclose content or private URLs.
    this.events.push({ stage, atMs: this.elapsed(), currentTime: numeric(this.video.currentTime),
      aheadSeconds: numeric(this.ahead()), downloadMbps: this.statistics.downloadMbps,
      transmuxEndDtsMs: this.transmux.endDtsMs, playableEndSeconds: this.playable.endSeconds });
    if (this.events.length > 16) this.events.shift();
  }
  snapshot() {
    // Mixed audio/video positions and update_end include cleanup, not just append.
    // Reason: receipt intervals must not be mislabeled raw-fetch or per-append duration.
    return { mode: this.mode, rawFetchAvailable: this.rawFetch !== null, rawFetch: this.rawFetch ? { ...this.rawFetch } : null,
      appendDurationAvailable: false,
      statistics: { ...this.statistics }, transmux: { ...this.transmux }, mse: { ...this.mse },
      playable: { ...this.playable }, events: this.events.map(event => ({ ...event })) };
  }
}
import { rawFetchNumbers } from '../shared/raw-fetch-fields.js';

