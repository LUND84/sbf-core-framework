import { request as httpRequest } from 'node:http';

export const ACTOR_SOURCE_URL = 'http://127.0.0.1:19996/api/v1/streams/';
const MAX_RESPONSE_BYTES = 64 * 1024;

function counter(value) { return Number.isSafeInteger(value) && value >= 0; }

function counters(row) {
  if (!counter(row.frames) || !counter(row.recv_bytes)) return null;
  const result = { frames: row.frames, recvBytes: row.recv_bytes };
  for (const track of ['audio', 'video']) {
    if (row[track]?.frames !== undefined) {
      if (!counter(row[track].frames)) return null;
      result[`${track}Frames`] = row[track].frames;
    }
  }
  return result;
}

// Readiness belongs to the independently published actor stream.
// Reason: a connected control worker or SRS's latched active flag does not prove live media progress.
export class ContinuousActorSource {
  constructor({ onChange = () => {}, requestImpl = httpRequest, now = Date.now,
    schedule = setTimeout, cancel = clearTimeout, pollIntervalMs = 1000,
    requestTimeoutMs = 1500, progressMaxAgeMs = 8000, url = ACTOR_SOURCE_URL } = {}) {
    if (url !== ACTOR_SOURCE_URL) throw new Error('ACTOR_SOURCE_URL_INVALID');
    for (const value of [pollIntervalMs, requestTimeoutMs, progressMaxAgeMs]) {
      if (!Number.isFinite(value) || value <= 0) throw new Error('ACTOR_SOURCE_TIMING_INVALID');
    }
    this.onChange = onChange; this.requestImpl = requestImpl;
    this.now = now; this.schedule = schedule; this.cancel = cancel;
    this.pollIntervalMs = pollIntervalMs; this.requestTimeoutMs = requestTimeoutMs;
    this.progressMaxAgeMs = progressMaxAgeMs;
    this.started = false; this.closed = false; this.ready = false; this.reason = 'starting';
    this.pollTimer = null; this.staleTimer = null; this.cancelRequest = null;
    this.lastSample = null; this.lastSampleAt = null; this.lastProgressAt = null;
    this.checkpoint = null; this.checkpointAt = null;
    this.consecutiveProgress = 0; this.samples = 0;
  }

  snapshot() {
    return { ready: this.ready, reason: this.reason, samples: this.samples,
      lastSampleAt: this.lastSampleAt, lastProgressAt: this.lastProgressAt,
      consecutiveProgress: this.consecutiveProgress };
  }

  setState(ready, reason) {
    if (this.ready === ready && this.reason === reason) return;
    this.ready = ready; this.reason = reason;
    // Only the gate crosses into the broker callback.
    // Reason: SRS payloads, identifiers and per-second counters need no public status broadcast.
    this.onChange({ ready, reason });
  }

  clearTimer(name) {
    if (this[name] !== null) this.cancel(this[name]);
    this[name] = null;
  }

  arm(name, fn, delay) {
    this.clearTimer(name);
    this[name] = this.schedule(() => { this[name] = null; fn(); }, delay);
    this[name]?.unref?.();
  }

  reset(reason) {
    this.clearTimer('staleTimer');
    this.lastSample = null; this.lastSampleAt = null; this.lastProgressAt = null;
    this.checkpoint = null; this.checkpointAt = null;
    this.consecutiveProgress = 0;
    this.setState(false, reason);
  }

  start() {
    if (this.started || this.closed) return this.snapshot();
    this.started = true;
    this.poll();
    return this.snapshot();
  }

  observe(body) {
    if (!body || body.code !== 0 || !Array.isArray(body.streams)) return this.reset('invalid-response');
    const rows = body.streams.filter(row => row?.app === 'live' && row.name === 'actor-continuous');
    if (rows.length !== 1) return this.reset('source-missing');
    const row = rows[0];
    if (row.publish?.active !== true) return this.reset('not-publishing');
    if (!row.audio || !row.video || typeof row.audio.codec !== 'string' || !row.audio.codec
      || typeof row.video.codec !== 'string' || !row.video.codec) return this.reset('tracks-missing');
    const values = counters(row);
    if (!values) return this.reset('invalid-counters');
    const at = this.now();
    this.samples += 1;
    const previous = this.lastSample;
    const samePublisher = previous && previous.id === row.id && previous.cid === row.publish.cid;
    const keys = Object.keys(values);
    const sameCounters = previous && keys.length === Object.keys(previous.values).length
      && keys.every(key => key in previous.values);
    const recent = this.lastSampleAt !== null && at - this.lastSampleAt <= this.progressMaxAgeMs;
    const regressed = sameCounters && keys.some(key => values[key] < previous.values[key]);
    const checkpointFresh = this.checkpointAt !== null && at - this.checkpointAt < this.progressMaxAgeMs;
    const grew = samePublisher && sameCounters && recent && !regressed && checkpointFresh
      && keys.every(key => values[key] > this.checkpoint[key]);
    if (!samePublisher || !sameCounters || !recent || regressed || !checkpointFresh) {
      this.checkpoint = values; this.checkpointAt = at;
      this.lastProgressAt = null; this.consecutiveProgress = 0;
      this.arm('staleTimer', () => this.reset('source-stalled'), this.progressMaxAgeMs);
      this.setState(false, previous ? 'source-restarted' : 'warming');
    } else if (grew) {
      this.checkpoint = values; this.checkpointAt = at;
      this.lastProgressAt = at; this.consecutiveProgress += 1;
      this.arm('staleTimer', () => this.reset('source-stalled'), this.progressMaxAgeMs);
      if (this.consecutiveProgress >= 2) this.setState(true, 'ready');
      else if (!this.ready) this.setState(false, 'warming');
    } else {
      // SRS publishes frames and bytes in independent batches on the current relay.
      // Reason: partial updates must accumulate against one checkpoint without renewing its bounded liveness window.
      if (!this.ready) this.setState(false, 'warming');
    }
    this.lastSample = { id: row.id, cid: row.publish.cid, values };
    this.lastSampleAt = at;
  }

  poll() {
    if (this.closed || this.cancelRequest) return;
    const began = this.now();
    let outgoing, incoming, deadline, settled = false;
    const chunks = []; let bytes = 0;
    const finish = (reason, body) => {
      if (settled) return;
      settled = true;
      if (deadline !== undefined) this.cancel(deadline);
      this.cancelRequest = null;
      incoming?.destroy(); outgoing?.destroy();
      if (this.closed) return;
      if (reason) this.reset(reason); else this.observe(body);
      if (!this.closed) this.arm('pollTimer', () => this.poll(),
        Math.max(0, this.pollIntervalMs - (this.now() - began)));
    };
    this.cancelRequest = () => finish('closed');
    // A total deadline bounds both headers and a slow-dripped body.
    // Reason: an inactivity timeout alone can retain a request indefinitely and overlap polling.
    deadline = this.schedule(() => finish('source-timeout'), this.requestTimeoutMs);
    deadline?.unref?.();
    try {
      // Pin address, port, route, headers and disable pooling/redirects.
      // Reason: readiness probes must never become arbitrary HTTP access or retain idle sockets.
      outgoing = this.requestImpl({ protocol: 'http:', hostname: '127.0.0.1', port: 19996,
        method: 'GET', path: '/api/v1/streams/', agent: false, maxHeaderSize: 8192,
        headers: { Accept: 'application/json', 'Accept-Encoding': 'identity' } }, response => {
        incoming = response;
        if (settled || this.closed) { response.destroy(); return; }
        response.once('error', () => finish('source-unavailable'));
        response.once('aborted', () => finish('source-unavailable'));
        response.once('close', () => { if (!response.complete) finish('source-unavailable'); });
        const type = response.headers['content-type']?.split(';')[0].trim().toLowerCase();
        if (response.statusCode !== 200 || type !== 'application/json'
          || ![undefined, 'identity'].includes(response.headers['content-encoding'])) {
          return finish('invalid-response');
        }
        const size = response.headers['content-length'];
        if (size !== undefined && (!/^\d+$/.test(String(size)) || Number(size) > MAX_RESPONSE_BYTES)) {
          return finish('response-too-large');
        }
        response.on('data', chunk => {
          if (settled) return;
          const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          bytes += data.length;
          if (bytes > MAX_RESPONSE_BYTES) return finish('response-too-large');
          chunks.push(data);
        });
        response.once('end', () => {
          if (settled) return;
          let body;
          try { body = JSON.parse(Buffer.concat(chunks, bytes).toString('utf8')); }
          catch { return finish('invalid-response'); }
          finish(null, body);
        });
      });
      outgoing.once('error', () => finish('source-unavailable'));
      if (settled) outgoing.destroy(); else outgoing.end();
    } catch { finish('source-unavailable'); }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.clearTimer('pollTimer'); this.clearTimer('staleTimer');
    this.cancelRequest?.();
    this.reset('closed');
  }
}
