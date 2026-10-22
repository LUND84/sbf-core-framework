import { createHash, createPublicKey, verify } from 'node:crypto';
import { getBytes, keccak256, recoverAddress, verifyMessage } from 'ethers';
import { CHAIN_DEFAULTS, fail, formatUnits, normalizeAddress, parseUnits } from './policies.js';

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const ED25519_SPKI = Buffer.from('302a300506032b6570032100', 'hex');
function decode58(value, length) {
  if (typeof value !== 'string' || value.length > 88 || !/^[1-9A-HJ-NP-Za-km-z]+$/.test(value)) fail('INVALID_WALLET_PROOF');
  let n = 0n;
  for (const char of value) n = n * 58n + BigInt(BASE58.indexOf(char));
  const hex = n.toString(16).padStart(Math.ceil(n.toString(16).length / 2) * 2, '0');
  const bytes = Buffer.concat([Buffer.alloc(value.match(/^1*/)[0].length), n ? Buffer.from(hex, 'hex') : Buffer.alloc(0)]);
  if (bytes.length !== length || !bytes.some(byte => byte !== 0)) fail('INVALID_WALLET_PROOF');
  return bytes;
}
function encode58(bytes) {
  let n = BigInt('0x' + bytes.toString('hex')), value = '';
  while (n) { value = BASE58[Number(n % 58n)] + value; n /= 58n; }
  for (const byte of bytes) { if (byte !== 0) break; value = '1' + value; }
  return value;
}
function canonicalHash(chain, txHash) {
  if (typeof txHash !== 'string' || txHash.length > 128) fail('INVALID_TX_HASH');
  const value = txHash.trim();
  if (chain === 'solana') { decode58(value, 64); return value; }
  if (!/^(0x)?[0-9a-fA-F]{64}$/.test(value) || /^(0x)?0{64}$/.test(value)) fail('INVALID_TX_HASH');
  return (chain === 'tron' ? '' : '0x') + value.replace(/^0x/, '').toLowerCase();
}

// Rebuild the message from the stored order, never from client-supplied text.
// Reason: the order nonce and full transfer binding prevent same-price or cross-chain claims.
export function walletProofMessage(order, txHash) {
  if (!order || typeof order !== 'object' || Array.isArray(order) || !Object.hasOwn(CHAIN_DEFAULTS, order.chain)
    || typeof order.id !== 'string' || !/^[a-f0-9]{64}$/.test(order.id)
    || !Number.isSafeInteger(order.createdAt) || order.createdAt <= 0
    || !Number.isSafeInteger(order.expiresAt) || order.expiresAt <= order.createdAt) fail('INVALID_WALLET_PROOF_ORDER');
  const chain = order.chain, c = CHAIN_DEFAULTS[chain], recipient = normalizeAddress(chain, order.recipient);
  if (order.asset !== c.asset) fail('INVALID_WALLET_PROOF_ORDER');
  const token = normalizeAddress(chain, c.tokenAddress), amount = parseUnits(order.payAmount, c.decimals);
  if (amount <= 0n || (order.tokenAddress !== undefined && normalizeAddress(chain, order.tokenAddress) !== token)) {
    fail('INVALID_WALLET_PROOF_ORDER');
  }
  return ['SBF Module C payment ownership proof', 'Version: 1', 'Domain: example.invalid',
    'Purpose: claim-paid-message-transaction',
    'This signature proves wallet ownership only. It does not send funds or authorize token spending.',
    `Order: ${order.id}`, `Chain: ${chain}`, `Asset: ${c.asset}`, `Pay amount: ${formatUnits(amount, c.decimals)}`,
    `Recipient: ${recipient}`, `Token: ${token}`, `Created at (ms): ${order.createdAt}`,
    `Expires at (ms): ${order.expiresAt}`, `Transaction: ${canonicalHash(chain, txHash)}`].join('\n');
}
function secpSignature(value, allowUnprefixed) {
  if (typeof value !== 'string' || !(allowUnprefixed ? /^(0x)?[a-fA-F0-9]{130}$/ : /^0x[a-fA-F0-9]{130}$/).test(value)) {
    fail('INVALID_WALLET_PROOF');
  }
  return '0x' + value.replace(/^0x/, '');
}
function solanaSigner(message, payer, signature) {
  if (typeof signature !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(signature)) fail('INVALID_WALLET_PROOF');
  const bytes = Buffer.from(signature, 'base64');
  if (bytes.length !== 64 || bytes.toString('base64') !== signature) fail('INVALID_WALLET_PROOF');
  const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI, decode58(payer, 32)]), format: 'der', type: 'spki' });
  if (!verify(null, Buffer.from(message, 'utf8'), key, bytes)) fail('INVALID_WALLET_PROOF');
  return payer;
}
function tronSigner(message, signature) {
  // TronWeb V2 uses the UTF-8 byte length, not V1's fixed 32-byte header or Ethereum's prefix.
  // Reason: only signMessageV2 signatures match the wallet's readable-text ownership prompt.
  // Official source: https://github.com/tronprotocol/tronweb/blob/v6.5.0/src/utils/message.ts
  const bytes = Buffer.from(message, 'utf8');
  const digest = keccak256(Buffer.concat([Buffer.from('\x19TRON Signed Message:\n', 'utf8'),
    Buffer.from(String(bytes.length), 'ascii'), bytes]));
  const recovered = recoverAddress(digest, secpSignature(signature, true));
  const payload = Buffer.concat([Buffer.from([0x41]), Buffer.from(getBytes(recovered))]);
  const checksum = createHash('sha256').update(createHash('sha256').update(payload).digest()).digest().subarray(0, 4);
  return encode58(Buffer.concat([payload, checksum]));
}

// This proves control of a signing key, not that its transaction has paid the order.
// Reason: the caller must still compare the recovered payer with the independently verified transfer payer.
// No wall-clock expiry is applied here; the message binds the immutable original payment window.
// Reason: a transfer made in that window can legitimately reach chain confirmation later.
export function verifyWalletProof(order, txHash, proof) {
  try {
    if (!proof || typeof proof !== 'object' || Array.isArray(proof) || Object.keys(proof).length !== 2
      || !Object.hasOwn(proof, 'payer') || !Object.hasOwn(proof, 'signature')) fail('INVALID_WALLET_PROOF');
    const message = walletProofMessage(order, txHash), payer = normalizeAddress(order.chain, proof.payer);
    const recovered = order.chain === 'solana' ? solanaSigner(message, payer, proof.signature)
      : order.chain === 'tron' ? tronSigner(message, proof.signature)
        : normalizeAddress(order.chain, verifyMessage(message, secpSignature(proof.signature, false)));
    if (recovered !== payer) fail('INVALID_WALLET_PROOF');
    return payer;
  } catch { fail('INVALID_WALLET_PROOF'); }
}
