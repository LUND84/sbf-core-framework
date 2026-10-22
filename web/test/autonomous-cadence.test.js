import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Broker } from '../server/broker.js';
import { readConfig } from '../server/config.js';

function fixture(t, direct = false) {
  let now = 0;
  const timers = new Set();
  const clock = { now: () => now, schedule: (fn, ms) => {
    const timer = { fn, at: now + ms }; timers.add(timer); return timer;
  }, cancel: timer => timers.delete(timer) };
  const broker = new Broker(readConfig(direct ? { CONTINUOUS_ACTOR_ENABLED: '1' } : {}), {
    autonomousOptions: clock,
    ...(direct ? { actorSourceFactory: () => ({ snapshot: () => ({ ready: true }), start() {}, close() {} }) } : {}),
  });
  const worker = Object.assign(new EventEmitter(), { readyState: 1, bufferedAmount: 0,
    messages: [], send(raw) { this.messages.push(JSON.parse(raw)); },
    close() { this.readyState = 3; this.emit('close'); }, terminate() { this.close(); } });
  broker.attachWorker(worker);
  broker.receiveWorker({ type: 'worker.hello', mode: 'avatar', chatMode: 'llm', autonomousCrypto: 1,
    ...(direct ? { mediaMode: 'continuous-actor-v1' } : {}) });
  broker.stream.ready = true;
  const advance = ms => {
    const until = now + ms; let count = 0;
    for (;;) {
      const timer = [...timers].sort((a, b) => a.at - b.at)[0];
      if (!timer || timer.at > until) break;
      timers.delete(timer); now = timer.at; timer.fn();
      assert.ok(++count < 100, 'bounded scheduler');
    }
    now = until;
  };
  const requests = () => worker.messages.filter(item => item.type === 'chat.request');
  const terminal = (id, text, status = 'done') => broker.receiveWorker({
    type: 'chat.event', id, text, role: 'assistant', status });
  t.after(() => broker.close());
  broker.autonomous.setEnabled(true); advance(0);
  return { broker, requests, terminal, advance };
}

test('autonomous turns request a roughly ten second complete spoken thought', t => {
  const f = fixture(t), first = f.requests()[0];
  assert.equal(first.narrationTargetSeconds, 10);
  assert.match(first.text, /10 seconds/);
  assert.match(first.text, /22.{0,3}28.*words/);
  assert.doesNotMatch(first.text, /one or two short spoken sentences/);
  f.advance(60000);
  assert.equal(f.requests().length, 1, 'one actor turn at a time');
});

test('completed narration retains its topic and carries forward the previous thought', t => {
  const f = fixture(t), first = f.requests()[0];
  const reply = 'Scarce Bitcoin block space gives settlement a real cost.';
  f.terminal(first.id, reply); f.advance(1000);
  const next = f.requests()[1];
  assert.match(next.text, /Bitcoin block space/);
  assert.ok(next.text.includes(reply), 'the last completed thought reaches the next prompt');
  assert.equal(next.narrationTargetSeconds, 10);
});

test('failed narration cannot replace the last completed context or advance its topic', t => {
  const f = fixture(t), first = f.requests()[0];
  const reply = 'Bitcoin fees depend on demand for limited block space.';
  f.terminal(first.id, reply); f.advance(1000);
  f.terminal(f.requests()[1].id, 'A partial uncommitted thought.', 'error'); f.advance(5000);
  const retry = f.requests()[2];
  assert.ok(retry.text.includes(reply));
  assert.ok(!retry.text.includes('partial uncommitted'));
  assert.match(retry.text, /Bitcoin block space/);
});

test('continuous actor resumes narration promptly after completion while queued viewers win', t => {
  const f = fixture(t, true), first = f.requests()[0];
  const viewer = f.broker.submit('Explain Bitcoin settlement.');
  f.terminal(first.id, 'Bitcoin block space is limited.');
  assert.equal(f.requests()[1].id, viewer.id);
  f.terminal(viewer.id, 'Settlement confirms ownership.');
  f.advance(99); assert.equal(f.requests().length, 2);
  f.advance(1); assert.equal(f.requests().length, 3);
  assert.equal(f.requests()[2].kind, 'autonomous-crypto');
});
