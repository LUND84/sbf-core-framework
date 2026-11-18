export class AutonomousTalkControl {
  constructor({ button, state, detail, request, getContext, applyStatus, toast, log }) {
    Object.assign(this, { button, state, detail, request, getContext, applyStatus, toast, log });
    this.pending = false;
    button.addEventListener('click', () => this.toggle());
  }

  render({ status, online, authenticated }) {
    const auto = status.autonomous || {};
    const worker = status.worker || {};
    const enabled = auto.enabled === true;
    const supported = online && worker.connected && worker.mode === 'avatar' && worker.autonomousCrypto === true;
    this.button.textContent = `${enabled ? 'Pause' : 'Start'} crypto commentary`;
    this.button.disabled = this.pending || !authenticated || (!enabled && !supported);
    this.button.setAttribute('aria-pressed', String(enabled));
    this.button.setAttribute('aria-busy', String(this.pending));
    this.button.dataset.state = enabled ? 'enabled' : 'disabled';
    let label = 'Paused';
    let detail = 'Continuous crypto commentary, with chat replies taking priority. Pausing lets the current segment finish.';
    if (!authenticated) label = 'Access code required';
    else if (!online) label = 'Live connection lost';
    else if (!worker.connected) label = 'Device offline';
    else if (worker.autonomousCrypto !== true || worker.mode !== 'avatar') label = 'Not supported by this device';
    else if (auto.state === 'error') {
      label = 'Generation error · paused';
      detail = auto.lastError || 'Check the device status and try again.';
    } else if (enabled) {
      const busy = status.queue?.current || status.queue?.active || status.queue?.pending;
      label = auto.state === 'generating' ? 'Speaking'
        : auto.state === 'cooldown' ? 'Preparing the next segment'
        : busy ? 'Waiting for the chat reply to finish'
        : worker.mediaMode === 'continuous-actor-v1' && status.actorSource?.ready !== true
          ? 'Waiting for the video source to recover' : 'Waiting for generation to be ready';
      const completed = Number.isInteger(auto.completed) && auto.completed >= 0 ? auto.completed : 0;
      detail = `${auto.topic ? `${auto.topic} · ` : ''}${completed} segments completed · pausing lets the current segment finish.`;
    }
    if (this.pending) label = enabled ? 'Pausing' : 'Starting';
    this.state.textContent = label;
    this.detail.textContent = detail;
  }

  async toggle() {
    if (this.pending || this.button.disabled) return;
    const enabled = this.getContext().status.autonomous?.enabled !== true;
    this.pending = true;
    this.render(this.getContext());
    try {
      const autonomous = await this.request('/api/autonomous', {
        method: 'POST', body: JSON.stringify({ enabled }),
      });
      this.applyStatus({ autonomous });
      this.toast(enabled ? 'Crypto commentary started. Chat replies take priority.' : 'Further generation is paused. The current segment will finish first.');
    } catch (error) {
      this.toast(error.message || 'The operation failed. Please try again.');
      this.log(`Crypto commentary control failed: ${error.message}`);
    } finally {
      this.pending = false;
      this.render(this.getContext());
    }
  }
}
