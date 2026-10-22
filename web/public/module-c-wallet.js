const CHAINS = new Set(['ethereum', 'bsc', 'solana', 'tron']);
const ERRORS = new Set(['WALLET_UNAVAILABLE', 'WALLET_ACCOUNT_UNAVAILABLE', 'WALLET_ACCOUNT_CHANGED',
  'WALLET_SIGNATURE_INVALID', 'WALLET_REQUEST_REJECTED', 'WALLET_REQUEST_PENDING', 'WALLET_SIGNING_FAILED',
  'INVALID_WALLET_MESSAGE', 'INVALID_TX_HASH', 'UNSUPPORTED_PAYMENT_CHAIN']);
const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const fail = code => { throw new Error(code); };

function base58Size(value) {
  if (typeof value !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{1,100}$/.test(value)) return 0;
  let n = 0n;
  for (const char of value) n = n * 58n + BigInt(BASE58.indexOf(char));
  return (n ? Math.ceil(n.toString(16).length / 2) : 0) + value.match(/^1*/)[0].length;
}
function account(chain, value) {
  const valid = chain === 'ethereum' || chain === 'bsc'
    ? typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value) && !/^0x0{40}$/i.test(value)
    : chain === 'solana' ? base58Size(value) === 32 && !/^1+$/.test(value)
      : typeof value === 'string' && /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(value);
  if (!valid) fail('WALLET_ACCOUNT_UNAVAILABLE');
  return chain === 'ethereum' || chain === 'bsc' ? value.toLowerCase() : value;
}
function publicKey(value) {
  return typeof value === 'string' ? value : value?.toBase58?.() || value?.toString?.();
}
function transaction(chain, value) {
  if (typeof value !== 'string' || (chain === 'solana' ? base58Size(value) !== 64
    : !new RegExp(chain === 'tron' ? '^(0x)?[a-fA-F0-9]{64}$' : '^0x[a-fA-F0-9]{64}$').test(value))) {
    fail('INVALID_TX_HASH');
  }
  return chain === 'solana' ? value : (chain === 'tron' ? '' : '0x') + value.replace(/^0x/, '').toLowerCase();
}
function hexSignature(value, optionalPrefix = false) {
  if (typeof value !== 'string' || !(optionalPrefix ? /^(0x)?[a-fA-F0-9]{130}$/
    : /^0x[a-fA-F0-9]{130}$/).test(value)) fail('WALLET_SIGNATURE_INVALID');
  return '0x' + value.replace(/^0x/, '').toLowerCase();
}
function walletError(error) {
  if (ERRORS.has(error?.message)) return error;
  const code = String(error?.code || '');
  const message = typeof error === 'string' ? error : error?.message || '';
  if (code === '4001' || code === 'ACTION_REJECTED'
    || /(?:user rejected|user declined|declined by user|rejected the request)/i.test(message)) {
    return new Error('WALLET_REQUEST_REJECTED');
  }
  if (['4000', '-32002'].includes(code)) return new Error('WALLET_REQUEST_PENDING');
  return new Error('WALLET_SIGNING_FAILED');
}
async function connectEvm(provider) {
  if (typeof provider?.request !== 'function') fail('WALLET_UNAVAILABLE');
  const accounts = await provider.request({ method: 'eth_requestAccounts' });
  return account('ethereum', Array.isArray(accounts) ? accounts[0] : undefined);
}
async function evm(message, provider) {
  const payer = await connectEvm(provider);
  const encoded = '0x' + [...new TextEncoder().encode(message)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  const signature = hexSignature(await provider.request({ method: 'personal_sign', params: [encoded, payer] }));
  return { payer, signature };
}
async function connectSol(provider) {
  if (typeof provider?.connect !== 'function' || typeof provider.signMessage !== 'function') fail('WALLET_UNAVAILABLE');
  const connection = await provider.connect();
  return account('solana', publicKey(connection?.publicKey || provider.publicKey));
}
async function sol(message, provider) {
  const payer = await connectSol(provider);
  const response = await provider.signMessage(new TextEncoder().encode(message), 'utf8');
  const signature = response instanceof Uint8Array ? response : response?.signature;
  if (!(signature instanceof Uint8Array) || signature.byteLength !== 64) fail('WALLET_SIGNATURE_INVALID');
  for (const selected of [response?.publicKey, provider.publicKey]) {
    if (selected && account('solana', publicKey(selected)) !== payer) fail('WALLET_ACCOUNT_CHANGED');
  }
  return { payer, signature: btoa(String.fromCharCode(...signature)) };
}
async function connectTron(modern, legacy, injectedWeb) {
  const provider = modern || legacy || (typeof injectedWeb?.request === 'function' ? injectedWeb : null);
  if (typeof provider?.request !== 'function') fail('WALLET_UNAVAILABLE');
  let connection;
  try { connection = await provider.request({ method: modern ? 'eth_requestAccounts' : 'tron_requestAccounts' }); }
  catch (error) {
    if (!modern || !['4200', '-32601'].includes(String(error?.code))) throw error;
    connection = await provider.request({ method: 'tron_requestAccounts' });
  }
  if (connection?.code !== undefined && connection.code !== 200) throw connection;
  if (!Array.isArray(connection) && connection?.code !== 200) fail('WALLET_ACCOUNT_UNAVAILABLE');
  const web = provider.tronWeb || injectedWeb;
  if (typeof web?.trx?.signMessageV2 !== 'function') fail('WALLET_UNAVAILABLE');
  const payer = account('tron', Array.isArray(connection) ? connection[0] : web.defaultAddress?.base58);
  if (web.defaultAddress?.base58 && account('tron', web.defaultAddress.base58) !== payer) fail('WALLET_ACCOUNT_CHANGED');
  return { payer, web };
}
async function tron(message, modern, legacy, injectedWeb) {
  const { payer, web } = await connectTron(modern, legacy, injectedWeb);
  const signature = hexSignature(await web.trx.signMessageV2(message), true);
  if (web.defaultAddress?.base58 && account('tron', web.defaultAddress.base58) !== payer) fail('WALLET_ACCOUNT_CHANGED');
  return { payer, signature };
}

// Connect before creating a payable order, while leaving payment and ownership signing to their own prompts.
// Reason: a viewer must discover missing or locked signing capabilities before transferring funds.
export async function connectModuleCPaymentWallet(chain, { ethereum = globalThis.ethereum,
  solana = globalThis.solana || globalThis.phantom?.solana, tronLink = globalThis.tronLink,
  tronWeb = globalThis.tronWeb, tron: modernTron = globalThis.tron } = {}) {
  if (!CHAINS.has(chain)) fail('UNSUPPORTED_PAYMENT_CHAIN');
  try {
    if (chain === 'ethereum' || chain === 'bsc') return await connectEvm(ethereum);
    if (chain === 'solana') return await connectSol(solana);
    return (await connectTron(modernTron, tronLink, tronWeb)).payer;
  } catch (error) { throw walletError(error); }
}

// Sign the exact readable challenge returned by the same-origin proof-message endpoint.
// Reason: the server owns order/hash binding and must verify its own message, never client-reconstructed text.
// These adapters request account access and a message signature only.
// Reason: claiming an existing payment must never send funds, approve tokens or request a transaction signature.
export async function signModuleCPayment(order, txHash, { message, ethereum = globalThis.ethereum,
  solana = globalThis.solana || globalThis.phantom?.solana, tronLink = globalThis.tronLink,
  tronWeb = globalThis.tronWeb, tron: modernTron = globalThis.tron } = {}) {
  if (!CHAINS.has(order?.chain)) fail('UNSUPPORTED_PAYMENT_CHAIN');
  const canonicalHash = transaction(order.chain, txHash);
  if (typeof message !== 'string' || !message.trim() || message.length > 8192
    || /[\u0000-\u0008\u000b-\u001f\u007f]/.test(message)) fail('INVALID_WALLET_MESSAGE');
  const lines = message.split('\n');
  if (typeof order.id !== 'string' || !/^[a-f0-9]{64}$/.test(order.id)
    || lines[0] !== 'SBF Module C payment ownership proof' || lines[1] !== 'Version: 1'
    || !lines.includes('Domain: example.invalid') || !lines.includes('Purpose: claim-paid-message-transaction')
    || !lines.includes(`Order: ${order.id}`) || !lines.includes(`Chain: ${order.chain}`)
    || !lines.includes(`Transaction: ${canonicalHash}`)) fail('INVALID_WALLET_MESSAGE');
  try {
    if (order.chain === 'ethereum' || order.chain === 'bsc') return await evm(message, ethereum);
    if (order.chain === 'solana') return await sol(message, solana);
    return await tron(message, modernTron, tronLink, tronWeb);
  } catch (error) { throw walletError(error); }
}
