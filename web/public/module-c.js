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
  MODULE_C_DISABLED: 'Payments are not configured for Module C. Orders are currently unavailable.',
  MODULE_C_NOT_CONFIGURED: 'Payments are not configured for Module C. Orders are currently unavailable.',
  MODULE_C_PAYMENT_NOT_CONFIGURED: 'No payment address is configured. Orders are currently unavailable.',
  ORDER_NOT_FOUND: 'Order not found. It may have expired and been removed.',
  TX_NOT_FOUND: 'Transaction not found yet. Check the transaction hash and try again later.',
  TX_ALREADY_USED: 'This transaction has already been used for another order. Check your payment history.',
  INVALID_AMOUNT: 'Select an available message tier.',
  INVALID_CA: 'Enter a valid contract address on the token network.',
  ORIGIN_NOT_ALLOWED: 'Page origin verification failed. Reopen this form from the official studio page.',
  MODULE_C_CLOSED: 'The payment service is restarting. Refresh your existing order later; do not pay again.',
  MODULE_C_SERVICE_UNAVAILABLE: 'The payment service is temporarily unavailable. Refresh your existing order later.',
  MODULE_C_QUERY_NOT_ALLOWED: 'Invalid order URL. Reopen paid messages from the studio.',
  MODULE_C_NOT_FOUND: 'The order or paid-message endpoint was not found. Refresh and try again.',
  MODULE_C_STORE_INVALID: 'Order storage requires administrator attention. Payments are temporarily unavailable.',
  MODULE_C_STORE_LOCKED: 'The order service is under maintenance. Payments are temporarily unavailable.',
  INVALID_ORDER: 'Invalid order details. Check the fields and create a new order.',
  INVALID_TOKEN_CHAIN: 'Select the network of the token you want to display.',
  INVALID_ADDRESS: 'Invalid contract address. Check the address and selected token network.',
  INVALID_MESSAGE: 'Enter a message of 1–1000 characters without invisible control characters.',
  INVALID_NAME: 'Use a name of up to 40 characters without angle brackets or invisible control characters.',
  INVALID_AMOUNT_PRECISION: 'Invalid tier amount. Refresh the configuration and select a tier again.',
  AMOUNT_MUST_BE_20_TO_100000: 'The message amount does not match the current pricing tiers. Select a tier again.',
  PRICING_REVISION_CONFLICT: 'Pricing has changed. Select a tier again and confirm its price and display duration.',
  INVALID_ORDER_PRICING: 'Pricing information is incomplete. Refresh the configuration and select a tier again.',
  INVALID_PRICING_TIER: 'This tier is unavailable. Select another tier and confirm.',
  ORDER_PRICE_MISMATCH: 'The tier price has changed. Select a tier again and confirm.',
  AMOUNT_MUST_MATCH_PRICING_TIER: 'Select an available pricing tier. The amount must match the tier price.',
  TIER_NOT_AVAILABLE: 'This tier is unavailable. Select another tier and confirm.',
  PRICE_MISMATCH: 'The tier price has changed. Select a tier again and confirm.',
  ORDER_CAPACITY_REACHED: 'Too many orders are open. Please try creating an order later.',
  PAYMENT_AMOUNT_CAPACITY: 'This tier has too many open orders. Try again later or choose another tier.',
  INVALID_TX_HASH: 'Invalid transaction hash. Paste the full payment transaction hash.',
  PAYMENT_INVALID_TX_HASH: 'The transaction hash format does not match the payment network. Check the full hash.',
  ORDER_TRANSACTION_ALREADY_BOUND: 'This order is linked to a different transaction. Verify with the original hash, or contact an administrator to change it.',
  TRANSACTION_ALREADY_USED: 'This transaction has already been used for another order and cannot be reused.',
  ORDER_EXPIRED: 'This order has expired. Do not send a new payment. If you paid before expiry, you can still submit the transaction hash for verification.',
  PAYMENT_CHAIN_UNAVAILABLE: 'This payment network is temporarily unavailable. Choose another configured network or try again later.',
  PAYMENT_RPC_UNAVAILABLE: 'Blockchain queries are temporarily unavailable. Verify the original transaction later; do not pay again.',
  PAYMENT_RPC_INVALID_RESPONSE: 'The blockchain query returned an invalid response. Verify the original transaction later; do not pay again.',
  PAYMENT_WRONG_NETWORK: 'Payment network verification failed. Contact an administrator; do not pay again.',
  PAYMENT_OUTSIDE_ORDER_WINDOW: 'The transaction is outside the order validity window. Keep the transaction hash and contact an administrator.',
  PAYMENT_TRANSFER_NOT_FOUND: 'This transaction did not transfer the required stablecoin to the specified recipient. Check the payment network, token, and address.',
  PAYMENT_AMBIGUOUS_PAYER: 'This transaction has multiple senders and cannot be verified automatically. Keep the hash and contact an administrator.',
  PAYMENT_TRANSACTION_FAILED: 'This blockchain transaction failed and no payment was completed. Check your wallet transaction history.',
  PAYMENT_AMOUNT_MISMATCH: 'The received amount does not match the order. Check all decimal places and fees, and keep the transaction hash when contacting an administrator.',
  PAYMENT_UNSUPPORTED_TRANSFER: 'This transfer type cannot be verified automatically. Keep the transaction hash and contact an administrator.',
  PAYMENT_UNSUPPORTED_CHAIN: 'This payment network is not supported. Choose an available network.',
  PAYMENT_INVALID_ORDER: 'Invalid order payment details. Keep your order ID and contact an administrator.',
  INVALID_PAYMENT_PROOF: 'Payment verification returned an invalid result. Keep your order ID and transaction hash, and contact an administrator; do not pay again.',
  WALLET_SIGNATURE_REQUIRED: 'Sign with the wallet that sent the payment to claim this transaction.',
  INVALID_WALLET_PROOF: 'Invalid payment-wallet signature. Try again with the wallet that sent the payment.',
  PAYMENT_PAYER_MISMATCH: 'The signing wallet does not match the on-chain sender. Switch to the wallet that sent the payment and try again.',
  WALLET_UNAVAILABLE: 'Open this page in a browser with the appropriate wallet extension, then sign to claim your payment.',
  WALLET_ACCOUNT_UNAVAILABLE: 'No wallet account was provided. Unlock and connect the wallet that sent the payment.',
  WALLET_ACCOUNT_CHANGED: 'Your wallet account changed. Switch back to the account that sent the payment and try again.',
  WALLET_REQUEST_PENDING: 'Your wallet has a pending request. Complete or cancel it in your wallet first.',
  WALLET_SIGNING_FAILED: 'Wallet signing was not completed. Unlock the wallet that sent the payment and try again.',
  WALLET_SIGNATURE_INVALID: 'The wallet did not return a valid signature. Sign again.',
  WALLET_REQUEST_REJECTED: 'Wallet signing was canceled. Your payment record is saved, and you can claim it later.',
  INVALID_WALLET_MESSAGE: 'Invalid order-signing details. Refresh your existing order and try again.',
  ACTOR_NOT_READY: 'Payment received. Waiting for the host device to become ready; do not pay again.',
  DELIVERY_UNCERTAIN_AFTER_RESTART: 'Payment received. The response status after the service restart requires manual review; do not pay again.',
  DISPATCH_OUTCOME_UNCERTAIN: 'Payment received. The host-task submission result requires manual review; do not pay again.',
  ACTOR_DELIVERY_UNCERTAIN: 'Payment received. The host response requires manual review; do not pay again.',
};

export function readableError(error) {
  const raw = typeof error === 'string' ? error : error?.message;
  return knownErrors[raw] || raw || 'Request failed. Please try again later.';
}

export function displayDuration(seconds) {
  if (!Number.isSafeInteger(seconds) || seconds < 0) return '—';
  const hours = Math.floor(seconds / 3600), minutes = Math.floor(seconds % 3600 / 60);
  return [hours ? `${hours} h` : '', minutes ? `${minutes} min` : '',
    seconds % 60 ? `${seconds % 60} s` : ''].filter(Boolean).join(' ') || '0 s';
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
    ? displayDuration(Math.floor((end - start) / 1000)) : 'Waiting for duration information';
}

export function paymentTokenDetails(order, config) {
  const chain = config?.chains?.find((entry) => entry.id === order.chain);
  return { address: order.tokenAddress || chain?.tokenAddress || '',
    note: order.chain === 'bsc'
      ? 'Binance-Peg USDT (18 decimals). Check the payment token contract.'
      : 'Check the stablecoin contract or mint address before sending.' };
}

export function orderMessage(order) {
  if (paidStates.has(order.state)) {
    if (timestamp(order.startsAt) > Date.now()) return 'Payment received. Your message is queued for display; its timer starts when it appears. Host responses use the paid-message priority queue.';
    if (order.interactionState === 'needs_review' || order.interactionState === 'error') {
      return 'Payment received. The host response requires manual review. Keep your order ID; do not pay again.';
    }
    if (order.interactionState === 'dispatching') return 'Payment received. Submitting to the host. Paid messages receive interaction priority.';
    if (order.error === 'ACTOR_NOT_READY') return knownErrors.ACTOR_NOT_READY;
    return `Payment received · ${interactionLabel(order.interactionState)}. The server countdown determines the display time.`;
  }
  if (order.state === 'expired') return 'This order has expired. Do not send a new payment. If you paid before expiry, you can still submit the transaction hash for verification.';
  if (order.state === 'confirming' || order.state === 'verifying') return 'Waiting for blockchain confirmation. Do not pay again; click verify again later.';
  return 'Awaiting payment. Send the exact amount using the network and address below, then submit the transaction hash for verification.';
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
      const fallback = response.status === 401 ? 'Enter the studio access code before opening paid messages.'
        : response.status === 404 ? 'Paid messages are not enabled. Please try again later.'
          : `Request failed (HTTP ${response.status}). Please try again later.`;
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
    $('mc-estimate').textContent = tier ? `${tier.price} U · Displayed for ${displayDuration(tier.durationSeconds)}, timed from when it appears`
      : 'Choose a tier to confirm its price and display duration';
    $('mc-pricing-notice').textContent = pricingNotice;
    $('mc-pricing-notice').hidden = !pricingNotice;
  }
  function renderConfig() {
    const enabled = Boolean(config?.enabled && activeChains().length && pricing);
    const lowest = minimumTier(pricing);
    const reason = enabled ? 'Choose a message tier. The host gives paid messages priority after payment is confirmed.'
      : configProblem || (config?.enabled && !pricing ? 'Pricing tiers are temporarily unavailable. Refresh later.'
        : readableError(config?.reason || 'Payments are not configured. You cannot create an order or pay yet.'));
    $('mc-service-state').textContent = enabled ? `From ${lowest.price} U / ${displayDuration(lowest.durationSeconds)} · ${activeChains().length} payment networks available` : reason;
    $('mc-explainer').textContent = lowest
      ? `From ${lowest.price} U, with ${displayDuration(lowest.durationSeconds)} of display time at the lowest tier. Send the listed amount and pay gas separately, using a wallet that supports signing. Once payment is confirmed, your token logo, contract address, and message appear, and the host responds through the priority queue.`
      : 'Choose a message tier and confirm its price and display duration. Once payment is confirmed, your token logo, contract address, and message appear, and the host responds through the priority queue.';
    $('mc-config-status').textContent = reason;
    $('mc-config-status').hidden = enabled;
    $('mc-open').textContent = orderId ? 'View my order' : enabled ? 'Paid message ↗' : 'View paid messages';
    $('mc-create').disabled = busy || !enabled || !selectedTier();
    $('mc-tier').replaceChildren();
    const placeholder = document.createElement('option');
    placeholder.value = ''; placeholder.textContent = pricing ? 'Select a message tier' : 'Loading pricing tiers…';
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
      option.textContent = `${chain.label} · ${chain.asset}${available ? '' : ' (not configured)'}`;
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
          pricingNotice = 'Pricing has changed. Select a tier again and confirm its price and display duration.';
        }
        config = next; pricing = nextPricing; configProblem = '';
      } catch (error) { configProblem = readableError(error); }
      finally { renderConfig(); renderOrder(); }
    })().finally(() => { configPromise = null; });
    await configPromise;
    if (requireSelection) {
      selectedTierId = '';
      pricingNotice = 'Pricing has changed. Select a tier again and confirm its price and display duration. No new order was created.';
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
    $('mc-payment-token-address').textContent = paymentToken.address || 'Contract information is unavailable. Refresh the order and check it again.';
    $('mc-payment-token-note').textContent = paymentToken.note;
    $('mc-order-ca').textContent = order.ca || '—';
    $('mc-order-token-chain').textContent = chainLabel(order.tokenChain || order.chain);
    $('mc-order-message').textContent = order.message || '—';
    $('mc-order-duration').textContent = orderDisplayDuration(order);
    $('mc-payment-warning').hidden = paid || expired;
    $('mc-payment-warning').textContent = order.paymentMode === 'exact-wallet-v1'
      ? 'Send the listed amount from your own wallet and pay gas separately. After submitting the transaction hash, sign with the payment wallet to claim the order. This signature only verifies transaction ownership. Direct withdrawals from exchanges are not supported.'
      : 'This is an existing order. Send exactly the original amount shown above, including its identifying fractional amount, and pay gas separately. The original order amount and display duration remain unchanged.';
    $('mc-verify-form').hidden = paid;
    $('mc-payment-instructions').hidden = paid || expired;
    $('mc-order-expiry-row').hidden = paid || expired;
    $('mc-verify').disabled = busy;
    $('mc-verify').textContent = busy ? 'Verifying…' : expired ? 'Verify a payment sent before expiry'
      : order.state === 'confirming' ? 'Verify transaction again' : 'Verify transaction hash';
    $('mc-order-refresh').disabled = busy;
    $('mc-new').disabled = busy;
    $('mc-new').textContent = paid || expired ? 'Write a new message' : 'Create another message';
    $('mc-prior-order-note').hidden = paid || expired;
    if (order.txHash && !$('mc-tx').value) $('mc-tx').value = order.txHash;
    updateClock();
  }

  function updateClock() {
    if (order) $('mc-order-expiry').textContent = countdown(order.expiresAt, Date.now() + serverOffset);
  }
  function acceptOrder(value) {
    if (!value?.id || !value.chain || !value.payAmount || !value.recipient || !value.asset) {
      throw new Error('Order details are incomplete. Refresh the order and do not pay until all details are available.');
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
      if (!order) setError('Restoring your order…');
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
    try { await clipboard.writeText(order.recipient); $('mc-copy').textContent = 'Copied'; }
    catch { setError('Copy failed. Select the recipient address and copy it manually.'); }
  });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (busy || !config?.enabled || !activeChains().length || !form.reportValidity()) return;
    const tier = selectedTier();
    if (!tier || !pricing) { setError('Select an available message tier.'); return; }
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
      $('mc-copy').textContent = 'Copy';
    } catch (error) {
      if (error.status === 409 || ['PRICING_REVISION_CONFLICT', 'INVALID_ORDER_PRICING', 'INVALID_PRICING_TIER',
        'ORDER_PRICE_MISMATCH', 'AMOUNT_MUST_MATCH_PRICING_TIER', 'TIER_NOT_AVAILABLE', 'PRICE_MISMATCH'].includes(error.code)) {
        await refreshConfig({ requireSelection: true });
        setError('Select a tier again and confirm it before creating an order.');
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
