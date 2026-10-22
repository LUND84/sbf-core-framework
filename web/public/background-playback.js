// Keep background entry separate from leaving the document.
// Reason: an embedded browser may hide a live page without unloading it;
// only the browser can decide when to reclaim that document's resources.
export function installBackgroundPlayback({ page, lifecycle, player, connectionState,
  canReconnect, reconnect, resetWatchdog, mediaSession = null }) {
  function recover() {
    player.setVisibility(page.hidden === true);
    resetWatchdog();
    // A live socket and decoder remain owned by the current player.
    // Reason: returning to a healthy page must not reload its buffers or epoch.
    if (canReconnect() && connectionState() === 'closed') reconnect();
    else player.maintain();
  }
  function visibilityChanged() {
    if (page.hidden) player.setVisibility(true);
    else recover();
  }
  page.addEventListener('visibilitychange', visibilityChanged);
  page.addEventListener('resume', recover);
  lifecycle.addEventListener('pageshow', recover);
  // Do not close or clear on pagehide.
  // Reason: actual unload reclaims the socket automatically, while a living
  // webview can emit pagehide for a temporary background transition.
  player.setVisibility(page.hidden === true);
  if (mediaSession?.setActionHandler) {
    for (const [name, action] of [['pause', () => player.pauseByUser()], ['play', () => player.tryPlay(true)]]) {
      try { mediaSession.setActionHandler(name, action); } catch { /* Optional browser controls. */ }
    }
  }
  return () => {
    page.removeEventListener('visibilitychange', visibilityChanged);
    page.removeEventListener('resume', recover);
    lifecycle.removeEventListener('pageshow', recover);
  };
}
