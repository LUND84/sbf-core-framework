// Read numeric receiver counters only. Reason: distinguish packet loss from
// decoder/render drops without storing SDP, addresses, chat, or credentials.
const COUNTERS = ['bytesReceived', 'packetsReceived', 'packetsLost', 'framesReceived',
  'framesDecoded', 'framesDropped', 'keyFramesDecoded', 'nackCount', 'pliCount',
  'freezeCount', 'totalFreezesDuration', 'totalDecodeTime', 'jitterBufferDelay',
  'jitterBufferEmittedCount', 'jitter', 'frameWidth', 'frameHeight', 'framesPerSecond'];

export function receiverSnapshot(report, previous = null) {
  const values = [...report.values()];
  const video = values.find(s => s.type === 'inbound-rtp' && (s.kind ?? s.mediaType) === 'video');
  if (!video) return null;
  const result = { id: video.id, timestamp: video.timestamp };
  for (const key of COUNTERS) result[key] = Number.isFinite(video[key]) ? video[key] : null;
  const transport = values.find(s => s.type === 'transport' && s.selectedCandidatePairId);
  const pair = report.get(transport?.selectedCandidatePairId);
  const candidate = report.get(pair?.localCandidateId);
  result.protocol = ['udp', 'tcp'].includes(candidate?.protocol) ? candidate.protocol : null;
  result.rttMs = Number.isFinite(pair?.currentRoundTripTime) ? pair.currentRoundTripTime * 1000 : null;
  result.intervalSeconds = previous?.id === result.id ? (result.timestamp - previous.timestamp) / 1000 : null;
  const seconds = result.intervalSeconds;
  for (const key of ['bytesReceived', 'packetsReceived', 'packetsLost', 'framesReceived', 'framesDecoded', 'framesDropped']) {
    const delta = previous?.id === result.id && result[key] !== null && previous[key] !== null ? result[key] - previous[key] : null;
    result[key + 'PerSecond'] = seconds > 0 && delta >= 0 ? delta / seconds : null;
  }
  result.meanDecodeMs = result.framesDecoded > 0 && result.totalDecodeTime !== null
    ? result.totalDecodeTime / result.framesDecoded * 1000 : null;
  result.meanJitterBufferMs = result.jitterBufferEmittedCount > 0 && result.jitterBufferDelay !== null
    ? result.jitterBufferDelay / result.jitterBufferEmittedCount * 1000 : null;
  return result;
}
