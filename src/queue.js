export class RequestQueue {
  constructor({
    maxPending = 5,
    maxAgeMs = 60_000,
    handle,
    onExpired = async () => {},
    now = Date.now,
    logger = console,
  }) {
    this.maxPending = maxPending;
    this.maxAgeMs = maxAgeMs;
    this.handle = handle;
    this.onExpired = onExpired;
    this.now = now;
    this.logger = logger;
    this.states = new Map();
  }

  isActive(scopeId) {
    return this.states.has(scopeId);
  }

  whenIdle(scopeId) {
    return this.states.get(scopeId)?.idlePromise || Promise.resolve();
  }

  enqueue(scopeId, item) {
    const queuedItem = { item, enqueuedAt: this.now() };
    const existing = this.states.get(scopeId);
    if (!existing) {
      let resolveIdle;
      const idlePromise = new Promise((resolve) => { resolveIdle = resolve; });
      const state = {
        current: queuedItem,
        pending: [],
        idlePromise,
        resolveIdle,
      };
      this.states.set(scopeId, state);
      void this.drain(scopeId, state);
      return { status: "started", position: 0 };
    }

    if (existing.pending.some((queued) => queued.item.userId === item.userId)) {
      return { status: "duplicate", position: 0 };
    }
    if (existing.pending.length >= this.maxPending) {
      return { status: "full", position: 0 };
    }

    existing.pending.push(queuedItem);
    return { status: "queued", position: existing.pending.length };
  }

  async runItem(queuedItem) {
    try {
      if (this.now() - queuedItem.enqueuedAt > this.maxAgeMs) {
        await this.onExpired(queuedItem.item);
      } else {
        await this.handle(queuedItem.item);
      }
    } catch (error) {
      this.logger.error?.("Queued request failed", error);
    }
  }

  async drain(scopeId, state) {
    try {
      while (state.current) {
        await this.runItem(state.current);
        state.current = state.pending.shift() || null;
      }
    } finally {
      if (this.states.get(scopeId) === state) this.states.delete(scopeId);
      state.resolveIdle();
    }
  }
}
