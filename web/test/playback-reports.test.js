import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { PlaybackReports } from '../server/playback-reports.js';
import { createApp } from '../server/app.js';
import { readConfig } from '../server/config.js';

const tabId = '70c3a9f8-3d0f-4d0f-a390-9b75602592df';
function sample(changes = {}) {
  return { tabId, seq: 1, perfNowMs: 100, elapsedMs: 100,
    connectionIndex: 1, connectionElapsedMs: 100, epochIndex: 1, epochElapsedMs: 90,
    firstDataMs: 10, firstPlayingMs: null, routeClass: 'main', connection: 'open',
    visibility: 'visible', state: 'buffering', receivedBytes: 1269, queuedBytes: 0,
    bufferAheadSeconds: 0, bufferSeconds: 0, lag: null, hasData: false,
    paused: true, seeking: false, readyState: 1, currentTime: 0,
    totalVideoFrames: 0, droppedVideoFrames: 0, waitingEvents: 1,
    ignoredStaleWaiting: 0, programPauseCalls: 0, playCalls: 0, autoSeekCalls: 0,
    ...changes };
}

test('report store keeps bounded numeric copies and exact 2s/sliding-window admission', () => {
  let now = 0;
  const store = new PlaybackReports({ now: () => now, wallNow: () => 1700000000000 + now });
  const input = sample();
  store.add(input, { media: { fragments: { count: 9, last_age_ms: 7 },
    viewers: { pending_high_water_bytes: 8, backpressure_closes: 1 } }, stream: { epoch: 'private-epoch' } });
  input.receivedBytes = 999;
  const first = store.snapshot().tabs[0].records[0];
  assert.equal(first.receivedBytes, 1269); assert.equal(first.server.sourceFragmentCount, 9);
  assert.equal(first.server.sourceAgeMs, 7); assert.match(first.server.streamEpochHash, /^[0-9a-f]{12}$/);
  assert.throws(() => store.add(sample()), error => error.statusCode === 429);
  now = 1999; assert.throws(() => store.add(sample()), error => error.statusCode === 429);
  now = 2000; store.add(sample({ seq: 2 }));
  for (let i = 2; i < 30; i++) { now = i * 2000; store.add(sample({ seq: i + 1 })); }
  const view = store.snapshot();
  assert.equal(view.tabs.length, 1); assert.equal(view.tabs[0].records.length, 8);
  assert.equal(view.tabs[0].records.at(-1).seq, 30);
  assert.equal(JSON.stringify(view).includes('private-epoch'), false);
  now = 60000; store.add(sample({ seq: 31 }));
  now = 180001; assert.deepEqual(store.snapshot().tabs, []);
  store.close();
});

test('store rejects excess keys, nonfinite/range/type/UUID errors and a seventeenth active tab', () => {
  const store = new PlaybackReports({ now: () => 0 });
  for (const changes of [{ url: 'private' }, { receivedBytes: NaN }, { perfNowMs: Infinity },
    { currentTime: -1 }, { readyState: 5 }, { paused: 1 }, { seq: 1.5 },
    { tabId: 'viewer-name' }, { state: 'private-text' }, { connection: 'unknown' },
    { routeClass: 'https://private.invalid' }, { visibility: 'anything' }]) {
    assert.throws(() => store.add(sample(changes)), error => error.statusCode === 400);
  }
  const missing = sample(); delete missing.seq;
  assert.throws(() => store.add(missing), error => error.statusCode === 400);
  for (let i = 0; i < 16; i++) store.add(sample({ tabId: randomUUID() }));
  assert.throws(() => store.add(sample({ tabId: randomUUID() })), error => error.statusCode === 429);
  assert.equal(store.snapshot().tabs.length, 16);
  store.close();
});

test('one owned expiry timer removes abandoned records without a reader or another POST', () => {
  let now = 0, timer = null;
  const store = new PlaybackReports({ now: () => now,
    setTimer: (callback, delay) => { timer = { callback, delay }; return timer; },
    clearTimer: value => { if (timer === value) timer = null; } });
  store.add(sample()); assert.equal(timer.delay, 120000);
  now = 2000; store.add(sample({ seq: 2 })); assert.equal(timer.delay, 118000);
  now = 120000; const first = timer; timer = null; first.callback();
  assert.equal(timer.delay, 2000);
  now = 122000; const last = timer; timer = null; last.callback();
  assert.equal(timer, null, 'All expired entries must be removed by the owned timer itself');
  assert.deepEqual(store.snapshot().tabs, []); store.close();
});

test('actual app route separates viewer POST from worker-only GET, rejects bad origins/body sizes', async t => {
  const app = createApp(readConfig({ WORKER_TOKEN: 'test-worker-only-token', DEMO_ACCESS_CODE: 'test-code' }));
  t.after(() => app.close());
  const handle = app.server.listeners('request')[0];
  async function call(method, path, { body, cookie, bearer, origin = 'http://fixture.invalid' } = {}) {
    const request = Readable.from(body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]);
    request.method = method; request.url = path;
    request.headers = { host: 'fixture.invalid', origin, ...(cookie ? { cookie } : {}),
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) };
    request.socket = { remoteAddress: 'DO_NOT_RETAIN_IP' };
    return await new Promise((resolve, reject) => {
      const headers = {};
      const response = { headersSent: false, setHeader: (key, value) => { headers[key] = value; },
        writeHead(code, extra) { this.statusCode = code; this.headersSent = true; Object.assign(headers, extra); },
        end(bytes) { resolve({ status: this.statusCode, headers, body: JSON.parse(String(bytes)) }); },
        destroy: () => reject(new Error('Unexpected response destroy')) };
      Promise.resolve(handle(request, response)).catch(reject);
    });
  }
  const login = await call('POST', '/api/login', { body: { code: 'test-code' } });
  const cookie = login.headers['Set-Cookie'].split(';')[0];
  assert.equal((await call('POST', '/api/playback-report', { body: sample() })).status, 401);
  assert.equal((await call('POST', '/api/playback-report', { body: sample(), cookie, origin: 'https://wrong.invalid' })).status, 403);
  assert.equal((await call('POST', '/api/playback-report', { body: sample(), cookie })).status, 202);
  assert.equal((await call('POST', '/api/playback-report', { body: sample(), cookie })).status, 429);
  assert.equal((await call('POST', '/api/playback-report', { body: 'x'.repeat(8193), cookie })).status, 413);
  assert.equal((await call('GET', '/api/playback-report', { cookie })).status, 401);
  assert.equal((await call('GET', '/api/playback-report', { bearer: 'wrong' })).status, 401);
  const accepted = await call('GET', '/api/playback-report', { bearer: 'test-worker-only-token' });
  assert.equal(accepted.status, 200); assert.equal(accepted.body.tabs[0].tabId, tabId);
  const text = JSON.stringify(accepted.body);
  for (const secret of ['DO_NOT_RETAIN_IP', 'test-code', 'test-worker-only-token', cookie]) assert.equal(text.includes(secret), false);
});
