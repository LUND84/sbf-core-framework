import { createHash } from 'node:crypto';
import { CHAIN_DEFAULTS, decode58, encode58, fail, normalizeAddress } from './policies.js';

const TRANSFER = 'ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const SOLANA_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
const TRON_GENESIS = '00000000000000001ebf88508a03865c71d452e25f4d51194196a1d22b6653dc';
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 8000;
const TRON_REQUEST_GAP_MS = 500;
const TRON_GENESIS_TTL_MS = 60000;
const TRON_MAX_QUEUED_REQUESTS = 32;
const tronProviders = new WeakMap();
const rpcInvalid = () => fail('PAYMENT_RPC_INVALID_RESPONSE', 503);
const pending = txHash => ({ state: 'pending', txHash, amountAtomic: '0', payer: '', paidAt: 0 });
const confirmed = (txHash, amount, payer, paidAt) => ({
  state: 'confirmed', txHash, amountAtomic: amount.toString(), payer, paidAt,
});

async function postJson(url, body, fetchImpl) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new Error('RPC_TIMEOUT')); }, REQUEST_TIMEOUT_MS);
  });
  try {
    const response = await Promise.race([timeout, fetchImpl(url, {
      method: 'POST', redirect: 'error', signal: controller.signal,
      headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body),
    })]);
    if (!response.ok || response.redirected) fail('PAYMENT_RPC_UNAVAILABLE', 503);
    const declared = Number(response.headers.get('content-length'));
    if (declared > MAX_RESPONSE_BYTES) rpcInvalid();
    if (!response.body) rpcInvalid();
    const reader = response.body.getReader(), chunks = [];
    let bytes = 0;
    try {
      while (true) {
        const { done, value } = await Promise.race([timeout, reader.read()]);
        if (done) break;
        bytes += value.byteLength;
        if (bytes > MAX_RESPONSE_BYTES) { await Promise.race([timeout, reader.cancel()]); rpcInvalid(); }
        chunks.push(Buffer.from(value));
      }
    } finally { reader.releaseLock(); }
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) rpcInvalid();
    return parsed;
  } catch (error) {
    if (error.statusCode === 503 && /^PAYMENT_[A-Z_]+$/.test(error.message)) throw error;
    fail('PAYMENT_RPC_UNAVAILABLE', 503);
  } finally { clearTimeout(timer); }
}

async function rpc(url, method, params, fetchImpl) {
  const response = await postJson(url, { jsonrpc: '2.0', id: 1, method, params }, fetchImpl);
  if (method === 'getTransaction' && response.error?.code === -32015) fail('PAYMENT_UNSUPPORTED_TRANSFER');
  if (response.error || !Object.hasOwn(response, 'result')) fail('PAYMENT_RPC_UNAVAILABLE', 503);
  return response.result;
}

function endpoint(base, path) {
  const url = new URL(base);
  url.pathname = `${url.pathname.replace(/\/$/, '')}/${path}`;
  return url.href;
}

function tronProvider(base, fetchImpl) {
  let providers = tronProviders.get(fetchImpl);
  if (!providers) { providers = new Map(); tronProviders.set(fetchImpl, providers); }
  if (!providers.has(base)) providers.set(base, { tail: Promise.resolve(), pending: 0, nextStart: 0,
    genesisUntil: 0, genesisPromise: null });
  return providers.get(base);
}

async function solidity(base, method, body, fetchImpl) {
  const provider = tronProvider(base, fetchImpl);
  if (provider.pending >= TRON_MAX_QUEUED_REQUESTS) fail('PAYMENT_RPC_UNAVAILABLE', 503);
  provider.pending++;
  let expired = false, queueTimer;
  const deadline = new Promise((resolve, reject) => {
    queueTimer = setTimeout(() => {
      expired = true; reject(Object.assign(new Error('PAYMENT_RPC_UNAVAILABLE'), { statusCode: 503 }));
    }, REQUEST_TIMEOUT_MS);
  });
  const request = provider.tail.then(async () => {
    if (expired) return;
    const delay = provider.nextStart - Date.now();
    if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
    if (expired) return;
    clearTimeout(queueTimer);
    provider.nextStart = Date.now() + TRON_REQUEST_GAP_MS;
    const result = await postJson(endpoint(base, `walletsolidity/${method}`), body, fetchImpl);
    if (result.Error || result.error) fail('PAYMENT_RPC_UNAVAILABLE', 503);
    return result;
  }).finally(() => { provider.pending--; clearTimeout(queueTimer); });
  // Serialize this provider and limit its start rate so one verification does not burst into rate limits.
  // Reason: public TronGrid rejected concurrent genesis/receipt/head reads with HTTP 429 during readiness checks.
  provider.tail = request.then(() => {}, () => {});
  return Promise.race([request, deadline]);
}

function atomic(value) {
  if (typeof value !== 'string' || !/^\d{1,78}$/.test(value)) rpcInvalid();
  return BigInt(value);
}

function hexInteger(value) {
  if (typeof value !== 'string' || !/^0x[0-9a-f]{1,64}$/i.test(value)) rpcInvalid();
  return BigInt(value);
}

function hexBytes(value, length, prefix = true) {
  if (typeof value !== 'string' || !new RegExp(`^${prefix ? '0x' : ''}[0-9a-f]{${length * 2}}$`, 'i').test(value)) rpcInvalid();
  return value.replace(/^0x/i, '').toLowerCase();
}

function safeInteger(value) {
  if (!Number.isSafeInteger(value) || value < 0) rpcInvalid();
  return value;
}

function paymentTime(order, timeMs) {
  if (!Number.isSafeInteger(timeMs) || timeMs <= 0) rpcInvalid();
  // Chain timestamps have second precision; comparing creation seconds avoids rejecting a same-second payment.
  if (timeMs < Math.floor(order.createdAt / 1000) * 1000 || timeMs > order.expiresAt) {
    fail('PAYMENT_OUTSIDE_ORDER_WINDOW');
  }
  return timeMs;
}

function topicAddress(topic, prefix) {
  const value = hexBytes(topic, 32, prefix);
  if (!value.startsWith('0'.repeat(24))) rpcInvalid();
  return value.slice(24);
}

function verifyTransfers(logs, token, recipient, prefix) {
  if (!Array.isArray(logs)) rpcInvalid();
  let received = 0n, spent = 0n;
  const payers = new Set();
  for (const log of logs) {
    const address = typeof log.address === 'string' ? log.address.replace(/^0x/i, '').replace(/^41(?=[0-9a-fA-F]{40}$)/, '').toLowerCase() : '';
    if (address !== token || log.removed === true) continue;
    if (!Array.isArray(log.topics) || log.topics[0]?.replace(/^0x/i, '').toLowerCase() !== TRANSFER) continue;
    if (log.topics.length !== 3) rpcInvalid();
    const source = topicAddress(log.topics[1], prefix), target = topicAddress(log.topics[2], prefix);
    const value = BigInt(`0x${hexBytes(log.data, 32, prefix)}`);
    if (source === target) continue;
    if (target === recipient && value > 0n) { received += value; payers.add(source); }
    if (source === recipient) spent += value;
  }
  if (received === 0n) fail('PAYMENT_TRANSFER_NOT_FOUND');
  if (payers.size !== 1 || payers.has('0'.repeat(40))) fail('PAYMENT_AMBIGUOUS_PAYER');
  return { amount: received - spent, payer: [...payers][0] };
}

async function verifyEvm(order, txHash, chain, fetchImpl) {
  const call = (method, params = []) => rpc(chain.rpcUrl, method, params, fetchImpl);
  const chainId = hexInteger(await call('eth_chainId'));
  if (chainId !== (order.chain === 'ethereum' ? 1n : 56n)) fail('PAYMENT_WRONG_NETWORK', 503);
  const receipt = await call('eth_getTransactionReceipt', [txHash]);
  if (receipt === null) return pending(txHash);
  if (!receipt || typeof receipt !== 'object') rpcInvalid();
  if (hexBytes(receipt.transactionHash, 32) !== txHash.slice(2)) rpcInvalid();
  if (hexInteger(receipt.status) !== 1n) fail('PAYMENT_TRANSACTION_FAILED');
  const number = hexInteger(receipt.blockNumber), blockHash = hexBytes(receipt.blockHash, 32);
  const transfer = verifyTransfers(receipt.logs, chain.tokenAddress.slice(2), order.recipient.slice(2), true);
  if (transfer.amount !== BigInt(order.amountAtomic)) fail('PAYMENT_AMOUNT_MISMATCH');
  const [block, head] = await Promise.all([
    call('eth_getBlockByNumber', [receipt.blockNumber, false]), call('eth_blockNumber'),
  ]);
  if (!block || hexBytes(block.hash, 32) !== blockHash || hexInteger(block.number) !== number) {
    return pending(txHash);
  }
  const seconds = hexInteger(block.timestamp);
  if (seconds > BigInt(Math.floor(Number.MAX_SAFE_INTEGER / 1000))) rpcInvalid();
  const paidAt = paymentTime(order, Number(seconds) * 1000);
  if (hexInteger(head) - number + 1n < BigInt(chain.confirmations)) return pending(txHash);
  return confirmed(txHash, transfer.amount, `0x${transfer.payer}`, paidAt);
}

function tokenBalances(entries, accountKeys, mint) {
  if (!Array.isArray(entries)) rpcInvalid();
  const result = new Map();
  for (const entry of entries) {
    if (entry.mint !== mint) continue;
    const index = safeInteger(entry.accountIndex);
    if (!accountKeys[index] || result.has(index)) rpcInvalid();
    if (!entry.owner || (entry.programId && entry.programId !== TOKEN_PROGRAM)) rpcInvalid();
    try { normalizeAddress('solana', entry.owner); } catch { rpcInvalid(); }
    if (entry.uiTokenAmount?.decimals !== 6) rpcInvalid();
    result.set(index, { owner: entry.owner, amount: atomic(entry.uiTokenAmount.amount) });
  }
  return result;
}

function solanaTransfers(transaction, mint, recipient) {
  const message = transaction.transaction?.message, meta = transaction.meta;
  if (!Array.isArray(message?.accountKeys) || !Array.isArray(message.instructions)) rpcInvalid();
  const keys = message.accountKeys.map(key => typeof key === 'string' ? key : key.pubkey);
  if (new Set(keys).size !== keys.length) rpcInvalid();
  const pre = tokenBalances(meta.preTokenBalances, keys, mint), post = tokenBalances(meta.postTokenBalances, keys, mint);
  const byKey = new Map(keys.map((key, index) => [key, index]));
  const ownedTotal = balances => [...balances.values()].reduce((sum, item) => sum + (item.owner === recipient ? item.amount : 0n), 0n);
  const net = ownedTotal(post) - ownedTotal(pre);
  const inner = meta.innerInstructions || [];
  if (!Array.isArray(inner) || inner.some(group => !Array.isArray(group.instructions))) rpcInvalid();
  const instructions = [...message.instructions, ...inner.flatMap(group => group.instructions)];
  let received = 0n, spent = 0n;
  const payers = new Set();
  for (const instruction of instructions) {
    if (instruction.programId !== TOKEN_PROGRAM || !['transferChecked', 'transfer'].includes(instruction.parsed?.type)) continue;
    const { info, type } = instruction.parsed;
    if (!info || (type === 'transferChecked' && info.mint !== mint)) continue;
    const source = pre.get(byKey.get(info.source)) || post.get(byKey.get(info.source));
    const target = post.get(byKey.get(info.destination));
    if (!source || !target) continue;
    if (type === 'transferChecked' && info.tokenAmount?.decimals !== 6) rpcInvalid();
    const amount = atomic(type === 'transferChecked' ? info.tokenAmount.amount : info.amount);
    if (target.owner === recipient && source.owner !== recipient && amount > 0n) {
      received += amount; payers.add(source.owner);
    }
    if (source.owner === recipient && target.owner !== recipient) spent += amount;
  }
  if (received === 0n || net <= 0n) fail('PAYMENT_TRANSFER_NOT_FOUND');
  if (payers.size !== 1) fail('PAYMENT_AMBIGUOUS_PAYER');
  if (received - spent !== net) fail('PAYMENT_UNSUPPORTED_TRANSFER');
  return { amount: net, payer: [...payers][0] };
}

async function verifySolana(order, txHash, chain, fetchImpl) {
  const call = (method, params = []) => rpc(chain.rpcUrl, method, params, fetchImpl);
  if (await call('getGenesisHash') !== SOLANA_GENESIS) fail('PAYMENT_WRONG_NETWORK', 503);
  const transaction = await call('getTransaction', [txHash, {
    commitment: 'finalized', encoding: 'jsonParsed', maxSupportedTransactionVersion: 1,
  }]);
  if (transaction === null) return pending(txHash);
  if (!transaction?.meta || transaction.transaction?.signatures?.[0] !== txHash) rpcInvalid();
  if (![undefined, 'legacy', 0, 1].includes(transaction.version)) fail('PAYMENT_UNSUPPORTED_TRANSFER');
  if (transaction.meta.err !== null) fail('PAYMENT_TRANSACTION_FAILED');
  const paidAt = paymentTime(order, safeInteger(transaction.blockTime) * 1000);
  const transfer = solanaTransfers(transaction, chain.tokenAddress, order.recipient);
  if (transfer.amount !== BigInt(order.amountAtomic)) fail('PAYMENT_AMOUNT_MISMATCH');
  const slot = safeInteger(transaction.slot);
  if (chain.confirmations > 1) {
    const head = safeInteger(await call('getSlot', [{ commitment: 'finalized' }]));
    if (head - slot + 1 < chain.confirmations) return pending(txHash);
  }
  return confirmed(txHash, transfer.amount, transfer.payer, paidAt);
}

function tronHex(address) { return decode58(address).subarray(1, 21).toString('hex'); }
function tronAddress(hex) {
  const bytes = Buffer.from(`41${hex}`, 'hex');
  const checksum = createHash('sha256').update(createHash('sha256').update(bytes).digest()).digest().subarray(0, 4);
  return encode58(Buffer.concat([bytes, checksum]));
}

async function verifyTron(order, txHash, chain, fetchImpl) {
  const call = (method, body = {}) => solidity(chain.rpcUrl, method, body, fetchImpl);
  const provider = tronProvider(chain.rpcUrl, fetchImpl);
  if (provider.genesisUntil <= Date.now()) {
    if (!provider.genesisPromise) provider.genesisPromise = (async () => {
      const genesis = await call('getblockbynum', { num: 0 });
      const genesisId = hexBytes(genesis.blockID, 32, false);
      if (genesisId !== TRON_GENESIS ||
          (genesis.block_header?.raw_data?.number ?? 0) !== 0) fail('PAYMENT_WRONG_NETWORK', 503);
      provider.genesisUntil = Date.now() + TRON_GENESIS_TTL_MS;
    })().finally(() => { provider.genesisPromise = null; });
    // Share only a short-lived successful mainnet fingerprint; payment receipts and blocks are always reread.
    // Reason: repeated order polling must not spend a public RPC request on the immutable genesis every time.
    await provider.genesisPromise;
  }
  const receipt = await call('gettransactioninfobyid', { value: txHash });
  if (!Object.keys(receipt).length) return pending(txHash);
  if (hexBytes(receipt.id, 32, false) !== txHash) rpcInvalid();
  if (receipt.receipt?.result !== 'SUCCESS') fail('PAYMENT_TRANSACTION_FAILED');
  const transfer = verifyTransfers(receipt.log, tronHex(chain.tokenAddress), tronHex(order.recipient), false);
  if (transfer.amount !== BigInt(order.amountAtomic)) fail('PAYMENT_AMOUNT_MISMATCH');
  const number = safeInteger(receipt.blockNumber);
  const [block, head] = await Promise.all([call('getblockbynum', { num: number }), call('getnowblock')]);
  if (safeInteger(block.block_header?.raw_data?.number) !== number) rpcInvalid();
  const paidAt = paymentTime(order, safeInteger(block.block_header.raw_data.timestamp));
  if (receipt.blockTimeStamp !== paidAt) rpcInvalid();
  if (!Array.isArray(block.transactions) || !block.transactions.some(item => item.txID === txHash)) rpcInvalid();
  const solidNumber = safeInteger(head.block_header?.raw_data?.number);
  if (solidNumber - number + 1 < chain.confirmations) return pending(txHash);
  return confirmed(txHash, transfer.amount, tronAddress(transfer.payer), paidAt);
}

function validateInputs(order, suppliedHash, config) {
  if (!order || !Object.hasOwn(CHAIN_DEFAULTS, order.chain)) fail('PAYMENT_UNSUPPORTED_CHAIN');
  const chain = config?.chains?.[order.chain], defaults = CHAIN_DEFAULTS[order.chain];
  if (!chain?.rpcUrl || !chain.recipient) fail('PAYMENT_CHAIN_UNAVAILABLE', 503);
  let url;
  try { url = new URL(chain.rpcUrl); } catch { fail('PAYMENT_CHAIN_UNAVAILABLE', 503); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) fail('PAYMENT_CHAIN_UNAVAILABLE', 503);
  const recipient = normalizeAddress(order.chain, order.recipient);
  if (recipient !== normalizeAddress(order.chain, chain.recipient) ||
      normalizeAddress(order.chain, chain.tokenAddress) !== normalizeAddress(order.chain, defaults.tokenAddress) ||
      chain.decimals !== defaults.decimals || !Number.isSafeInteger(chain.confirmations) ||
      chain.confirmations < 1 || chain.confirmations > 1000000) fail('PAYMENT_CHAIN_UNAVAILABLE', 503);
  if (typeof order.amountAtomic !== 'string' || !/^\d{1,78}$/.test(order.amountAtomic) || BigInt(order.amountAtomic) <= 0n ||
      !Number.isSafeInteger(order.createdAt) || order.createdAt <= 0 || !Number.isSafeInteger(order.expiresAt) ||
      order.expiresAt <= order.createdAt) fail('PAYMENT_INVALID_ORDER');
  let txHash;
  if (order.chain === 'solana') {
    try {
      if (typeof suppliedHash !== 'string' || decode58(suppliedHash).length !== 64) fail('PAYMENT_INVALID_TX_HASH');
      txHash = suppliedHash;
    } catch { fail('PAYMENT_INVALID_TX_HASH'); }
  } else if (order.chain === 'tron') {
    if (typeof suppliedHash !== 'string' || !/^(0x)?[0-9a-f]{64}$/i.test(suppliedHash)) fail('PAYMENT_INVALID_TX_HASH');
    txHash = suppliedHash.replace(/^0x/i, '').toLowerCase();
  } else {
    if (typeof suppliedHash !== 'string' || !/^0x[0-9a-f]{64}$/i.test(suppliedHash)) fail('PAYMENT_INVALID_TX_HASH');
    txHash = suppliedHash.toLowerCase();
  }
  return { chain: { ...chain, tokenAddress: normalizeAddress(order.chain, chain.tokenAddress) },
    order: { ...order, recipient }, txHash };
}

export async function verifyPayment(order, txHash, config, { fetchImpl = fetch } = {}) {
  try {
    const input = validateInputs(order, txHash, config);
    if (order.chain === 'solana') return await verifySolana(input.order, input.txHash, input.chain, fetchImpl);
    if (order.chain === 'tron') return await verifyTron(input.order, input.txHash, input.chain, fetchImpl);
    return await verifyEvm(input.order, input.txHash, input.chain, fetchImpl);
  } catch (error) {
    if ([400, 503].includes(error.statusCode) && /^[A-Z][A-Z0-9_]*$/.test(error.message)) throw error;
    rpcInvalid();
  }
}
