import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { LocalRelay } from '../server/local-relay.js';
import { LocalPlayout } from '../server/local-playout.js';
import { EncodedClip } from '../server/local-fmp4.js';
import { clipBytes } from './fixtures/local-fmp4-fixture.js';

function clock() {
  let now = 0; const jobs = [];
  return { now: () => now,
    schedule(fn, delay) { const job = { fn, at: now + delay }; jobs.push(job); return job; },
    cancel(job) { const index = jobs.indexOf(job); if (index >= 0) jobs.splice(index, 1); },
    advance(ms) {
      const until = now + ms; let calls = 0;
      while (jobs.length) {
        jobs.sort((a, b) => a.at - b.at); if (jobs[0].at > until) break;
        const job = jobs.shift(); now = Math.max(now, job.at); job.fn(); assert.ok(++calls < 30000);
      }
      now = until;
    },
  };
}
const clips = () => [1, 2, 3].map((marker) => new EncodedClip(clipBytes({ marker, parts: 15 })));
function setup(t, extra = {}) {
  const time = clock(), messages = [], finished = [], media = [];
  const broker = { config: { replyUploadTimeoutMs: 10000 }, current: { id: 'first' },
    worker: {}, workerInfo: { connected: true }, resetCount: 0,
    resetMedia() { this.resetCount++; }, broadcast() {}, publishStatus() {},
    receiveMedia(bytes) { media.push(bytes); this.stream.ready = true; },
    send(worker, message) { messages.push({ worker, ...message }); },
    finishLocalJob(id, terminal) { finished.push({ id, terminal }); if (this.current?.id === id) this.current = null; },
    failAll() {}, chatEvent() {}, clearCurrent() { this.current = null; }, dispatch() {},
  };
  const local = new LocalRelay(broker, { clips: clips() }, { ...time, random: () => 0,
    normalizeReply: (bytes) => ({ clip: new EncodedClip(bytes) }), ...extra });
  t.after(() => local.close()); time.advance(0);
  const begin = (id, bytes = clipBytes({ marker: 9, parts: 15 })) => {
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const meta = { id, mime: local.playlist.clips[0].mime, source_epoch: 'source', bytes: bytes.length,
      sha256, width: 1920, height: 1080, fps: 30 };
    local.begin(meta); return { bytes, meta };
  };
  const upload = async (id) => {
    const value = begin(id); local.binary(value.bytes); await local.end({ id, sha256: value.meta.sha256 });
  };
  return { time, broker, local, messages, finished, media, begin, upload };
}

test('partial generation cancellation preserves idle epoch, init and continuous fragment output', (t) => {
  const f = setup(t), epoch = f.broker.stream.epoch, initialResets = f.broker.resetCount;
  const pending = f.begin('first'); f.local.binary(pending.bytes.subarray(0, 20));
  f.local.cancel({ id: 'first', allowDrain: false }); f.time.advance(1000);
  assert.equal(f.broker.stream.epoch, epoch);
  assert.equal(f.broker.resetCount, initialResets);
  assert.ok(f.media.length > 5);
  assert.equal(f.local.snapshot().upload_active, false);
});

test('cancel admitted but unsent speech removes only that slot without resetting idle', async (t) => {
  const f = setup(t), epoch = f.broker.stream.epoch; await f.upload('first');
  f.local.cancel({ id: 'first' }); f.time.advance(18000);
  assert.equal(f.broker.stream.epoch, epoch);
  assert.equal(f.local.snapshot().speech_clips, 0);
  assert.equal(f.messages.some((v) => v.type === 'reply.clip.played'), false);
});

test('two admitted jobs finish independently while generation points at the newer job', async (t) => {
  const f = setup(t); await f.upload('first');
  assert.equal(f.local.hasReply('first'), true);
  f.broker.current = { id: 'second' }; await f.upload('second');
  assert.equal(f.local.hasReply('second'), true);
  f.local.markDone('first', { id: 'first', status: 'done' });
  f.time.advance(16050);
  assert.equal(f.finished[0]?.id, 'first');
  assert.equal(f.broker.current.id, 'second');
  assert.equal(f.messages.filter((v) => v.type === 'reply.clip.played' && v.id === 'first').length, 1);
  f.local.markDone('second', { id: 'second', status: 'done' }); f.time.advance(8000);
  assert.equal(f.finished[1]?.id, 'second');
});

test('producer loss drains admitted clip but never acknowledges a replacement worker', async (t) => {
  const f = setup(t), epoch = f.broker.stream.epoch; await f.upload('first');
  f.time.advance(7000); f.local.producerLost();
  f.broker.worker = {}; f.broker.workerInfo.connected = true; f.time.advance(10000);
  assert.equal(f.broker.stream.epoch, epoch);
  assert.equal(f.messages.some((v) => v.type === 'reply.clip.played'), false);
  assert.equal(f.finished[0]?.terminal?.status, 'error');
  assert.equal(f.local.hasReply('first'), false);
});

test('cancelling a second generation cannot remove the first admitted slot', async (t) => {
  const f = setup(t), epoch = f.broker.stream.epoch; await f.upload('first');
  f.broker.current = { id: 'second' }; f.begin('second');
  f.local.cancel({ id: 'second', allowDrain: false }); f.time.advance(16050);
  assert.equal(f.broker.stream.epoch, epoch);
  assert.equal(f.local.hasReply('first'), true);
  assert.equal(f.messages.filter((v) => v.type === 'reply.clip.played' && v.id === 'first').length, 1);
});

test('integration callback exceptions do not stop the independent idle scheduler', (t) => {
  const time = clock(), output = [], faults = [];
  const player = new LocalPlayout({ idleClips: clips(), ...time, random: () => 0,
    sink(bytes) { output.push(bytes); return { accepted: true, pendingBytes: 0 }; },
    onClipStart() { throw new Error('integration callback'); }, onFault: (event) => faults.push(event) });
  t.after(() => player.stop()); player.start(); time.advance(9000);
  assert.equal(player.snapshot().running, true);
  assert.ok(output.length >= 20);
  assert.equal(faults.length, 0);
  assert.ok(player.snapshot().callback_errors >= 1);
});

test('future fragment waiting reuses one rewritten buffer instead of copying it on every tick', (t) => {
  const time = clock(); let rewrites = 0;
  class CountedClip extends EncodedClip {
    rewrite(...args) { rewrites++; return super.rewrite(...args); }
  }
  const player = new LocalPlayout({ idleClips: [1, 2, 3].map((marker) => new CountedClip(clipBytes({ marker, parts: 15 }))),
    ...time, random: () => 0, sink: () => ({ accepted: true, pendingBytes: 0 }) });
  t.after(() => player.stop()); player.start(); time.advance(1000);
  assert.ok(rewrites <= player.snapshot().fragments + 1, `rewrites=${rewrites}`);
});

test('late asynchronous validation result cannot resurrect an interrupted generation or reset idle', async (t) => {
  let resolveValidation;
  const f = setup(t, { normalizeReply: () => new Promise((resolve) => { resolveValidation = resolve; }) });
  const value = f.begin('first'), epoch = f.broker.stream.epoch; f.local.binary(value.bytes);
  const validation = f.local.end({ id: 'first', sha256: value.meta.sha256 });
  assert.equal(f.local.snapshot().validation_active, true);
  f.local.cancel({ id: 'first' }); f.time.advance(1000);
  resolveValidation({ clip: new EncodedClip(value.bytes) }); await validation;
  assert.equal(f.local.hasReply('first'), false); assert.equal(f.broker.stream.epoch, epoch);
  assert.equal(f.messages.some((v) => v.type === 'reply.clip.accepted'), false);
});

test('actual scheduler faults preserve lifetime reason across player recovery', async (t) => {
  let first = true;
  const f = setup(t, { random: () => { if (first) { first = false; return 99; } return 0; } });
  assert.equal(f.local.snapshot().scheduler_faults_total, 1);
  f.time.advance(250);
  assert.equal(f.local.snapshot().stream_restarts, 1);
  assert.equal(f.local.snapshot().last_fault_code, 'PLAYOUT_RANDOM');
  assert.equal(f.local.snapshot().faults, 0, 'new player counter cannot erase the lifetime fault');
});

test('persistent genuine scheduler failure cannot spin immediate restart epochs', (t) => {
  const f = setup(t, { random: () => 99 }); f.time.advance(1000);
  assert.equal(f.local.snapshot().scheduler_faults_total, 5);
  assert.equal(f.local.snapshot().stream_restarts, 4);
});
