import { randomUUID } from 'node:crypto';

const context = text => ` Previous completed narration (context, not a script to repeat): ${JSON.stringify(text)}`;

// A plan reserves preparation only; the real actor slot remains serial.
// Reason: one bounded lookahead can hide LLM/TTS work without pre-playing speech ahead of viewers.
export class AutonomousWarm {
  constructor(broker) {
    this.broker = broker;
    this.epoch = randomUUID();
    this.next = null;
  }

  capable() { return this.broker.continuousActor() && this.broker.workerInfo.warmPrefetch === true; }

  plan(request, baseText, topicIndex) {
    if (!this.capable()) return;
    const next = this.broker.createRequest(baseText, {
      kind: 'autonomous-crypto', source: 'autonomous-crypto', narrationTargetSeconds: 10 });
    this.next = { request: next, parentId: request.id, epoch: this.epoch, topicIndex, completed: false };
    request.warmNext = { id: next.id, text: baseText, parentId: request.id, epoch: this.epoch };
  }

  completed(id, text) {
    if (this.next?.parentId !== id) return;
    if (typeof text !== 'string' || !text.trim()) { this.clear(); return; }
    this.next.request.text += context(text.trim().slice(-600));
    this.next.completed = true;
  }

  take(topicIndex) {
    const next = this.next;
    if (!next?.completed || next.epoch !== this.epoch || next.topicIndex !== topicIndex || !this.capable()) return null;
    this.next = null;
    return { ...next.request, warmEpoch: next.epoch, warmParentId: next.parentId };
  }

  clear() {
    const planned = this.next !== null;
    this.next = null;
    this.epoch = randomUUID();
    if (planned && this.capable()) this.broker.send(this.broker.worker, { type: 'warm.clear', epoch: this.epoch });
  }

  checkSource() {
    if (this.next && (!this.capable() || !this.broker.generationReady())) this.clear();
  }
}
