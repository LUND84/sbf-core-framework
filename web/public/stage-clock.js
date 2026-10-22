export function installStageClock(element) {
  if (!element) return;
  const format = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Hong_Kong', hourCycle: 'h23',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  // Use wall time independently of video progress. Reason: the display is a
  // current clock, not a capture timestamp or a measurement of stream latency.
  const update = () => {
    const now = new Date();
    element.textContent = format.format(now);
    element.dateTime = now.toISOString();
  };
  update();
  setInterval(update, 1000);
  document.addEventListener('visibilitychange', update);
}
