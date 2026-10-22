import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Broker } from '../server/broker.js';
import { readConfig } from '../server/config.js';

function setup(t, { maxQueue = 20, warm = true } = {}) {
  let now = 0;
  const timers = new Set();
  const worker = Object.assign(new EventEmitter(), { readyState: 1, bufferedAmount: 0, messages: [],
    send(data) { this.messages.push(JSON.parse(data)); }, close() {}, terminate() {} });
  const broker = new Broker({ ...readConfig({ CONTINUOUS_ACTOR_ENABLED: '1' }), maxQueue }, {
    actorSourceFactory: () => ({ start() {}, close() {}, snapshot: () => ({ ready: true }) }),
    autonomousOptions: { now: () => now,
      schedule(fn, delay) { const timer = { fn, at: now + delay }; timers.add(timer); return timer; },
      cancel(timer) { timers.delete(timer); } },
  });
  broker.attachWorker(worker);
  broker.receiveWorker({ type: 'worker.hello', mode: 'avatar', chatMode: 'llm', autonomousCrypto: 1,
    mediaMode: 'continuous-actor-v1', ...(warm ? { warm_prefetch: 1 } : {}) });
  const advance = ms => {
    const end = now + ms;
    let count = 0;
    while (true) {
      const next = [...timers].sort((a, b) => a.at - b.at)[0];
      if (!next || next.at > end) break;
      timers.delete(next); now = next.at; next.fn();
      assert.ok(++count < 100, 'autonomous scheduler must not spin');
    }
    now = end;
  };
  const terminal = (id, extra = {}) => broker.receiveWorker({ type: 'chat.event', id,
    role: 'assistant', status: 'done', text: 'Completed mock turn.', ...extra });
  const requests = () => worker.messages.filter(message => message.type === 'chat.request');
  t.after(() => broker.close());
  return { broker, worker, advance, terminal, requests };
}

function x(id) { return { id, kind: 'chat', source: 'x-live', broadcastId: 'live', eventId: id }; }
function paid(id, amountAtomic = '20000000') {
  return { id, kind: 'chat', source: 'paid-message', paymentId: `payment-${id}`, chain: 'sol',
    ca: 'So11111111111111111111111111111111111111112', amountAtomic,
    symbol: 'MOCK', logoUrl: '/api/module-c/logo/mock' };
}

test('paid messages take the next turn ahead of X and preserve paid FIFO regardless of amount', t => {
  const f = setup(t), current = f.broker.submit('Current turn');
  const firstX = f.broker.submit('First X comment', x('x-1'));
  const secondX = f.broker.submit('Second X comment', x('x-2'));
  const firstPaid = f.broker.submit('First paid comment', paid('paid-1'));
  const secondPaid = f.broker.submit('Larger later paid comment', paid('paid-2', '1000000000'));
  assert.equal(firstX.position, 2);
  assert.equal(secondX.position, 3);
  assert.equal(firstPaid.position, 2);
  assert.equal(secondPaid.position, 3);
  assert.deepEqual(f.broker.pending.map(request => request.id), ['paid-1', 'paid-2', 'x-1', 'x-2']);
  assert.equal(f.broker.current.id, current.id);
  assert.equal(f.worker.messages.some(message => message.type === 'interrupt'), false);
  for (const id of [current.id, 'paid-1', 'paid-2', 'x-1', 'x-2']) f.terminal(id);
  assert.deepEqual(f.requests().map(request => request.id), [current.id, 'paid-1', 'paid-2', 'x-1', 'x-2']);
  assert.equal(f.broker.activeJobs.size, 0);
});

test('a current autonomous turn completes before paid then X and fresh autonomous continuation', t => {
  const f = setup(t);
  f.broker.autonomous.setEnabled(true); f.advance(0);
  const current = f.requests()[0], oldWarm = current.warmNext;
  f.broker.submit('X comment', x('x'));
  f.broker.submit('Paid comment', paid('paid'));
  assert.equal(f.requests().length, 1);
  assert.equal(f.broker.autonomous.warm.next, null);
  assert.ok(f.worker.messages.some(message => message.type === 'warm.clear'));
  assert.equal(f.worker.messages.some(message => message.type === 'interrupt'), false);
  f.terminal(current.id);
  assert.equal(f.broker.autonomous.completed, 1);
  assert.equal(f.requests()[1].id, 'paid');
  f.advance(0); assert.equal(f.requests().length, 2);
  f.terminal('paid'); assert.equal(f.requests()[2].id, 'x');
  f.terminal('x'); f.advance(0);
  const next = f.requests()[3];
  assert.equal(next.source, 'autonomous-crypto');
  assert.notEqual(next.id, oldWarm.id);
  assert.notEqual(next.warmNext.epoch, oldWarm.epoch);
  assert.equal(f.broker.autonomous.completed, 1, 'payment and X replies are not narration progress');
});

test('a paid message arriving after parent completion discards the ready unspoken warm ticket', t => {
  const f = setup(t);
  f.broker.autonomous.setEnabled(true); f.advance(0);
  const current = f.requests()[0];
  f.terminal(current.id);
  assert.equal(f.broker.autonomous.warm.next.completed, true);
  f.broker.submit('Pay before the continuation timer', paid('paid'));
  f.advance(0);
  assert.deepEqual(f.requests().map(request => request.id), [current.id, 'paid']);
  f.terminal('paid'); f.advance(0);
  assert.notEqual(f.requests()[2].id, current.warmNext.id);
  assert.equal(f.requests()[2].kind, 'autonomous-crypto');
});

test('queued autonomous work cannot overtake source classes when readiness resumes', t => {
  const f = setup(t), current = f.broker.submit('Current');
  f.broker.actorSourceState = { ready: false };
  f.broker.enqueue(f.broker.createRequest('Queued narration', {
    id: 'auto', source: 'autonomous-crypto', kind: 'autonomous-crypto' }));
  // Existing accepted work remains queued during a source stall.
  f.broker.actorSourceState = { ready: true };
  f.broker.submit('X', x('x'));
  f.broker.submit('Paid', paid('paid'));
  f.broker.actorSourceState = { ready: false };
  f.terminal(current.id);
  assert.deepEqual(f.broker.pending.map(request => request.id), ['paid', 'x', 'auto']);
  assert.equal(f.requests().length, 1);
  f.broker.actorSourceState = { ready: true }; f.broker.dispatch();
  assert.equal(f.requests()[1].id, 'paid');
  f.terminal('paid'); assert.equal(f.requests()[2].id, 'x');
  f.terminal('x'); assert.equal(f.requests()[3].id, 'auto');
});

test('paid event metadata comes from accepted service request and survives terminal history replay', t => {
  const f = setup(t);
  f.broker.submit('Paid text', paid('paid'));
  f.terminal('paid', { source: 'x-live', ca: 'spoofed', chain: 'bsc', paymentId: 'spoofed' });
  f.broker.chatEvent({ id: 'paid', role: 'system', status: 'error', source: 'x-live', ca: 'spoofed' });
  const events = f.broker.history.filter(event => event.id === 'paid');
  assert.equal(events.length, 3);
  for (const event of events) {
    assert.equal(event.source, 'paid-message');
    assert.equal(event.paymentId, 'payment-paid');
    assert.equal(event.chain, 'sol');
    assert.equal(event.ca, paid('paid').ca);
    assert.equal(event.amountAtomic, '20000000');
    assert.equal(event.symbol, 'MOCK');
    assert.equal(event.logoUrl, '/api/module-c/logo/mock');
  }
});

test('worker-supplied paid source cannot upgrade website or X events', t => {
  const f = setup(t), web = f.broker.submit('Website message');
  f.broker.submit('X comment', x('x'));
  f.terminal(web.id, { source: 'paid-message', paymentId: 'fake', ca: 'fake' });
  f.terminal('x', { source: 'paid-message', paymentId: 'fake', ca: 'fake' });
  const website = f.broker.history.findLast(event => event.id === web.id);
  assert.equal(website.source, undefined);
  assert.equal(website.paymentId, undefined);
  const platform = f.broker.history.findLast(event => event.id === 'x');
  assert.equal(platform.source, 'x-live');
  assert.equal(platform.eventId, 'x');
  assert.equal(platform.paymentId, undefined);
});

test('failure clears pending entries with their paid source intact and no collateral interrupt', t => {
  const f = setup(t), current = f.broker.submit('Current');
  f.broker.submit('Pending paid', paid('paid'));
  f.broker.submit('Pending X', x('x'));
  f.broker.failProducer('Disconnected mock producer.');
  const failed = f.broker.history.filter(event => event.status === 'error');
  assert.deepEqual(new Set(failed.map(event => event.id)), new Set([current.id, 'paid', 'x']));
  assert.equal(failed.find(event => event.id === 'paid').paymentId, 'payment-paid');
  assert.equal(failed.find(event => event.id === 'paid').source, 'paid-message');
  assert.equal(f.worker.messages.some(message => message.type === 'interrupt'), false);
});

test('paid ingress keeps readiness rejection retryable and owns a separate bounded reserve', t => {
  const f = setup(t, { maxQueue: 1 });
  f.broker.actorSourceState = { ready: false };
  assert.throws(() => f.broker.submit('Offline payment', paid('offline')), error => error.statusCode === 503);
  assert.equal(f.broker.history.length, 0);
  f.broker.actorSourceState = { ready: true };
  f.broker.submit('Current'); f.broker.submit('Queued X', x('x'));
  assert.doesNotThrow(() => f.broker.submit('Reserved queue payment', paid('reserved')));
  assert.throws(() => f.broker.submit('Full paid reserve', paid('full')), error => error.statusCode === 429);
  assert.equal(f.broker.history.some(event => event.paymentId === 'payment-full'), false);
  assert.deepEqual(f.broker.pending.map(request => request.source), ['paid-message', 'x-live']);
});

test('eight full X entries cannot make a verified payment miss the next actor turn', t => {
  const f = setup(t, { maxQueue: 8 }), current = f.broker.submit('Current');
  for (let i = 0; i < 8; i++) f.broker.submit(`X ${i}`, x(`x-${i}`));
  assert.throws(() => f.broker.submit('Ninth X', x('x-overflow')), error => error.statusCode === 429);
  const receipt = f.broker.submit('Paid ahead of the full X queue', paid('paid'));
  assert.equal(receipt.position, 2);
  assert.equal(f.broker.pending.length, 9);
  f.terminal(current.id);
  assert.equal(f.requests()[1].id, 'paid');
  assert.equal(f.worker.messages.some(message => message.type === 'interrupt'), false);
  f.terminal('paid');
  assert.equal(f.requests()[2].id, 'x-0');
});

test('paid reservation never grows the combined pending queue beyond twice maxQueue', t => {
  const f = setup(t, { maxQueue: 8 }), current = f.broker.submit('Current');
  for (let i = 0; i < 8; i++) f.broker.submit(`X ${i}`, x(`x-${i}`));
  for (let i = 0; i < 8; i++) f.broker.submit(`Paid ${i}`, paid(`paid-${i}`));
  assert.equal(f.broker.pending.length, 16);
  assert.equal(f.broker.pending.filter(request => request.source === 'paid-message').length, 8);
  assert.throws(() => f.broker.submit('Paid overflow', paid('paid-overflow')), error => error.statusCode === 429);
  assert.throws(() => f.broker.submit('Website overflow'), error => error.statusCode === 429);
  assert.equal(f.broker.pending.length, 16);
  f.terminal(current.id);
  assert.equal(f.requests()[1].id, 'paid-0');
  assert.doesNotThrow(() => f.broker.submit('Paid enters the freed reservation', paid('paid-next')));
  assert.equal(f.broker.pending.length, 16);
  assert.equal(f.broker.pending[0].id, 'paid-1');
  assert.equal(f.broker.pending[7].id, 'paid-next', 'new paid message stays behind earlier paid messages');
});

test('legacy workers remain serial and plain website chat stays FIFO with X', t => {
  const f = setup(t, { warm: false }), first = f.broker.submit('Website first');
  f.broker.submit('X second', x('x'));
  const third = f.broker.submit('Website third');
  f.terminal(first.id); assert.equal(f.requests()[1].id, 'x');
  f.terminal('x'); assert.equal(f.requests()[2].id, third.id);
  assert.equal(f.worker.messages.some(message => message.type === 'warm.clear'), false);
});
