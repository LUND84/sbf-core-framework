import { AutonomousWarm } from './autonomous-warm.js';

const topics = [
  ['Bitcoin 与区块空间', 'Bitcoin block space, fees, and why settlement matters'],
  ['稳定币', 'stablecoin reserves, redemption, and payment use cases'],
  ['DeFi 流动性', 'DeFi liquidity pools and the tradeoffs of automated market makers'],
  ['钱包与私钥', 'wallet security, private keys, and self-custody tradeoffs'],
  ['以太坊', 'Ethereum validators, staking, and network incentives'],
  ['Layer 2', 'Layer 2 scaling and the tradeoffs around bridges and sequencers'],
  ['交易所风控', 'exchange risk management, collateral, and leverage'],
  ['链上透明度', 'on-chain transparency and the limits of proof of reserves'],
  ['代币经济', 'token incentives, supply schedules, and sustainable demand'],
  ['MEV', 'MEV and transaction ordering as a market design problem'],
  ['跨链', 'cross-chain interoperability and bridge security assumptions'],
  ['Crypto 应用', 'practical crypto applications and how to evaluate their usefulness'],
];

const prompt = subject => `Continue your crypto monologue about ${subject}. `
  + 'Deliver one connected spoken thought lasting about 10 seconds, around 22–28 English words. '
  + 'Build directly on your previous point, add one useful detail, and avoid repeating its opening. '
  + 'If the topic changes, bridge naturally from the previous point. Do not address an imaginary viewer.';

// Actor admission stays serial; compatible workers may prepare one future text/PCM ticket.
// Reason: readiness must improve without a second video producer or an unbounded speech backlog.
export class AutonomousTalk {
  constructor(broker, { now = Date.now, schedule = setTimeout, cancel = clearTimeout } = {}) {
    this.broker = broker;
    this.now = now; this.schedule = schedule; this.cancel = cancel;
    this.enabled = false; this.state = 'disabled'; this.completed = 0;
    this.topicIndex = 0; this.topic = null; this.activeId = null;
    this.topicCompleted = 0; this.lastThought = '';
    this.failures = 0; this.lastError = null; this.nextAt = 0; this.timer = null;
    this.closed = false;
    this.warm = new AutonomousWarm(broker);
    this.onStatus = () => this.update();
    this.onChat = event => this.observe(event);
    broker.on('status', this.onStatus);
    broker.on('chat', this.onChat);
  }

  snapshot() {
    return { enabled: this.enabled, state: this.state, completed: this.completed,
      topic: this.topic, lastError: this.lastError };
  }

  owns(id) { return Boolean(id && this.activeId === id); }

  setEnabled(enabled) {
    if (this.closed) return this.snapshot();
    if (enabled && !this.enabled) {
      this.failures = 0; this.lastError = null; this.nextAt = this.now();
    }
    if (!enabled) this.warm.clear();
    this.enabled = enabled;
    this.update();
    this.broker.publishStatus();
    return this.snapshot();
  }

  ready() {
    const b = this.broker;
    return b.generationReady()
      && b.workerInfo.mode === 'avatar' && b.workerInfo.autonomousCrypto === true
      && !b.interrupting && !b.current && !b.pending.length && !b.activeJobs.size;
  }

  update() {
    if (this.closed) return;
    this.warm.checkSource();
    const previous = this.state;
    if (!this.enabled) this.state = this.lastError ? 'error' : 'disabled';
    else if (this.activeId) this.state = 'generating';
    else if (!this.ready()) this.state = 'waiting';
    else {
      const delay = Math.max(0, this.nextAt - this.now());
      this.state = delay ? 'cooldown' : 'waiting';
      if (this.timer === null) {
        this.timer = this.schedule(() => { this.timer = null; this.tick(); }, delay);
        this.timer?.unref?.();
      }
    }
    if (!this.enabled || this.activeId || !this.ready()) this.clearTimer();
    if (previous !== this.state) this.broker.publishStatus();
  }

  tick() {
    if (this.closed || !this.enabled || !this.ready()) return this.update();
    const [label, subject] = topics[this.topicIndex % topics.length];
    this.topic = label;
    // The mode's full terminal, rather than chat.rendered, unlocks the next turn.
    // Reason: a reply must finish actor output or legacy playback before another autonomous turn.
    const request = this.warm.take(this.topicIndex) || this.broker.createRequest(
      prompt(subject)
      + (this.lastThought ? ` Previous completed narration (context, not a script to repeat): ${JSON.stringify(this.lastThought)}` : ''),
      { kind: 'autonomous-crypto', source: 'autonomous-crypto', narrationTargetSeconds: 10 });
    const nextTopic = this.topicIndex + (this.topicCompleted + 1 >= 6 ? 1 : 0);
    this.warm.plan(request, prompt(topics[nextTopic % topics.length][1]), nextTopic);
    this.activeId = request.id;
    this.broker.enqueue(request);
    this.broker.dispatch();
    this.update(); this.broker.publishStatus();
  }

  observe(event) {
    if (!this.owns(event.id) || !['done', 'error', 'interrupted'].includes(event.status)) return;
    this.activeId = null;
    if (event.status === 'done') {
      this.warm.completed(event.id, event.text);
      this.completed += 1; this.failures = 0; this.lastError = null;
      if (typeof event.text === 'string' && event.text.trim()) this.lastThought = event.text.trim().slice(-600);
      // Keep a topic for about a minute, advancing only after completed speech.
      // Reason: changing subjects every ten seconds breaks the continuing thought.
      if (++this.topicCompleted >= 6) { this.topicCompleted = 0; this.topicIndex += 1; }
    } else if (event.status === 'error') {
      this.warm.clear();
      this.failures += 1;
      this.lastError = '主动讲话未完成；请检查设备状态后重试。';
      // Bounded exponential backoff stops a broken warm actor from being hammered.
      // Reason: a generation fault must not become an endless background retry loop.
      if (this.failures >= 3) this.enabled = false;
    } else this.warm.clear();
    const delay = event.status === 'error' ? Math.min(60000, 5000 * 2 ** (this.failures - 1))
      // A continuous source needs no legacy clip boundary cooldown.
      // Reason: terminal admission already releases the serial actor; an extra second creates audible dead air.
      : this.warm.capable() ? 0
        : this.broker.continuousActor() ? Math.min(100, this.broker.config.autonomousGapMs ?? 1000)
        : (this.broker.config.autonomousGapMs ?? 1000);
    this.nextAt = this.now() + delay;
  }

  clearTimer() {
    if (this.timer !== null) this.cancel(this.timer);
    this.timer = null;
  }

  close() {
    this.warm.clear();
    this.closed = true; this.enabled = false; this.clearTimer();
    this.broker.off('status', this.onStatus);
    this.broker.off('chat', this.onChat);
  }
}
