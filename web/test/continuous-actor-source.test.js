import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { createServer, request as httpRequest } from 'node:http';
import { ACTOR_SOURCE_URL, ContinuousActorSource } from '../server/continuous-actor-source.js';

function stream(n = 0, extra = {}) {
  return { id: 'actor-stream', app: 'live', name: 'actor-continuous', frames: 100 + n * 30,
    recv_bytes: 10000 + n * 1000, publish: { active: true, cid: 'publisher' },
    audio: { codec: 'AAC' }, video: { codec: 'H264' }, ...extra };
}

function fixture(t, options = {}) {
  let time = 0;
  const timers = new Set(), requests = [], changes = [];
  const schedule = (fn, delay) => {
    const timer = { fn, at: time + delay };
    timers.add(timer); return timer;
  };
  const requestImpl = (requestOptions, onResponse) => {
    const request = Object.assign(new EventEmitter(), { options: requestOptions, destroyed: false,
      ended: false, end() { this.ended = true; }, destroy() { this.destroyed = true; },
      respond(raw, { statusCode = 200, headers = {}, complete = true } = {}) {
        const response = Object.assign(new EventEmitter(), {
          statusCode, headers: { 'content-type': 'application/json', ...headers }, complete: false,
          destroyed: false, destroy() { this.destroyed = true; },
        });
        this.response = response; onResponse(response);
        if (raw !== undefined) response.emit('data', Buffer.isBuffer(raw) ? raw : Buffer.from(raw));
        if (complete) { response.complete = true; response.emit('end'); }
        return response;
      },
    });
    requests.push(request); return request;
  };
  const source = new ContinuousActorSource({ requestImpl, now: () => time, schedule, progressMaxAgeMs: 3000,
    cancel: timer => timers.delete(timer), onChange: value => changes.push(value), ...options });
  const advance = ms => {
    const end = time + ms; let count = 0;
    while (true) {
      const next = [...timers].sort((a, b) => a.at - b.at)[0];
      if (!next || next.at > end) break;
      timers.delete(next); time = next.at; next.fn();
      assert.ok(++count < 1000, 'timers must remain bounded');
    }
    time = end;
  };
  const respond = (rows = [stream()], options) => requests.at(-1).respond(
    JSON.stringify({ code: 0, streams: rows }), options);
  const sample = (row, interval = 1000) => { advance(interval); respond([row]); };
  const warm = () => {
    source.start(); respond([stream(0)]); sample(stream(1)); sample(stream(2));
    assert.equal(source.snapshot().ready, true);
  };
  t.after(() => source.close());
  return { source, timers, requests, changes, advance, respond, sample, warm };
}

test('active publisher requires two fresh consecutive frame and byte increases before readiness', t => {
  const f = fixture(t);
  assert.deepEqual(f.source.snapshot(), { ready: false, reason: 'starting', samples: 0,
    lastSampleAt: null, lastProgressAt: null, consecutiveProgress: 0 });
  f.source.start(); f.respond([stream()]);
  assert.equal(f.source.snapshot().ready, false);
  f.sample(stream(1)); assert.equal(f.source.snapshot().ready, false);
  f.sample(stream(2)); assert.equal(f.source.snapshot().ready, true);
  f.sample(stream(3)); f.sample(stream(4));
  assert.deepEqual(f.changes, [{ ready: false, reason: 'warming' }, { ready: true, reason: 'ready' }]);
  assert.equal(f.source.snapshot().lastProgressAt, 4000);
});

test('unchanged active flags and counters never unlock a latched but stopped source', t => {
  const f = fixture(t);
  f.source.start(); f.respond();
  for (let i = 0; i < 10; i++) f.sample(stream());
  assert.equal(f.source.snapshot().ready, false);
  assert.equal(f.changes.some(change => change.ready), false);
});

test('five-second SRS counter batches warm and sustain the default eight-second liveness gate', t => {
  const f = fixture(t, { progressMaxAgeMs: 8000 });
  f.source.start(); f.respond();
  for (let second = 1; second <= 15; second++) {
    f.sample(stream(Math.floor(second / 5)));
    assert.equal(f.source.snapshot().ready, second >= 10);
  }
  for (let second = 1; second <= 7; second++) f.sample(stream(3));
  assert.equal(f.source.snapshot().ready, true);
  f.advance(1000); assert.equal(f.source.snapshot().ready, false);
});

test('both counters must beat the qualified checkpoint and partial growth preserves startup evidence', t => {
  const f = fixture(t);
  f.source.start(); f.respond();
  f.sample(stream(1));
  f.sample(stream(2, { recv_bytes: stream(1).recv_bytes }));
  assert.equal(f.source.snapshot().consecutiveProgress, 1);
  assert.equal(f.source.snapshot().lastProgressAt, 1000);
  f.sample(stream(3)); assert.equal(f.source.snapshot().ready, true);
});

test('independent real SRS frame and byte batches qualify together without simultaneous per-sample growth', t => {
  const f = fixture(t, { progressMaxAgeMs: 8000 });
  const row = (frames, recv_bytes) => stream(0, { frames, recv_bytes });
  f.source.start(); f.respond([row(1347206, 44953587634)]);
  f.sample(row(1347206, 44956590707));
  assert.equal(f.source.snapshot().consecutiveProgress, 0);
  assert.equal(f.source.snapshot().lastProgressAt, null);
  f.sample(row(1347356, 44956590707));
  assert.equal(f.source.snapshot().consecutiveProgress, 1);
  assert.equal(f.source.snapshot().ready, false);
  f.sample(row(1347356, 44959741676));
  assert.equal(f.source.snapshot().consecutiveProgress, 1);
  assert.equal(f.source.snapshot().lastProgressAt, 2000);
  f.sample(row(1347506, 44959741676));
  assert.equal(f.source.snapshot().consecutiveProgress, 2);
  assert.equal(f.source.snapshot().ready, true);
  f.sample(row(1347506, 44962741676));
  f.sample(row(1347656, 44962741676));
  assert.equal(f.source.snapshot().ready, true);
  assert.equal(f.source.snapshot().lastProgressAt, 6000);
});

test('one counter growing alone never extends a ready source liveness deadline', t => {
  for (const frozen of ['frames', 'recv_bytes']) {
    const f = fixture(t, { progressMaxAgeMs: 8000 }); f.warm();
    for (let second = 1; second <= 7; second++) {
      f.sample(stream(2 + second, { [frozen]: stream(2)[frozen] }));
      assert.equal(f.source.snapshot().ready, true);
      assert.equal(f.source.snapshot().lastProgressAt, 2000);
    }
    f.advance(1000);
    assert.equal(f.source.snapshot().ready, false);
    assert.equal(f.source.snapshot().reason, 'source-stalled');
    assert.equal(f.source.checkpoint, null);
  }
});

test('startup partial progress expires and recovering requires two new qualified rounds', t => {
  const f = fixture(t, { progressMaxAgeMs: 8000 });
  f.source.start(); f.respond([stream(0)]); f.sample(stream(1));
  for (let second = 1; second <= 7; second++) {
    f.sample(stream(1 + second, { recv_bytes: stream(1).recv_bytes }));
    assert.equal(f.source.snapshot().consecutiveProgress, 1);
    assert.equal(f.source.snapshot().ready, false);
  }
  f.advance(1000);
  assert.equal(f.source.snapshot().reason, 'source-stalled');
  assert.equal(f.source.snapshot().consecutiveProgress, 0);
  f.respond([stream(10)]);
  assert.equal(f.source.snapshot().consecutiveProgress, 0);
  f.sample(stream(11)); assert.equal(f.source.snapshot().ready, false);
  f.sample(stream(12)); assert.equal(f.source.snapshot().ready, true);
});

test('startup baseline with only single-counter progress expires without qualifying any round', t => {
  const f = fixture(t, { progressMaxAgeMs: 8000 });
  f.source.start(); f.respond([stream(0)]);
  for (let second = 1; second <= 7; second++) {
    f.sample(stream(second, { frames: stream(0).frames }));
    assert.equal(f.source.snapshot().consecutiveProgress, 0);
  }
  f.advance(1000); assert.equal(f.source.snapshot().reason, 'source-stalled');
  assert.equal(f.source.checkpoint, null);
  f.respond([stream(9)]); f.sample(stream(10));
  assert.equal(f.source.snapshot().ready, false);
  f.sample(stream(11)); assert.equal(f.source.snapshot().ready, true);
});

test('a partial counter rollback is detected against the latest sample even above its old checkpoint', t => {
  const f = fixture(t, { progressMaxAgeMs: 8000 });
  f.source.start(); f.respond([stream(0)]);
  f.sample(stream(2, { recv_bytes: stream(0).recv_bytes }));
  f.sample(stream(1));
  assert.equal(f.source.snapshot().reason, 'source-restarted');
  assert.equal(f.source.snapshot().consecutiveProgress, 0);
  f.sample(stream(3)); assert.equal(f.source.snapshot().ready, false);
  f.sample(stream(4)); assert.equal(f.source.snapshot().ready, true);
});

test('ready tolerates a brief plateau, continues when progress resumes, and expires at three seconds', t => {
  const f = fixture(t); f.warm();
  f.sample(stream(2)); assert.equal(f.source.snapshot().ready, true);
  f.sample(stream(3)); assert.equal(f.source.snapshot().ready, true);
  f.sample(stream(3)); f.sample(stream(3));
  f.advance(999); assert.equal(f.source.snapshot().ready, true);
  f.advance(1); assert.equal(f.source.snapshot().ready, false);
  assert.equal(f.source.snapshot().reason, 'source-stalled');
  f.respond([stream(4)]);
  f.sample(stream(5)); assert.equal(f.source.snapshot().ready, false);
  f.sample(stream(6)); assert.equal(f.source.snapshot().ready, true);
});

test('publisher identity changes and counter rollback require a new warm-up', t => {
  const f = fixture(t); f.warm();
  f.sample(stream(3, { publish: { active: true, cid: 'replacement' } }));
  assert.equal(f.source.snapshot().reason, 'source-restarted');
  f.sample(stream(4, { publish: { active: true, cid: 'replacement' } }));
  assert.equal(f.source.snapshot().ready, false);
  f.sample(stream(5, { publish: { active: true, cid: 'replacement' } }));
  assert.equal(f.source.snapshot().ready, true);
  f.sample(stream()); assert.equal(f.source.snapshot().ready, false);
  assert.equal(f.source.snapshot().reason, 'source-restarted');
});

test('missing, duplicate, inactive, single-track and invalid-counter sources fail closed', t => {
  const f = fixture(t);
  for (const [rows, reason] of [
    [[stream(3, { app: 'other' }), stream(3, { name: 'sbf' })], 'source-missing'],
    [[stream(), stream()], 'source-missing'],
    [[stream(3, { publish: { active: false } })], 'not-publishing'],
    [[stream(3, { audio: null })], 'tracks-missing'],
    [[stream(3, { video: { codec: '' } })], 'tracks-missing'],
    [[stream(3, { frames: '200' })], 'invalid-counters'],
    [[stream(3, { recv_bytes: -1 })], 'invalid-counters'],
    [[stream(3, { frames: Number.MAX_SAFE_INTEGER + 1 })], 'invalid-counters'],
  ]) {
    f.source.start(); if (f.requests.at(-1).destroyed) f.advance(1000);
    f.respond(rows);
    assert.equal(f.source.snapshot().ready, false); assert.equal(f.source.snapshot().reason, reason);
  }
});

test('optional separate audio/video counters must both progress when supplied', t => {
  const f = fixture(t);
  const row = (n, audioFrames = n) => stream(n, {
    audio: { codec: 'AAC', frames: 1000 + audioFrames }, video: { codec: 'H264', frames: 2000 + n },
  });
  f.source.start(); f.respond([row(0)]); f.sample(row(1)); f.sample(row(2, 1));
  assert.equal(f.source.snapshot().ready, false);
  f.sample(row(3)); assert.equal(f.source.snapshot().ready, true);
});

test('a changed SRS stream identifier resets readiness even when counters continue increasing', t => {
  const f = fixture(t); f.warm();
  f.sample(stream(3, { id: 'replacement-stream' }));
  assert.equal(f.source.snapshot().ready, false);
  assert.equal(f.source.snapshot().reason, 'source-restarted');
});

test('single request remains in flight until bounded total deadline and late response cannot revive it', t => {
  const f = fixture(t); f.source.start();
  const first = f.requests[0];
  f.source.start(); f.advance(1499); assert.equal(f.requests.length, 1);
  f.advance(1); assert.equal(first.destroyed, true);
  assert.equal(f.source.snapshot().reason, 'source-timeout');
  assert.equal(f.requests.length, 2);
  first.respond(JSON.stringify({ code: 0, streams: [stream(3)] }));
  assert.equal(f.source.snapshot().reason, 'source-timeout');
  assert.equal(first.response.destroyed, true);
});

test('slow-dripped response body cannot extend the total request deadline', t => {
  const f = fixture(t); f.source.start();
  const response = f.requests[0].respond('{', { complete: false });
  f.advance(1000); response.emit('data', Buffer.from(' '));
  f.advance(499); response.emit('data', Buffer.from(' '));
  f.advance(1);
  assert.equal(f.source.snapshot().reason, 'source-timeout');
  assert.equal(response.destroyed, true);
});

test('HTTP is pinned to the owned loopback endpoint with bounded headers and no shared socket agent', t => {
  const f = fixture(t); f.source.start();
  assert.deepEqual(f.requests[0].options, { protocol: 'http:', hostname: '127.0.0.1', port: 19996,
    method: 'GET', path: '/api/v1/streams/', agent: false, maxHeaderSize: 8192,
    headers: { Accept: 'application/json', 'Accept-Encoding': 'identity' } });
  assert.equal(f.requests[0].ended, true);
  for (const url of ['http://localhost:19996/api/v1/streams', `${ACTOR_SOURCE_URL}?url=x`,
    'http://127.0.0.1:19996/api/v1/streams/../clients', 'https://example.com']) {
    assert.throws(() => new ContinuousActorSource({ url }), /ACTOR_SOURCE_URL_INVALID/);
  }
});

test('redirects, encodings, wrong content types and malformed SRS JSON cannot mark ready', t => {
  const f = fixture(t);
  for (const [raw, responseOptions] of [
    ['{}', { statusCode: 302, headers: { location: 'http://example.com' } }],
    ['{}', { headers: { 'content-encoding': 'gzip' } }],
    ['{}', { headers: { 'content-type': 'text/html' } }],
    ['{"code":0', {}], ['{"code":1,"streams":[]}', {}], ['{"code":0,"streams":{}}', {}],
  ]) {
    f.source.start(); if (f.requests.at(-1).destroyed) f.advance(1000);
    f.requests.at(-1).respond(raw, responseOptions);
    assert.equal(f.source.snapshot().reason, 'invalid-response');
    assert.equal(f.source.snapshot().ready, false);
  }
  assert.equal(f.requests.length, 6, 'redirect must never be followed');
});

test('response size is capped at 64 KiB for both declared and chunked bodies', t => {
  const f = fixture(t); f.source.start();
  f.requests.at(-1).respond('{}', { headers: { 'content-length': '65537' } });
  assert.equal(f.source.snapshot().reason, 'response-too-large');
  f.advance(1000);
  const response = f.requests.at(-1).respond(Buffer.alloc(65536, 32), { complete: false });
  assert.equal(response.destroyed, false);
  response.emit('data', Buffer.from(' '));
  assert.equal(response.destroyed, true);
  assert.equal(f.source.snapshot().reason, 'response-too-large');
  f.advance(1000);
  const valid = JSON.stringify({ code: 0, streams: [stream()] }).padEnd(65536, ' ');
  f.requests.at(-1).respond(valid, { headers: { 'content-length': '65536' } });
  assert.equal(f.source.snapshot().reason, 'warming');
});

test('HTTP failure or upstream abort drops an existing ready gate and resets its evidence', t => {
  const f = fixture(t); f.warm();
  f.advance(1000); f.requests.at(-1).emit('error', new Error('secret upstream details'));
  assert.equal(f.source.snapshot().reason, 'source-unavailable');
  assert.equal(f.source.snapshot().ready, false);
  f.advance(1000); const response = f.requests.at(-1).respond('{', { complete: false });
  response.emit('aborted');
  assert.equal(f.source.snapshot().reason, 'source-unavailable');
  assert.deepEqual(Object.keys(f.changes.at(-1)).sort(), ['ready', 'reason']);
});

test('close cancels polling, pending HTTP deadline and progress expiry without a later callback', t => {
  const f = fixture(t); f.warm(); f.advance(1000);
  const request = f.requests.at(-1);
  const response = request.respond('{', { complete: false });
  f.source.close();
  assert.equal(request.destroyed, true); assert.equal(response.destroyed, true);
  assert.equal(f.timers.size, 0);
  const changes = f.changes.length, requests = f.requests.length;
  response.complete = true;
  response.emit('data', Buffer.from('"code":0,"streams":[]}')); response.emit('end');
  request.emit('error', new Error('after close'));
  f.advance(60000); f.source.start(); f.source.close();
  assert.equal(f.changes.length, changes); assert.equal(f.requests.length, requests);
  assert.equal(f.source.snapshot().reason, 'closed');
});

test('close before start never creates a request', t => {
  const f = fixture(t); f.source.close(); f.source.start(); f.advance(60000);
  assert.equal(f.requests.length, 0); assert.equal(f.timers.size, 0);
});

test('real HTTP slow body deadline destroys its socket and close leaves no scheduled probe',
  { timeout: 3000 }, async () => {
    const server = createServer((request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' }); response.write('{');
    });
    const sockets = new Set();
    let socketClosed;
    const closed = new Promise(resolve => { socketClosed = resolve; });
    server.on('connection', socket => {
      sockets.add(socket);
      socket.on('close', () => { sockets.delete(socket); socketClosed(); });
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const changes = [];
    let timedOut;
    const timeout = new Promise(resolve => { timedOut = resolve; });
    const source = new ContinuousActorSource({ pollIntervalMs: 10000, requestTimeoutMs: 30,
      requestImpl: (options, callback) => httpRequest({ ...options, port: server.address().port }, callback),
      onChange: value => { changes.push(value); if (value.reason === 'source-timeout') timedOut(); },
    });
    try {
      source.start(); await timeout; await closed;
      assert.equal(source.snapshot().reason, 'source-timeout'); assert.equal(sockets.size, 0);
      source.close();
      assert.deepEqual(changes, [{ ready: false, reason: 'source-timeout' }, { ready: false, reason: 'closed' }]);
      assert.equal(source.pollTimer, null); assert.equal(source.staleTimer, null);
      assert.equal(source.cancelRequest, null);
    } finally {
      source.close(); for (const socket of sockets) socket.destroy();
      await new Promise(resolve => server.close(resolve));
    }
  });
