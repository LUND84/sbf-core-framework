import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';

const TTL_MS = 120000, MAX_TABS = 16, RECORDS = 8, MIN_INTERVAL_MS = 2000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const COUNT = Number.MAX_SAFE_INTEGER, TIME_MS = 366 * 86400000;
const counts = ['receivedBytes', 'queuedBytes', 'totalVideoFrames', 'droppedVideoFrames',
  'waitingEvents', 'ignoredStaleWaiting', 'programPauseCalls', 'playCalls', 'autoSeekCalls'];
const times = ['epochElapsedMs', 'firstDataMs', 'firstPlayingMs'];
const seconds = ['bufferAheadSeconds', 'bufferSeconds', 'lag', 'currentTime'];
const booleans = ['paused', 'seeking', 'hasData'];
const enums = { routeClass: ['main', 'alternate'], connection: ['connecting', 'open', 'closed'],
  visibility: ['visible', 'hidden', 'prerender'], state: ['idle', 'buffering', 'playing', 'paused', 'blocked', 'error'] };
const keys = ['tabId', 'seq', 'perfNowMs', 'elapsedMs', 'connectionIndex', 'connectionElapsedMs',
  'epochIndex', 'readyState', ...counts, ...times, ...seconds, ...booleans, ...Object.keys(enums)];

function error(statusCode, message) { throw Object.assign(new Error(message), { statusCode }); }
function numeric(value, max, integer = false, nullable = false) {
  return (nullable && value === null) || (typeof value === 'number' && Number.isFinite(value)
    && value >= 0 && value <= max && (!integer || Number.isSafeInteger(value)));
}

function validate(body) {
  // Admit exact fields, never caller labels or traces. Reason: this memory store must not become a channel for private text or identities.
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).length !== keys.length || keys.some(key => !Object.hasOwn(body, key))
    || Object.keys(body).some(key => !keys.includes(key)) || typeof body.tabId !== 'string'
    || !UUID.test(body.tabId)) error(400, 'PLAYBACK_REPORT_FIELDS');
  for (const key of ['seq', 'connectionIndex', 'epochIndex'])
    if (!numeric(body[key], COUNT, true)) error(400, 'PLAYBACK_REPORT_NUMBER');
  for (const key of ['perfNowMs', 'elapsedMs', 'connectionElapsedMs'])
    if (!numeric(body[key], TIME_MS)) error(400, 'PLAYBACK_REPORT_TIME');
  for (const key of times)
    if (!numeric(body[key], TIME_MS, false, true)) error(400, 'PLAYBACK_REPORT_TIME');
  for (const key of counts)
    if (!numeric(body[key], COUNT, true, ['totalVideoFrames', 'droppedVideoFrames'].includes(key)))
      error(400, 'PLAYBACK_REPORT_COUNT');
  for (const key of seconds)
    if (!numeric(body[key], key === 'currentTime' ? 366 * 86400 : 3600, false, key === 'lag' || key === 'currentTime'))
      error(400, 'PLAYBACK_REPORT_SECONDS');
  if (!numeric(body.readyState, 4, true, true)) error(400, 'PLAYBACK_REPORT_READY');
  for (const key of booleans)
    if (typeof body[key] !== 'boolean' && !(key !== 'hasData' && body[key] === null)) error(400, 'PLAYBACK_REPORT_BOOLEAN');
  for (const [key, values] of Object.entries(enums))
    if (!values.includes(body[key])) error(400, 'PLAYBACK_REPORT_STATE');
  return Object.fromEntries(keys.map(key => [key, body[key]]));
}

function sourceContext(status, wallNow) {
  const safe = value => numeric(value, COUNT) ? value : null;
  return { receivedAtUnixMs: wallNow,
    streamEpochHash: typeof status?.stream?.epoch === 'string'
      ? createHash('sha256').update(status.stream.epoch).digest('hex').slice(0, 12) : null,
    sourceFragmentCount: safe(status?.media?.fragments?.count),
    sourceAgeMs: safe(status?.media?.fragments?.last_age_ms),
    viewerPendingHighWaterBytes: safe(status?.media?.viewers?.pending_high_water_bytes),
    viewerBackpressureCloses: safe(status?.media?.viewers?.backpressure_closes) };
}

// In-memory bounds are independent of viewer/worker media. Reason: diagnostics must not retain identities or grow without limit.
export class PlaybackReports {
  #tabs = new Map();
  #now;
  #wallNow;
  #timer = null;
  #setTimer;
  #clearTimer;
  constructor({ now = () => performance.now(), wallNow = Date.now,
    setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    this.#now = now; this.#wallNow = wallNow;
    this.#setTimer = setTimer; this.#clearTimer = clearTimer;
  }
  #prune(now) {
    for (const [id, tab] of this.#tabs) {
      tab.records = tab.records.filter(record => now - record.at < TTL_MS);
      if (now - tab.lastAt >= TTL_MS) this.#tabs.delete(id);
    }
  }
  #schedule(now) {
    if (this.#timer !== null) this.#clearTimer(this.#timer);
    this.#timer = null;
    if (!this.#tabs.size) return;
    const earliest = Math.min(...[...this.#tabs.values()].map(tab => tab.records[0].at));
    // Expire without another request, using one owned timer. Reason: an abandoned tab must not leave diagnostic records retained indefinitely.
    this.#timer = this.#setTimer(() => {
      this.#timer = null;
      const at = this.#now(); this.#prune(at); this.#schedule(at);
    }, Math.max(1, earliest + TTL_MS - now));
    this.#timer?.unref?.();
  }
  add(body, status = {}) {
    const report = validate(body), now = this.#now();
    this.#prune(now);
    let tab = this.#tabs.get(report.tabId);
    if (!tab) {
      if (this.#tabs.size >= MAX_TABS) error(429, 'PLAYBACK_REPORT_CAPACITY');
      tab = { lastAt: -Infinity, accepted: [], records: [] };
    }
    tab.accepted = tab.accepted.filter(at => now - at < 60000);
    // Use both a spacing floor and a rolling minute. Reason: synchronized timers or boundary bursts must not exceed thirty admissions per tab.
    if (now - tab.lastAt < MIN_INTERVAL_MS || tab.accepted.length >= 30) error(429, 'PLAYBACK_REPORT_RATE');
    tab.lastAt = now; tab.accepted.push(now);
    tab.records.push({ at: now, report: { ...report, server: sourceContext(status, this.#wallNow()) } });
    if (tab.records.length > RECORDS) tab.records.shift();
    this.#tabs.set(report.tabId, tab);
    this.#schedule(now);
  }
  snapshot() {
    const now = this.#now(); this.#prune(now); this.#schedule(now);
    return { schema: 'sbf-playback-reports-v1', ttlSeconds: TTL_MS / 1000,
      tabs: [...this.#tabs].map(([tabId, tab]) => ({ tabId,
        records: tab.records.map(({ report }) => ({ ...report, server: { ...report.server } })) })) };
  }
  close() {
    if (this.#timer !== null) this.#clearTimer(this.#timer);
    this.#timer = null; this.#tabs.clear();
  }
}
