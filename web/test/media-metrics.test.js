import test from 'node:test';
import assert from 'node:assert/strict';
import { MediaMetrics } from '../server/media-metrics.js';

test('fragment arrivals and cache contents remain distinct, with age from the last arrival', () => {
  let time = 100;
  const metrics = new MediaMetrics({ now: () => time });
  assert.deepEqual(metrics.snapshot(), {
    epoch_elapsed_ms: 0, init_bytes: 0,
    fragments: { count: 0, bytes: 0, max_bytes: 0, last_age_ms: null },
    cache: { fragments: 0, bytes: 0 },
    viewers: { pending_high_water_bytes: 0, backpressure_closes: 0 },
  });
  metrics.setInitBytes(1306);
  time = 125;
  metrics.recordFragment(1000);
  metrics.setCache(1, 1000);
  time = 180;
  metrics.recordFragment(7 * 1024 ** 2);
  metrics.setCache(0, 0);
  time = 200;
  const snapshot = metrics.snapshot();
  assert.equal(snapshot.epoch_elapsed_ms, 100);
  assert.equal(snapshot.init_bytes, 1306);
  assert.deepEqual(snapshot.fragments, {
    count: 2, bytes: 1000 + 7 * 1024 ** 2, max_bytes: 7 * 1024 ** 2, last_age_ms: 20,
  });
  assert.deepEqual(snapshot.cache, { fragments: 0, bytes: 0 });
  time = 500;
  assert.equal(metrics.snapshot().fragments.last_age_ms, 320);
});

test('viewer pending is an aggregate high-water value and closes count only explicit records', () => {
  const metrics = new MediaMetrics();
  metrics.recordViewerPending(300);
  metrics.recordViewerPending(5 * 1024 ** 2);
  metrics.recordViewerPending(0);
  assert.deepEqual(metrics.snapshot().viewers, {
    pending_high_water_bytes: 5 * 1024 ** 2, backpressure_closes: 0,
  });
  metrics.recordBackpressureClose();
  metrics.recordBackpressureClose();
  assert.equal(metrics.snapshot().viewers.backpressure_closes, 2);
});

test('reset clears all epoch aggregates and does not expose mutable internal state', () => {
  let time = 10;
  const metrics = new MediaMetrics({ now: () => time });
  metrics.setInitBytes(1200);
  metrics.recordFragment(50);
  metrics.setCache(1, 50);
  metrics.recordViewerPending(60);
  metrics.recordBackpressureClose();
  const old = metrics.snapshot();
  old.fragments.bytes = 999;
  old.cache.bytes = 999;
  old.viewers.backpressure_closes = 999;
  assert.equal(metrics.snapshot().fragments.bytes, 50);
  assert.equal(metrics.snapshot().cache.bytes, 50);
  assert.equal(metrics.snapshot().viewers.backpressure_closes, 1);
  time = 90;
  metrics.reset();
  time = 110;
  assert.deepEqual(metrics.snapshot(), {
    epoch_elapsed_ms: 20, init_bytes: 0,
    fragments: { count: 0, bytes: 0, max_bytes: 0, last_age_ms: null },
    cache: { fragments: 0, bytes: 0 },
    viewers: { pending_high_water_bytes: 0, backpressure_closes: 0 },
  });
});

test('elapsed values are nonnegative and malformed counter values are rejected', () => {
  let time = 100;
  const metrics = new MediaMetrics({ now: () => time });
  metrics.recordFragment(100);
  time = 50;
  assert.equal(metrics.snapshot().epoch_elapsed_ms, 0);
  assert.equal(metrics.snapshot().fragments.last_age_ms, 0);
  for (const value of [-1, 0.5, NaN, Infinity, '1', Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => metrics.setInitBytes(value), TypeError);
    assert.throws(() => metrics.recordFragment(value), TypeError);
    assert.throws(() => metrics.recordViewerPending(value), TypeError);
    assert.throws(() => metrics.setCache(value, 0), TypeError);
    assert.throws(() => metrics.setCache(0, value), TypeError);
  }
  metrics.recordFragment(Number.MAX_SAFE_INTEGER);
  metrics.recordFragment(100);
  assert.equal(metrics.snapshot().fragments.bytes, Number.MAX_SAFE_INTEGER);
  assert.equal(metrics.snapshot().fragments.max_bytes, Number.MAX_SAFE_INTEGER);
});
