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
    this.button.textContent = `${enabled ? '暂停' : '开始'} Crypto 自言自语`;
    this.button.disabled = this.pending || !authenticated || (!enabled && !supported);
    this.button.setAttribute('aria-pressed', String(enabled));
    this.button.setAttribute('aria-busy', String(this.pending));
    this.button.dataset.state = enabled ? 'enabled' : 'disabled';
    let label = '已暂停';
    let detail = '持续聊 Crypto，弹幕回复优先。暂停后当前段说完。';
    if (!authenticated) label = '需要访问码';
    else if (!online) label = '实时连接已断开';
    else if (!worker.connected) label = '设备离线';
    else if (worker.autonomousCrypto !== true || worker.mode !== 'avatar') label = '设备暂不支持';
    else if (auto.state === 'error') {
      label = '生成异常 · 已暂停';
      detail = auto.lastError || '请检查设备状态后重试。';
    } else if (enabled) {
      const busy = status.queue?.current || status.queue?.active || status.queue?.pending;
      label = auto.state === 'generating' ? '主动讲话中'
        : auto.state === 'cooldown' ? '准备下一段'
        : busy ? '等待弹幕回复完成'
        : worker.mediaMode === 'continuous-actor-v1' && status.actorSource?.ready !== true
          ? '等待视频源恢复' : '等待生成就绪';
      const completed = Number.isInteger(auto.completed) && auto.completed >= 0 ? auto.completed : 0;
      detail = `${auto.topic ? `${auto.topic} · ` : ''}已完成 ${completed} 段 · 暂停后当前段说完。`;
    }
    if (this.pending) label = enabled ? '正在暂停' : '正在开启';
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
      this.toast(enabled ? 'Crypto 自言自语已开启，弹幕回复优先。' : '已暂停后续生成，当前段说完后暂停。');
    } catch (error) {
      this.toast(error.message || '操作失败，请重试。');
      this.log(`Crypto 自言自语操作失败：${error.message}`);
    } finally {
      this.pending = false;
      this.render(this.getContext());
    }
  }
}
