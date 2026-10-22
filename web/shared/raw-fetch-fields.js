export const RAW_FETCH_FIELDS = Object.freeze([
  'version', 'count', 'totalBytes', 'firstReadMs', 'lastReadMs', 'lastReadGapMs',
  'maxReadGapMs', 'gapsOver750Ms', 'lastWaitMs', 'maxWaitMs', 'lastChunkBytes',
  'lastCallbackMs', 'maxCallbackMs', 'lastReadAgeMs', 'stashUsedBytes', 'stashLimitBytes', 'stashEnabled',
]);
const COUNTERS = new Set(['count', 'totalBytes', 'gapsOver750Ms', 'lastChunkBytes', 'stashUsedBytes', 'stashLimitBytes']);

export function rawFetchNumbers(source) {
  // Require the complete pinned numeric schema and copy only its known fields.
  // Reason: availability cannot come from an unsupported version, partial payload or private media/URL fields.
  if (!source || typeof source !== 'object' || Array.isArray(source)
    || source.version !== 1 || ![0, 1].includes(source.stashEnabled)) return null;
  const result = {};
  for (const field of RAW_FETCH_FIELDS) {
    const value = source[field];
    // Long sessions exceed 1e10 transferred bytes; exact counters still have a finite upper bound.
    // Reason: eight-hour measurements must survive without accepting imprecise or unbounded numeric values.
    if (!Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER
      || (COUNTERS.has(field) && !Number.isSafeInteger(value))) return null;
    result[field] = value;
  }
  return result;
}
