import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { createHash } from 'node:crypto';
import { Broker } from '../server/broker.js';
import { readConfig } from '../server/config.js';
import { createApp } from '../server/app.js';
import { EncodedClip } from '../server/local-fmp4.js';
import { clipBytes } from './fixtures/local-fmp4-fixture.js';

function workerSocket() {
  return Object.assign(new EventEmitter(), { readyState: 1, bufferedAmount: 0, messages: [],
    send(data) { this.messages.push(JSON.parse(data)); },
    close() { this.readyState = 3; this.emit('close'); }, terminate() { this.close(); } });
}

function send(worker, message) {
  worker.emit('message', Buffer.from(JSON.stringify(message)), false);
}

function fixture(t, { local = false } = {}) {
  let now = 0;
  const timers = new Set();
  const clock = {
    now: () => now,
    schedule: (fn, delay) => { const timer = { fn, at: now + delay }; timers.add(timer); return timer; },
    cancel: timer => timers.delete(timer),
  };
  const clips = local ? [1, 2, 3].map(marker => new EncodedClip(clipBytes({ marker, parts: 15 }))) : null;
  const broker = new Broker(readConfig(local ? { IDLE_PLAYLIST_MANIFEST: 'unit-injected' } : {}), {
    autonomousOptions: clock,
    ...(local ? { idlePlaylist: { clips }, localOptions: { ...clock, random: () => 0,
      normalizeReply: bytes => ({ clip: new EncodedClip(bytes) }) } } : {}),
  });
  const worker = workerSocket();
  broker.attachWorker(worker);
  const hello = extra => broker.receiveWorker({ type: 'worker.hello', mode: 'avatar',
    chatMode: 'llm', autonomousCrypto: 1,
    ...(local ? { mediaMode: 'sealed-replies', reply_pipeline: 1 } : {}), ...extra });
  hello();
  broker.stream.ready = true;
  const advance = ms => {
    const end = now + ms;
    let steps = 0;
    while (true) {
      const next = [...timers].sort((a, b) => a.at - b.at)[0];
      if (!next || next.at > end) break;
      timers.delete(next); now = Math.max(now, next.at); next.fn();
      assert.ok(++steps < (local ? 20000 : 100), 'scheduler must not spin');
    }
    now = end;
  };
  const requests = () => worker.messages.filter(m => m.type === 'chat.request');
  const terminal = (id, status = 'done') => broker.receiveWorker({ type: 'chat.event',
    id, role: 'assistant', text: 'A crypto observation.', status });
  const upload = id => {
    const bytes = clipBytes({ marker: 9, parts: 15 });
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    send(worker, { type: 'reply.clip.begin', id, mime: clips[0].mime, source_epoch: 'unit',
      bytes: bytes.length, sha256, width: 1920, height: 1080, fps: 30 });
    worker.emit('message', bytes, true); send(worker, { type: 'reply.clip.end', id, sha256 });
  };
  if (local) advance(0);
  t.after(() => broker.close());
  return { broker, worker, hello, advance, requests, terminal, timers, upload };
}

test('explicit start generates bounded crypto turns and continues only after full terminal and gap', t => {
  const f = fixture(t);
  f.advance(60000); assert.equal(f.requests().length, 0);
  f.broker.autonomous.setEnabled(true); f.advance(0);
  const first = f.requests()[0];
  assert.equal(first.kind, 'autonomous-crypto'); assert.match(first.text, /Bitcoin/);
  assert.equal(f.broker.history.some(event => event.role === 'user'), false);
  f.broker.receiveWorker({ type: 'chat.rendered', id: first.id }); f.advance(60000);
  assert.equal(f.requests().length, 1);
  f.terminal(first.id); f.advance(999); assert.equal(f.requests().length, 1);
  f.advance(1); assert.equal(f.requests().length, 2);
  assert.notEqual(f.requests()[1].text, first.text);
  assert.equal(f.broker.status().autonomous.completed, 1);
  assert.equal(f.broker.history.at(-1).source, 'autonomous-crypto');
});

test('viewer chat wins over both a scheduled turn and ongoing narration without being discarded', t => {
  const f = fixture(t);
  f.broker.autonomous.setEnabled(true);
  const user = f.broker.submit('Explain liquidity'); f.advance(0);
  assert.equal(f.requests()[0].id, user.id);
  f.terminal(user.id); f.advance(0);
  const auto = f.requests()[1];
  const next = f.broker.submit('What about stablecoins?');
  f.advance(100000); assert.equal(f.requests().length, 2);
  f.terminal(auto.id); assert.equal(f.requests()[2].id, next.id);
  f.terminal(next.id); f.advance(1000);
  assert.equal(f.requests().at(-1).kind, 'autonomous-crypto');
});

test('pipeline rendering does not unlock a second autonomous job during playback', t => {
  const f = fixture(t);
  f.broker.workerInfo.replyPipeline = true;
  f.broker.workerInfo.mediaMode = f.broker.localMode;
  f.broker.local = { hasReply: () => true, terminal: () => false, snapshot: () => ({}), close() {}, producerLost() {} };
  f.broker.autonomous.setEnabled(true); f.advance(0);
  const first = f.requests()[0];
  f.broker.receiveWorker({ type: 'chat.rendered', id: first.id }); f.advance(10000);
  assert.equal(f.broker.current, null); assert.equal(f.broker.activeJobs.size, 1);
  assert.equal(f.requests().length, 1);
  const user = f.broker.submit('A viewer arrives');
  assert.equal(f.requests()[1].id, user.id);
  f.terminal(user.id); f.advance(10000); assert.equal(f.requests().length, 2);
  f.terminal(first.id); f.advance(1000); assert.equal(f.requests().length, 3);
});

test('pause and global interrupt cancel future turns; pausing preserves the current spoken segment', t => {
  const f = fixture(t);
  f.broker.autonomous.setEnabled(true); f.advance(0);
  const first = f.requests()[0];
  f.broker.autonomous.setEnabled(false);
  assert.equal(f.broker.current.id, first.id);
  assert.equal(f.worker.messages.some(m => m.type === 'interrupt'), false);
  f.terminal(first.id); f.advance(60000); assert.equal(f.requests().length, 1);
  f.broker.autonomous.setEnabled(true); f.advance(0); f.broker.interrupt();
  const command = f.worker.messages.findLast(m => m.type === 'interrupt');
  f.broker.receiveWorker({ type: 'interrupt.ack', id: command.id, status: 'done' });
  f.advance(60000); assert.equal(f.requests().length, 2);
  assert.equal(f.broker.autonomous.enabled, false);
});

test('disconnected, unready, old, echo and test workers never receive autonomous work', t => {
  const f = fixture(t);
  f.broker.autonomous.setEnabled(true);
  for (const hello of [{ autonomousCrypto: undefined }, { chatMode: 'echo' }, { mode: 'test-pattern' }]) {
    f.hello(hello); f.advance(10000); assert.equal(f.requests().length, 0);
  }
  f.hello(); f.broker.stream.ready = false; f.broker.publishStatus();
  f.advance(10000); assert.equal(f.requests().length, 0);
  f.broker.stream.ready = true; f.broker.publishStatus(); f.advance(0);
  assert.equal(f.requests().length, 1);
  f.worker.close(); f.advance(60000); assert.equal(f.requests().length, 1);
  assert.equal(f.broker.autonomous.snapshot().state, 'waiting');
});

test('failed narration backs off and pauses after three failures; duplicate receipts do not increment', t => {
  const f = fixture(t);
  f.broker.autonomous.setEnabled(true); f.advance(0);
  const first = f.requests()[0]; f.terminal(first.id, 'error'); f.terminal(first.id, 'error');
  assert.equal(f.broker.autonomous.failures, 1);
  f.advance(4999); assert.equal(f.requests().length, 1); f.advance(1);
  f.terminal(f.requests()[1].id, 'error'); f.advance(10000);
  f.terminal(f.requests()[2].id, 'error'); f.advance(120000);
  assert.equal(f.requests().length, 3);
  assert.equal(f.broker.autonomous.snapshot().state, 'error');
  assert.equal(f.broker.autonomous.enabled, false);
  f.broker.autonomous.setEnabled(true); f.advance(0);
  assert.equal(f.requests().length, 4);
});

test('shutdown removes timers and cannot restart narration from late status callbacks', t => {
  const f = fixture(t);
  f.broker.autonomous.setEnabled(true); assert.equal(f.timers.size, 1);
  f.broker.close(); f.broker.publishStatus(); f.advance(60000);
  assert.equal(f.timers.size, 0); assert.equal(f.requests().length, 0);
});

test('a replacement worker resumes narration only after a fresh compatible media source is ready', t => {
  const f = fixture(t);
  f.broker.autonomous.setEnabled(true); f.advance(0);
  const first = f.requests()[0];
  f.worker.readyState = 2;
  const replacement = workerSocket();
  f.broker.attachWorker(replacement);
  send(replacement, { type: 'worker.hello', mode: 'avatar', chatMode: 'llm', autonomousCrypto: 1 });
  f.worker.emit('close');
  send(f.worker, { type: 'chat.event', id: first.id, role: 'assistant', status: 'done' });
  f.advance(10000);
  assert.equal(f.broker.worker, replacement);
  assert.equal(f.broker.autonomous.completed, 0);
  assert.equal(replacement.messages.filter(m => m.type === 'chat.request').length, 0);
  send(replacement, { type: 'stream.reset', epoch: 'replacement-epoch', mime: 'video/mp4',
    width: 1920, height: 1080, fps: 30 });
  replacement.emit('message', Buffer.from('0000ftypmoov'), true);
  replacement.emit('message', Buffer.from('0000moofmdat'), true);
  f.advance(0);
  const next = replacement.messages.filter(m => m.type === 'chat.request');
  assert.equal(next.length, 1);
  assert.equal(next[0].kind, 'autonomous-crypto');
  assert.notEqual(next[0].id, first.id);
});

test('an admitted autonomous clip survives disconnection and finishes before a replacement gets work', t => {
  const f = fixture(t, { local: true });
  const epoch = f.broker.stream.epoch;
  f.broker.autonomous.setEnabled(true); f.advance(0);
  const first = f.requests()[0];
  f.upload(first.id); send(f.worker, { type: 'chat.rendered', id: first.id });
  f.worker.close();
  assert.equal(f.broker.local.hasReply(first.id), true);
  assert.equal(f.broker.activeJobs.has(first.id), true);
  assert.equal(f.broker.history.some(event => event.id === first.id && event.status === 'error'), false);
  const replacement = workerSocket();
  f.broker.attachWorker(replacement);
  send(replacement, { type: 'worker.hello', mode: 'avatar', chatMode: 'llm', autonomousCrypto: 1,
    mediaMode: 'sealed-replies', reply_pipeline: 1 });
  let waited = 0;
  while (f.broker.local.hasReply(first.id) && waited < 20000) {
    assert.equal(replacement.messages.filter(m => m.type === 'chat.request').length, 0);
    f.advance(100); waited += 100;
  }
  assert.equal(f.broker.local.hasReply(first.id), false);
  assert.equal(f.broker.activeJobs.has(first.id), false);
  assert.equal(f.broker.stream.epoch, epoch);
  const terminal = f.broker.history.filter(event => event.id === first.id && event.status === 'error');
  assert.equal(terminal.length, 1);
  assert.equal(terminal[0].source, 'autonomous-crypto');
  assert.equal(f.broker.autonomous.completed, 0);
  assert.equal(f.worker.messages.some(m => m.type === 'reply.clip.played'), false);
  assert.equal(replacement.messages.filter(m => m.type === 'chat.request').length, 0);
  f.advance(5000);
  assert.equal(replacement.messages.filter(m => m.type === 'chat.request').length, 1);
});

test('a scheduled continuation rechecks readiness and resumes when the source returns', t => {
  const f = fixture(t);
  f.broker.autonomous.setEnabled(true); f.advance(0); f.terminal(f.requests()[0].id);
  assert.equal(f.timers.size, 1);
  f.broker.stream.ready = false;
  f.advance(1000);
  assert.equal(f.requests().length, 1);
  assert.equal(f.timers.size, 0);
  assert.equal(f.broker.autonomous.snapshot().state, 'waiting');
  f.broker.stream.ready = true; f.broker.publishStatus(); f.advance(0);
  assert.equal(f.requests().length, 2);
});

test('closing during a turn ignores late terminal events and cannot be enabled again', t => {
  const f = fixture(t);
  f.broker.autonomous.setEnabled(true); f.advance(0);
  const first = f.requests()[0]; f.broker.close();
  send(f.worker, { type: 'chat.event', id: first.id, role: 'assistant', status: 'done' });
  f.terminal(first.id, 'error'); f.broker.publishStatus();
  f.broker.autonomous.setEnabled(true); f.advance(60000);
  assert.equal(f.broker.activeJobs.size, 0);
  assert.equal(f.broker.autonomous.enabled, false);
  assert.equal(f.broker.autonomous.completed, 0);
  assert.equal(f.timers.size, 0);
  assert.equal(f.requests().length, 1);
});

test('pausing an active turn prevents late successful or failed receipts from restarting it', t => {
  for (const status of ['done', 'error']) {
    const f = fixture(t);
    f.broker.autonomous.setEnabled(true); f.advance(0);
    const first = f.requests()[0]; f.broker.autonomous.setEnabled(false);
    f.terminal(first.id, status); f.terminal(first.id, status);
    f.broker.publishStatus(); f.advance(120000);
    assert.equal(f.broker.autonomous.enabled, false);
    assert.equal(f.broker.autonomous.completed, status === 'done' ? 1 : 0);
    assert.equal(f.broker.activeJobs.size, 0);
    assert.equal(f.timers.size, 0);
    assert.equal(f.requests().length, 1);
  }
});

test('autonomous API enforces viewer authentication, origin and strict boolean input', async t => {
  const app = createApp(readConfig({ DEMO_ACCESS_CODE: 'unit-code', WORKER_TOKEN: 'unit-worker-token' }));
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const post = (path, body, headers = {}) => fetch(base + path, { method: 'POST',
    headers: { Origin: base, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  assert.equal((await post('/api/autonomous', { enabled: true })).status, 401);
  const login = await post('/api/login', { code: 'unit-code' });
  const Cookie = login.headers.get('set-cookie').split(';')[0];
  assert.equal((await post('/api/autonomous', { enabled: true }, { Cookie, Origin: 'https://outside.example' })).status, 403);
  assert.equal((await post('/api/autonomous', { enabled: 'true' }, { Cookie })).status, 400);
  assert.equal((await post('/api/autonomous', { enabled: true }, { Cookie })).status, 200);
  assert.equal(app.broker.status().autonomous.enabled, true);
  assert.equal(app.broker.status().autonomous.state, 'waiting');
  await post('/api/autonomous', { enabled: false }, { Cookie });
  assert.equal(app.broker.status().autonomous.enabled, false);
});

test('autonomous gap config rejects invalid and excessive values', () => {
  assert.equal(readConfig({}).autonomousGapMs, 1000);
  assert.equal(readConfig({ AUTONOMOUS_GAP_MS: '0' }).autonomousGapMs, 0);
  for (const value of ['-1', '60001', 'fast']) assert.throws(() => readConfig({ AUTONOMOUS_GAP_MS: value }));
});
