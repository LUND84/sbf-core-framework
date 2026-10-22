import { PaidAlerts, ensureAlertSurface, activeAlert, alertProgress, ALERT_STYLES, ALERT_DURATIONS } from './module-c-alerts.js';
import { paintAlertArt } from './module-c-alert-art.js';

const allowed = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
const status = document.getElementById('preview-status');
if (!allowed) {
  status.textContent = '此演示只在本机 localhost 预览服务器中运行。';
  document.querySelectorAll('button').forEach(button => { button.disabled = true; });
} else {
  const surface = ensureAlertSurface(document.getElementById('preview-board'));
  const controller = new PaidAlerts(surface);
  const amounts = ['20', '50', '100', '200', '500', '1000', '10000'];
  let events = [], sequence = 0, recorder = null, exportFrame = null, downloadUrl = '';
  const event = (tierIndex, startsAt) => ({ id: (++sequence).toString(16).padStart(16, '0'), version: 1,
    tierIndex, startsAt, expiresAt: startsAt + ALERT_DURATIONS[tierIndex - 1], amount: amounts[tierIndex - 1],
    name: `本地演示 ${String(tierIndex).padStart(2, '0')}`, chain: 'solana', tokenChain: 'ethereum',
    ca: '0x1111111111111111111111111111111111111111', logoUrl: '/preview-token.svg', symbol: 'DEMO' });
  const apply = () => controller.update({ alerts: events, serverTime: Date.now() });
  const buttons = document.getElementById('tier-buttons');
  function pressed(index) {
    buttons.querySelectorAll('button').forEach((button, i) => button.setAttribute('aria-pressed', String(i + 1 === index)));
  }
  function playTier(index, lateMs = 0) {
    events = [event(index, Date.now() - lateMs)]; apply(); pressed(index);
    status.textContent = `第 ${index} 档 · ${ALERT_STYLES[index - 1].name} · ${ALERT_DURATIONS[index - 1] / 1000} 秒`;
    return events[0];
  }
  function playAll() {
    let at = Date.now() + 600;
    events = amounts.map((_, i) => { const value = event(i + 1, at); at = value.expiresAt; return value; });
    apply(); pressed(0); status.textContent = '依次播放七档：4 / 5 / 6 / 7 / 8 / 10 / 12 秒（无音轨）';
    return at;
  }
  amounts.forEach((amount, i) => {
    const button = document.createElement('button'); button.type = 'button'; button.style.setProperty('--tier-color', ALERT_STYLES[i].color);
    const price = document.createElement('strong'); price.textContent = `${amount} U`;
    const text = document.createElement('span'); text.textContent = `${ALERT_STYLES[i].name} · ${ALERT_DURATIONS[i] / 1000}s`;
    button.append(price, text); button.setAttribute('aria-pressed', 'false'); button.onclick = () => playTier(i + 1); buttons.append(button);
  });
  document.getElementById('play-all').onclick = playAll;
  const room = new Image(); room.src = '/preview-room.png';
  const tokenLogo = new Image(); tokenLogo.src = '/preview-token.svg';
  function exportPaint(canvas, art) {
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#1c2931'; ctx.fillRect(0, 0, 1920, 1080);
    if (room.complete && room.naturalWidth) ctx.drawImage(room, 0, 0, 320, 180, 0, 0, 1920, 1080);
    ctx.fillStyle = '#ffffffa0'; ctx.font = '20px sans-serif'; ctx.fillText('LOCAL PREVIEW · NO PAYMENT · SILENT', 35, 1040);
    const value = activeAlert(events, Date.now());
    if (value) {
      const x = 1920 * .32, y = 1080 * .5, w = Math.round(1920 * .36), h = Math.round(1080 * .23);
      const p = alertProgress(value, Date.now()), opacity = Math.min(1, p * ALERT_DURATIONS[value.tierIndex - 1] / 300,
        (1 - p) * ALERT_DURATIONS[value.tierIndex - 1] / 500);
      ctx.save(); ctx.globalAlpha = opacity; ctx.fillStyle = '#111c2af2'; ctx.beginPath(); ctx.roundRect(x, y, w, h, 15); ctx.fill();
      art.width = w; art.height = h; paintAlertArt(art.getContext('2d'), w, h, value, p);
      ctx.drawImage(art, x, y); ctx.strokeStyle = ALERT_STYLES[value.tierIndex - 1].color; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.roundRect(x, y, w, h, 15); ctx.stroke();
      ctx.fillStyle = ALERT_STYLES[value.tierIndex - 1].color; ctx.font = 'bold 16px sans-serif';
      ctx.fillText(`TIER 0${value.tierIndex} · ${ALERT_STYLES[value.tierIndex - 1].name}`, x + 190, y + 40);
      if (tokenLogo.complete && tokenLogo.naturalWidth) ctx.drawImage(tokenLogo, x + 149, y + 57, 30, 30);
      ctx.fillStyle = '#fff'; ctx.font = 'bold 25px sans-serif'; ctx.fillText(value.name, x + 190, y + 83);
      ctx.font = 'bold 42px sans-serif'; ctx.fillStyle = ALERT_STYLES[value.tierIndex - 1].color;
      ctx.fillText(`${value.amount} U`, x + 190, y + 134);
      ctx.fillStyle = '#b7c8e8'; ctx.font = '14px sans-serif'; ctx.fillText('DEMO · ETHEREUM · CA', x + 18, y + h - 45);
      ctx.fillStyle = '#fff'; ctx.font = '18px monospace'; ctx.fillText(value.ca, x + 18, y + h - 18);
      ctx.fillStyle = ALERT_STYLES[value.tierIndex - 1].color; ctx.fillRect(x, y + h - 3, w * (1 - p), 3); ctx.restore();
    }
    exportFrame = requestAnimationFrame(() => exportPaint(canvas, art));
  }
  document.getElementById('record-all').onclick = async () => {
    if (recorder?.state === 'recording') return;
    if (!globalThis.MediaRecorder) { status.textContent = '当前浏览器未提供 MediaRecorder，请使用 Chrome。'; return; }
    const canvas = document.createElement('canvas'); canvas.width = 1920; canvas.height = 1080;
    const stream = canvas.captureStream(30), chunks = [];
    const mimeType = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find(type => MediaRecorder.isTypeSupported(type));
    recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 4500000 });
    recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
    recorder.onstop = () => {
      cancelAnimationFrame(exportFrame); stream.getTracks().forEach(track => track.stop());
      if (downloadUrl) URL.revokeObjectURL(downloadUrl);
      downloadUrl = URL.createObjectURL(new Blob(chunks, { type: mimeType }));
      const link = document.getElementById('download'); link.href = downloadUrl; link.download = 'module-c-seven-alerts-local.webm'; link.hidden = false;
      status.textContent = '七档静音 WebM 已生成；这是本地演示，没有真实收款。';
      document.getElementById('record-all').disabled = false; link.click();
    };
    const end = playAll(); exportPaint(canvas, document.createElement('canvas'));
    recorder.start(1000); document.getElementById('record-all').disabled = true;
    setTimeout(() => { if (recorder.state === 'recording') recorder.stop(); }, end - Date.now() + 700);
  };
  globalThis.alertPreview = { controller, surface, playTier, playAll, get events() { return events; },
    update: values => { events = values; apply(); } };
  playTier(1);
}
