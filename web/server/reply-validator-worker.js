import { parentPort } from 'node:worker_threads';
import { performance } from 'node:perf_hooks';
import { normalizeSealedReply } from './local-reply-normalize.js';
import { preparedDescriptor } from './prepared-clip.js';

parentPort.postMessage({ type: 'ready' });
parentPort.on('message', ({ serial, chunks, meta }) => {
  const started = performance.now();
  try {
    // Concatenation, hashes, normalization and strict reparse all stay here. Reason: an authenticated 64MiB upload must not block the relay's 20ms pacing owner.
    const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)));
    const result = normalizeSealedReply(bytes, meta), descriptor = preparedDescriptor(result);
    const transfer = [descriptor.init.buffer, ...descriptor.parts.map((part) => part.data.buffer)];
    parentPort.postMessage({ serial, descriptor, validationMs: performance.now() - started }, transfer);
  } catch (error) {
    // Fixed error codes only. Reason: request objects, byte payloads and exception messages can contain identity or application content.
    parentPort.postMessage({ serial, error: /^\w{1,64}$/.test(error?.code || '') ? error.code : 'REPLY_VALIDATION_FAILED' });
  }
});
