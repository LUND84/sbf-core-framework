import test from 'node:test';
import assert from 'node:assert/strict';
import { readConfig } from '../server/config.js';
import { RateLimiter, safeEqual } from '../server/auth.js';

test('public production startup requires real secrets and bounds resource limits', () => {
  assert.throws(() => readConfig({ NODE_ENV: 'production' }), /Production requires/);
  assert.throws(() => readConfig({ MAX_VIEWERS: '1000000' }), /MAX_VIEWERS/);
  assert.throws(() => readConfig({ PORT: 'NaN' }), /PORT/);
  assert.equal(readConfig({ PORT: '0' }).port, 0);
});

test('rate limits reset after their time window and tokens compare exactly', () => {
  let now = 0;
  const limit = new RateLimiter(2, 1000, () => now);
  assert.equal(limit.allow('one'), true);
  assert.equal(limit.allow('one'), true);
  assert.equal(limit.allow('one'), false);
  now = 1001;
  assert.equal(limit.allow('one'), true);
  assert.equal(safeEqual('abc', 'abcd'), false);
  assert.equal(safeEqual('abc', 'abc'), true);
});
