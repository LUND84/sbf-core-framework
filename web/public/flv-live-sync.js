export const FLV_SYNC_POLICY = Object.freeze({
  // Keep a continuous playable reserve above one source GOP and one statistics tick.
  // Reason: the measured .533s delivery cadence must not be spent on latency catch-up.
  releaseSeconds: 1.8,
  // Taper toward the reserve instead of retaining 1.2x until a sharp threshold.
  // Reason: timeupdate is coarse and network recovery otherwise overshoots the reserve.
  fullSpeedSeconds: 3, maxRate: 1.2,
  // Hold normal speed briefly after real starvation, without pausing or seeking.
  // Reason: a newly recovered buffer is jitter protection, not immediately expendable backlog.
  recoveryHoldMs: 2000,
});

export class FlvLiveSync {
  constructor(video, now, onRate = () => {}) {
    Object.assign(this, { video, now, onRate, recoveryUntil: 0 });
  }
  setRate(rate) {
    if (this.video.playbackRate === rate) return;
    const previous = this.video.playbackRate;
    this.video.playbackRate = rate; this.onRate(rate, previous);
  }
  recover() { this.recoveryUntil = this.now() + FLV_SYNC_POLICY.recoveryHoldMs; this.setRate(1); }
  reset() { this.recoveryUntil = 0; this.setRate(1); }
  update(ahead) {
    const { releaseSeconds, fullSpeedSeconds, maxRate } = FLV_SYNC_POLICY;
    if (this.video.paused || this.video.readyState < 3 || !Number.isFinite(ahead)
      || ahead <= releaseSeconds || this.now() < this.recoveryUntil) { this.setRate(1); return; }
    const surplus = Math.min(1, (ahead - releaseSeconds) / (fullSpeedSeconds - releaseSeconds));
    // Quantize minor changes. Reason: rewriting pitch/rate at every video frame adds work without useful progress.
    this.setRate(Math.round((1 + surplus * (maxRate - 1)) * 100) / 100);
  }
}
