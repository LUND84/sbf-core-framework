import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { Broker } from '../server/broker.js';
import { readConfig } from '../server/config.js';
import { EncodedClip } from '../server/local-fmp4.js';
import { clipBytes } from './fixtures/local-fmp4-fixture.js';

function setup(t) {
  let now = 0; const timers = [];
  const broker = new Broker({ ...readConfig({ IDLE_PLAYLIST_MANIFEST: 'structural-fixture' }), chatTimeoutMs: 600000 }, {
    idlePlaylist: { clips: [1, 2, 3].map(marker => new EncodedClip(clipBytes({ marker, parts: 15 }))) },
    localOptions: { now: () => now, random: () => 0, normalizeReply: bytes => ({ clip: new EncodedClip(bytes) }),
      schedule(fn, delay) { const timer = { fn, at: now + delay }; timers.push(timer); return timer; },
      cancel(timer) { const index = timers.indexOf(timer); if (index >= 0) timers.splice(index, 1); } },
  });
  const advance = ms => {
    const until = now + ms; let calls = 0;
    while (timers.length) {
      timers.sort((a, b) => a.at - b.at); if (timers[0].at > until) break;
      const timer = timers.shift(); now = Math.max(now, timer.at); timer.fn(); assert.ok(++calls < 10000);
    }
    now = until;
  };
  advance(0); t.after(() => broker.close());
  const socket = () => Object.assign(new EventEmitter(), { readyState: 1, bufferedAmount: 0, packets: [], fail: false,
    send(data, options) { if (this.fail) throw new Error('fixture send failure'); this.packets.push({ data, binary: options?.binary }); },
    close() { this.readyState = 3; this.emit('close'); }, terminate() { this.close(); } });
  return { broker, advance, socket };
}

test('a throwing viewer is removed without interrupting healthy delivery or the local media epoch', t => {
  const f = setup(t), bad = f.socket(), good = f.socket(), epoch = f.broker.stream.epoch;
  f.broker.attachViewer(bad); f.broker.attachViewer(good); bad.fail = true;
  const before = good.packets.filter(packet => packet.binary).length;
  f.advance(1500);
  assert.equal(f.broker.viewers.has(bad), false); assert.equal(f.broker.viewers.has(good), true);
  assert.ok(good.packets.filter(packet => packet.binary).length > before);
  assert.equal(f.broker.stream.epoch, epoch); assert.equal(f.broker.stream.ready, true);
  assert.equal(f.broker.local.snapshot().scheduler_faults_total, 0);
  assert.equal(f.broker.local.snapshot().stream_restarts, 0);
});

test('an already completed stop ACK cannot fail a newer generation', t => {
  const f = setup(t), worker = f.socket(); f.broker.attachWorker(worker);
  const send = message => worker.emit('message', Buffer.from(JSON.stringify(message)), false);
  send({ type: 'worker.hello', mode: 'avatar', mediaMode: 'sealed-replies', reply_pipeline: 1 });
  f.broker.interrupt();
  const nonce = worker.packets.map(packet => JSON.parse(packet.data)).find(packet => packet.type === 'interrupt').id;
  send({ type: 'interrupt.ack', id: nonce, status: 'done' });
  const current = f.broker.submit('structural-control-token');
  // Delayed duplicate terminal packets are stale even when no stop is active.
  // Reason: transaction nonce validation must not apply only while a newer stop happens to be pending.
  send({ type: 'interrupt.ack', id: nonce, status: 'error' });
  assert.equal(f.broker.current?.id, current.id);
  assert.equal(f.broker.history.some(event => event.id === current.id && event.status === 'error'), false);
});

for (const type of ['worker.error', 'stream.reset']) {
  test(`${type} in accepted-before-rendered window preserves the admitted slot`, t => {
    const f = setup(t), worker = f.socket(), epoch = f.broker.stream.epoch; f.broker.attachWorker(worker);
    const send = message => worker.emit('message', Buffer.from(JSON.stringify(message)), false);
    send({ type: 'worker.hello', mode: 'avatar', mediaMode: 'sealed-replies', reply_pipeline: 1 });
    const request = f.broker.submit('structural-control-token'), bytes = clipBytes({ marker: 9, parts: 15 });
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    send({ type: 'reply.clip.begin', id: request.id, mime: f.broker.local.playlist.clips[0].mime,
      source_epoch: 'structural', bytes: bytes.length, sha256, width: 1920, height: 1080, fps: 30 });
    worker.emit('message', bytes, true); send({ type: 'reply.clip.end', id: request.id, sha256 });
    assert.equal(f.broker.local.hasReply(request.id), true); assert.equal(f.broker.current.id, request.id);
    // Admission is already durable before the producer's separate rendered event.
    // Reason: a control packet race must not erase a complete locally owned reply.
    send({ type, message: 'structural failure' });
    assert.equal(f.broker.local.hasReply(request.id), true);
    assert.equal(f.broker.activeJobs.has(request.id), true); assert.equal(f.broker.stream.epoch, epoch);
    f.advance(16100);
    assert.equal(worker.packets.some(packet => !packet.binary && JSON.parse(packet.data).type === 'reply.clip.played'), true);
  });
}

test('rejection terminal releases only its matching producer and publishes no duplicate UI terminal', async t => {
  const f = setup(t), worker = f.socket(), epoch = f.broker.stream.epoch; f.broker.attachWorker(worker);
  f.broker.config.replyUploadTimeoutMs = 100;
  const send = message => worker.emit('message', Buffer.from(JSON.stringify(message)), false);
  send({ type: 'worker.hello', mode: 'avatar', mediaMode: 'sealed-replies', reply_pipeline: 1 });
  const first = f.broker.submit('fixture-one'), next = f.broker.submit('fixture-two');
  f.broker.rejectLocalJob(first.id, { id: first.id, role: 'system', status: 'error', error: 'FIXTURE_REJECT' });
  assert.equal(f.broker.current.id, first.id); assert.equal(f.broker.current.rejectionPending, true);
  send({ type: 'chat.event', id: 'wrong-transaction', status: 'error' }); assert.equal(f.broker.current.id, first.id);
  send({ type: 'chat.event', id: first.id, status: 'error' }); assert.equal(f.broker.current.id, next.id);
  assert.equal(f.broker.history.filter(event => event.id === first.id && event.status === 'error').length, 1);
  await new Promise(resolve => setTimeout(resolve, 120));
  assert.equal(f.broker.current.id, next.id); assert.equal(f.broker.interrupting, false);
  assert.equal(worker.packets.some(packet => !packet.binary && JSON.parse(packet.data).type === 'interrupt'), false);
  assert.equal(f.broker.stream.epoch, epoch);
});

test('missing rejection terminal has bounded targeted stop without reusing an unconfirmed actor', async t => {
  const f = setup(t), worker = f.socket(), epoch = f.broker.stream.epoch; f.broker.attachWorker(worker);
  f.broker.config.replyUploadTimeoutMs = 100;
  const send = message => worker.emit('message', Buffer.from(JSON.stringify(message)), false);
  send({ type: 'worker.hello', mode: 'avatar', mediaMode: 'sealed-replies', reply_pipeline: 1 });
  const first = f.broker.submit('fixture-one'), next = f.broker.submit('fixture-two');
  f.broker.rejectLocalJob(first.id, { id: first.id, role: 'system', status: 'error', error: 'FIXTURE_REJECT' });
  await new Promise(resolve => setTimeout(resolve, 120));
  assert.equal(f.broker.current, null); assert.equal(f.broker.interrupting, true);
  const stop = worker.packets.filter(packet => !packet.binary).map(packet => JSON.parse(packet.data)).find(packet => packet.type === 'interrupt');
  assert.equal(stop.request_id, first.id); assert.equal(stop.id, f.broker.interruptCommandId);
  assert.equal(f.broker.history.filter(event => event.id === first.id && event.status === 'error').length, 1);
  send({ type: 'interrupt.ack', id: stop.id, status: 'done' }); assert.equal(f.broker.current.id, next.id);
  assert.equal(f.broker.stream.epoch, epoch);
});
