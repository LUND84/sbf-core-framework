export function formatBytes(value) {
  const bytes = Math.max(0, Number(value) || 0);
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

export function streamDimensions(stream = {}) {
  const width = Math.floor(Number(stream.width));
  const height = Math.floor(Number(stream.height));
  const fps = Number(stream.fps);
  const resolution = width > 0 && height > 0 ? `${width} × ${height}` : '—';
  return { resolution, fps: fps > 0 ? `${Number(fps.toFixed(2))} FPS` : '帧率待上报' };
}

// Local playlist health is independent of its generator. Reason: GPU loss must neither clear local idle nor disable stalled-viewer recovery.
export function mediaSourceReady(status = {}) {
  return Boolean(status.stream?.ready && (status.worker?.connected || status.local?.enabled));
}
export function clearOnWorkerLoss(previous = {}, next = {}) {
  return Boolean(previous.worker?.connected && !next.worker?.connected && !next.local?.enabled);
}

export function queueCount(queue = {}) {
  if (Array.isArray(queue.pending)) return queue.pending.length;
  return Math.max(0, Math.floor(Number(queue.pending) || 0));
}

export function currentTask(queue = {}) {
  if (!queue.current) return null;
  return typeof queue.current === 'object' ? queue.current.id || '执行中' : queue.current;
}

export function mergeChatStatus(previous, incoming) {
  const rank = { queued: 0, running: 1, done: 2, error: 2, interrupted: 2 };
  if (!incoming) return previous || '';
  return (rank[previous] ?? -1) > (rank[incoming] ?? -1) ? previous : incoming;
}

export function playbackTarget(ranges, currentTime, targetDelay = 2) {
  if (!ranges.length) return null;
  const last = ranges[ranges.length - 1];
  const edge = last.end;
  const span = edge - last.start;
  const target = span >= targetDelay ? edge - targetDelay : Math.min(last.start + 0.02, edge - 0.01);
  const current = ranges.find(({ start, end }) => currentTime >= start && currentTime < end);
  // Only contiguous data ahead can fund playback. Reason: historical buffered ranges or a gap cannot prevent underflow.
  return { edge, target, span, lag: Math.max(0, edge - currentTime), inside: Boolean(current),
    ahead: current ? Math.max(0, current.end - currentTime) : 0 };
}

export function mp4FragmentKind(buffer) {
  const view = new DataView(buffer);
  let position = 0;
  let kind = 'unknown';
  while (position + 8 <= view.byteLength) {
    let size = view.getUint32(position);
    const type = String.fromCharCode(...new Uint8Array(buffer, position + 4, 4));
    if (type === 'ftyp' || type === 'moov') kind = 'init';
    if (type === 'moof' && kind !== 'init') kind = 'media';
    if (size === 1) {
      if (position + 16 > view.byteLength) break;
      size = Number(view.getBigUint64(position + 8));
    }
    if (size < 8 || position + size > view.byteLength) break;
    position += size;
  }
  return kind;
}
