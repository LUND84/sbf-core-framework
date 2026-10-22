import { randomBytes } from 'node:crypto';
import { PaymentStore } from './store.js';
import { PricingStore, priceUnits } from './pricing.js';
import { fail, normalizeAddress, parseUnits, formatUnits } from './policies.js';
import { verifyPayment } from './chains.js';
import { walletProofMessage, verifyWalletProof } from './wallet-proof.js';
import { PaidMarketContext } from './market-context.js';

const TERMINAL = new Set(['done', 'needs_review']);
const ALERT_DURATIONS = [4000, 5000, 6000, 7000, 8000, 10000, 12000];
const LEGACY_ALERT_THRESHOLDS = [2000n, 5000n, 10000n, 20000n, 50000n, 100000n, 1000000n];
function validAlert(alert) {
  return alert?.version === 1 && Number.isInteger(alert.tierIndex) && alert.tierIndex >= 1 && alert.tierIndex <= 7
    && Number.isSafeInteger(alert.startsAt) && alert.startsAt >= 0 && Number.isSafeInteger(alert.expiresAt)
    && alert.expiresAt - alert.startsAt === ALERT_DURATIONS[alert.tierIndex - 1];
}
function alertTier(order) {
  if (order.tierId !== undefined) {
    const match = typeof order.tierId === 'string' && /^tier-([1-7])$/.exec(order.tierId);
    if (!match) fail('INVALID_ORDER_TIER_SNAPSHOT', 503);
    return Number(match[1]);
  }
  const amount = parseUnits(order.amount, 2);
  const tier = LEGACY_ALERT_THRESHOLDS.findLastIndex(threshold => threshold <= amount) + 1;
  if (!tier) fail('INVALID_ORDER_TIER_SNAPSHOT', 503);
  return tier;
}
export class ModuleC {
  constructor(config, broker, { now = Date.now, verify = verifyPayment, store,
    metadata = async () => ({}), timers = true, verifyWallet = verifyWalletProof, marketContext } = {}) {
    this.config = config; this.broker = broker; this.now = now; this.verifyPayment = verify;
    this.verifyWallet = verifyWallet;
    const market = new PaidMarketContext({ now });
    this.marketContext = marketContext || ((chain, ca) => market.lookup(chain, ca));
    this.metadata = metadata; this.checking = new Map(); this.closed = false; this.draining = false;
    this.store = config.enabled ? store || new PaymentStore(config.dataFile) : null;
    try { this.pricing = new PricingStore(config.pricingDataFile); }
    catch (error) { this.store?.close(); throw error; }
    if (this.store) {
      for (const order of this.store.all()) {
        if (['dispatching', 'queued', 'running'].includes(order.interactionState)) {
          this.store.put({ ...order, interactionState: 'needs_review', error: 'DELIVERY_UNCERTAIN_AFTER_RESTART' });
        }
      }
    }
    this.chatListener = event => this.onChat(event);
    this.statusListener = () => this.drain();
    broker.on('chat', this.chatListener); broker.on('status', this.statusListener);
    if (timers && this.store) {
      this.timer = setInterval(() => this.tick(), 5000); this.timer.unref();
    }
  }
  publicConfig() {
    const pricing = this.pricing.get();
    return { enabled: this.config.enabled, pricing, minAmount: pricing.tiers[0].price,
      paymentMode: 'exact-wallet-v1', gasPaidBy: 'payer',
      secondsPer20: pricing.tiers[0].durationSeconds, displaySlots: 3,
      videoOverlay: this.config.videoOverlay,
      reason: this.config.enabled ? undefined : '收款尚未启用。',
      chains: Object.entries(this.config.chains).map(([id, c]) => ({ id, label: c.label, asset: c.asset,
        recipient: c.recipient, decimals: c.decimals, enabled: c.enabled, tokenAddress: c.tokenAddress })) };
  }
  requireEnabled() {
    if (this.closed) fail('MODULE_C_CLOSED', 503);
    if (!this.store) fail('MODULE_C_DISABLED', 503);
  }
  get(id) {
    this.requireEnabled();
    const order = this.store.get(id); if (!order) fail('ORDER_NOT_FOUND', 404);
    if (order.state === 'awaiting_payment' && this.now() > order.expiresAt) {
      order.state = 'expired'; this.store.put(order);
    }
    return order;
  }
  view(order) {
    return { id: order.id, chain: order.chain, tokenChain: order.tokenChain, ca: order.ca,
      recipient: order.recipient, asset: order.asset, amount: order.amount, payAmount: order.payAmount,
      tierId: order.tierId, pricingRevision: order.pricingRevision, durationMs: order.durationMs,
      paymentMode: order.paymentMode, gasPaidBy: 'payer', walletAuthorizedTxHash: order.walletBinding?.txHash,
      tokenAddress: this.config.chains[order.chain].tokenAddress,
      message: order.message, name: order.name, createdAt: order.createdAt, expiresAt: order.expiresAt,
      state: order.state, interactionState: order.interactionState, txHash: order.txHash,
      startsAt: order.startsAt, boardExpiresAt: order.boardExpiresAt, error: order.error };
  }
  create(body) {
    this.requireEnabled();
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(k => ![
      'chain', 'tokenChain', 'ca', 'message', 'name', 'amount', 'tierId', 'pricingRevision'].includes(k))) fail('INVALID_ORDER');
    const chain = body.chain, c = Object.hasOwn(this.config.chains, chain) ? this.config.chains[chain] : null;
    if (!c?.enabled) fail('PAYMENT_CHAIN_UNAVAILABLE', 503);
    const tokenChain = body.tokenChain || chain;
    if (!Object.hasOwn(this.config.chains, tokenChain)) fail('INVALID_TOKEN_CHAIN');
    const ca = normalizeAddress(tokenChain, body.ca);
    if (typeof body.message !== 'string' || !body.message.trim() || body.message.trim().length > 1000
      || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(body.message)) fail('INVALID_MESSAGE');
    const name = body.name || '匿名观众';
    if (typeof name !== 'string' || name.length > 40 || /[\u0000-\u001f\u007f<>]/u.test(name)) fail('INVALID_NAME');
    const pricing = this.pricing.get(), base = priceUnits(body.amount);
    let tier;
    if (Object.hasOwn(body, 'tierId') || Object.hasOwn(body, 'pricingRevision')) {
      if (typeof body.tierId !== 'string' || !Number.isSafeInteger(body.pricingRevision) || body.pricingRevision < 1) {
        fail('INVALID_ORDER_PRICING');
      }
      if (body.pricingRevision !== pricing.revision) fail('PRICING_REVISION_CONFLICT', 409);
      tier = pricing.tiers.find(t => t.id === body.tierId);
      if (!tier) fail('INVALID_PRICING_TIER');
      if (base !== priceUnits(tier.price)) fail('ORDER_PRICE_MISMATCH');
    } else {
      tier = pricing.tiers.find(t => base === priceUnits(t.price));
      if (!tier) fail('AMOUNT_MUST_MATCH_PRICING_TIER');
    }
    const now = this.now(), orders = this.store.all();
    if (orders.length >= 10000) fail('ORDER_CAPACITY_REACHED', 503);
    // New orders use the tier's exact stablecoin price and require payer ownership proof.
    // Reason: public transaction hashes cannot securely distinguish equal-price orders on their own.
    const exact = base * 10n ** BigInt(c.decimals - 2);
    const order = { id: randomBytes(32).toString('hex'), chain, tokenChain, ca,
      recipient: c.recipient, asset: c.asset, amount: formatUnits(base, 2),
      paymentMode: 'exact-wallet-v1',
      tierId: tier.id, pricingRevision: pricing.revision,
      amountAtomic: String(exact), payAmount: formatUnits(exact, c.decimals),
      message: body.message.trim(), name: name.trim() || '匿名观众',
      createdAt: now, expiresAt: now + this.config.orderTtlMs, state: 'awaiting_payment',
      interactionState: 'waiting', deliveryAttempt: 0, durationMs: tier.durationSeconds * 1000, token: {} };
    this.store.put(order); return this.view(order);
  }
  proofMessage(id, txHash) {
    const order = this.get(id);
    if (order.paymentMode !== 'exact-wallet-v1') fail('WALLET_PROOF_NOT_REQUIRED');
    const canonical = this.canonicalHash(order, txHash);
    return { txHash: canonical, message: walletProofMessage(order, canonical) };
  }
  canonicalHash(order, txHash) {
    if (typeof txHash !== 'string' || txHash.length > 128) fail('INVALID_TX_HASH');
    return order.chain === 'solana' ? txHash.trim()
      : order.chain === 'tron' ? txHash.trim().toLowerCase().replace(/^0x/, '')
        : '0x' + txHash.trim().toLowerCase().replace(/^0x/, '');
  }
  async verify(id, txHash, walletProof) {
    this.requireEnabled();
    if (this.checking.has(id)) { await this.checking.get(id); return this.view(this.get(id)); }
    const promise = this.check(id, txHash, walletProof); this.checking.set(id, promise);
    try { return await promise; } finally { this.checking.delete(id); }
  }
  async check(id, txHash, walletProof) {
    const order = this.get(id);
    if (order.state === 'paid') return this.view(order);
    const canonical = this.canonicalHash(order, txHash);
    if (order.paymentMode !== undefined && order.paymentMode !== 'exact-wallet-v1') fail('INVALID_ORDER_PAYMENT_MODE', 503);
    let walletBinding = order.walletBinding;
    if (order.paymentMode === 'exact-wallet-v1' && walletBinding?.txHash !== canonical) {
      if (!walletProof) fail('WALLET_SIGNATURE_REQUIRED');
      const payer = this.verifyWallet(order, canonical, walletProof);
      walletBinding = { txHash: canonical, payer: normalizeAddress(order.chain, payer), authorizedAt: this.now() };
    }
    // Save the last submitted hash, but reserve global consumption only for confirmed payments.
    // Reason: a pending hash copied from the public mempool must not block its rightful order.
    const collision = this.store.all().find(o => o.id !== id && o.state === 'paid' && o.chain === order.chain && o.txHash === canonical);
    if (collision) {
      this.store.put({ ...order, txHash: undefined, state: this.now() > order.expiresAt ? 'expired' : 'awaiting_payment',
        error: 'TRANSACTION_ALREADY_USED' });
      fail('TRANSACTION_ALREADY_USED', 409);
    }
    const original = { ...order };
    order.txHash = canonical; order.state = 'confirming'; order.error = undefined;
    if (order.paymentMode === 'exact-wallet-v1') order.walletBinding = walletBinding;
    this.store.put(order);
    let proof;
    try { proof = await this.verifyPayment(order, canonical, this.config); }
    catch (error) {
      if (this.closed) throw error;
      if (error.statusCode === 400) {
        // A typo is retryable, whereas a valid pending transaction stays reserved.
        // Reason: users must be able to correct an invalid hash without burning their order.
        this.store.put({ ...original, txHash: undefined,
          state: this.now() > order.expiresAt ? 'expired' : 'awaiting_payment', error: error.message });
      }
      throw error;
    }
    if (this.closed) fail('MODULE_C_CLOSED', 503);
    if (proof.state !== 'confirmed') {
      if (this.now() > order.expiresAt + 24 * 60 * 60 * 1000) {
        this.store.put({ ...order, state: 'expired', error: 'PAYMENT_UNCONFIRMED_AFTER_WINDOW' });
      }
      return this.view(this.get(id));
    }
    if (proof.amountAtomic !== order.amountAtomic || !Number.isFinite(proof.paidAt)) fail('INVALID_PAYMENT_PROOF', 503);
    if (order.paymentMode === 'exact-wallet-v1') {
      let payer;
      try { payer = normalizeAddress(order.chain, proof.payer); } catch { fail('INVALID_PAYMENT_PROOF', 503); }
      if (payer !== order.walletBinding.payer) {
        this.store.put({ ...original, txHash: undefined, walletBinding: undefined,
          state: this.now() > order.expiresAt ? 'expired' : 'awaiting_payment', error: 'PAYMENT_PAYER_MISMATCH' });
        fail('PAYMENT_PAYER_MISMATCH');
      }
    }
    if (this.store.all().some(o => o.id !== id && o.state === 'paid' && o.chain === order.chain && o.txHash === canonical)) {
      fail('TRANSACTION_ALREADY_USED', 409);
    }
    let marketContext;
    try { marketContext = await this.marketContext(order.tokenChain, order.ca); }
    catch { marketContext = { chain: order.tokenChain, ca: order.ca, status: 'unavailable', sourcedAt: this.now() }; }
    // Market lookup yields; recheck transaction ownership immediately before the atomic paid write.
    // Reason: another order may have consumed the same transaction while its context was fetched.
    if (this.store.all().some(o => o.id !== id && o.state === 'paid' && o.chain === order.chain && o.txHash === canonical)) {
      fail('TRANSACTION_ALREADY_USED', 409);
    }
    const at = this.now();
    // Three independent slots preserve every purchased placement under a busy board.
    // Reason: an off-screen paid item must not consume its purchased duration beneath higher amounts.
    const slots = [at, at, at];
    for (const prior of this.store.all()) {
      if (prior.state === 'paid' && Number.isInteger(prior.displaySlot) && prior.displaySlot >= 0 && prior.displaySlot < 3) {
        slots[prior.displaySlot] = Math.max(slots[prior.displaySlot], prior.boardExpiresAt);
      }
    }
    const displaySlot = slots.indexOf(Math.min(...slots)), startsAt = slots[displaySlot];
    const tierIndex = alertTier(order);
    let alertStartsAt = at + 1500;
    for (const prior of this.store.all()) {
      if (prior.state === 'paid' && validAlert(prior.alert)) alertStartsAt = Math.max(alertStartsAt, prior.alert.expiresAt);
    }
    // One durable paid transition owns both placement rights and the immutable animation window.
    // Reason: polling, delivery recovery and repricing must never create or extend a payment alert.
    Object.assign(order, { state: 'paid', paidAt: proof.paidAt, confirmedAt: at, payer: proof.payer, marketContext,
      displaySlot, startsAt, boardExpiresAt: startsAt + order.durationMs, interactionState: 'waiting',
      alert: { version: 1, tierIndex, startsAt: alertStartsAt, expiresAt: alertStartsAt + ALERT_DURATIONS[tierIndex - 1] } });
    this.store.put(order); this.drain();
    // Token metadata cannot delay paid admission or change the verified CA.
    // Reason: a third party logo outage must not lose a paid interaction.
    void Promise.resolve().then(() => this.metadata(order.tokenChain, order.ca)).then(token => {
      if (this.closed) return;
      const latest = this.store.get(id);
      this.store.put({ ...latest, token });
    }).catch(() => {});
    return this.view(this.get(id));
  }
  board() {
    const at = this.now(), orders = this.store?.all() || [];
    return { serverTime: at, entries: orders
      .filter(o => o.state === 'paid' && o.startsAt <= at && o.boardExpiresAt > at)
      .sort((a, b) => Number(parseUnits(b.amount, 2) - parseUnits(a.amount, 2)) || a.startsAt - b.startsAt)
      .slice(0, 100).map(o => ({ id: o.id.slice(0, 16), chain: o.chain, tokenChain: o.tokenChain, ca: o.ca,
        logoUrl: o.token?.logo ? `/api/module-c/logo/${o.id.slice(0, 16)}` : null,
        symbol: o.token?.symbol, name: o.name, message: o.message, amount: o.amount,
        startsAt: o.startsAt, expiresAt: o.boardExpiresAt, interactionState: o.interactionState })),
      alerts: orders.filter(o => o.state === 'paid' && validAlert(o.alert)
        && o.alert.expiresAt > at && o.alert.startsAt <= at + 30000)
        .sort((a, b) => a.alert.startsAt - b.alert.startsAt).slice(0, 8)
        .map(o => ({ id: o.id.slice(0, 16), version: 1, tierIndex: o.alert.tierIndex,
          startsAt: o.alert.startsAt, expiresAt: o.alert.expiresAt, name: o.name, amount: o.amount,
          chain: o.chain, tokenChain: o.tokenChain, ca: o.ca,
          logoUrl: o.token?.logo ? `/api/module-c/logo/${o.id.slice(0, 16)}` : null, symbol: o.token?.symbol })) };
  }
  drain() {
    if (!this.store || this.store.unavailable || this.draining || this.closed) return;
    this.draining = true;
    try {
      const waiting = this.store.all().filter(o => o.state === 'paid' && o.interactionState === 'waiting')
        .sort((a, b) => (a.confirmedAt || a.startsAt) - (b.confirmedAt || b.startsAt) || a.createdAt - b.createdAt);
      for (const order of waiting) {
        this.store.put({ ...order, interactionState: 'dispatching' });
        try {
          // The model receives the actual paid message and token identifier as context.
          // Reason: payment metadata and user text never get to select their own queue priority.
          this.broker.submit(`Paid viewer message about token ${order.ca} on ${order.tokenChain}:\n${order.message}`,
            { id: this.requestId(order), kind: 'chat', source: 'paid-message',
              paymentId: order.id.slice(0, 16), chain: order.tokenChain, ca: order.ca, amountAtomic: order.amountAtomic,
              marketContext: order.marketContext, paidReplyTier: alertTier(order) });
          const latest = this.store.get(order.id);
          if (latest.interactionState === 'dispatching') this.store.put({ ...latest, interactionState: 'queued' });
        } catch (error) {
          const id = this.requestId(order);
          const owned = this.broker.current?.id === id || this.broker.activeJobs?.has(id)
            || this.broker.pending?.some(r => r.id === id) || this.broker.history?.some(r => r.id === id);
          const retryable = [409, 429, 503].includes(error.statusCode) && !owned;
          this.store.put({ ...order, interactionState: retryable ? 'waiting' : 'needs_review',
            error: retryable ? 'ACTOR_NOT_READY' : 'DISPATCH_OUTCOME_UNCERTAIN' });
          break;
        }
      }
    } finally { this.draining = false; }
  }
  requestId(order) { return `paid-${order.id.slice(0, 32)}-${order.deliveryAttempt || 0}`; }
  onChat(event) {
    if (!this.store || this.store.unavailable || this.closed) return;
    const order = this.store.all().find(o => event.id === this.requestId(o));
    if (!order || TERMINAL.has(order.interactionState)) return;
    let state;
    if (event.status === 'done') state = 'done';
    else if (['error', 'interrupted'].includes(event.status)) state = 'needs_review';
    else if (event.role === 'assistant' || ['generating', 'speaking', 'running'].includes(event.status)) state = 'running';
    if (state) this.store.put({ ...order, interactionState: state, error: state === 'needs_review' ? 'ACTOR_DELIVERY_UNCERTAIN' : undefined });
  }
  tick() {
    if (this.closed || this.store?.unavailable) return;
    this.drain();
    const checking = this.store.all().filter(o => o.state === 'confirming' && o.txHash)
      .sort((a, b) => (a.nextCheckAt || 0) - (b.nextCheckAt || 0));
    for (const o of checking.filter(o => (o.nextCheckAt || 0) <= this.now()).slice(0, 8)) {
      this.store.put({ ...o, nextCheckAt: this.now() + 15000 });
      void this.verify(o.id, o.txHash).catch(() => {});
    }
  }
  review() {
    return (this.store?.all() || []).filter(o => o.state === 'paid' && o.interactionState === 'needs_review').map(o => this.view(o));
  }
  resolve(id, action) {
    const order = this.get(id);
    if (order.state !== 'paid' || order.interactionState !== 'needs_review') fail('ORDER_NOT_IN_REVIEW', 409);
    if (!['retry', 'done'].includes(action)) fail('INVALID_REVIEW_ACTION');
    this.store.put({ ...order, interactionState: action === 'done' ? 'done' : 'waiting',
      deliveryAttempt: (order.deliveryAttempt || 0) + (action === 'retry' ? 1 : 0), error: undefined });
    this.drain(); return this.view(this.get(id));
  }
  async close() {
    clearInterval(this.timer); this.closed = true;
    this.broker.off('chat', this.chatListener); this.broker.off('status', this.statusListener);
    await Promise.allSettled(this.checking.values()); this.store?.close(); this.pricing.close();
  }
}
