import { createHash } from 'node:crypto';

const known = new WeakSet(), completed = new WeakSet();
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const elapsed = (start, end) => finite(start) && finite(end) && end >= start ? end - start : null;

export class StreamReceiveTimings {
  #clock; #report; #last = null; #samples = 0; #maxAfterBody = null;
  constructor({ clock, report = () => {} }) { this.#clock = clock; this.#report = report; }
  #stamp() {
    try { const value = this.#clock(); return finite(value) ? value : null; }
    catch { return null; }
  }
  arrival() { return this.#stamp(); }
  begin(id, kind, index, bytes, arrivedAt = this.#stamp()) {
    const trace = { requestHash: createHash('sha256').update(typeof id === 'string' ? id : '').digest('hex').slice(0, 12),
      kind: kind === 'init' ? 'init' : 'part', index: Number.isSafeInteger(index) ? index : null,
      bytes: Number.isSafeInteger(bytes) ? bytes : null, headerAt: arrivedAt, firstAt: null, seenBinary: false,
      completeAt: null, assembledAt: null, validationStartedAt: null, validatedAt: null,
      creditedAt: null, creditBlockedAttempts: 0, worker: null };
    known.add(trace); return trace;
  }
  binary(trace, last, arrivedAt = this.#stamp()) {
    if (!known.has(trace)) return;
    if (!trace.seenBinary) { trace.firstAt = arrivedAt; trace.seenBinary = true; }
    if (last) trace.completeAt = arrivedAt;
  }
  assembled(trace) { if (known.has(trace)) trace.assembledAt = this.#stamp(); }
  validationStarted(trace) { if (known.has(trace)) trace.validationStartedAt = this.#stamp(); }
  validated(trace, worker = null) {
    if (!known.has(trace)) return;
    trace.validatedAt = this.#stamp(); trace.worker = worker;
  }
  creditBlocked(trace) {
    if (known.has(trace)) trace.creditBlockedAttempts = Math.min(100000, trace.creditBlockedAttempts + 1);
  }
  credited(trace) { if (known.has(trace)) trace.creditedAt ??= this.#stamp(); }
  ackQueued(trace, bufferedBytes) {
    if (!known.has(trace) || completed.has(trace)) return;
    completed.add(trace); const at = this.#stamp();
    // Every duration uses this receiver's monotonic clock, beginning at arrival.
    // Reason: GPU send clocks and application ACKs cannot establish one-way wire latency.
    const row = { schema: 'sbf-stream-receive-timing-v1', requestHash: trace.requestHash,
      kind: trace.kind, index: trace.index, bytes: trace.bytes,
      firstPartArrivalToAckQueueMs: elapsed(trace.headerAt, at),
      firstBinaryArrivalToAckQueueMs: elapsed(trace.firstAt, at),
      bodyCallbackSpanMs: elapsed(trace.firstAt, trace.completeAt),
      bodyCompleteToAckQueueMs: elapsed(trace.completeAt, at),
      assemblyAfterLastCallbackMs: elapsed(trace.completeAt, trace.assembledAt),
      assemblyToValidatorCallMs: elapsed(trace.assembledAt, trace.validationStartedAt),
      validatorCallToResultMs: elapsed(trace.validationStartedAt, trace.validatedAt),
      creditWaitMs: elapsed(trace.validatedAt, trace.creditedAt), creditBlockedAttempts: trace.creditBlockedAttempts,
      creditToAckQueueMs: elapsed(trace.creditedAt, at),
      ackSocketBufferedBytes: finite(bufferedBytes) ? bufferedBytes : null };
    for (const [output, input] of Object.entries({ validatorTransferCopyMs: 'transferCopyMs', validatorQueueMs: 'queueMs',
      validatorWorkerRoundTripMs: 'workerRoundTripMs', validatorWorkerExecuteMs: 'workerExecuteMs',
      validatorHydrationMs: 'hydrationMs', validatorTotalMs: 'totalMs' }))
      row[output] = finite(trace.worker?.[input]) ? trace.worker[input] : null;
    this.#samples++; this.#last = row;
    if (row.bodyCompleteToAckQueueMs !== null)
      this.#maxAfterBody = Math.max(this.#maxAfterBody ?? 0, row.bodyCompleteToAckQueueMs);
    // Retain only a fixed-size summary and emit no user text, ids or payload.
    // Reason: long broadcasts need bounded diagnostics without leaking chat/media content.
    try { this.#report(Object.freeze(row)); } catch { /* Diagnostics cannot reject validated media. */ }
  }
  snapshot() {
    return { ingest_timing_samples: this.#samples,
      ingest_last_body_callback_span_ms: this.#last?.bodyCallbackSpanMs ?? null,
      ingest_last_body_complete_to_ack_ms: this.#last?.bodyCompleteToAckQueueMs ?? null,
      ingest_max_body_complete_to_ack_ms: this.#maxAfterBody,
      ingest_last_validator_queue_ms: this.#last?.validatorQueueMs ?? null,
      ingest_last_credit_wait_ms: this.#last?.creditWaitMs ?? null };
  }
}
