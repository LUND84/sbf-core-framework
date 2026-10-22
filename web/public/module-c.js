import { installPaidBoard, timestamp, countdown, interactionLabel } from './module-c-board.js';
import { ensureAlertSurface } from './module-c-alerts.js';
import { connectModuleCPaymentWallet, signModuleCPayment } from './module-c-wallet.js';

const storageKey = 'sbf.moduleC.orderId';
const defaultChains = [
  { id: 'solana', label: 'Solana', asset: 'USDC' },
  { id: 'tron', label: 'TRON', asset: 'USDT' },
  { id: 'ethereum', label: 'Ethereum', asset: 'USDT' },
  { id: 'bsc', label: 'BNB Smart Chain', asset: 'USDT' },
];
const paidStates = new Set(['paid', 'confirmed']);
const knownErrors = {
  MODULE_C_DISABLED: '模块 C 尚未配置收款，暂不可创建订单。',
  MODULE_C_NOT_CONFIGURED: '模块 C 尚未配置收款，暂不可创建订单。',
  MODULE_C_PAYMENT_NOT_CONFIGURED: '尚未配置收款地址，暂不可创建订单。',
  ORDER_NOT_FOUND: '找不到这条订单，可能已过期清理。',
  TX_NOT_FOUND: '暂未查到这笔交易，请核对交易哈希并稍后重试。',
  TX_ALREADY_USED: '这笔交易已用于其他订单，请检查付款记录。',
  INVALID_AMOUNT: '请选择当前可用的留言档位。',
  INVALID_CA: '请填写代币所属链上的有效 CA 地址。',
  ORIGIN_NOT_ALLOWED: '页面来源校验失败，请从正式演播室页面重新进入。',
  MODULE_C_CLOSED: '收款服务正在重启，请稍后刷新原订单，无需重复付款。',
  MODULE_C_SERVICE_UNAVAILABLE: '收款服务暂不可用，请稍后刷新原订单。',
  MODULE_C_QUERY_NOT_ALLOWED: '订单地址格式无效，请从演播室重新打开付费留言。',
  MODULE_C_NOT_FOUND: '找不到这条订单或付费留言接口，请刷新后重试。',
  MODULE_C_STORE_INVALID: '订单存储需要管理员处理，暂不可收款。',
  MODULE_C_STORE_LOCKED: '订单服务正在维护，暂不可收款。',
  INVALID_ORDER: '订单内容无效，请检查各项后重新创建。',
  INVALID_TOKEN_CHAIN: '请选择要展示的代币所属链。',
  INVALID_ADDRESS: 'CA 地址无效，请核对地址与所选代币所属链。',
  INVALID_MESSAGE: '请填写 1–1000 字的留言，并去除不可见控制字符。',
  INVALID_NAME: '昵称最多 40 字，请去除尖括号和不可见控制字符。',
  INVALID_AMOUNT_PRECISION: '档位金额无效，请刷新配置后重新选择。',
  AMOUNT_MUST_BE_20_TO_100000: '留言金额与当前收费档位不符，请重新选择。',
  PRICING_REVISION_CONFLICT: '收费档位已更新，请重新选择并确认价格与停留时间。',
  INVALID_ORDER_PRICING: '收费档位信息不完整，请刷新配置后重新选择。',
  INVALID_PRICING_TIER: '此档位暂不可用，请重新选择并确认。',
  ORDER_PRICE_MISMATCH: '档位价格已变化，请重新选择并确认。',
  AMOUNT_MUST_MATCH_PRICING_TIER: '请选择当前可用的收费档位，金额须与档位一致。',
  TIER_NOT_AVAILABLE: '此档位暂不可用，请重新选择并确认。',
  PRICE_MISMATCH: '档位价格已变化，请重新选择并确认。',
  ORDER_CAPACITY_REACHED: '当前订单较多，暂不可创建新订单，请稍后再试。',
  PAYMENT_AMOUNT_CAPACITY: '当前档位订单较多，请稍后再试或改选其他档位。',
  INVALID_TX_HASH: '交易哈希格式无效，请粘贴完整的付款交易哈希。',
  PAYMENT_INVALID_TX_HASH: '交易哈希格式与付款网络不符，请核对完整交易哈希。',
  ORDER_TRANSACTION_ALREADY_BOUND: '此订单已绑定另一笔交易，请使用原交易哈希验证；需要更换时请联系管理员。',
  TRANSACTION_ALREADY_USED: '这笔交易已用于另一条订单，不能重复使用。',
  ORDER_EXPIRED: '订单已过期，请勿再付款；若到期前已转账，仍可提交交易哈希核验。',
  PAYMENT_CHAIN_UNAVAILABLE: '该付款网络暂不可用，请选择其他已配置网络或稍后重试。',
  PAYMENT_RPC_UNAVAILABLE: '链上查询暂不可用，请稍后重新验证原交易，无需重复付款。',
  PAYMENT_RPC_INVALID_RESPONSE: '链上查询返回异常，请稍后重新验证原交易，无需重复付款。',
  PAYMENT_WRONG_NETWORK: '当前付款网络校验未通过，请联系管理员处理，无需重复付款。',
  PAYMENT_OUTSIDE_ORDER_WINDOW: '该交易时间不在订单有效期内，请保留交易哈希联系管理员。',
  PAYMENT_TRANSFER_NOT_FOUND: '这笔交易没有向指定收款地址转入所需稳定币，请核对付款网络、币种和地址。',
  PAYMENT_AMBIGUOUS_PAYER: '这笔交易包含多个来源，无法自动核验，请保留交易哈希联系管理员。',
  PAYMENT_TRANSACTION_FAILED: '这笔链上交易执行失败，未完成付款，请核对钱包交易记录。',
  PAYMENT_AMOUNT_MISMATCH: '实际到账数量与订单要求不一致，请核对全部小数位和手续费，保留交易哈希联系管理员。',
  PAYMENT_UNSUPPORTED_TRANSFER: '这笔转账方式无法自动核验，请保留交易哈希联系管理员。',
  PAYMENT_UNSUPPORTED_CHAIN: '暂不支持该付款网络，请从可用网络中选择。',
  PAYMENT_INVALID_ORDER: '订单付款信息异常，请保留订单号联系管理员。',
  INVALID_PAYMENT_PROOF: '付款核验结果异常，请保留订单号和交易哈希联系管理员，无需重复付款。',
  WALLET_SIGNATURE_REQUIRED: '请使用实际付款的钱包签名认领这笔交易。',
  INVALID_WALLET_PROOF: '付款钱包签名无效，请使用实际付款的钱包重试。',
  PAYMENT_PAYER_MISMATCH: '签名钱包与链上转出钱包不一致，请切换到实际付款钱包后重试。',
  WALLET_UNAVAILABLE: '请在安装了对应钱包扩展的浏览器中打开此页面，再签名认领付款。',
  WALLET_ACCOUNT_UNAVAILABLE: '未取得钱包账户，请解锁并连接实际付款的钱包。',
  WALLET_ACCOUNT_CHANGED: '钱包账户发生变化，请切换回实际付款账户后重试。',
  WALLET_REQUEST_PENDING: '钱包已有待处理请求，请先在钱包中完成或取消该请求。',
  WALLET_SIGNING_FAILED: '钱包签名未完成，请解锁实际付款钱包后重试。',
  WALLET_SIGNATURE_INVALID: '钱包未返回有效签名，请重新签名。',
  WALLET_REQUEST_REJECTED: '已取消钱包签名；付款记录仍保留，可稍后重新认领。',
  INVALID_WALLET_MESSAGE: '订单签名信息异常，请刷新原订单重试。',
  ACTOR_NOT_READY: '已收款，等待主播设备就绪，无需重复付款。',
  DELIVERY_UNCERTAIN_AFTER_RESTART: '已收款，服务重启后的回应状态需要人工处理，无需重复付款。',
  DISPATCH_OUTCOME_UNCERTAIN: '已收款，主播任务提交结果需要人工处理，无需重复付款。',
  ACTOR_DELIVERY_UNCERTAIN: '已收款，主播回应结果需要人工处理，无需重复付款。',
};

export function readableError(error) {
  const raw = typeof error === 'string' ? error : error?.message;
  return knownErrors[raw] || raw || '请求失败，请稍后重试。';
}

export function displayDuration(seconds) {
  if (!Number.isSafeInteger(seconds) || seconds < 0) return '—';
  const hours = Math.floor(seconds / 3600), minutes = Math.floor(seconds % 3600 / 60);
  return [hours ? `${hours} 小时` : '', minutes ? `${minutes} 分钟` : '',
    seconds % 60 ? `${seconds % 60} 秒` : ''].filter(Boolean).join(' ') || '0 秒';
}

export function normalizePricing(value) {
  if (!Number.isSafeInteger(value?.revision) || value.revision < 1 || !Array.isArray(value.tiers)
    || value.tiers.length !== 7) return null;
  const tiers = value.tiers.map(tier => ({ id: tier?.id, price: tier?.price, durationSeconds: tier?.durationSeconds }));
  if (tiers.some(tier => !/^tier-[1-7]$/.test(tier.id) || typeof tier.price !== 'string'
    || !/^\d{1,12}(?:\.\d{1,2})?$/.test(tier.price) || priceAtomic(tier.price) === 0n
    || !Number.isSafeInteger(tier.durationSeconds) || tier.durationSeconds <= 0)
    || new Set(tiers.map(tier => tier.id)).size !== 7) return null;
  return { revision: value.revision, tiers: tiers.sort((a, b) => a.id.localeCompare(b.id)) };
}

function priceAtomic(price) {
  const [whole, fraction = ''] = price.split('.');
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
}

export function minimumTier(pricing) {
  return pricing?.tiers.reduce((best, tier) => !best || priceAtomic(tier.price) < priceAtomic(best.price) ? tier : best, null) || null;
}

export function orderDisplayDuration(order) {
  const recorded = order.durationMs;
  if (Number.isSafeInteger(recorded) && recorded >= 0) return displayDuration(Math.floor(recorded / 1000));
  const start = timestamp(order.startsAt), end = timestamp(order.boardExpiresAt);
  return Number.isFinite(start) && Number.isFinite(end) && end >= start
    ? displayDuration(Math.floor((end - start) / 1000)) : '时长信息待恢复';
}

export function paymentTokenDetails(order, config) {
  const chain = config?.chains?.find((entry) => entry.id === order.chain);
  return { address: order.tokenAddress || chain?.tokenAddress || '',
    note: order.chain === 'bsc'
      ? 'Binance-Peg USDT（18 位小数），请核对收款币合约。'
      : '转账时请核对该稳定币合约 / Mint。' };
}

export function orderMessage(order) {
  if (paidStates.has(order.state)) {
    if (timestamp(order.startsAt) > Date.now()) return '已收款，榜单排队展示；从实际展示起计时。主播回应按付费优先队列处理。';
    if (order.interactionState === 'needs_review' || order.interactionState === 'error') {
      return '已收款，主播回应需要人工处理。请保留订单号，无需重复付款。';
    }
    if (order.interactionState === 'dispatching') return '已收款，正在提交给主播。付费留言优先互动。';
    if (order.error === 'ACTOR_NOT_READY') return knownErrors.ACTOR_NOT_READY;
    return `已收款 · ${interactionLabel(order.interactionState)}。榜单展示以服务器倒计时为准。`;
  }
  if (order.state === 'expired') return '订单已过期，请勿再付款；若到期前已转账，仍可提交交易哈希核验。';
  if (order.state === 'confirming' || order.state === 'verifying') return '正在等待链上确认。无需重复付款，稍后点击重新验证即可。';
  return '等待付款。请按下方网络、地址和准确数量转账，完成后提交交易哈希验证。';
}

export function installModuleC({ document = globalThis.document, fetcher = fetch,
  storage = globalThis.localStorage, clipboard = globalThis.navigator?.clipboard,
  signPayment = signModuleCPayment, connectPaymentWallet = connectModuleCPaymentWallet } = {}) {
  const $ = (id) => document.getElementById(id);
  if (!$('mc-dialog')) return null;
  const dialog = $('mc-dialog');
  const form = $('mc-form');
  let config = null;
  let order = null;
  let orderId = '';
  let busy = false;
  let polling = false;
  let configPromise = null;
  let serverOffset = 0;
  let configProblem = '';
  let board = null;
  let pricing = null;
  let selectedTierId = '';
  let pricingNotice = '';
  try { orderId = storage?.getItem(storageKey) || ''; } catch { /* Storage can be unavailable in private browsing. Reason: payment UI must still work in this session. */ }
  if (!/^[a-zA-Z0-9_-]{16,160}$/.test(orderId)) orderId = '';

  const api = async (path, body) => {
    const response = await fetcher(path, { method: body === undefined ? 'GET' : 'POST',
      credentials: 'same-origin', cache: 'no-store',
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(12000) });
    let result;
    try { result = await response.json(); } catch { result = {}; }
    if (!response.ok) {
      const detail = typeof result.error === 'string' ? result.error : result.error?.message || result.message;
      const fallback = response.status === 401 ? '请先输入演播室访问码，再打开付费留言。'
        : response.status === 404 ? '付费留言服务尚未启用，请稍后再试。'
          : `请求失败（HTTP ${response.status}），请稍后重试。`;
      throw Object.assign(new Error(readableError(detail || fallback)), { status: response.status, code: detail });
    }
    return result;
  };

  function activeChains() { return config?.chains?.filter((chain) => chain.enabled && chain.recipient) || []; }
  function syncBoardOverlay() {
    if (config?.videoOverlay) {
      board?.stop();
      board = null;
      $('mc-board').hidden = true;
      if ($('mc-alerts')) $('mc-alerts').hidden = true;
    } else if (!board) board = installPaidBoard($('mc-board'), { fetcher,
      alertsElement: ensureAlertSurface($('mc-board')) });
  }
  function setError(message) { $('mc-error').textContent = message || ''; }
  function selectedTier() { return pricing?.tiers.find(tier => tier.id === selectedTierId); }
  function updateEstimate() {
    const tier = selectedTier();
    $('mc-estimate').textContent = tier ? `${tier.price} U · 上榜 ${displayDuration(tier.durationSeconds)}，从实际展示起计时`
      : '选择档位以确认价格和上榜时长';
    $('mc-pricing-notice').textContent = pricingNotice;
    $('mc-pricing-notice').hidden = !pricingNotice;
  }
  function renderConfig() {
    const enabled = Boolean(config?.enabled && activeChains().length && pricing);
    const lowest = minimumTier(pricing);
    const reason = enabled ? '选择留言档位，支付确认后主播优先回应。'
      : configProblem || (config?.enabled && !pricing ? '收费档位暂不可用，请稍后刷新。'
        : readableError(config?.reason || '收款尚未配置，暂不可创建订单或付款。'));
    $('mc-service-state').textContent = enabled ? `${lowest.price} U / ${displayDuration(lowest.durationSeconds)}起 · ${activeChains().length} 个付款网络可用` : reason;
    $('mc-explainer').textContent = lowest
      ? `${lowest.price} U 起，最低价档位上榜 ${displayDuration(lowest.durationSeconds)}。按标价转账，Gas 由用户另付；请使用可签名的付款钱包。支付确认后展示代币 Logo、CA 和留言，主播按优先队列回应。`
      : '选择留言档位，确认价格和上榜时长。支付确认后展示代币 Logo、CA 和留言，主播按优先队列回应。';
    $('mc-config-status').textContent = reason;
    $('mc-config-status').hidden = enabled;
    $('mc-open').textContent = orderId ? '查看我的订单' : enabled ? '付费留言 ↗' : '查看付费留言';
    $('mc-create').disabled = busy || !enabled || !selectedTier();
    $('mc-tier').replaceChildren();
    const placeholder = document.createElement('option');
    placeholder.value = ''; placeholder.textContent = pricing ? '请选择留言档位' : '正在读取收费档位…';
    $('mc-tier').append(placeholder);
    for (const tier of pricing?.tiers || []) {
      const option = document.createElement('option');
      option.value = tier.id;
      option.textContent = `${tier.price} U · ${displayDuration(tier.durationSeconds)}`;
      $('mc-tier').append(option);
    }
    $('mc-tier').value = selectedTierId;
    $('mc-tier').disabled = !enabled || busy;
    const selected = $('mc-chain').value;
    $('mc-chain').replaceChildren();
    for (const chain of config?.chains || defaultChains) {
      const option = document.createElement('option');
      option.value = chain.id;
      const available = Boolean(chain.enabled && chain.recipient);
      option.textContent = `${chain.label} · ${chain.asset}${available ? '' : '（暂未配置）'}`;
      option.disabled = !available;
      $('mc-chain').append(option);
    }
    const next = activeChains().find((chain) => chain.id === selected) || activeChains()[0];
    if (next) $('mc-chain').value = next.id;
    $('mc-chain').disabled = !enabled || busy;
    syncBoardOverlay();
    updateEstimate();
  }

  async function refreshConfig({ requireSelection = false } = {}) {
    if (!configPromise) configPromise = (async () => {
      try {
        const next = await api('/api/module-c/config');
        const nextPricing = normalizePricing(next.pricing);
        if (pricing && JSON.stringify(pricing) !== JSON.stringify(nextPricing)) {
          selectedTierId = '';
          pricingNotice = '收费档位已更新，请重新选择并确认价格与停留时间。';
        }
        config = next; pricing = nextPricing; configProblem = '';
      } catch (error) { configProblem = readableError(error); }
      finally { renderConfig(); renderOrder(); }
    })().finally(() => { configPromise = null; });
    await configPromise;
    if (requireSelection) {
      selectedTierId = '';
      pricingNotice = '收费档位已更新，请重新选择并确认价格与停留时间；本次未创建新订单。';
      renderConfig();
    }
  }

  function chainLabel(id) {
    return [...(config?.chains || []), ...defaultChains].find((chain) => chain.id === id)?.label || id;
  }
  function renderOrder() {
    if (!order) return;
    const paid = paidStates.has(order.state);
    const expired = order.state === 'expired';
    $('mc-order-panel').hidden = false;
    form.hidden = true;
    $('mc-order-state').textContent = orderMessage(order);
    $('mc-order-state').dataset.paid = String(paid);
    $('mc-order-id').textContent = order.id;
    $('mc-order-chain').textContent = `${chainLabel(order.chain)} · ${order.asset}`;
    $('mc-pay-amount').textContent = `${order.payAmount} ${order.asset}`;
    $('mc-recipient').textContent = order.recipient;
    const paymentToken = paymentTokenDetails(order, config);
    $('mc-payment-token-address').textContent = paymentToken.address || '暂未读取到合约信息，请刷新订单后核对。';
    $('mc-payment-token-note').textContent = paymentToken.note;
    $('mc-order-ca').textContent = order.ca || '—';
    $('mc-order-token-chain').textContent = chainLabel(order.tokenChain || order.chain);
    $('mc-order-message').textContent = order.message || '—';
    $('mc-order-duration').textContent = orderDisplayDuration(order);
    $('mc-payment-warning').hidden = paid || expired;
    $('mc-payment-warning').textContent = order.paymentMode === 'exact-wallet-v1'
      ? '请从自己的钱包按标价转账，Gas 由用户另付。提交交易哈希后，需使用付款钱包签名认领订单；此签名只核验交易归属。交易所直接提现暂不支持。'
      : '此为原有订单，请严格按上方原支付数量（含识别零头）转账，Gas 由用户另付；原订单金额及展示时长保持。';
    $('mc-verify-form').hidden = paid;
    $('mc-payment-instructions').hidden = paid || expired;
    $('mc-order-expiry-row').hidden = paid || expired;
    $('mc-verify').disabled = busy;
    $('mc-verify').textContent = busy ? '正在核验…' : expired ? '核验到期前已付款交易'
      : order.state === 'confirming' ? '重新验证交易' : '提交交易哈希验证';
    $('mc-order-refresh').disabled = busy;
    $('mc-new').disabled = busy;
    $('mc-new').textContent = paid || expired ? '写一条新留言' : '另建一条留言';
    $('mc-prior-order-note').hidden = paid || expired;
    if (order.txHash && !$('mc-tx').value) $('mc-tx').value = order.txHash;
    updateClock();
  }

  function updateClock() {
    if (order) $('mc-order-expiry').textContent = countdown(order.expiresAt, Date.now() + serverOffset);
  }
  function acceptOrder(value) {
    if (!value?.id || !value.chain || !value.payAmount || !value.recipient || !value.asset) {
      throw new Error('订单信息不完整，请刷新订单；请勿在信息不完整时付款。');
    }
    order = value;
    orderId = value.id;
    if (value.serverTime && Number.isFinite(timestamp(value.serverTime))) serverOffset = timestamp(value.serverTime) - Date.now();
    try { storage?.setItem(storageKey, orderId); } catch { /* Keep the order in memory. Reason: blocked storage must not conceal a created payment order. */ }
    renderConfig();
    renderOrder();
    if (value.error && !paidStates.has(value.state)) setError(readableError(value.error));
    else if (paidStates.has(value.state)) setError('');
    $('mc-recover-new').hidden = true;
  }

  async function refreshOrder({ report = false } = {}) {
    if (!orderId || polling || busy) return;
    polling = true;
    const requestedId = orderId;
    try {
      const result = await api(`/api/module-c/orders/${encodeURIComponent(requestedId)}`);
      if (orderId !== requestedId) return;
      if (report) setError('');
      acceptOrder(result);
    } catch (error) {
      if (orderId === requestedId && (report || !order)) {
        setError(readableError(error));
        $('mc-recover-new').hidden = Boolean(order);
      }
    } finally { polling = false; }
  }

  $('mc-open').addEventListener('click', () => {
    setError('');
    if (!dialog.open) dialog.showModal();
    void refreshConfig();
    if (orderId) {
      form.hidden = true;
      $('mc-order-panel').hidden = !order;
      if (!order) setError('正在恢复你的订单…');
      void refreshOrder({ report: true });
    }
  });
  $('mc-close').addEventListener('click', () => dialog.close());
  $('mc-tier').addEventListener('change', () => {
    selectedTierId = $('mc-tier').value;
    if (selectedTier()) pricingNotice = '';
    renderConfig();
  });
  function startNew() {
    order = null;
    orderId = '';
    try { storage?.removeItem(storageKey); } catch { /* Session state is already cleared. Reason: local storage failure should not block a new draft. */ }
    $('mc-order-panel').hidden = true;
    form.hidden = false;
    $('mc-tx').value = '';
    $('mc-recover-new').hidden = true;
    selectedTierId = ''; pricingNotice = '';
    setError('');
    renderConfig();
  }
  $('mc-new').addEventListener('click', startNew);
  $('mc-recover-new').addEventListener('click', startNew);
  $('mc-order-refresh').addEventListener('click', () => void refreshOrder({ report: true }));
  $('mc-copy').addEventListener('click', async () => {
    try { await clipboard.writeText(order.recipient); $('mc-copy').textContent = '已复制'; }
    catch { setError('无法自动复制，请选中收款地址手动复制。'); }
  });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (busy || !config?.enabled || !activeChains().length || !form.reportValidity()) return;
    const tier = selectedTier();
    if (!tier || !pricing) { setError('请选择当前可用的留言档位。'); return; }
    const quote = { amount: tier.price, tierId: tier.id, pricingRevision: pricing.revision };
    const paymentChain = $('mc-chain').value;
    busy = true;
    setError('');
    renderConfig();
    try {
      await connectPaymentWallet(paymentChain);
      const result = await api('/api/module-c/orders', { chain: paymentChain,
        tokenChain: $('mc-token-chain').value, ca: $('mc-ca').value.trim(),
        message: $('mc-message').value.trim(), name: $('mc-name').value.trim(), ...quote });
      acceptOrder(result);
      $('mc-copy').textContent = '复制';
    } catch (error) {
      if (error.status === 409 || ['PRICING_REVISION_CONFLICT', 'INVALID_ORDER_PRICING', 'INVALID_PRICING_TIER',
        'ORDER_PRICE_MISMATCH', 'AMOUNT_MUST_MATCH_PRICING_TIER', 'TIER_NOT_AVAILABLE', 'PRICE_MISMATCH'].includes(error.code)) {
        await refreshConfig({ requireSelection: true });
        setError('请重新选择档位并确认后再创建订单。');
      } else setError(readableError(error));
    }
    finally { busy = false; renderConfig(); renderOrder(); }
  });
  $('mc-verify-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (busy || !order || !$('mc-verify-form').reportValidity()) return;
    const txHash = $('mc-tx').value.trim();
    if (!txHash) return;
    busy = true;
    setError('');
    renderOrder();
    try {
      let walletProof;
      if (order.paymentMode === 'exact-wallet-v1') {
        const challenge = await api(`/api/module-c/orders/${encodeURIComponent(order.id)}/proof-message`, { txHash });
        if (challenge.txHash !== order.walletAuthorizedTxHash) {
          walletProof = await signPayment(order, challenge.txHash, { message: challenge.message });
        }
      }
      const result = await api(`/api/module-c/orders/${encodeURIComponent(order.id)}/verify`, { txHash, walletProof });
      acceptOrder(result);
      if (result.error && !paidStates.has(result.state)) setError(readableError(result.error));
      void board?.refresh();
    } catch (error) { setError(readableError(error)); }
    finally { busy = false; renderOrder(); }
  });
  const configPoll = setInterval(refreshConfig, 10000);
  const orderPoll = setInterval(() => { updateClock(); if (dialog.open) void refreshOrder(); }, 5000);
  const clock = setInterval(updateClock, 1000);
  void refreshConfig();
  return { refreshConfig, refreshOrder, get board() { return board; }, stop: () => {
    board?.stop(); clearInterval(configPoll); clearInterval(orderPoll); clearInterval(clock);
  } };
}

if (globalThis.document?.getElementById('mc-dialog')) installModuleC();
