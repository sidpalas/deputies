import type { DetailResource } from './session-event-plan.js';

export type SelectedResourceContext = {
  sessionId: string;
  authorityEpoch: number;
  selectionVersion: number;
};

type CoordinatorOptions = {
  delayMs?: number;
  load: (resource: DetailResource, sessionId: string) => Promise<unknown>;
  apply: (resource: DetailResource, value: unknown, context: SelectedResourceContext) => void;
  onError?: (error: unknown, resource: DetailResource) => void;
  setTimer?: (callback: () => void, delayMs: number) => number;
  clearTimer?: (timer: number) => void;
};

export class SelectedResourceCoordinator {
  readonly #delayMs: number;
  readonly #load: CoordinatorOptions['load'];
  readonly #apply: CoordinatorOptions['apply'];
  readonly #onError: NonNullable<CoordinatorOptions['onError']>;
  readonly #setTimer: NonNullable<CoordinatorOptions['setTimer']>;
  readonly #clearTimer: NonNullable<CoordinatorOptions['clearTimer']>;
  #context: SelectedResourceContext = { sessionId: '', authorityEpoch: 0, selectionVersion: 0 };
  #pending = new Set<DetailResource>();
  #versions = new Map<DetailResource, number>();
  #inFlight = new Map<DetailResource, symbol>();
  #timer: number | null = null;
  #disposed = false;

  constructor(options: CoordinatorOptions) {
    this.#delayMs = options.delayMs ?? 125;
    this.#load = options.load;
    this.#apply = options.apply;
    this.#onError = options.onError ?? (() => undefined);
    this.#setTimer = options.setTimer ?? ((callback, delayMs) => window.setTimeout(callback, delayMs));
    this.#clearTimer = options.clearTimer ?? ((timer) => window.clearTimeout(timer));
  }

  setContext(context: SelectedResourceContext): void {
    if (sameContext(this.#context, context)) return;
    this.#context = context;
    this.#pending.clear();
    this.#versions.clear();
    this.#inFlight.clear();
    this.#clearScheduledFlush();
  }

  invalidate(context: SelectedResourceContext, resources: ReadonlySet<DetailResource>): void {
    if (this.#disposed || !context.sessionId || resources.size === 0) return;
    if (!sameContext(this.#context, context)) return;

    let hasReadyInvalidation = false;
    for (const resource of resources) {
      this.#versions.set(resource, (this.#versions.get(resource) ?? 0) + 1);
      this.#pending.add(resource);
      if (!this.#inFlight.has(resource)) hasReadyInvalidation = true;
    }
    if (hasReadyInvalidation) this.#scheduleFlush(this.#delayMs);
  }

  supersede(context: SelectedResourceContext, resources: ReadonlySet<DetailResource>): ReadonlySet<DetailResource> {
    const displaced = new Set<DetailResource>();
    if (this.#disposed || !context.sessionId || resources.size === 0) return displaced;
    if (!sameContext(this.#context, context)) return displaced;

    for (const resource of resources) {
      if (this.#pending.has(resource) || this.#inFlight.has(resource)) displaced.add(resource);
      this.#versions.set(resource, (this.#versions.get(resource) ?? 0) + 1);
      this.#pending.delete(resource);
    }
    if (!this.#hasReadyResource()) this.#clearScheduledFlush();
    return displaced;
  }

  captureVersion(context: SelectedResourceContext, resource: DetailResource): number {
    if (!sameContext(this.#context, context)) return -1;
    return this.#versions.get(resource) ?? 0;
  }

  isVersionCurrent(context: SelectedResourceContext, resource: DetailResource, version: number): boolean {
    return !this.#disposed && sameContext(this.#context, context) && (this.#versions.get(resource) ?? 0) === version;
  }

  dispose(): void {
    this.#disposed = true;
    this.#pending.clear();
    this.#versions.clear();
    this.#inFlight.clear();
    this.#clearScheduledFlush();
  }

  #scheduleFlush(delayMs: number, trailing = false): void {
    if (this.#disposed || !this.#hasReadyResource()) return;
    if (trailing) this.#clearScheduledFlush();
    if (this.#timer !== null) return;
    this.#timer = this.#setTimer(() => {
      this.#timer = null;
      this.#flush();
    }, delayMs);
  }

  #flush(): void {
    if (this.#disposed) return;
    const resources = [...this.#pending].filter((resource) => !this.#inFlight.has(resource));
    for (const resource of resources) {
      this.#pending.delete(resource);
      this.#start(resource);
    }
  }

  #start(resource: DetailResource): void {
    const operation = Symbol(resource);
    const context = { ...this.#context };
    const version = this.#versions.get(resource) ?? 0;
    this.#inFlight.set(resource, operation);

    void this.#load(resource, context.sessionId)
      .then((value) => {
        if (!this.#isCurrent(resource, operation, context, version)) return;
        this.#apply(resource, value, context);
      })
      .catch((error: unknown) => {
        if (this.#isCurrent(resource, operation, context, version)) this.#onError(error, resource);
      })
      .finally(() => {
        if (this.#inFlight.get(resource) !== operation) return;
        this.#inFlight.delete(resource);
        this.#scheduleFlush(0, true);
      });
  }

  #isCurrent(resource: DetailResource, operation: symbol, context: SelectedResourceContext, version: number): boolean {
    return (
      !this.#disposed &&
      this.#inFlight.get(resource) === operation &&
      sameContext(this.#context, context) &&
      this.#versions.get(resource) === version
    );
  }

  #hasReadyResource(): boolean {
    return [...this.#pending].some((resource) => !this.#inFlight.has(resource));
  }

  #clearScheduledFlush(): void {
    if (this.#timer === null) return;
    this.#clearTimer(this.#timer);
    this.#timer = null;
  }
}

function sameContext(left: SelectedResourceContext, right: SelectedResourceContext): boolean {
  return (
    left.sessionId === right.sessionId &&
    left.authorityEpoch === right.authorityEpoch &&
    left.selectionVersion === right.selectionVersion
  );
}
