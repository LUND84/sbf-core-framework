import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Broker } from '../server/broker.js';
import { readConfig } from '../server/config.js';
import { EncodedClip } from '../server/local-fmp4.js';
import { clipBytes } from './fixtures/local-fmp4-fixture.js';

function setup(t, enabled = true) {
  let sourceOptions;
  const source = { state: { ready: false, reason: 'warming' },
    start() {}, close() {}, snapshot() { return this.state; },
    set(ready) { this.state = { ready, reason: ready ? 'flowing' : 'stalled' }; sourceOptions.onChange(this.state); } };
  const clips = [1, 2, 3].map(marker => new EncodedClip(clipBytes({ marker, parts: 15 })));
  const broker = new Broker({ ...readConfig({ IDLE_PLAYLIST_MANIFEST: 'unit-injected' }),
    continuousActorEnabled: enabled }, { idlePlaylist: { clips },
    localOptions: { schedule: () => 1, cancel() {} },
    actorSourceFactory: options => { sourceOptions = options; return source; } });
  broker.stream.ready = true;
  const worker = Object.assign(new EventEmitter(), { readyState: 1, bufferedAmount: 0, messages: [],
    send(data) { this.messages.push(JSON.parse(data)); }, close() { this.readyState = 3; this.emit('close'); },
    terminate() { this.close(); } });
  broker.attachWorker(worker);
  const hello = () => broker.receiveWorker({ type: 'worker.hello', mode: 'avatar', chatMode: 'llm',
    mediaMode: 'continuous-actor-v1', autonomousCrypto: 1, reply_pipeline: 1 });
  const terminal = id => broker.receiveWorker({ type: 'chat.event', id, role: 'assistant',
    text: 'Crypto has interesting tradeoffs.', status: 'done' });
  t.after(() => broker.close());
  return { broker, worker, source, hello, terminal };
}

test('continuous actor control negotiates independently of legacy local playout and needs flowing source', t => {
  const f = setup(t); f.hello();
  assert.equal(f.broker.workerInfo.mediaMode, 'continuous-actor-v1');
  assert.equal(f.broker.workerInfo.replyPipeline, false);
  assert.throws(() => f.broker.submit('Explain Bitcoin'), error => error.statusCode === 503);
  f.source.set(true);
  const first = f.broker.submit('Explain Bitcoin');
  f.terminal(first.id);
  assert.equal(f.broker.activeJobs.size, 0);
  assert.equal(f.broker.history.at(-1).status, 'done');
  assert.equal(f.worker.messages.some(m => m.type.includes('reply.') || m.type === 'worker.ready'), false);
  assert.equal(f.broker.local.hasReply(first.id), false);
});

test('source loss holds queued chat and autonomous continuation until media resumes', t => {
  const f = setup(t); f.hello(); f.source.set(true);
  const first = f.broker.submit('First'), second = f.broker.submit('Second');
  f.source.set(false); f.terminal(first.id);
  assert.equal(f.broker.current, null);
  assert.equal(f.broker.pending[0].id, second.id);
  f.broker.autonomous.setEnabled(true);
  assert.equal(f.broker.autonomous.ready(), false);
  f.source.set(true);
  assert.equal(f.broker.current.id, second.id);
  f.terminal(second.id);
  assert.equal(f.broker.autonomous.ready(), true);
});

test('continuous mode is opt-in and refuses media upload and reset messages', t => {
  const disabled = setup(t, false);
  assert.throws(() => disabled.hello(), /Incompatible/);
  const f = setup(t); f.hello();
  for (const message of [{ type: 'stream.reset' }, { type: 'stream.reply.begin' }, { type: 'reply.clip.begin' }]) {
    assert.throws(() => f.broker.receiveWorker(message));
  }
});
