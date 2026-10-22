// Reliable transport is selected by the candidate viewer; UDP remains an explicit
// comparison override. Reason: the same encoded picture exposed UDP loss locally.
export function selectAnswerTransport(answer, transport) {
  if (transport !== 'tcp') return answer;
  const lines = answer.split('\r\n');
  if (!lines.some(line => /^a=candidate:\S+\s+\d+\s+tcp\s/i.test(line))) {
    throw new Error('TCP candidate unavailable');
  }
  return lines.filter(line => !/^a=candidate:\S+\s+\d+\s+udp\s/i.test(line)).join('\r\n');
}
