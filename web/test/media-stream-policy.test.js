import test from 'node:test';
import assert from 'node:assert/strict';
import { LivePlayer } from '../public/media.js';

const policy = { targetSeconds: 1.2, lowWaterSeconds: 0.25, maxLagSeconds: 2.5 };
const stream = { epoch: 'policy-fixture', mime: 'video/mp4', source: 'local-playlist-stream', playbackPolicy: policy };
function harness(t) {
  const prior = { window: globalThis.window, media: globalThis.MediaSource, create: URL.createObjectURL, revoke: URL.revokeObjectURL };
  t.after(() => { globalThis.window = prior.window; globalThis.MediaSource = prior.media;
    URL.createObjectURL = prior.create; URL.revokeObjectURL = prior.revoke; });
  class Source extends EventTarget { static isTypeSupported() { return true; } }
  class Video extends EventTarget {
    paused = true; currentTime = 0;
    get buffered() { return { length: 0 }; }
    pause() {} removeAttribute() {} load() {}
  }
  globalThis.window = { MediaSource: Source }; globalThis.MediaSource = Source;
  URL.createObjectURL = () => 'blob:policy-fixture'; URL.revokeObjectURL = () => {};
  return new LivePlayer(new Video(), () => {}, () => {});
}

test('only paired streamed metadata selects the low-latency policy and a later legacy reset restores defaults', t => {
  const player = harness(t); player.reset(stream);
  assert.equal(player.state, 'buffering'); assert.equal(player.targetDelay, 1.2);
  assert.equal(player.lowWaterSeconds, 0.25); assert.equal(player.maxLagSeconds, 2.5);
  assert.deepEqual(player.snapshot().playbackPolicy, policy);
  player.reset({ epoch: 'legacy', mime: 'video/mp4', source: 'local-playlist' });
  assert.equal(player.targetDelay, 2); assert.equal(player.lowWaterSeconds, 0.5); assert.equal(player.maxLagSeconds, 4.5);
});

test('incomplete, excessive or mismatched policies fail closed instead of silently lowering the buffer gate', t => {
  const player = harness(t);
  for (const meta of [
    null, [],
    { ...stream, playbackPolicy: undefined }, { ...stream, playbackPolicy: null },
    { ...stream, source: 'local-playlist' }, { ...stream, source: undefined },
    ...[{}, { ...policy, extra: 1 }, { ...policy, targetSeconds: NaN }, { ...policy, targetSeconds: '1.2' },
      { ...policy, targetSeconds: 1, lowWaterSeconds: 0.5 }, { ...policy, lowWaterSeconds: 0 },
      { ...policy, targetSeconds: 0.5 }, { ...policy, maxLagSeconds: 1.3 },
      { ...policy, maxLagSeconds: 100 }].map(value => ({ ...stream, playbackPolicy: value })),
  ]) {
    player.reset(meta); assert.equal(player.state, 'error'); assert.equal(player.source, null);
  }
});
