import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { Wallet, concat, encodeBase58, getBytes, hashMessage, keccak256, toUtf8Bytes } from 'ethers';
import { CHAIN_DEFAULTS } from '../server/module-c/policies.js';
import { verifyWalletProof, walletProofMessage } from '../server/module-c/wallet-proof.js';

const createdAt = 1731912286000;
const recipient = {
  ethereum: '0x2222222222222222222222222222222222222222',
  bsc: '0x2222222222222222222222222222222222222222',
  solana: 'So11111111111111111111111111111111111111112',
  tron: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
};
const base58 = bytes => encodeBase58(bytes);
function tronAddress(evmAddress) {
  const bytes = Buffer.from('41' + evmAddress.slice(2), 'hex');
  const checksum = createHash('sha256').update(createHash('sha256').update(bytes).digest()).digest().subarray(0, 4);
  return encodeBase58(Buffer.concat([bytes, checksum]));
}
function fixture(chain = 'ethereum') {
  const wallet = chain === 'solana' ? generateKeyPairSync('ed25519') : Wallet.createRandom();
  const payer = chain === 'solana' ? base58(wallet.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32))
    : chain === 'tron' ? tronAddress(wallet.address) : wallet.address;
  const order = { id: randomBytes(32).toString('hex'), chain, asset: CHAIN_DEFAULTS[chain].asset,
    payAmount: '0.1', recipient: recipient[chain], createdAt, expiresAt: createdAt + 300000 };
  const txHash = chain === 'solana' ? base58(randomBytes(64))
    : (chain === 'tron' ? '' : '0x') + randomBytes(32).toString('hex');
  const signText = async message => {
    if (chain === 'solana') return sign(null, Buffer.from(message, 'utf8'), wallet.privateKey).toString('base64');
    if (chain !== 'tron') return wallet.signMessage(message);
    const bytes = toUtf8Bytes(message), prefixed = concat([toUtf8Bytes('\x19TRON Signed Message:\n'),
      toUtf8Bytes(String(bytes.length)), bytes]);
    return wallet.signingKey.sign(keccak256(prefixed)).serialized;
  };
  return { wallet, payer, order, txHash, signText };
}
const invalid = error => error.message === 'INVALID_WALLET_PROOF' && error.statusCode === 400 && error.cause === undefined;

for (const chain of ['solana', 'tron', 'ethereum', 'bsc']) {
  test(`${chain}: a real temporary key proves ownership of this stored order and transaction`, async () => {
    const f = fixture(chain), before = JSON.stringify(f.order), message = walletProofMessage(f.order, f.txHash);
    const signature = await f.signText(message), proof = { payer: f.payer, signature };
    const expected = ['ethereum', 'bsc'].includes(chain) ? f.payer.toLowerCase() : f.payer;
    assert.equal(verifyWalletProof(f.order, f.txHash, proof), expected);
    assert.equal(JSON.stringify(f.order), before); assert.deepEqual(Object.keys(proof), ['payer', 'signature']);
    assert.ok(message.includes('This signature proves wallet ownership only.'));
    assert.ok(message.includes('Domain: example.invalid\nPurpose: claim-paid-message-transaction'));
    assert.ok(message.includes('Token: ' + CHAIN_DEFAULTS[chain].tokenAddress.toLowerCase())
      || message.includes('Token: ' + CHAIN_DEFAULTS[chain].tokenAddress));
    assert.equal(message.endsWith('\n'), false);
  });

  test(`${chain}: same-priced orders and another transaction cannot reuse the signature`, async () => {
    const f = fixture(chain), signature = await f.signText(walletProofMessage(f.order, f.txHash));
    const proof = { payer: f.payer, signature };
    assert.throws(() => verifyWalletProof({ ...f.order, id: randomBytes(32).toString('hex') }, f.txHash, proof), invalid);
    const otherTx = chain === 'solana' ? base58(randomBytes(64)) : 'b'.repeat(64);
    assert.throws(() => verifyWalletProof(f.order, otherTx, proof), invalid);
    const other = fixture(chain);
    assert.throws(() => verifyWalletProof(f.order, f.txHash, { ...proof, payer: other.payer }), invalid);
  });

  test(`${chain}: transfer amount, recipient, original window and domain remain bound`, async () => {
    const f = fixture(chain), message = walletProofMessage(f.order, f.txHash);
    const proof = { payer: f.payer, signature: await f.signText(message) };
    const another = fixture(chain);
    for (const patch of [{ payAmount: '0.2' }, { recipient: another.payer },
      { createdAt: createdAt + 1 }, { expiresAt: f.order.expiresAt + 1 }]) {
      assert.throws(() => verifyWalletProof({ ...f.order, ...patch }, f.txHash, proof), invalid);
    }
    for (const replacement of [message.replace('example.invalid', 'attacker.invalid'),
      message.replace('claim-paid-message-transaction', 'send-all-funds'), message + '\n']) {
      const alteredSignature = await f.signText(replacement);
      assert.throws(() => verifyWalletProof(f.order, f.txHash,
        { payer: f.payer, signature: alteredSignature }), invalid);
    }
  });
}

test('walletProofMessage has a stable readable format with canonical amount, contract and hash', () => {
  const order = { id: 'a'.repeat(64), chain: 'ethereum', asset: 'USDT', payAmount: '0.100000',
    recipient: recipient.ethereum.toUpperCase().replace('0X', '0x'), createdAt, expiresAt: createdAt + 300000 };
  assert.equal(walletProofMessage(order, '  ' + 'B'.repeat(64) + '  '), [
    'SBF Module C payment ownership proof', 'Version: 1', 'Domain: example.invalid',
    'Purpose: claim-paid-message-transaction',
    'This signature proves wallet ownership only. It does not send funds or authorize token spending.',
    'Order: ' + 'a'.repeat(64), 'Chain: ethereum', 'Asset: USDT', 'Pay amount: 0.1',
    'Recipient: ' + recipient.ethereum, 'Token: 0xdac17f958d2ee523a2206206994597c13d831ec7',
    'Created at (ms): ' + createdAt, 'Expires at (ms): ' + (createdAt + 300000),
    'Transaction: 0x' + 'b'.repeat(64),
  ].join('\n'));
});

test('Ethereum and BSC signatures are chain-separated even for the same EOA and amount', async () => {
  const f = fixture(), proof = { payer: f.payer, signature: await f.signText(walletProofMessage(f.order, f.txHash)) };
  assert.throws(() => verifyWalletProof({ ...f.order, chain: 'bsc' }, f.txHash, proof), invalid);
  const bytesSignature = await f.wallet.signMessage(getBytes(hashMessage(walletProofMessage(f.order, f.txHash))));
  assert.throws(() => verifyWalletProof(f.order, f.txHash, { payer: f.payer, signature: bytesSignature }), invalid);
});

test('TRON V2 accepts its documented hex signature forms and canonicalizes tx hash', async () => {
  const f = fixture('tron'), message = walletProofMessage(f.order, f.txHash);
  const signature = await f.signText(message);
  assert.equal(verifyWalletProof(f.order, '0x' + f.txHash.toUpperCase(), { payer: f.payer, signature }), f.payer);
  assert.equal(verifyWalletProof(f.order, f.txHash, { payer: f.payer, signature: signature.slice(2) }), f.payer);
  const recovery = Number.parseInt(signature.slice(-2), 16) - 27;
  const zeroOneSignature = signature.slice(0, -2) + recovery.toString(16).padStart(2, '0');
  assert.equal(verifyWalletProof(f.order, f.txHash, { payer: f.payer, signature: zeroOneSignature }), f.payer);
});

test('TRON V1 and Ethereum personal-sign prefixes cannot substitute for signMessageV2', async () => {
  const f = fixture('tron'), message = walletProofMessage(f.order, f.txHash);
  const ethereum = await f.wallet.signMessage(message);
  const v1 = f.wallet.signingKey.sign(keccak256(concat([toUtf8Bytes('\x19TRON Signed Message:\n32'),
    toUtf8Bytes(message)]))).serialized;
  for (const signature of [ethereum, v1]) assert.throws(() => verifyWalletProof(f.order, f.txHash,
    { payer: f.payer, signature }), invalid);
});

test('Solana requires the raw UTF-8 signature and canonical base64 representation of exactly 64 bytes', async () => {
  const f = fixture('solana'), message = walletProofMessage(f.order, f.txHash), signature = await f.signText(message);
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const noncanonical = signature.slice(0, 85) + alphabet[alphabet.indexOf(signature[85]) + 1] + '==';
  assert.equal(Buffer.from(noncanonical, 'base64').toString('hex'), Buffer.from(signature, 'base64').toString('hex'));
  for (const value of [signature.trimEnd() + '\n', signature.slice(0, -2), noncanonical,
    randomBytes(63).toString('base64'), randomBytes(65).toString('base64'), base58(Buffer.from(signature, 'base64'))]) {
    assert.throws(() => verifyWalletProof(f.order, f.txHash, { payer: f.payer, signature: value }), invalid);
  }
  const hashSigned = sign(null, createHash('sha256').update(message).digest(), f.wallet.privateKey).toString('base64');
  assert.throws(() => verifyWalletProof(f.order, f.txHash, { payer: f.payer, signature: hashSigned }), invalid);
});

test('Solana transaction signatures preserve leading zero bytes as base58 ones', async () => {
  const f = fixture('solana'), txHash = base58(Buffer.concat([Buffer.alloc(2), randomBytes(62)]));
  assert.ok(txHash.startsWith('11'));
  const signature = await f.signText(walletProofMessage(f.order, txHash));
  assert.equal(verifyWalletProof(f.order, txHash, { payer: f.payer, signature }), f.payer);
});

test('invalid proofs, addresses and signature formats produce a scrubbed 400 error', async () => {
  const f = fixture(), proof = { payer: f.payer, signature: await f.signText(walletProofMessage(f.order, f.txHash)) };
  for (const value of [null, [], {}, { payer: proof.payer }, { ...proof, message: 'client supplied' },
    { ...proof, payer: '0x' + '0'.repeat(40) }, { ...proof, payer: 'not-an-address' },
    { ...proof, signature: '0x' + 'a'.repeat(128) }, { ...proof, signature: '0x' + 'g'.repeat(130) },
    { ...proof, signature: 4 }, { ...proof, signature: 'x'.repeat(100000) }]) {
    assert.throws(() => verifyWalletProof(f.order, f.txHash, value), invalid);
  }
});

test('unknown assets, manipulated contracts and invalid order windows cannot create a proof message', () => {
  const f = fixture();
  for (const patch of [{ id: 'a'.repeat(63) }, { id: 'a'.repeat(64) + '\nPurpose: other' }, { chain: '__proto__' },
    { asset: 'USDC' }, { tokenAddress: f.order.recipient }, { payAmount: '0' }, { payAmount: '-0.1' },
    { payAmount: '0.0000001' }, { payAmount: 0.1 }, { createdAt: 0 }, { createdAt: 1.5 },
    { expiresAt: f.order.createdAt }, { expiresAt: Number.MAX_SAFE_INTEGER + 1 }]) {
    assert.throws(() => walletProofMessage({ ...f.order, ...patch }, f.txHash));
  }
});

test('invalid or zero transaction identifiers cannot be signed as a claim', () => {
  const f = fixture();
  for (const value of ['', 'a'.repeat(63), '0x' + 'a'.repeat(65), '0'.repeat(64), 'x'.repeat(129), 3]) {
    assert.throws(() => walletProofMessage(f.order, value));
  }
  const solana = fixture('solana');
  for (const value of ['1'.repeat(64), 'O'.repeat(88), base58(randomBytes(63))]) {
    assert.throws(() => walletProofMessage(solana.order, value));
  }
});

test('cryptographic ownership verification preserves old paid rights and the original expiry snapshot', async () => {
  const f = fixture('bsc'), signature = await f.signText(walletProofMessage(f.order, f.txHash));
  const paid = { ...f.order, state: 'paid', startsAt: createdAt + 1000, boardExpiresAt: createdAt + 31000,
    amountAtomic: '100000000000000000', durationMs: 30000, interactionState: 'done',
    alert: { version: 1, tierIndex: 1, startsAt: createdAt + 2000, expiresAt: createdAt + 6000 } };
  const before = JSON.stringify(paid);
  assert.equal(verifyWalletProof(paid, f.txHash, { payer: f.payer, signature }), f.payer.toLowerCase());
  assert.equal(JSON.stringify(paid), before);
});
