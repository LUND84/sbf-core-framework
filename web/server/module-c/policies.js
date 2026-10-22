import { createHash, timingSafeEqual } from 'node:crypto';
import { dirname, isAbsolute, join, resolve } from 'node:path';

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function encode58(bytes) {
  let n = BigInt('0x' + (Buffer.from(bytes).toString('hex') || '0')), result = '';
  while (n) { result = BASE58[Number(n % 58n)] + result; n /= 58n; }
  for (const b of bytes) { if (b !== 0) break; result = '1' + result; }
  return result;
}
export function decode58(value) {
  if (typeof value !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{1,100}$/.test(value)) fail('INVALID_ADDRESS');
  let n = 0n;
  for (const ch of value) n = n * 58n + BigInt(BASE58.indexOf(ch));
  let hex = n.toString(16); if (hex.length % 2) hex = '0' + hex;
  const bytes = n ? Buffer.from(hex, 'hex') : Buffer.alloc(0);
  return Buffer.concat([Buffer.alloc(value.match(/^1*/)[0].length), bytes]);
}
export function fail(code, statusCode = 400) { throw Object.assign(new Error(code), { statusCode }); }
export function normalizeAddress(chain, value) {
  if (typeof value !== 'string') fail('INVALID_ADDRESS');
  if (chain === 'ethereum' || chain === 'bsc') {
    if (!/^0x[0-9a-fA-F]{40}$/.test(value) || /^0x0{40}$/i.test(value)) fail('INVALID_ADDRESS');
    return value.toLowerCase();
  }
  const bytes = decode58(value);
  if (chain === 'solana' && bytes.length === 32 && bytes.some(b => b !== 0)) return value;
  if (chain === 'tron' && bytes.length === 25 && bytes[0] === 0x41) {
    const checksum = createHash('sha256').update(createHash('sha256').update(bytes.subarray(0, 21)).digest()).digest();
    if (timingSafeEqual(bytes.subarray(21), checksum.subarray(0, 4))) return value;
  }
  fail('INVALID_ADDRESS');
}
export function parseUnits(value, decimals) {
  if (typeof value !== 'string' || !/^\d{1,12}(\.\d{1,18})?$/.test(value)) fail('INVALID_AMOUNT');
  const [whole, fraction = ''] = value.split('.');
  if (fraction.length > decimals) fail('INVALID_AMOUNT_PRECISION');
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, '0') || '0');
}
export function formatUnits(value, decimals) {
  const n = BigInt(value), scale = 10n ** BigInt(decimals);
  const fraction = (n % scale).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${n / scale}${fraction ? '.' + fraction : ''}`;
}
export const CHAIN_DEFAULTS = {
  solana: { label: 'Solana', asset: 'USDC', decimals: 6,
    tokenAddress: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', rpcUrl: 'https://api.mainnet-beta.solana.com', confirmations: 1 },
  tron: { label: 'TRON', asset: 'USDT', decimals: 6,
    tokenAddress: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', rpcUrl: 'https://api.trongrid.io', confirmations: 1 },
  ethereum: { label: 'Ethereum', asset: 'USDT', decimals: 6,
    tokenAddress: '0xdac17f958d2ee523a2206206994597c13d831ec7', rpcUrl: 'https://ethereum-rpc.publicnode.com', confirmations: 12 },
  bsc: { label: 'BNB Smart Chain', asset: 'USDT', decimals: 18,
    tokenAddress: '0x55d398326f99059ff775485246999027b3197955', rpcUrl: 'https://bsc-rpc.publicnode.com', confirmations: 15 },
};
export function readModuleCConfig(env) {
  const requested = env.MODULE_C_ENABLED === '1';
  if (env.MODULE_C_ENABLED && !['0', '1'].includes(env.MODULE_C_ENABLED)) fail('INVALID_MODULE_C_ENABLED', 500);
  const chains = {};
  for (const [id, defaults] of Object.entries(CHAIN_DEFAULTS)) {
    const prefix = `MODULE_C_${id.toUpperCase()}`;
    const recipient = env[`${prefix}_RECIPIENT`] || '';
    const rpcUrl = env[`${prefix}_RPC_URL`] || defaults.rpcUrl;
    let url; try { url = new URL(rpcUrl); } catch { fail('INVALID_MODULE_C_RPC_URL', 500); }
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) fail('INVALID_MODULE_C_RPC_URL', 500);
    chains[id] = { ...defaults, rpcUrl, recipient: recipient ? normalizeAddress(id, recipient) : '',
      enabled: requested && Boolean(recipient) };
  }
  const enabled = Object.values(chains).some(c => c.enabled);
  const dataFile = env.MODULE_C_DATA_FILE || '';
  if (enabled && !isAbsolute(dataFile)) fail('MODULE_C_REQUIRES_ABSOLUTE_DATA_FILE', 500);
  const adminToken = env.MODULE_C_ADMIN_TOKEN || '';
  if (typeof adminToken !== 'string' || (adminToken && (!/^[\x21-\x7e]{32,512}$/.test(adminToken)
    || adminToken === env.WORKER_TOKEN))) fail('INVALID_MODULE_C_ADMIN_TOKEN', 500);
  const pricingDataFile = env.MODULE_C_PRICING_DATA_FILE || (isAbsolute(dataFile) ? join(dirname(dataFile), 'pricing.json') : '');
  if ((enabled || adminToken || pricingDataFile) && !isAbsolute(pricingDataFile)) fail('MODULE_C_REQUIRES_ABSOLUTE_PRICING_FILE', 500);
  const canonical = value => process.platform === 'win32' ? resolve(value).toLowerCase() : resolve(value);
  if (pricingDataFile && dataFile && canonical(pricingDataFile) === canonical(dataFile)) fail('MODULE_C_PRICING_FILE_MUST_BE_SEPARATE', 500);
  if (pricingDataFile && isAbsolute(dataFile) && canonical(dirname(pricingDataFile)) !== canonical(dirname(dataFile))) {
    fail('MODULE_C_PRICING_FILE_MUST_SHARE_STATE_DIRECTORY', 500);
  }
  return { enabled, chains, dataFile, adminToken, pricingDataFile, trustProxy: env.TRUST_PROXY === 'true',
    videoOverlay: env.MODULE_C_VIDEO_OVERLAY === '1',
    minAmount: '20', secondsPer20: 30, orderTtlMs: 30 * 60 * 1000 };
}
