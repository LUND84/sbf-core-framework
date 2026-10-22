import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Broker } from '../server/broker.js';
import { readConfig } from '../server/config.js';

function fixture(t, warm = true) {
  let now = 0;
  const timers = new Set();
  const worker = Object.assign(new EventEmitter(), { readyState: 1, bufferedAmount: 0, messages: [],
    send(data) { this.messages.push(JSON.parse(data)); }, close() {}, terminate() {} });
  const broker = new Broker(readConfig({ CONTINUOUS_ACTOR_ENABLED: '1' }), {
    actorSourceFactory: () => ({ start() {}, close() {}, snapshot: () => ({ ready: true }) }),
    autonomousOptions: { now: () => now,
      schedule(fn, delay) { const timer = { fn, at: now + delay }; timers.add(timer); return timer; },
      cancel: timer => timers.delete(timer) },
  });
  broker.attachWorker(worker);
  broker.receiveWorker({ type: 'worker.hello', mode: 'avatar', chatMode: 'llm', autonomousCrypto: 1,
    mediaMode: 'continuous-actor-v1', ...(warm ? { warm_prefetch: 1 } : {}) });
  const advance = ms => {
    const end = now + ms; let count = 0;
    while (true) {
      const next = [...timers].sort((a, b) => a.at - b.at)[0];
      if (!next || next.at > end) break;
      timers.delete(next); now = next.at; next.fn(); assert.ok(++count < 100);
    }
    now = end;
  };
  const requests = () => worker.messages.filter(x => x.type === 'chat.request');
  const terminal = (id, text = 'Bitcoin settlement uses scarce block space.', status = 'done') =>
    broker.receiveWorker({ type: 'chat.event', id, text, role: 'assistant', status });
  broker.autonomous.setEnabled(true); advance(0);
  t.after(() => broker.close());
  return { broker, worker, requests, terminal, advance };
}

test('warm worker receives one next plan while the current actor remains the sole active turn', t => {
  const f = fixture(t), first = f.requests()[0];
  assert.ok(first.warmNext, 'next preparation must be dispatched before current done');
  assert.equal(first.warmNext.parentId, first.id);
  assert.notEqual(first.warmNext.id, first.id);
  assert.match(first.warmNext.text, /Bitcoin/);
  assert.equal(f.broker.activeJobs.size, 1);
  f.advance(2900);
  assert.equal(f.requests().length, 1, 'preparation must not start a second actor');
  const previous = 'A quoted "Bitcoin" thought.';
  f.terminal(first.id, previous); f.advance(0);
  const next = f.requests()[1];
  assert.equal(next.id, first.warmNext.id, 'ready continuation consumes the same private ticket');
  assert.equal(next.warmParentId, first.id);
  assert.equal(next.warmEpoch, first.warmNext.epoch);
  assert.equal(next.text, first.warmNext.text
    + ` Previous completed narration (context, not a script to repeat): ${JSON.stringify(previous)}`);
  assert.equal(next.warmNext.parentId, next.id);
  assert.equal(f.broker.activeJobs.size, 1);
});

test('queued viewer cancels speculative preparation and wins the next real actor slot', t => {
  const f = fixture(t), first = f.requests()[0];
  const viewer = f.broker.submit('Explain ETH.');
  assert.ok(f.worker.messages.some(x => x.type === 'warm.clear'));
  assert.equal(f.broker.current.id, first.id);
  f.terminal(first.id); assert.equal(f.requests()[1].id, viewer.id);
  f.terminal(viewer.id, 'Ethereum uses validators.'); f.advance(0);
  const next = f.requests()[2];
  assert.notEqual(next.id, first.warmNext.id);
  assert.notEqual(next.warmNext.epoch, first.warmNext.epoch);
});

test('pause discards only future preparation and cannot replay it after re-enable', t => {
  const f = fixture(t), first = f.requests()[0];
  f.broker.autonomous.setEnabled(false);
  assert.equal(f.broker.current.id, first.id);
  assert.ok(f.worker.messages.some(x => x.type === 'warm.clear'));
  assert.ok(!f.worker.messages.some(x => x.type === 'interrupt'));
  f.terminal(first.id); f.advance(30000); assert.equal(f.requests().length, 1);
  f.broker.autonomous.setEnabled(true); f.advance(0);
  assert.notEqual(f.requests()[1].id, first.warmNext.id);
});

test('loss of source readiness invalidates a pending next plan without committing topic progress', t => {
  const f = fixture(t), first = f.requests()[0];
  f.broker.actorSourceState = { ready: false }; f.broker.publishStatus();
  assert.ok(f.worker.messages.some(x => x.type === 'warm.clear'));
  assert.equal(f.broker.autonomous.completed, 0);
  f.terminal(first.id); f.advance(30000); assert.equal(f.requests().length, 1);
  f.broker.actorSourceState = { ready: true }; f.broker.publishStatus(); f.advance(0);
  assert.notEqual(f.requests()[1].id, first.warmNext.id);
});

test('sixth completed thought predicts the next topic, never advancing on speculative preparation', t => {
  const f = fixture(t);
  for (let i = 0; i < 5; i++) {
    f.terminal(f.requests().at(-1).id, `Completed Bitcoin thought ${i}.`); f.advance(0);
  }
  const sixth = f.requests().at(-1);
  assert.match(sixth.text, /Bitcoin/);
  assert.match(sixth.warmNext.text, /stablecoin reserves/);
  assert.equal(f.broker.autonomous.topicIndex, 0);
  f.terminal(sixth.id, 'One final Bitcoin detail.'); f.advance(0);
  assert.equal(f.requests().at(-1).id, sixth.warmNext.id);
  assert.equal(f.broker.autonomous.topicIndex, 1);
});

test('legacy workers keep the original bounded serial cooldown with no speculative protocol', t => {
  const f = fixture(t, false), first = f.requests()[0];
  assert.equal(first.warmNext, undefined);
  f.terminal(first.id); f.advance(99); assert.equal(f.requests().length, 1);
  f.advance(1); assert.equal(f.requests().length, 2);
});

test('failed parent clears the unspoken ticket and does not bypass error backoff', t => {
  const f = fixture(t), first = f.requests()[0];
  f.terminal(first.id, 'An unfinished sentence.', 'error');
  assert.ok(f.worker.messages.some(x => x.type === 'warm.clear'));
  assert.equal(f.broker.autonomous.completed, 0);
  f.advance(4999); assert.equal(f.requests().length, 1);
  f.advance(1); assert.notEqual(f.requests()[1].id, first.warmNext.id);
});
