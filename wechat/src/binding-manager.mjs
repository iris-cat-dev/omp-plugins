import { createBinding } from './binding.mjs';

export class BindingManager {
  constructor({ root, directory, signal, create = createBinding }) {
    Object.assign(this, { root, directory, signal, create });
    this.canceled = new Map(); this.running = null; this.closed = false;
    this.abort = () => { this.running?.controller.abort(); };
    signal.addEventListener('abort', this.abort, { once: true });
  }
  cancel(id) {
    if (!this.canceled.has(id)) {
      const timer = setTimeout(() => this.canceled.delete(id), 300000);
      timer.unref?.(); this.canceled.set(id, timer);
    }
    if (this.running?.id === id) this.running.controller.abort();
  }
  async run(input) {
    if (this.closed || this.signal.aborted || this.canceled.has(input.id)) throw new Error('绑定核验已取消');
    if (this.running) throw new Error('已有绑定核验正在进行');
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, this.signal]);
    const work = this.create({ root: this.root, directory: this.directory, pythonPath: input.pythonPath, accountId: input.accountId, pid: input.pid, contactDatabase: input.contactDatabase, signal });
    const entry = { id: input.id, controller, work };
    this.running = entry;
    try { const result = await work; signal.throwIfAborted(); return result; }
    finally { if (this.running === entry) this.running = null; }
  }
  async close() {
    this.closed = true; this.signal.removeEventListener('abort', this.abort);
    const running = this.running; running?.controller.abort();
    if (running) await running.work.catch(() => {});
    for (const timer of this.canceled.values()) clearTimeout(timer);
    this.canceled.clear();
  }
}
