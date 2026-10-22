import { parentPort } from 'node:worker_threads';
import { performance } from 'node:perf_hooks';
import { FragmentStream } from './stream-fragments.js';
import { EncodedClip, mediaError } from './local-fmp4.js';
import { preparedDescriptor } from './prepared-clip.js';

const contexts = new Map(), ID = /^[A-Za-z0-9_-]{1,80}$/;
const codeOf = error => /^[A-Z][A-Z0-9_]{0,63}$/.test(error?.code || '') ? error.code : 'STREAM_VALIDATION_FAILED';
function need(value, code) { if (!value) throw mediaError(code); }
function buffer(data) {
  need(data instanceof Uint8Array && data.byteOffset === 0 && data.byteLength === data.buffer.byteLength,
    'STREAM_VALIDATOR_TRANSFER');
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
}
parentPort.on('message', ({ op, id, seq, meta, serial, data }) => {
  const started = performance.now();
  try {
    need(typeof id === 'string' && ID.test(id), 'STREAM_VALIDATOR_REQUEST');
    let result;
    if (op === 'begin') {
      need(!contexts.has(id) && contexts.size < 2, 'STREAM_VALIDATOR_CONTEXTS');
      const stream = new FragmentStream({ init: buffer(data), mime: meta?.mime,
        compatibilitySignature: meta?.compatibilitySignature });
      contexts.set(id, { stream, nextSeq: 0 }); result = { begun: true };
    } else if (op === 'cancel') {
      contexts.delete(id); result = { canceled: true };
    } else {
      const context = contexts.get(id); need(context, 'STREAM_VALIDATOR_REQUEST');
      if (op === 'push') {
        need(seq === context.nextSeq && Number.isSafeInteger(seq) && seq >= 0 && seq < 225, 'STREAM_VALIDATOR_SEQUENCE');
        const blocks = context.stream.push(buffer(data)); context.nextSeq++;
        result = { blocks: blocks.map(block => {
          // All concat, hashes, strict reparse and sample descriptors stay on this thread.
          // Reason: complete blocks may enter playout before end without stalling the relay's media clock.
          const bytes = Buffer.concat([context.stream.init, block.data]);
          const clip = new EncodedClip(bytes, { maxDurationSeconds: 1 });
          return { descriptor: preparedDescriptor({ bytes, clip }), index: block.index,
            relativeStartTicks: [...block.relativeStartTicks], receipt: block.receipt };
        }) };
      } else {
        need(op === 'end', 'STREAM_VALIDATOR_OPERATION');
        result = { receipt: context.stream.finish() }; contexts.delete(id);
      }
    }
    const transfer = (result.blocks || []).flatMap(block => [block.descriptor.init.buffer,
      ...block.descriptor.parts.map(part => part.data.buffer)]);
    parentPort.postMessage({ type: 'result', op, id, serial, ...result, validationMs: performance.now() - started }, transfer);
  } catch (error) {
    // Fail only this request and publish a fixed code. Reason: a malformed stream must not retire the other hot context or echo payload/error text.
    contexts.delete(id);
    parentPort.postMessage({ type: 'result', op, id, serial, error: codeOf(error) });
  }
});
parentPort.postMessage({ type: 'ready' });
