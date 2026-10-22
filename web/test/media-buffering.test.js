import test from 'node:test';
import assert from 'node:assert/strict';
import { LivePlayer } from '../public/media.js';
import { StreamWatchdog } from '../public/stream-watchdog.js';

class Video extends EventTarget {
  constructor() {
    super();
    this.autoplay = true;
    this.paused = true;
    this.readyState = 4;
    this.currentTime = 0;
    this.playbackRate = 1;
    this.playCalls = 0;
    this.pauseCalls = 0;
    this.ranges = [];
  }

  get buffered() {
    return { length: this.ranges.length, start: (i) => this.ranges[i].start,
      end: (i) => this.ranges[i].end };
  }

  play() {
    this.playCalls += 1;
    this.paused = false;
    this.dispatchEvent(new Event('play'));
    this.dispatchEvent(new Event('playing'));
    return Promise.resolve();
  }

  pause() {
    if (this.paused) return;
    this.pauseCalls += 1;
    this.paused = true;
    const dispatch = () => this.dispatchEvent(new Event('pause'));
    if (this.deferPauseEvent) queueMicrotask(dispatch);
    else dispatch();
  }
}

function harness({ current = 0, end = 0.5, playing = false } = {}) {
  globalThis.window = { setInterval: () => 1 };
  const video = new Video();
  video.ranges = [{ start: Math.min(0, current), end }];
  video.currentTime = current;
  const states = [];
  const player = new LivePlayer(video, (state) => states.push(state), () => {});
  player.source = {};
  player.setState('buffering');
  if (playing) {
    video.paused = false;
    video.dispatchEvent(new Event('playing'));
  }
  return { video, player, states };
}

test('loadeddata cannot start a half-second fragment before the two-second reserve exists', async () => {
  const { video, player } = harness();
  video.dispatchEvent(new Event('loadeddata'));
  await Promise.resolve();
  assert.equal(video.autoplay, false, 'HTML autoplay must not bypass the application buffer gate');
  assert.equal(video.playCalls, 0);
  assert.equal(player.state, 'buffering');
  video.ranges[0].end = 1.5;
  player.correctPlayback();
  assert.equal(video.playCalls, 0);
  video.ranges[0].end = 2.05;
  player.correctPlayback();
  assert.equal(video.playCalls, 1);
  assert.equal(player.state, 'playing');
});

test('26ms edge reserve pauses both tracks together, replenishes two seconds, then resumes', () => {
  const { video, player } = harness({ current: 123.524, end: 126, playing: true });
  video.ranges = [{ start: 110, end: 123.550 }];
  player.correctPlayback();
  assert.equal(video.paused, true);
  assert.equal(player.state, 'buffering', 'An internal pause must not become a manual pause');
  assert.equal(Boolean(player.playBlocked), false);
  assert.equal(video.currentTime, 123.524, 'Rebuffering must preserve the shared audio/video position');
  for (const end of [124.050, 124.550, 125.050]) {
    video.ranges[0].end = end;
    player.correctPlayback();
    assert.equal(video.paused, true);
  }
  video.ranges[0].end = 125.550;
  player.correctPlayback();
  assert.equal(video.paused, false);
  assert.equal(video.playCalls, 1);
  assert.equal(player.state, 'playing');
});

test('normal catchup does not consume the target reserve under a one-to-one source clock', () => {
  const { video, player } = harness({ current: 8, end: 10, playing: true });
  for (let step = 0; step < 60; step += 1) {
    player.correctPlayback();
    assert.equal(video.playbackRate, 1, 'Exactly the target reserve must not accelerate playback');
    video.currentTime += 0.5 * video.playbackRate;
    video.ranges[0].end += 0.5;
  }
  assert.equal(video.pauseCalls, 0);
  assert.equal(player.snapshot().bufferAheadSeconds, 2);
});

test('manual pause stays paused despite loadeddata, new fragments and maintenance', async () => {
  const { video, player } = harness({ current: 8, end: 10, playing: true });
  video.pause();
  const position = video.currentTime;
  video.ranges[0].end = 18;
  video.dispatchEvent(new Event('loadeddata'));
  player.correctPlayback();
  await Promise.resolve();
  assert.equal(player.state, 'paused');
  assert.equal(video.playCalls, 0);
  assert.equal(video.currentTime, position);
  player.goLive();
  assert.equal(video.paused, false, 'An explicit return-to-live action may resume');
});

test('ordinary two-second accumulation is not a watchdog fault, real starvation still recovers', () => {
  let now = 0;
  const watchdog = new StreamWatchdog({ now: () => now });
  const { player, video } = harness({ current: 0, end: 0.1 });
  for (let step = 0; step < 5; step += 1) {
    now = step * 500;
    player.receivedBytes = 1306 + step * 100000;
    video.ranges[0].end = 0.1 + step * 0.5;
    player.correctPlayback();
    assert.equal(watchdog.sample({ online: true, streamReady: true, ...player.snapshot() }), false);
  }
  video.ranges[0].end = video.currentTime + 0.026;
  player.correctPlayback();
  now += 9999;
  assert.equal(watchdog.sample({ online: true, streamReady: true, ...player.snapshot() }), false);
  now += 1;
  assert.equal(watchdog.sample({ online: true, streamReady: true, ...player.snapshot() }), true);
});

test('a native fullscreen play action releases manual pause and returns to the two-second reserve', () => {
  const { video, player } = harness({ current: 8, end: 10, playing: true });
  video.pause();
  assert.equal(player.state, 'paused');
  video.ranges[0].end = 18;
  video.play();
  assert.equal(video.currentTime, 16);
  assert.equal(player.state, 'playing');
  assert.equal(player.playBlocked, false);
});

test('fragment callbacks before the queued manual pause event cannot restart playback', async () => {
  const { video, player } = harness({ current: 8, end: 10, playing: true });
  video.deferPauseEvent = true;
  video.pause();
  video.ranges[0].end = 12;
  player.correctPlayback();
  video.dispatchEvent(new Event('loadeddata'));
  await Promise.resolve();
  assert.equal(video.paused, true);
  assert.equal(video.playCalls, 0);
  assert.equal(player.state, 'paused');
});

test('an old internal pause event arriving after resume does not become a user pause', async () => {
  const { video, player } = harness({ current: 8, end: 10, playing: true });
  video.deferPauseEvent = true;
  video.ranges[0].end = 8.026;
  player.correctPlayback();
  video.ranges[0].end = 10.1;
  player.correctPlayback();
  await Promise.resolve();
  assert.equal(video.paused, false);
  assert.equal(Boolean(player.playBlocked), false);
  assert.equal(player.state, 'playing');
});
