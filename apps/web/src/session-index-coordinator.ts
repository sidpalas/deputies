export type SessionIndexContext = {
  authorityEpoch: number;
  viewKey: string;
};

export type SessionIndexEffect = 'summary' | 'list';

export type SessionIndexTicket = Readonly<{
  context: SessionIndexContext;
  requestGeneration: number;
  scope: string;
  leaseId: number;
  summaryGenerations: ReadonlyMap<string, number>;
}>;

export type SessionIndexListResult = Readonly<{
  satisfiedIds: ReadonlySet<string>;
}>;

export type SessionIndexDiagnostics = Readonly<{
  staleDiscards: number;
  queuedReruns: number;
}>;

export type SessionIndexCoordinatorOptions = {
  listDelayMs?: number;
  summaryDelayMs?: number;
  loadList: (ticket: SessionIndexTicket) => Promise<SessionIndexListResult>;
  loadSummary: (sessionId: string, generation: number, context: SessionIndexContext) => Promise<void>;
  onError?: (error: unknown) => void;
  setTimer?: (callback: () => void, delayMs: number) => number;
  clearTimer?: (timer: number) => void;
};

/** Coordinates presentation invalidations and owns synchronous request tickets. */
export class SessionIndexCoordinator {
  readonly #options: Required<Omit<SessionIndexCoordinatorOptions, 'onError'>> &
    Pick<SessionIndexCoordinatorOptions, 'onError'>;
  #context: SessionIndexContext = { authorityEpoch: 0, viewKey: '' };
  #summaryGenerations = new Map<string, number>();
  #pendingSummaries = new Set<string>();
  #listPending = false;
  #listInFlight: SessionIndexTicket | null = null;
  #summaryDrainInFlight = false;
  #timer: number | null = null;
  #requestGeneration = 0;
  #leases = new Map<string, { leaseId: number; viewKey: string }>();
  #nextLeaseId = 0;
  #disposed = false;
  #staleDiscards = 0;
  #queuedReruns = 0;

  constructor(options: SessionIndexCoordinatorOptions) {
    this.#options = {
      ...options,
      listDelayMs: options.listDelayMs ?? 125,
      summaryDelayMs: options.summaryDelayMs ?? 125,
      setTimer: options.setTimer ?? ((callback, delay) => window.setTimeout(callback, delay)),
      clearTimer: options.clearTimer ?? ((timer) => window.clearTimeout(timer)),
    };
  }

  setContext(context: SessionIndexContext): void {
    if (sameContext(this.#context, context) || this.#disposed) return;
    this.#context = { ...context };
    this.#requestGeneration += 1;
    this.#summaryGenerations.clear();
    this.#pendingSummaries.clear();
    this.#listPending = false;
    this.#listInFlight = null;
    this.#leases.clear();
    this.#clearTimer();
  }

  invalidate(sessionId: string, effect: SessionIndexEffect, rowLoaded: boolean, filtersActive: boolean): void {
    if (this.#disposed || !sessionId) return;
    this.markSummaryChanged(sessionId);
    this.requestInvalidation(sessionId, effect, rowLoaded, filtersActive);
  }

  markSummaryChanged(sessionId: string): void {
    if (this.#disposed || !sessionId) return;
    const generation = (this.#summaryGenerations.get(sessionId) ?? 0) + 1;
    this.#summaryGenerations.set(sessionId, generation);
  }

  requestInvalidation(sessionId: string, effect: SessionIndexEffect, rowLoaded: boolean, filtersActive: boolean): void {
    if (this.#disposed || !sessionId) return;
    if (effect === 'list' || filtersActive || !rowLoaded) {
      // A list may not represent a loaded archived, child, search, or
      // supplemental row. Keep summary work pending until the list proves that
      // it satisfied this exact generation.
      if (rowLoaded) this.#pendingSummaries.add(sessionId);
      const newlyPending = !this.#listPending;
      this.#listPending = true;
      if (this.#listInFlight && newlyPending) this.#queuedReruns += 1;
      this.#schedule(this.#options.listDelayMs);
    } else {
      this.#pendingSummaries.add(sessionId);
      if (!this.#listPending) this.#schedule(this.#options.summaryDelayMs, true);
    }
  }

  captureTicket(scope: string, viewKey = this.#context.viewKey): SessionIndexTicket | null {
    if (this.#disposed) return null;
    const currentLease = this.#leases.get(scope);
    if (currentLease?.viewKey === viewKey) return null;
    const leaseId = ++this.#nextLeaseId;
    this.#leases.set(scope, { leaseId, viewKey });
    return {
      context: { ...this.#context, viewKey },
      requestGeneration: this.#requestGeneration,
      scope,
      leaseId,
      summaryGenerations: new Map(this.#summaryGenerations),
    };
  }

  release(ticket: SessionIndexTicket): void {
    if (this.#leases.get(ticket.scope)?.leaseId === ticket.leaseId) this.#leases.delete(ticket.scope);
  }

  isTicketCurrent(ticket: SessionIndexTicket): boolean {
    const current =
      !this.#disposed &&
      ticket.requestGeneration === this.#requestGeneration &&
      ticket.context.authorityEpoch === this.#context.authorityEpoch &&
      this.#leases.get(ticket.scope)?.leaseId === ticket.leaseId;
    if (!current) this.#staleDiscards += 1;
    return current;
  }

  isRowCurrent(ticket: SessionIndexTicket, sessionId: string): boolean {
    const current =
      !this.#disposed &&
      ticket.requestGeneration === this.#requestGeneration &&
      ticket.context.authorityEpoch === this.#context.authorityEpoch &&
      this.#leases.get(ticket.scope)?.leaseId === ticket.leaseId &&
      (ticket.summaryGenerations.get(sessionId) ?? 0) === (this.#summaryGenerations.get(sessionId) ?? 0);
    if (!current) this.#staleDiscards += 1;
    return current;
  }

  isSummaryCurrent(sessionId: string, generation: number, context: SessionIndexContext): boolean {
    return (
      !this.#disposed &&
      sameContext(context, this.#context) &&
      generation === (this.#summaryGenerations.get(sessionId) ?? 0)
    );
  }

  /** Records that a directly fetched summary satisfied the generation it was requested for. */
  satisfyDirectSummary(sessionId: string, generation: number, context: SessionIndexContext): boolean {
    if (!this.isSummaryCurrent(sessionId, generation, context)) return false;
    this.#pendingSummaries.delete(sessionId);
    return true;
  }

  diagnostics(): SessionIndexDiagnostics {
    return { staleDiscards: this.#staleDiscards, queuedReruns: this.#queuedReruns };
  }

  dispose(): void {
    this.#disposed = true;
    this.#requestGeneration += 1;
    this.#pendingSummaries.clear();
    this.#listPending = false;
    this.#listInFlight = null;
    this.#leases.clear();
    this.#clearTimer();
  }

  #schedule(delay: number, trailing = false): void {
    if (this.#listInFlight || this.#summaryDrainInFlight) return;
    if (trailing) this.#clearTimer();
    if (this.#timer !== null) return;
    this.#timer = this.#options.setTimer(() => {
      this.#timer = null;
      void this.#flush();
    }, delay);
  }

  async #flush(): Promise<void> {
    if (this.#disposed) return;
    if (this.#listPending) {
      this.#listPending = false;
      const ticket = this.captureTicket(`list:${this.#requestGeneration}`);
      if (!ticket) return;
      this.#listInFlight = ticket;
      try {
        const result = await this.#options.loadList(ticket);
        if (this.isTicketCurrent(ticket)) {
          for (const id of result.satisfiedIds) {
            const generation = ticket.summaryGenerations.get(id) ?? 0;
            if (this.#summaryGenerations.get(id) === generation) this.#pendingSummaries.delete(id);
          }
        }
      } catch (error) {
        if (this.isTicketCurrent(ticket)) this.#options.onError?.(error);
      } finally {
        this.release(ticket);
        if (this.#listInFlight === ticket) {
          this.#listInFlight = null;
          if (this.#listPending || this.#pendingSummaries.size > 0) this.#schedule(0);
        }
      }
      return;
    }
    const context = { ...this.#context };
    const requestGeneration = this.#requestGeneration;
    const entries = [...this.#pendingSummaries].map((id) => [id, this.#summaryGenerations.get(id) ?? 0] as const);
    this.#pendingSummaries.clear();
    this.#summaryDrainInFlight = true;
    const queue = [...entries];
    const workers = Array.from({ length: Math.min(6, queue.length) }, async () => {
      for (;;) {
        const entry = queue.shift();
        if (!entry) return;
        const [id, generation] = entry;
        try {
          await this.#options.loadSummary(id, generation, context);
        } catch (error) {
          if (
            !this.#disposed &&
            requestGeneration === this.#requestGeneration &&
            context.authorityEpoch === this.#context.authorityEpoch &&
            generation === this.#summaryGenerations.get(id)
          )
            this.#options.onError?.(error);
        }
      }
    });
    try {
      await Promise.all(workers);
    } finally {
      this.#summaryDrainInFlight = false;
      if (!this.#disposed && (this.#listPending || this.#pendingSummaries.size > 0)) this.#schedule(0);
    }
  }

  #clearTimer(): void {
    if (this.#timer === null) return;
    this.#options.clearTimer(this.#timer);
    this.#timer = null;
  }
}

function sameContext(left: SessionIndexContext, right: SessionIndexContext): boolean {
  return left.authorityEpoch === right.authorityEpoch && left.viewKey === right.viewKey;
}
