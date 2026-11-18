import { LivePlaybackControl } from './live-playback-control.js';
import { LivePlayer } from './media.js';
import { RtcPlayer } from './rtc-player.js';
import { HlsPlayer } from './hls-player.js';
import { FlvPlayer } from './flv-player.js';
import { StreamWatchdog } from './stream-watchdog.js';
import { playbackDiagnosticText } from './playback-diagnostics.js';
import { PlaybackReporter } from './playback-report.js';
import { installBackgroundPlayback } from './background-playback.js';
import { installStageClock } from './stage-clock.js';
import { currentTask, formatBytes, mergeChatStatus, queueCount, streamDimensions, mediaSourceReady, clearOnWorkerLoss } from './format.js';

const $ = (id) => document.getElementById(id);
const video = $('avatar-video');
installStageClock($('stage-current-time'));
const deliveryMode = document.documentElement?.dataset?.transport;
const nativeRealtime = ['webrtc', 'hls', 'flv'].includes(deliveryMode);
const rtcReportId = nativeRealtime ? crypto.randomUUID() : null;
let rtcReportPending = false;
const input = $('chat-input');
const logEntries = [];
const messages = new Map();
let status = { worker: { connected: false }, stream: { ready: false }, queue: { pending: 0 } };
let socket;
let socketState = 'connecting';
let reconnectTimer;
let reconnectAttempts = 0;
let toastTimer;
let authenticated = true;
let sending = false;
let mediaState = { state: 'idle' };
let livePlaybackState = { state: 'unavailable', checkedAtMs: null };
let lastStatusError = '';
let stopped = false;
let stopMediaAppendObservation = () => {};
const streamWatchdog = new StreamWatchdog();
const playbackReporter = new PlaybackReporter({
  // Fixed route labels are observation context only. Reason: no hostname is uploaded and the label cannot establish a physical network route.
  routeClass: location.hostname.endsWith('.trycloudflare.com') ? 'alternate' : 'main',
});

function log(message) {
  const time = new Date().toLocaleTimeString('en-GB', { hour12: false });
  logEntries.push(`${time}  ${message}`);
  if (logEntries.length > 20) logEntries.shift();
  $('diagnostic-log').textContent = logEntries.join('\n');
  $('diagnostic-log').scrollTop = $('diagnostic-log').scrollHeight;
}

function toast(message) {
  clearTimeout(toastTimer);
  $('toast').textContent = message;
  $('toast').hidden = false;
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 4500);
}

const player = new (deliveryMode === 'flv' ? FlvPlayer : deliveryMode === 'hls' ? HlsPlayer : nativeRealtime ? RtcPlayer : LivePlayer)(video, (next) => {
  mediaState = next;
  render();
}, log, deliveryMode === 'flv' ? { mediaPath: document.documentElement?.dataset?.mediaPath } : undefined);
// The actor preview owns a different media timeline from the relay program.
// Reason: relay idle/task labels must not describe the continuous GPU source.
const actorPreview = deliveryMode === 'flv' && player.sourceProfile === 'actor-continuous';
video.addEventListener('playing', () => { if (player.state === 'playing') playbackReporter.playing(); });
const livePlayback = new LivePlaybackControl({ player, video,
  canPlay: () => authenticated && !stopped,
  onUnauthorized: showLogin,
  onState(next) {
    const previous = livePlaybackState.state;
    livePlaybackState = next;
    if (next.state === 'live' && previous !== 'live' && !nativeRealtime && socketState === 'open') connect();
    render();
  },
});


function showLogin() {
  authenticated = false;
  livePlayback.apply('unavailable');
  clearTimeout(reconnectTimer);
  socketState = 'closed';
  clearPlayback();
  if (!$('login-dialog').open) $('login-dialog').showModal();
  $('access-code').focus();
  render();
}

async function request(path, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(path, {
      credentials: 'same-origin', cache: 'no-store', ...options,
      headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers },
      signal: controller.signal,
    });
    const data = await response.json().catch(() => ({}));
    if (response.status === 401) {
      showLogin();
      throw new Error(path === '/api/login' ? 'Incorrect access code. Please try again.' : 'Please enter your access code first.');
    }
    if (!response.ok) {
      const detail = typeof data.error === 'string' ? data.error : data.message;
      throw new Error(detail || `Request failed (${response.status})`);
    }
    return data;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('The server timed out. Check your connection and try again.');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function applyStatus(next) {
  const previousStatus = status;
  status = {
    ...status, ...next,
    worker: { ...status.worker, ...next.worker },
    stream: { ...status.stream, ...next.stream },
    queue: { ...status.queue, ...next.queue },
  };
  if (!nativeRealtime && clearOnWorkerLoss(previousStatus, status)) {
    clearPlayback();
    log('The rendering device is offline. The previous video has been cleared.');
  }
  render();
}

async function refreshStatus() {
  try {
    applyStatus(await request('/api/status'));
    if (lastStatusError) log('Server status requests have recovered.');
    lastStatusError = '';
  } catch (error) {
    if (lastStatusError !== error.message) log(`Status request failed: ${error.message}`);
    lastStatusError = error.message;
    render();
  }
}

async function refreshAuth() {
  const access = await request('/api/auth');
  status.authRequired = Boolean(access.authRequired);
  authenticated = !access.authRequired || access.authenticated === true;
  if (!authenticated) showLogin();
  render();
  return authenticated;
}

async function initialize() {
  livePlayback.start();
  void livePlayback.refresh();
  // WHEP authenticates its own request. Reason: native media negotiation can
  // overlap the UI's access check instead of paying another sequential RTT.
  if (nativeRealtime && livePlayback.isLive()) player.start();
  // Start status separately from authorization. Reason: a slow status response
  // must not postpone the first live-video connection after the page opens.
  void Promise.resolve().then(refreshStatus).catch(() => {});
  try {
    if (await refreshAuth()) connect();
  } catch (error) {
    socketState = 'closed';
    log(`Access verification failed: ${error.message}`);
    render();
    if (!stopped && authenticated) reconnectTimer = setTimeout(initialize, 5000);
  }
}

function connect() {
  if (stopped || !authenticated) return;
  clearTimeout(reconnectTimer);
  if (socket) {
    socket.onclose = null;
    socket.close();
  }
  playbackReporter.connectionSwitched();
  if (!nativeRealtime) clearPlayback();
  else if (livePlayback.isLive()) player.start();
  streamWatchdog.reset();
  socketState = 'connecting';
  render();
  const controlPath = deliveryMode === 'flv' ? '/ws/flv-viewer' : deliveryMode === 'hls' ? '/ws/hls-viewer' : '/ws/viewer';
  const url = new URL(controlPath, location.href);
  url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const connection = new WebSocket(url);
  socket = connection;
  connection.binaryType = 'arraybuffer';
  connection.onopen = () => {
    if (socket !== connection) return;
    socketState = 'open';
    reconnectAttempts = 0;
    log('Live connection established. Waiting for the video source status.');
    render();
  };
  connection.onmessage = ({ data }) => {
    if (socket !== connection) return;
    if (data instanceof ArrayBuffer) {
      appendVideoData(data);
      return;
    }
    try {
      const event = JSON.parse(data);
      if (event.type === 'status') applyStatus(event);
      else if (event.type === 'stream.reset') {
        if (!livePlayback.isLive()) return;
        playbackReporter.epochSwitched();
        streamWatchdog.reset();
        $('diag-mime').textContent = event.mime || '—';
        $('diag-epoch').textContent = player.sourceProfile === 'actor-continuous' ? 'actor-continuous' : String(event.epoch ?? '—');
        stopMediaAppendObservation();
        player.reset(event);
        observeMediaAppend();
      } else if (event.type === 'chat.event') addMessage(event);
    } catch (error) {
      log(`Could not process the live message: ${error.message}`);
    }
  };
  connection.onerror = () => {
    if (socket === connection) {
      log('A network error interrupted the live connection.');
      refreshAuth().catch((error) => log(`Access status check failed: ${error.message}`));
    }
  };
  connection.onclose = (event) => {
    if (socket !== connection || stopped) return;
    playbackReporter.connectionClosed(event.code, event.wasClean, player.snapshot());
    socketState = 'closed';
    if (!nativeRealtime) clearPlayback();
    if (event.code === 1008 && status.authRequired) {
      log('A valid access code is required for the live connection.');
      showLogin();
      return;
    }
    const wait = Math.min(15000, 1000 * 2 ** Math.min(reconnectAttempts, 4));
    reconnectAttempts += 1;
    log(`Live connection closed (${event.code}). Retrying in ${wait / 1000} s.`);
    render();
    reconnectTimer = setTimeout(connect, wait);
  };
}

function appendVideoData(data) {
  if (!livePlayback.isLive()) return;
  if (nativeRealtime) return;
  const before = player.receivedBytes;
  const rawMedia = player.receivedInit && !player.chunkAssembler;
  player.append(data);
  if (player.receivedBytes > before) {
    playbackReporter.dataReceived();
    // A raw WS message is one complete append unit. Reason: partial transport chunks must not be labeled complete media before assembly.
    if (rawMedia) playbackReporter.completeMediaReceived();
  }
}

function observeMediaAppend() {
  stopMediaAppendObservation();
  const source = player.source;
  if (!source) return;
  let buffer = null;
  const updated = () => {
    try {
      if (player.source !== source || !buffer?.buffered.length) return;
      playbackReporter.mediaAppendCompleted();
      stopMediaAppendObservation();
    } catch { /* Observation cannot interfere with MSE's serial append owner. */ }
  };
  const opened = () => {
    if (player.source !== source) return;
    buffer = player.buffer;
    buffer?.addEventListener('updateend', updated);
  };
  // Own only these observer listeners. Reason: reset must retire old measurements without wrapping appendBuffer or changing its scheduling.
  stopMediaAppendObservation = () => {
    source.removeEventListener('sourceopen', opened);
    buffer?.removeEventListener('updateend', updated);
  };
  if (source.readyState === 'open') opened();
  else source.addEventListener('sourceopen', opened, { once: true });
}

function clearPlayback() {
  stopMediaAppendObservation();
  player.clear();
}

function setOverlay(kicker, title, description, play = false) {
  $('stage-overlay').hidden = false;
  $('stage-kicker').textContent = kicker;
  $('stage-title').textContent = title;
  $('stage-description').textContent = description;
  $('play-button').hidden = !play;
}

function render() {
  const worker = status.worker || {};
  const stream = status.stream || {};
  const online = socketState === 'open' && authenticated;
  const connected = Boolean(worker.connected && online);
  const local = Boolean(status.local?.enabled);
  const test = worker.mode === 'test-pattern';
  const real = worker.mode === 'avatar';
  const stopping = Boolean(status.queue?.interrupting);
  const llm = worker.chatMode === 'llm';
  const broadcastLive = livePlaybackState.state === 'live';
  const ready = broadcastLive && (nativeRealtime ? authenticated && player.snapshot().hasData : online && mediaSourceReady(status));
  const visible = ready && mediaState.state === 'playing';
  const unavailable = !ready || !connected || (local && !['sealed-replies', 'streamed-replies-v1'].includes(worker.mediaMode))
    || mediaState.state !== 'playing' || stopping || test;
  const dimensions = streamDimensions(stream);
  const pending = queueCount(status.queue);
  const current = currentTask(status.queue);
  let connectionLabel = 'Rendering device offline';
  let connectionStyle = 'offline';
  if (!authenticated) { connectionLabel = 'Access code required'; connectionStyle = 'error'; }
  else if (!broadcastLive) { connectionLabel = livePlaybackState.state === 'stopped' ? 'Broadcast stopped' : 'Broadcast unavailable'; connectionStyle = 'offline'; }
  else if (socketState !== 'open') { connectionLabel = socketState === 'connecting' ? 'Connecting' : 'Disconnected'; connectionStyle = 'connecting'; }
  else if (connected) { connectionLabel = test ? 'Test stream connected' : real ? 'Avatar connected' : 'Device connected'; connectionStyle = test ? 'test' : 'online'; }
  else if (local && ready) { connectionLabel = actorPreview ? 'Continuous GPU video · interaction offline' : 'Idle video playing · GPU offline'; connectionStyle = 'online'; }
  $('connection-label').textContent = connectionLabel;
  $('connection-pill').dataset.state = connectionStyle;
  $('access-button').hidden = !status.authRequired;
  $('stage-dot').className = `status-dot${ready ? test ? ' test' : ' active' : ''}`;
  $('source-tag').textContent = actorPreview ? 'Continuous GPU stream preview' : local ? status.local.kind === 'speech' ? 'Playing a chat response' : 'Local idle playback' : connected ? test ? 'Test video source' : real ? 'GPU · LiveTalking' : worker.engine || 'Connected device' : 'No video source connected';
  $('source-tag').classList.toggle('test', test && connected);
  $('session-label').textContent = actorPreview ? 'Continuous GPU stream' : local ? status.local.kind === 'speech' ? 'Chat response' : 'Local idle playlist' : connected ? test ? 'Test mode' : `Video session ${stream.epoch ?? 'preparing'}` : 'Waiting for a video source';
  $('worker-value').textContent = connected ? test ? 'Test source' : 'GPU online' : 'Offline';
  $('worker-note').textContent = connected ? worker.engine || 'Rendering engine connected' : 'Waiting for a device';
  $('format-value').textContent = ready ? dimensions.resolution : '—';
  $('format-note').textContent = ready ? dimensions.fps : 'Reported by the video source';
  $('queue-value').replaceChildren(document.createTextNode(String(pending)), Object.assign(document.createElement('span'), { textContent: ' tasks' }));
  $('queue-note').textContent = stopping ? 'Stopping the current task' : current ? 'Processing a task' : 'No active task';
  $('test-banner').hidden = !ready || !test;
  $('live-badge').hidden = !visible;
  $('live-badge').classList.toggle('test', test);
  $('live-label').textContent = test ? 'TEST' : 'LIVE';
  $('video-stage').dataset.state = visible ? 'playing' : connected ? 'waiting' : 'offline';
  video.setAttribute('aria-hidden', String(!visible));
  if (!authenticated) setOverlay('PRIVATE ACCESS', 'Enter your access code to connect', 'This studio requires an access code. Use the lock button in the top-right corner to sign in.');
  else if (!broadcastLive) setOverlay(livePlaybackState.state === 'stopped' ? 'BROADCAST ENDED' : 'BROADCAST UNAVAILABLE',
    livePlaybackState.state === 'stopped' ? 'Broadcast stopped' : 'Broadcast unavailable',
    livePlaybackState.state === 'stopped' ? 'The host has ended the broadcast. Video will return automatically when the broadcast restarts.' : 'Checking the broadcast status. The player will reconnect automatically when it is available.');
  else if (nativeRealtime && visible) $('stage-overlay').hidden = true;
  else if (!online) setOverlay('CONNECTION INTERRUPTED', socketState === 'connecting' ? 'Connecting to the studio' : 'Live connection lost', 'Trying to reconnect.');
  else if (!worker.connected && !local) setOverlay('WAITING FOR SOURCE', 'Waiting for the avatar', 'The page is ready. Live video will appear here once a rendering device connects.');
  else if (!stream.ready) setOverlay('SOURCE CONNECTED', 'Preparing the video source', 'The rendering device is connected. Waiting for playable video segments.');
  else if (mediaState.state === 'error') setOverlay('PLAYBACK DIAGNOSTIC', 'Playback unavailable', mediaState.detail);
  else if (mediaState.state === 'blocked') setOverlay('READY TO PLAY', 'Video ready', 'Click once to allow playback in your browser.', true);
  else if (mediaState.state === 'paused') setOverlay('PLAYBACK PAUSED', 'Live video paused', 'Click to resume and return to the live video.', true);
  else if (!visible) setOverlay('BUFFERING LIVE VIDEO', 'Buffering live video', mediaState.detail || 'The video source is connected. Waiting for the player to decode it.');
  else $('stage-overlay').hidden = true;
  const playbackText = !broadcastLive ? livePlaybackState.state === 'stopped' ? 'Broadcast stopped' : 'Broadcast unavailable' : visible ? test ? 'Playing test video' : 'Playing live' : ready ? mediaState.state === 'error' ? 'Playback error' : 'Waiting for playback' : 'No video yet';
  $('playback-label').textContent = playbackText;
  $('playback-dot').className = `status-dot${visible ? test ? ' test' : ' active' : ''}`;
  $('chat-title').textContent = connected ? llm ? 'Chat responses' : 'Read aloud' : 'Text chat';
  $('chat-context-label').textContent = connected ? test ? 'Connection and video test only · text tasks unavailable' : llm ? 'A local model writes the response, then the avatar speaks it' : 'Reads your text aloud · no AI response generation' : 'Text input will be available when the rendering device connects';
  $('empty-chat-description').textContent = test ? 'This is a connection test signal without avatar or speech generation. Connect a rendering device to submit text.' : llm ? 'Ask a question and the avatar will respond using the configured model. Your tasks and their status will appear here.' : 'Enter text for the avatar to say on screen. Your submitted tasks and their status will appear here.';
  input.placeholder = llm ? 'What would you like to talk about?' : 'What would you like the avatar to say?';
  const voice = worker.voice;
  const voiceLabel = typeof voice === 'string' ? voice : voice?.label || voice?.name || voice?.id;
  $('voice-status').textContent = voiceLabel ? `Voice: ${voiceLabel}${typeof voice === 'object' && voice.cloned === false ? ' · standard voice, not cloned' : typeof voice === 'object' && voice.cloned === true ? ' · cloned' : ''}` : 'Waiting for the device to report its voice';
  $('composer-notice').textContent = !broadcastLive ? 'The broadcast is offline. Chat is unavailable.' : !authenticated ? 'Enter your access code first' : !online ? 'You can send messages once the connection recovers' : !worker.connected ? actorPreview ? 'The interaction generation device is not connected' : local ? 'Idle playback continues. The interaction generation device is not connected.' : 'No video source is connected' : !stream.ready ? 'Waiting for the video source to be ready' : mediaState.state === 'error' ? 'Resume video playback first' : stopping ? 'Stopping the current task. Please wait before sending another.' : test ? 'Connection test mode · avatar speech is not enabled' : mediaState.state !== 'playing' ? 'Wait for video playback to resume before sending' : current ? 'A task is in progress. New messages will be queued.' : llm ? 'Ready. Send a question to start a conversation.' : 'Ready. Send text to hear it spoken.';
  input.disabled = unavailable;
  $('send-button').disabled = unavailable || sending || !input.value.trim();
  $('interrupt-button').disabled = !connected || (!current && !status.autonomous?.enabled) || stopping;
  $('diag-socket').textContent = !authenticated ? 'Access code required' : socketState === 'open' ? 'Connected · WebSocket' : socketState === 'connecting' ? 'Connecting' : 'Disconnected · waiting to reconnect';
  $('diagnostic-summary').replaceChildren(document.createTextNode(mediaState.state === 'error' ? 'Playback error · view details' : connectionLabel), Object.assign(document.createElement('span'), { className: 'chevron', textContent: '⌄' }));
  updateAudio();
}

function addMessage(event) {
  const role = ['user', 'assistant', 'system'].includes(event.role) ? event.role : 'system';
  if (event.source === 'autonomous-crypto' && role === 'user') return;
  const id = String(event.id ?? `event-${Date.now()}-${messages.size}`);
  const key = `${id}:${role}`;
  if (role === 'assistant' || (role === 'system' && ['error', 'interrupted'].includes(event.status))) {
    for (const linkedRole of role === 'assistant' ? ['user'] : ['user', 'assistant']) {
      const linked = messages.get(`${id}:${linkedRole}`);
      if (linked) addMessage({ ...event, role: linkedRole, text: linked.text.textContent });
    }
  }
  const nearBottom = $('messages').scrollHeight - $('messages').scrollTop - $('messages').clientHeight < 80;
  let entry = messages.get(key);
  if (!entry) {
    if (!event.text) return;
    $('chat-empty').hidden = true;
    const element = document.createElement('article');
    element.className = 'message';
    element.dataset.role = role;
    const header = document.createElement('div');
    header.className = 'message-header';
    const avatar = document.createElement('span');
    avatar.className = 'message-avatar';
    avatar.textContent = role === 'user' ? 'Me' : role === 'assistant' ? 'S' : '·';
    const label = document.createElement('span');
    label.textContent = role === 'user' ? 'You' : role === 'assistant' ? 'Avatar' : 'System';
    const time = document.createElement('time');
    time.dateTime = new Date().toISOString();
    time.textContent = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
    header.append(avatar, label, time);
    const text = document.createElement('p');
    text.className = 'message-text';
    const state = document.createElement('div');
    state.className = 'message-status';
    element.append(header, text, state);
    $('messages').append(element);
    entry = { element, text, state, label };
    messages.set(key, entry);
    if (messages.size > 160) {
      const oldest = messages.keys().next().value;
      messages.get(oldest).element.remove();
      messages.delete(oldest);
    }
  }
  if (event.source === 'autonomous-crypto') {
    entry.element.dataset.source = event.source;
    if (role === 'assistant') entry.label.textContent = 'Avatar · autonomous crypto commentary';
  }
  if (typeof event.text === 'string') entry.text.textContent = event.text;
  if (typeof event.error === 'string') entry.error = event.error;
  const state = mergeChatStatus(entry.element.dataset.status, event.status);
  entry.element.dataset.status = state;
  const labels = { queued: 'Queued', running: 'Processing', done: 'Completed', error: 'Failed', interrupted: 'Stopped' };
  entry.state.textContent = state === 'error' && entry.error ? `Failed: ${entry.error}` : labels[state] || '';
  $('chat-count').textContent = `${messages.size} messages`;
  if (nearBottom || role === 'user') $('messages').scrollTop = $('messages').scrollHeight;
}

function updateAudio() {
  const enabled = !video.muted;
  $('audio-button').setAttribute('aria-pressed', String(enabled));
  $('audio-button').setAttribute('aria-label', enabled ? 'Mute' : 'Enable sound');
  $('audio-label').textContent = enabled ? 'Sound enabled' : 'Enable sound';
  $('audio-icon').firstElementChild.setAttribute('href', enabled ? '#i-audio' : '#i-mute');
}

$('chat-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const text = input.value.trim();
  if (!text || $('send-button').disabled) return;
  const reportIndex = playbackReporter.requestSubmitted();
  sending = true;
  render();
  try {
    const result = await request('/api/chat', { method: 'POST', body: JSON.stringify({ text }) });
    playbackReporter.requestSettled(reportIndex, true);
    addMessage({ id: result.id, role: 'user', text, status: 'queued' });
    input.value = '';
    input.dispatchEvent(new Event('input'));
    toast(`Task submitted${Number.isFinite(result.position) ? ` · queue position ${result.position}` : ''}`);
  } catch (error) {
    playbackReporter.requestSettled(reportIndex, false);
    toast(error.message || 'Could not send. Please try again.');
    log(`Task submission failed: ${error.message}`);
  } finally {
    sending = false;
    render();
    if (!input.disabled) input.focus();
  }
});

input.addEventListener('input', () => {
  $('character-count').textContent = `${input.value.length} / 1000`;
  input.style.height = 'auto';
  input.style.height = `${Math.min(180, Math.max(77, input.scrollHeight))}px`;
  render();
});
input.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    $('chat-form').requestSubmit();
  }
});
$('interrupt-button').addEventListener('click', async () => {
  $('interrupt-button').disabled = true;
  try {
    await request('/api/interrupt', { method: 'POST' });
    applyStatus({ autonomous: { ...status.autonomous, enabled: false, state: 'disabled' } });
    void refreshStatus();
    toast('Interrupt request sent.');
  } catch (error) { toast(error.message); }
  finally { render(); }
});
$('audio-button').addEventListener('click', () => {
  video.muted = !video.muted;
  updateAudio();
  if (livePlayback.isLive() && !video.muted && (player.source || nativeRealtime)) player.tryPlay(true);
  else if (!video.muted) toast('Sound is enabled. Audio will play when the video connects.');
});
video.addEventListener('volumechange', updateAudio);
$('play-button').addEventListener('click', () => { if (livePlayback.isLive()) player.tryPlay(true); });
$('catchup-button').addEventListener('click', () => { if (livePlayback.isLive()) player.goLive(); });
$('fullscreen-button').addEventListener('click', async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else if ($('video-stage').requestFullscreen) await $('video-stage').requestFullscreen();
    else if (video.webkitEnterFullscreen) video.webkitEnterFullscreen();
    else toast('This browser does not support fullscreen playback.');
  } catch (error) { toast(`Could not enter fullscreen: ${error.message}`); }
});
document.addEventListener('fullscreenchange', () => { video.controls = Boolean(document.fullscreenElement); });
// Copy only numeric playback state on explicit user action. Reason: this clipboard trace must not include chat history or credentials.
$('copy-playback-diagnostics')?.addEventListener('click', async () => {
  try {
    const report = { schema: 'sbf-browser-playback-trace-v1', capturedUtc: new Date().toISOString(),
      connection: socketState, ...player.snapshot(), reporting: playbackReporter.snapshot() };
    await navigator.clipboard.writeText(JSON.stringify(report, null, 2));
    toast('Playback diagnostics copied. You can paste them now.');
  } catch { toast('Could not copy automatically. Please copy the diagnostic log below.'); }
});
$('reconnect-button').addEventListener('click', () => {
  reconnectAttempts = 0;
  if (!authenticated) showLogin();
  else {
    // Reconnect the media too when explicitly requested. Reason: refreshing only
    // the control socket cannot recover an FLV engine whose HTTP stream stopped.
    if (livePlayback.isLive()) player.reconnect?.();
    initialize();
  }
});
$('access-button').addEventListener('click', () => {
  $('login-error').textContent = '';
  if (!$('login-dialog').open) $('login-dialog').showModal();
});
$('login-close').addEventListener('click', () => $('login-dialog').close());
$('login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('login-submit').disabled = true;
  $('login-error').textContent = '';
  try {
    await request('/api/login', { method: 'POST', body: JSON.stringify({ code: $('access-code').value }) });
    $('access-code').value = '';
    authenticated = true;
    $('login-dialog').close();
    log('Access verified.');
    void livePlayback.refresh();
    connect();
    refreshStatus();
  } catch (error) { $('login-error').textContent = error.message; }
  finally { $('login-submit').disabled = false; }
});
window.addEventListener('online', () => { log('The browser is back online.'); if (authenticated) initialize(); });
window.addEventListener('beforeunload', () => livePlayback.close());
window.addEventListener('offline', () => { livePlayback.apply('unavailable'); log('The browser is offline.'); socketState = 'closed'; if (!nativeRealtime) clearPlayback(); render(); });
installBackgroundPlayback({ page: document, lifecycle: window, player,
  connectionState: () => socketState, canReconnect: () => livePlayback.isLive(),
  reconnect: connect, resetWatchdog: () => streamWatchdog.reset(), mediaSession: navigator.mediaSession });

setInterval(() => {
  const snapshot = player.snapshot();
  if (nativeRealtime) {
    void player.collectStats();
    const d = snapshot.diagnostics;
    $('diag-mime').textContent = snapshot.transport === 'flv' ? 'HTTPS FLV · H.264 / AAC'
      : snapshot.transport === 'hls' ? 'HTTPS HLS · H.264 / AAC' : 'WebRTC · H.264 / Opus';
    $('diag-lag').textContent = snapshot.firstFrameMs === null ? 'Connecting' : `First frame ${(snapshot.firstFrameMs / 1000).toFixed(2)} s`;
    const r = snapshot.rtcStats;
    const h = snapshot.httpStats;
    $('diag-bytes').textContent = h ? `${h.bytesReceived === null ? 'Total bytes received unavailable' : formatBytes(h.bytesReceived)} · HTTPS · download ${(h.lastDownloadMbps ?? 0).toFixed(2)} Mbps · buffer ${snapshot.bufferAheadSeconds.toFixed(2)} s` : r ? `${formatBytes(r.bytesReceived ?? 0)} · ${r.protocol ?? '—'} · frames received ${r.framesReceived ?? '—'} / decoded ${r.framesDecoded ?? '—'} · packets lost ${r.packetsLost ?? '—'} · mean decode ${(r.meanDecodeMs ?? 0).toFixed(1)}ms` : 'Native realtime transport';
    $('diag-buffer').textContent = `${playbackDiagnosticText(d)} · visible frame gaps >250 ms ${snapshot.visibleGapsOver250Ms}`;
    $('catchup-button').hidden = true;
    if (!rtcReportPending && authenticated && snapshot.observedSeconds !== null) {
      rtcReportPending = true;
      fetch('/api/rtc-report', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: rtcReportId, ...snapshot, ...d, hidden: document.hidden }),
        signal: AbortSignal.timeout(2000) }).catch(() => {}).finally(() => { rtcReportPending = false; });
    }
    $('local-time').textContent = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
    return;
  }
  playbackReporter.sample(snapshot, { enabled: livePlayback.isLive(),
    connection: socketState, visibility: document.visibilityState });
  const reporting = playbackReporter.snapshot();
  // A live socket can stop delivering media indefinitely. Reason: reconnect the observed init-only failure without sending chat.
  if (streamWatchdog.sample({
    online: livePlayback.isLive() && socketState === 'open',
    streamReady: mediaSourceReady(status),
    receivedBytes: snapshot.receivedBytes, bufferAheadSeconds: snapshot.bufferAheadSeconds,
    state: snapshot.state,
  })) {
    log('Video playback has stalled. Reconnecting automatically.');
    connect();
    return;
  }
  $('diag-bytes').textContent = formatBytes(snapshot.receivedBytes);
  $('diag-lag').textContent = snapshot.lag === null ? '—' : `${snapshot.lag.toFixed(1)} s`;
  const bufferText = snapshot.hasData ? `Ahead ${snapshot.bufferAheadSeconds.toFixed(2)} s · stored ${snapshot.bufferSeconds.toFixed(1)} s · pending ${formatBytes(snapshot.queuedBytes)}` : 'Waiting for segments';
  $('diag-buffer').textContent = `${bufferText} · ${playbackDiagnosticText(snapshot.diagnostics)} · report HTTP ${reporting.lastHTTPStatus ?? '—'}/${reporting.lastOutcomeCode} · timeouts ${reporting.deadlineCount} · disabled ${reporting.disabledReasonCode}`;
  $('catchup-button').hidden = !snapshot.hasData || snapshot.lag < 2;
  $('local-time').textContent = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
}, 1000);
setInterval(refreshStatus, 10000);
render();
initialize();
