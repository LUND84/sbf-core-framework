import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { Broker } from '../server/broker.js';
import { readConfig } from '../server/config.js';
import { EncodedClip } from '../server/local-fmp4.js';
import { clipBytes } from './fixtures/local-fmp4-fixture.js';

function setup(t, pipeline = true) {
  let now = 0;
  const scheduled = [];
  const clips = [1, 2, 3].map(marker => new EncodedClip(clipBytes({ marker, parts: 15 })));
  const broker = new Broker({ ...readConfig({ IDLE_PLAYLIST_MANIFEST: 'unit-injected' }), chatTimeoutMs: 600000 }, {
    idlePlaylist: { clips }, localOptions: { now: () => now, random: () => 0,
      schedule: (fn, delay) => { const timer = { fn, at: now + delay }; scheduled.push(timer); return timer; },
      cancel: timer => { const index = scheduled.indexOf(timer); if (index >= 0) scheduled.splice(index, 1); },
      normalizeReply: bytes => ({ clip: new EncodedClip(bytes) }) },
  });
  const advance = ms => {
    const end = now + ms;
    let guard = 0;
    while (scheduled.length) {
      scheduled.sort((a, b) => a.at - b.at);
      if (scheduled[0].at > end) break;
      const next = scheduled.shift(); now = Math.max(now, next.at); next.fn();
      assert.ok(++guard < 20000);
    }
    now = end;
  };
  advance(0);
  const worker = Object.assign(new EventEmitter(), { readyState: 1, bufferedAmount: 0, messages: [],
    send(data) { this.messages.push(JSON.parse(data)); },
    close() { this.readyState = 3; this.emit('close'); }, terminate() { this.close(); } });
  broker.attachWorker(worker);
  const send = message => worker.emit('message', Buffer.from(JSON.stringify(message)), false);
  send({ type: 'worker.hello', mode: 'avatar', mediaMode: 'sealed-replies', reply_pipeline: pipeline ? 1 : undefined });
  t.after(() => broker.close());
  function upload(id) {
    const bytes = clipBytes({ marker: 9, parts: 15 });
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    send({ type: 'reply.clip.begin', id, mime: clips[0].mime, source_epoch: 'unit',
      bytes: bytes.length, sha256, width: 1920, height: 1080, fps: 30 });
    worker.emit('message', bytes, true); send({ type: 'reply.clip.end', id, sha256 });
  }
  return { broker, worker, send, upload, advance };
}

test('negotiated pipeline prepares the second reply before the first has finished playback', t => {
  const f = setup(t), first = f.broker.submit('one'), second = f.broker.submit('two');
  assert.ok(f.worker.messages.some(m => m.type === 'worker.ready' && m.reply_pipeline === 1));
  f.upload(first.id); f.send({ type: 'chat.rendered', id: first.id });
  assert.equal(f.broker.current?.id, second.id);
  assert.equal(f.worker.messages.some(m => m.type === 'reply.clip.played'), false);
  assert.equal(f.broker.history.some(m => m.id === first.id && m.status === 'done'), false);
});

test('two slots bound prepared work and old played completion cannot clear the new producer', t => {
  const f = setup(t), first = f.broker.submit('one'), second = f.broker.submit('two'), third = f.broker.submit('three');
  f.upload(first.id); f.send({ type: 'chat.rendered', id: first.id });
  f.upload(second.id); f.send({ type: 'chat.rendered', id: second.id });
  assert.equal(f.worker.messages.filter(m => m.type === 'chat.request').length, 2);
  f.advance(16100);
  assert.ok(f.worker.messages.some(m => m.type === 'reply.clip.played' && m.id === first.id));
  f.send({ type: 'chat.event', id: first.id, role: 'assistant', status: 'done', text: 'first reply' });
  assert.equal(f.broker.current?.id, third.id);
  f.send({ type: 'chat.event', id: first.id, role: 'assistant', status: 'done', text: 'duplicate' });
  assert.equal(f.broker.current?.id, third.id);
  assert.equal(f.worker.messages.filter(m => m.type === 'chat.request').length, 3);
});

test('a producer failure preserves an admitted reply and the warm local idle timeline', t => {
  const f = setup(t), epoch = f.broker.stream.epoch;
  const first = f.broker.submit('one'), second = f.broker.submit('two');
  f.upload(first.id); f.send({ type: 'chat.rendered', id: first.id });
  assert.equal(f.broker.current?.id, second.id);
  f.send({ type: 'worker.error', message: 'fixed source failure' });
  f.advance(16100);
  assert.equal(f.broker.stream.epoch, epoch);
  assert.ok(f.worker.messages.some(m => m.type === 'reply.clip.played' && m.id === first.id));
  f.send({ type: 'chat.event', id: first.id, role: 'assistant', status: 'done', text: 'first reply' });
  assert.equal(f.broker.history.filter(m => m.id === first.id && m.status === 'done').length, 1);
});

test('legacy workers retain their serial contract and cannot use chat.rendered to release a slot', t => {
  const f = setup(t, false), first = f.broker.submit('one');
  f.broker.submit('two'); f.upload(first.id); f.send({ type: 'chat.rendered', id: first.id });
  assert.equal(f.broker.current?.id, first.id);
  assert.equal(f.worker.messages.filter(m => m.type === 'chat.request').length, 1);
});

test('a stale interrupt acknowledgement cannot release a newer stop transaction', t => {
  const f = setup(t);
  f.broker.interrupt();
  const old = f.worker.messages.filter(m => m.type === 'interrupt').at(-1);
  f.broker.interrupt();
  const next = f.worker.messages.filter(m => m.type === 'interrupt').at(-1);
  assert.notEqual(old.id, next.id);
  f.send({ type: 'interrupt.ack', id: old.id, status: 'done' });
  assert.equal(f.broker.interrupting, true);
  f.send({ type: 'interrupt.ack', id: next.id, status: 'done' });
  assert.equal(f.broker.interrupting, false);
});

test('a closing worker cannot accept new generation or terminate an already admitted reply', t => {
  const f = setup(t), first = f.broker.submit('one');
  f.upload(first.id); f.send({ type: 'chat.rendered', id: first.id });
  f.worker.readyState = 2;
  assert.throws(() => f.broker.submit('two'), error => error.statusCode === 503);
  assert.equal(f.broker.activeJobs.has(first.id), true);
  assert.equal(f.broker.local.hasReply(first.id), true);
  assert.equal(f.broker.history.some(m => m.id === first.id && m.status === 'error'), false);
});

test('replacing a closing worker retires its generation before dispatching to the replacement', t => {
  const f = setup(t), first = f.broker.submit('one');
  f.worker.readyState = 2;
  const replacement = Object.assign(new EventEmitter(), { readyState: 1, bufferedAmount: 0, messages: [],
    send(data) { this.messages.push(JSON.parse(data)); },
    close() { this.readyState = 3; this.emit('close'); }, terminate() { this.close(); } });
  f.broker.attachWorker(replacement);
  replacement.emit('message', Buffer.from(JSON.stringify({ type: 'worker.hello', mode: 'avatar',
    mediaMode: 'sealed-replies', reply_pipeline: 1 })), false);
  f.worker.emit('close');
  const next = f.broker.submit('two');
  assert.equal(f.broker.current?.id, next.id);
  assert.equal(f.broker.activeJobs.has(first.id), false);
  assert.equal(replacement.messages.filter(m => m.type === 'chat.request').length, 1);
});
