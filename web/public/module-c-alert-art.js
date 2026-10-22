export const ALERT_DURATIONS = Object.freeze([4000, 5000, 6000, 7000, 8000, 10000, 12000]);
export const ALERT_STYLES = Object.freeze([
  { name: '宝石闪光', color: '#63f5cb', second: '#c9fff0' },
  { name: '双环共振', color: '#a99aff', second: '#6feaff' },
  { name: '耀金星爆', color: '#ffc65c', second: '#ff8c64' },
  { name: '星际彗星', color: '#55dfff', second: '#9c89ff' },
  { name: '加冕时刻', color: '#ffda75', second: '#fff1bb' },
  { name: '流星之雨', color: '#f28dff', second: '#79dfff' },
  { name: '传奇庆典', color: '#ffe08b', second: '#ff83bd' },
]);

function random(seed) {
  let value = seed >>> 0;
  return () => { value = Math.imul(value ^ value >>> 15, 2246822519); value ^= value >>> 13;
    return (value >>> 0) / 4294967296; };
}
function polygon(ctx, points, fill, stroke) {
  ctx.beginPath(); points.forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y));
  ctx.closePath(); if (fill) { ctx.fillStyle = fill; ctx.fill(); }
  if (stroke) { ctx.strokeStyle = stroke; ctx.stroke(); }
}
function star(ctx, x, y, radius, count = 4, angle = 0) {
  const points = Array.from({ length: count * 2 }, (_, i) => {
    const r = i % 2 ? radius * .34 : radius, a = angle + i * Math.PI / count;
    return [x + Math.cos(a) * r, y + Math.sin(a) * r];
  });
  polygon(ctx, points, ctx.fillStyle);
}
function gem(ctx, x, y, size, color) {
  polygon(ctx, [[x, y - size], [x + size * .75, y - size * .3], [x + size * .5, y + size * .45],
    [x, y + size], [x - size * .5, y + size * .45], [x - size * .75, y - size * .3]], color, '#ffffffb3');
  ctx.strokeStyle = '#ffffff70'; ctx.beginPath(); ctx.moveTo(x, y - size); ctx.lineTo(x, y + size);
  ctx.moveTo(x - size * .75, y - size * .3); ctx.lineTo(x + size * .75, y - size * .3); ctx.stroke();
}
function crown(ctx, x, y, size, color) {
  polygon(ctx, [[x - size, y - size * .65], [x - size * .55, y - size * .13], [x, y - size],
    [x + size * .55, y - size * .13], [x + size, y - size * .65], [x + size * .72, y + size * .6],
    [x - size * .72, y + size * .6]], color, '#fff4c2');
  ctx.fillStyle = '#54435f'; star(ctx, x, y, size * .23, 4, Math.PI / 2);
  ctx.strokeStyle = '#fff6c9'; ctx.beginPath(); ctx.moveTo(x - size * .65, y + size * .37);
  ctx.lineTo(x + size * .65, y + size * .37); ctx.stroke();
}

// Progress is derived from the server's absolute window, never from an animation start callback.
// Reason: metadata polls, late joins and reloads must not replay a paid celebration from its beginning.
export function paintAlertArt(ctx, width, height, event, progress, reducedMotion = false) {
  const index = event.tierIndex - 1, style = ALERT_STYLES[index];
  if (!style || width <= 0 || height <= 0) return;
  ctx.clearRect(0, 0, width, height); ctx.save(); ctx.beginPath(); ctx.rect(0, 0, width, height); ctx.clip();
  const phase = reducedMotion ? .4 : progress, x = width * .14, y = height * .43;
  const size = Math.min(height * .22, width * .09), pulse = 1 + Math.sin(phase * Math.PI * 4) * .045;
  const glow = ctx.createRadialGradient(x, y, 0, x, y, height * .75);
  glow.addColorStop(0, style.color + '45'); glow.addColorStop(1, style.color + '00');
  ctx.fillStyle = glow; ctx.fillRect(0, 0, width, height);
  ctx.lineWidth = Math.max(.7, width / 400); ctx.lineCap = 'round';
  const rng = random(parseInt(event.id.slice(-8), 16) + index * 127), count = reducedMotion ? 4 : [7, 11, 16, 13, 20, 32, 48][index];
  for (let i = 0; i < count; i++) {
    const a = rng(), b = rng(), speed = .18 + rng() * .45;
    let px = a * width, py = b * height;
    ctx.globalAlpha = .18 + rng() * .35; ctx.fillStyle = i % 2 ? style.color : style.second;
    if (index === 5 || index === 6) {
      px = ((a + phase * speed) % 1) * width; py = ((b + phase * speed * 2) % 1) * height;
      if (index === 5 || i % 3 === 0) {
        ctx.strokeStyle = ctx.fillStyle; ctx.beginPath(); ctx.moveTo(px - size * .35, py - size * .55);
        ctx.lineTo(px, py); ctx.stroke();
      } else { ctx.save(); ctx.translate(px, py); ctx.rotate(phase * 4 + a * 8); ctx.fillRect(-1, -3, 2, 6); ctx.restore(); }
    } else {
      py += Math.sin(phase * Math.PI * 2 + a * 9) * height * .07;
      star(ctx, px, py, Math.max(1, size * (.035 + b * .07)), 4, phase);
    }
  }
  ctx.globalAlpha = .95; ctx.save(); ctx.translate(x, y); ctx.scale(pulse, pulse); ctx.translate(-x, -y);
  if (index === 0) gem(ctx, x, y, size * .7, style.color);
  if (index === 1) {
    for (const rotation of [phase * 2, -phase * 2 + 1.4]) {
      ctx.save(); ctx.translate(x, y); ctx.rotate(rotation); ctx.strokeStyle = style.color;
      ctx.beginPath(); ctx.ellipse(0, 0, size * 1.25, size * .48, 0, 0, Math.PI * 2); ctx.stroke(); ctx.restore();
    }
    gem(ctx, x, y, size * .52, style.second);
  }
  if (index === 2) {
    ctx.fillStyle = style.color; star(ctx, x, y, size * 1.12, 8, phase * .8);
    ctx.fillStyle = '#fff4cd'; star(ctx, x, y, size * .58, 4, -phase);
    ctx.strokeStyle = style.second; ctx.beginPath(); ctx.arc(x, y, size * (1.25 + phase * .12), 0, Math.PI * 2); ctx.stroke();
  }
  if (index === 3) {
    const a = .35 + phase * 2;
    ctx.strokeStyle = style.color; ctx.beginPath(); ctx.ellipse(x, y, size * 1.35, size * .65, -.5, .1, 5.8); ctx.stroke();
    ctx.fillStyle = style.second; ctx.beginPath(); ctx.arc(x, y, size * .48, 0, Math.PI * 2); ctx.fill();
    const cx = x + Math.cos(a) * size * 1.35, cy = y - Math.sin(a) * size * .7;
    const tail = ctx.createLinearGradient(cx - size, cy + size * .55, cx, cy);
    tail.addColorStop(0, '#55dfff00'); tail.addColorStop(1, '#dcfcff'); ctx.strokeStyle = tail;
    ctx.lineWidth *= 3; ctx.beginPath(); ctx.moveTo(cx - size, cy + size * .55); ctx.lineTo(cx, cy); ctx.stroke();
    ctx.fillStyle = '#fff'; star(ctx, cx, cy, size * .21, 4);
  }
  if (index === 4) crown(ctx, x, y, size * .85, style.color);
  if (index === 5) {
    ctx.strokeStyle = style.second; ctx.beginPath(); ctx.arc(x, y, size, -.5 + phase, 4.8 + phase); ctx.stroke();
    gem(ctx, x, y, size * .65, style.color);
  }
  if (index === 6) {
    for (let i = 0; i < 12; i++) {
      const a = i * Math.PI / 6 + phase * .35; ctx.strokeStyle = i % 2 ? style.color : style.second;
      ctx.beginPath(); ctx.moveTo(x + Math.cos(a) * size * 1.1, y + Math.sin(a) * size * 1.1);
      ctx.lineTo(x + Math.cos(a) * size * 1.5, y + Math.sin(a) * size * 1.5); ctx.stroke();
    }
    ctx.strokeStyle = style.color; ctx.beginPath(); ctx.arc(x, y, size * 1.02, 0, Math.PI * 2); ctx.stroke();
    crown(ctx, x, y, size * .73, style.color);
  }
  ctx.restore(); ctx.restore();
}
