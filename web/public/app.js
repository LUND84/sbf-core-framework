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
  const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
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
      throw new Error(path === '/api/login' ? '访问码不正确，请重试。' : '请先输入访问码。');
    }
    if (!response.ok) {
      const detail = typeof data.error === 'string' ? data.error : data.message;
      throw new Error(detail || `请求失败（${response.status}）`);
    }
    return data;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('服务器响应超时，请检查网络后重试。');
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
    log('渲染设备已离线，旧画面已清除。');
  }
  render();
}

async function refreshStatus() {
  try {
    applyStatus(await request('/api/status'));
    if (lastStatusError) log('服务器状态请求已恢复。');
    lastStatusError = '';
  } catch (error) {
    if (lastStatusError !== error.message) log(`状态请求失败：${error.message}`);
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
    log(`访问验证失败：${error.message}`);
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
    log('实时连接已建立，等待视频源状态。');
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
      log(`实时消息处理失败：${error.message}`);
    }
  };
  connection.onerror = () => {
    if (socket === connection) {
      log('实时连接发生网络错误。');
      refreshAuth().catch((error) => log(`访问状态检查失败：${error.message}`));
    }
  };
  connection.onclose = (event) => {
    if (socket !== connection || stopped) return;
    playbackReporter.connectionClosed(event.code, event.wasClean, player.snapshot());
    socketState = 'closed';
    if (!nativeRealtime) clearPlayback();
    if (event.code === 1008 && status.authRequired) {
      log('实时连接需要有效的访问码。');
      showLogin();
      return;
    }
    const wait = Math.min(15000, 1000 * 2 ** Math.min(reconnectAttempts, 4));
    reconnectAttempts += 1;
    log(`实时连接已断开（${event.code}），${wait / 1000} 秒后重试。`);
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
  let connectionLabel = '渲染设备离线';
  let connectionStyle = 'offline';
  if (!authenticated) { connectionLabel = '需要访问码'; connectionStyle = 'error'; }
  else if (!broadcastLive) { connectionLabel = livePlaybackState.state === 'stopped' ? '已停播' : '直播暂不可用'; connectionStyle = 'offline'; }
  else if (socketState !== 'open') { connectionLabel = socketState === 'connecting' ? '正在连接' : '连接已断开'; connectionStyle = 'connecting'; }
  else if (connected) { connectionLabel = test ? '测试流已连接' : real ? '数字人已连接' : '设备已连接'; connectionStyle = test ? 'test' : 'online'; }
  else if (local && ready) { connectionLabel = actorPreview ? 'GPU持续画面 · 互动离线' : '待机播放中 · GPU离线'; connectionStyle = 'online'; }
  $('connection-label').textContent = connectionLabel;
  $('connection-pill').dataset.state = connectionStyle;
  $('access-button').hidden = !status.authRequired;
  $('stage-dot').className = `status-dot${ready ? test ? ' test' : ' active' : ''}`;
  $('source-tag').textContent = actorPreview ? 'GPU持续上行预览' : local ? status.local.kind === 'speech' ? '互动回复播放中' : '本地待机播放' : connected ? test ? '测试视频源' : real ? 'GPU · LiveTalking' : worker.engine || '已连接设备' : '未连接视频源';
  $('source-tag').classList.toggle('test', test && connected);
  $('session-label').textContent = actorPreview ? 'GPU连续技术流' : local ? status.local.kind === 'speech' ? '互动回复' : '本地待机轮播' : connected ? test ? '测试模式' : `视频批次 ${stream.epoch ?? '准备中'}` : '等待视频源';
  $('worker-value').textContent = connected ? test ? '测试源' : 'GPU 在线' : '离线';
  $('worker-note').textContent = connected ? worker.engine || '渲染引擎已接入' : '等待设备接入';
  $('format-value').textContent = ready ? dimensions.resolution : '—';
  $('format-note').textContent = ready ? dimensions.fps : '以视频源上报为准';
  $('queue-value').replaceChildren(document.createTextNode(String(pending)), Object.assign(document.createElement('span'), { textContent: ' 项' }));
  $('queue-note').textContent = stopping ? '正在停止当前任务' : current ? '当前正在处理任务' : '暂无正在执行的任务';
  $('test-banner').hidden = !ready || !test;
  $('live-badge').hidden = !visible;
  $('live-badge').classList.toggle('test', test);
  $('live-label').textContent = test ? 'TEST' : 'LIVE';
  $('video-stage').dataset.state = visible ? 'playing' : connected ? 'waiting' : 'offline';
  video.setAttribute('aria-hidden', String(!visible));
  if (!authenticated) setOverlay('PRIVATE ACCESS', '输入访问码后连接', '此演播室启用了访问保护。请使用右上角的锁形按钮登录。');
  else if (!broadcastLive) setOverlay(livePlaybackState.state === 'stopped' ? 'BROADCAST ENDED' : 'BROADCAST UNAVAILABLE',
    livePlaybackState.state === 'stopped' ? '直播已停止' : '直播暂不可用',
    livePlaybackState.state === 'stopped' ? '主播已停止直播，重新开播后画面会自动恢复。' : '正在确认直播状态，恢复后会自动接入。');
  else if (nativeRealtime && visible) $('stage-overlay').hidden = true;
  else if (!online) setOverlay('CONNECTION INTERRUPTED', socketState === 'connecting' ? '正在连接演播室' : '实时连接已断开', '正在尝试恢复连接。');
  else if (!worker.connected && !local) setOverlay('WAITING FOR SOURCE', '等待数字人上线', '网页已就绪。连接渲染设备后，实时画面会出现在这里。');
  else if (!stream.ready) setOverlay('SOURCE CONNECTED', '视频源准备中', '渲染设备已连接，正在等待可播放的视频片段。');
  else if (mediaState.state === 'error') setOverlay('PLAYBACK DIAGNOSTIC', '暂时无法播放', mediaState.detail);
  else if (mediaState.state === 'blocked') setOverlay('READY TO PLAY', '画面已就绪', '浏览器需要一次点击才能开始播放。', true);
  else if (mediaState.state === 'paused') setOverlay('PLAYBACK PAUSED', '实时画面已暂停', '点击继续播放，将自动回到直播画面。', true);
  else if (!visible) setOverlay('BUFFERING LIVE VIDEO', '正在缓冲实时画面', mediaState.detail || '已连接视频源，正在等待播放器解码。');
  else $('stage-overlay').hidden = true;
  const playbackText = !broadcastLive ? livePlaybackState.state === 'stopped' ? '已停播' : '直播暂不可用' : visible ? test ? '测试画面播放中' : '实时播放中' : ready ? mediaState.state === 'error' ? '播放异常' : '等待播放' : '尚无视频';
  $('playback-label').textContent = playbackText;
  $('playback-dot').className = `status-dot${visible ? test ? ' test' : ' active' : ''}`;
  $('chat-title').textContent = connected ? llm ? '对话回复' : '文字播报' : '文字互动';
  $('chat-context-label').textContent = connected ? test ? '仅验证连接与视频 · 暂不接受文字任务' : llm ? '本地模型生成回复，再由数字人播报' : '直接朗读输入文字 · 不生成 AI 回答' : '渲染设备上线后可发送文字';
  $('empty-chat-description').textContent = test ? '当前播放连接测试信号，不包含数字人或语音生成。接入真实渲染设备后即可提交文字。' : llm ? '发送问题，数字人将通过已配置的模型生成回复。任务和处理状态会显示在这里。' : '输入内容，数字人会在画面中说出来。已提交的任务和处理状态会显示在这里。';
  input.placeholder = llm ? '想和数字人聊些什么？' : '想让数字人说些什么？';
  const voice = worker.voice;
  const voiceLabel = typeof voice === 'string' ? voice : voice?.label || voice?.name || voice?.id;
  $('voice-status').textContent = voiceLabel ? `音色：${voiceLabel}${typeof voice === 'object' && voice.cloned === false ? ' · 基础音色，未克隆' : typeof voice === 'object' && voice.cloned === true ? ' · 已克隆' : ''}` : '音色信息等待设备上报';
  $('composer-notice').textContent = !broadcastLive ? '直播未开启，暂不可发送互动' : !authenticated ? '请先输入访问码' : !online ? '实时连接恢复后可发送' : !worker.connected ? actorPreview ? '互动生成设备尚未连接' : local ? '待机继续播放，互动生成设备尚未连接' : '视频源尚未连接' : !stream.ready ? '等待视频源准备就绪' : mediaState.state === 'error' ? '请先恢复视频播放' : stopping ? '正在停止当前任务，请稍候再发送' : test ? '连接测试模式 · 数字人播报尚未启用' : mediaState.state !== 'playing' ? '等待画面恢复播放后可发送' : current ? '任务处理中，新文字将进入队列' : llm ? '已就绪，发送问题以开始对话' : '已就绪，发送文字以开始播报';
  input.disabled = unavailable;
  $('send-button').disabled = unavailable || sending || !input.value.trim();
  $('interrupt-button').disabled = !connected || (!current && !status.autonomous?.enabled) || stopping;
  $('diag-socket').textContent = !authenticated ? '需要访问码' : socketState === 'open' ? '已连接 · WebSocket' : socketState === 'connecting' ? '连接中' : '已断开 · 等待重连';
  $('diagnostic-summary').replaceChildren(document.createTextNode(mediaState.state === 'error' ? '播放异常 · 查看详情' : connectionLabel), Object.assign(document.createElement('span'), { className: 'chevron', textContent: '⌄' }));
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
    avatar.textContent = role === 'user' ? '我' : role === 'assistant' ? 'S' : '·';
    const label = document.createElement('span');
    label.textContent = role === 'user' ? '你' : role === 'assistant' ? '数字人' : '系统';
    const time = document.createElement('time');
    time.dateTime = new Date().toISOString();
    time.textContent = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
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
    if (role === 'assistant') entry.label.textContent = '数字人 · 主动 Crypto';
  }
  if (typeof event.text === 'string') entry.text.textContent = event.text;
  if (typeof event.error === 'string') entry.error = event.error;
  const state = mergeChatStatus(entry.element.dataset.status, event.status);
  entry.element.dataset.status = state;
  const labels = { queued: '已加入队列', running: '正在处理', done: '处理完成', error: '处理失败', interrupted: '已停止' };
  entry.state.textContent = state === 'error' && entry.error ? `处理失败：${entry.error}` : labels[state] || '';
  $('chat-count').textContent = `${messages.size} 条`;
  if (nearBottom || role === 'user') $('messages').scrollTop = $('messages').scrollHeight;
}

function updateAudio() {
  const enabled = !video.muted;
  $('audio-button').setAttribute('aria-pressed', String(enabled));
  $('audio-button').setAttribute('aria-label', enabled ? '关闭声音' : '启用声音');
  $('audio-label').textContent = enabled ? '声音已开启' : '启用声音';
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
    toast(`任务已提交${Number.isFinite(result.position) ? ` · 队列位置 ${result.position}` : ''}`);
  } catch (error) {
    playbackReporter.requestSettled(reportIndex, false);
    toast(error.message || '发送失败，请重试。');
    log(`任务提交失败：${error.message}`);
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
    toast('已发送打断请求。');
  } catch (error) { toast(error.message); }
  finally { render(); }
});
$('audio-button').addEventListener('click', () => {
  video.muted = !video.muted;
  updateAudio();
  if (livePlayback.isLive() && !video.muted && (player.source || nativeRealtime)) player.tryPlay(true);
  else if (!video.muted) toast('声音已开启，视频连接后将播放音频。');
});
video.addEventListener('volumechange', updateAudio);
$('play-button').addEventListener('click', () => { if (livePlayback.isLive()) player.tryPlay(true); });
$('catchup-button').addEventListener('click', () => { if (livePlayback.isLive()) player.goLive(); });
$('fullscreen-button').addEventListener('click', async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else if ($('video-stage').requestFullscreen) await $('video-stage').requestFullscreen();
    else if (video.webkitEnterFullscreen) video.webkitEnterFullscreen();
    else toast('此浏览器不支持全屏播放。');
  } catch (error) { toast(`无法进入全屏：${error.message}`); }
});
document.addEventListener('fullscreenchange', () => { video.controls = Boolean(document.fullscreenElement); });
// Copy only numeric playback state on explicit user action. Reason: this clipboard trace must not include chat history or credentials.
$('copy-playback-diagnostics')?.addEventListener('click', async () => {
  try {
    const report = { schema: 'sbf-browser-playback-trace-v1', capturedUtc: new Date().toISOString(),
      connection: socketState, ...player.snapshot(), reporting: playbackReporter.snapshot() };
    await navigator.clipboard.writeText(JSON.stringify(report, null, 2));
    toast('播放诊断已复制，可直接粘贴。');
  } catch { toast('复制失败，请复制下方诊断日志。'); }
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
    log('访问验证成功。');
    void livePlayback.refresh();
    connect();
    refreshStatus();
  } catch (error) { $('login-error').textContent = error.message; }
  finally { $('login-submit').disabled = false; }
});
window.addEventListener('online', () => { log('浏览器网络已恢复。'); if (authenticated) initialize(); });
window.addEventListener('beforeunload', () => livePlayback.close());
window.addEventListener('offline', () => { livePlayback.apply('unavailable'); log('浏览器网络已断开。'); socketState = 'closed'; if (!nativeRealtime) clearPlayback(); render(); });
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
    $('diag-lag').textContent = snapshot.firstFrameMs === null ? '正在连接' : `首画 ${(snapshot.firstFrameMs / 1000).toFixed(2)} 秒`;
    const r = snapshot.rtcStats;
    const h = snapshot.httpStats;
    $('diag-bytes').textContent = h ? `${h.bytesReceived === null ? '累计接收量未提供' : formatBytes(h.bytesReceived)} · HTTPS · 下载 ${(h.lastDownloadMbps ?? 0).toFixed(2)} Mbps · 缓冲 ${snapshot.bufferAheadSeconds.toFixed(2)} 秒` : r ? `${formatBytes(r.bytesReceived ?? 0)} · ${r.protocol ?? '—'} · 收帧 ${r.framesReceived ?? '—'} / 解码 ${r.framesDecoded ?? '—'} · 丢包 ${r.packetsLost ?? '—'} · 解码均值 ${(r.meanDecodeMs ?? 0).toFixed(1)}ms` : '原生实时传输';
    $('diag-buffer').textContent = `${playbackDiagnosticText(d)} · 可见停画>250ms ${snapshot.visibleGapsOver250Ms}`;
    $('catchup-button').hidden = true;
    if (!rtcReportPending && authenticated && snapshot.observedSeconds !== null) {
      rtcReportPending = true;
      fetch('/api/rtc-report', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: rtcReportId, ...snapshot, ...d, hidden: document.hidden }),
        signal: AbortSignal.timeout(2000) }).catch(() => {}).finally(() => { rtcReportPending = false; });
    }
    $('local-time').textContent = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
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
    log('视频长时间没有进展，正在自动重新连接。');
    connect();
    return;
  }
  $('diag-bytes').textContent = formatBytes(snapshot.receivedBytes);
  $('diag-lag').textContent = snapshot.lag === null ? '—' : `${snapshot.lag.toFixed(1)} 秒`;
  const bufferText = snapshot.hasData ? `向前 ${snapshot.bufferAheadSeconds.toFixed(2)} 秒 · 已存 ${snapshot.bufferSeconds.toFixed(1)} 秒 · 待写入 ${formatBytes(snapshot.queuedBytes)}` : '等待片段';
  $('diag-buffer').textContent = `${bufferText} · ${playbackDiagnosticText(snapshot.diagnostics)} · 上报HTTP ${reporting.lastHTTPStatus ?? '—'}/${reporting.lastOutcomeCode} · 超时 ${reporting.deadlineCount} · 禁用 ${reporting.disabledReasonCode}`;
  $('catchup-button').hidden = !snapshot.hasData || snapshot.lag < 2;
  $('local-time').textContent = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
}, 1000);
setInterval(refreshStatus, 10000);
render();
initialize();
