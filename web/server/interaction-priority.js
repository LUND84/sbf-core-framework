// Sources are assigned by server ingress, never by viewer JSON.
// Reason: paying changes dispatch priority only after payment verification.
export function interactionPriority(request) {
  if (request.source === 'paid-message') return 2;
  if (request.source === 'autonomous-crypto' || request.kind === 'autonomous-crypto') return 0;
  return 1;
}

export function enqueueInteraction(pending, request) {
  const priority = interactionPriority(request);
  const index = pending.findIndex(item => interactionPriority(item) < priority);
  // Insert after every equal source class, independently of amount or timestamp.
  // Reason: higher payments extend display duration without buying queue jumps over earlier paid messages.
  if (index === -1) pending.push(request);
  else pending.splice(index, 0, request);
  return pending.indexOf(request);
}
