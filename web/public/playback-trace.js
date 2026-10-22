// Keep only 24 numeric state samples. Reason: the diagnostic must remain bounded and never retain chat, URLs, headers, or identities.
const CAPACITY = 24;
const REASONS = new Set([
  'waiting', 'waiting-ignored', 'waiting-seeking', 'pause-waiting', 'pause-low-water',
  'pause-no-buffer', 'pause-playing-gate', 'pause-startup', 'pause-rebuffer',
  'play-call', 'play-abort', 'seek-join', 'seek-lag', 'seek-quota',
  'trim-start', 'trim-end', 'seeking', 'seeked', 'playing', 'pause-event',
]);

function number(value) { return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null; }
function flag(value) { return typeof value === 'boolean' ? value : null; }
function ready(value) { return Number.isInteger(value) && value >= 0 && value <= 4 ? value : null; }
function clock() { return globalThis.performance.now(); }

export class PlaybackTrace {
  #now;
  #start;
  #elapsed;
  #events;
  constructor({ now = clock } = {}) {
    if (typeof now !== 'function') throw new TypeError('TRACE_CLOCK');
    this.#now = now;
    this.reset();
  }

  // Reset without recording an epoch identifier. Reason: relative ordering is sufficient and a replaced source must not inherit old events.
  reset() {
    this.#start = number(this.#now());
    this.#elapsed = 0;
    this.#events = [];
  }

  record(reason, video = {}, context = {}) {
    // Accept fixed reasons, not caller text. Reason: diagnostic rendering must not become a route for chat, URLs, or error payloads.
    if (!REASONS.has(reason)) throw new RangeError('TRACE_REASON');
    const instant = number(this.#now());
    const delta = instant === null || this.#start === null ? this.#elapsed : Math.max(0, instant - this.#start);
    this.#elapsed = Math.max(this.#elapsed, delta);
    const event = {
      elapsedMs: this.#elapsed,
      currentTime: number(video?.currentTime),
      readyState: ready(video?.readyState),
      paused: flag(video?.paused),
      seeking: flag(video?.seeking),
      bufferAheadSeconds: number(context?.ahead),
      lagSeconds: number(context?.lag),
      reason,
      // Optional positions explain trim/seek ordering without storing media. Reason: ready1 alone cannot attribute a stall to buffer removal or seeking.
      removeStartSeconds: number(context?.removeStart),
      removeEndSeconds: number(context?.removeEnd),
      seekTargetSeconds: number(context?.seekTarget),
    };
    if (this.#events.length === CAPACITY) this.#events.shift();
    this.#events.push(event);
    return { ...event };
  }

  snapshot() { return this.#events.map(event => ({ ...event })); }
}

export function formatPlaybackTrace(event = {}) {
  if (!REASONS.has(event.reason)) throw new RangeError('TRACE_REASON');
  const seconds = value => number(value) === null ? '—' : `${value.toFixed(3)}s`;
  const boolean = value => typeof value === 'boolean' ? (value ? '1' : '0') : '—';
  const state = ready(event.readyState);
  const fields = [
    `[playback-trace] t=${seconds(number(event.elapsedMs) === null ? null : event.elapsedMs / 1000)}`,
    `video=${seconds(event.currentTime)}`, `ready=${state ?? '—'}`,
    `paused=${boolean(event.paused)}`, `seeking=${boolean(event.seeking)}`,
    `ahead=${seconds(event.bufferAheadSeconds)}`, `lag=${seconds(event.lagSeconds)}`,
    `reason=${event.reason}`,
  ];
  if (number(event.removeStartSeconds) !== null || number(event.removeEndSeconds) !== null)
    fields.push(`remove=${seconds(event.removeStartSeconds)}..${seconds(event.removeEndSeconds)}`);
  if (number(event.seekTargetSeconds) !== null) fields.push(`seekTo=${seconds(event.seekTargetSeconds)}`);
  return fields.join(' ');
}
