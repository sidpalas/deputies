import { SessionIndexCoordinator, type SessionIndexContext } from './session-index-coordinator.js';

const context: SessionIndexContext = { authorityEpoch: 1, viewKey: 'active:q=:tags=' };

describe('SessionIndexCoordinator', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('coalesces summary invalidations with a trailing debounce', async () => {
    const summary = vi.fn().mockResolvedValue(undefined);
    const coordinator = create(summary);
    coordinator.invalidate('s1', 'summary', true, false);
    await vi.advanceTimersByTimeAsync(100);
    coordinator.invalidate('s1', 'summary', true, false);
    await vi.advanceTimersByTimeAsync(124);
    expect(summary).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(summary).toHaveBeenCalledOnce();
  });

  it.each([
    { loaded: false, filters: false },
    { loaded: true, filters: true },
  ])('upgrades summary to list for $loaded/$filters membership context', async ({ loaded, filters }) => {
    const list = vi.fn().mockResolvedValue({ satisfiedIds: new Set(['s1']) });
    const coordinator = create(vi.fn(), list);
    coordinator.invalidate('s1', 'summary', loaded, filters);
    await vi.runAllTimersAsync();
    expect(list).toHaveBeenCalledOnce();
  });

  it('retains a newer summary invalidation behind an in-flight list', async () => {
    const first = deferred<void>();
    const list = vi
      .fn()
      .mockReturnValueOnce(first.promise.then(() => ({ satisfiedIds: new Set(['s1']) })))
      .mockResolvedValue({ satisfiedIds: new Set(['s1']) });
    const summary = vi.fn().mockResolvedValue(undefined);
    const coordinator = create(summary, list);
    coordinator.invalidate('s1', 'list', true, false);
    await vi.advanceTimersByTimeAsync(125);
    coordinator.invalidate('s1', 'summary', true, false);
    coordinator.invalidate('s1', 'summary', true, false);
    first.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await vi.runAllTimersAsync();
    expect(list).toHaveBeenCalledOnce();
    expect(summary).toHaveBeenCalledOnce();
  });

  it('reconciles a loaded row when the authoritative list does not represent it', async () => {
    const summary = vi.fn().mockResolvedValue(undefined);
    const list = vi.fn().mockResolvedValue({ satisfiedIds: new Set<string>() });
    const coordinator = create(summary, list);
    coordinator.invalidate('archived-row', 'list', true, false);

    await vi.runAllTimersAsync();

    expect(list).toHaveBeenCalledOnce();
    expect(summary).toHaveBeenCalledOnce();
    expect(summary).toHaveBeenCalledWith('archived-row', 1, context);
  });

  it('bounds summary reconciliation concurrency across invalidation waves', async () => {
    const pending: Array<ReturnType<typeof deferred<void>>> = [];
    let active = 0;
    let maxActive = 0;
    const summary = vi.fn(() => {
      const request = deferred<void>();
      pending.push(request);
      active += 1;
      maxActive = Math.max(maxActive, active);
      return request.promise.finally(() => {
        active -= 1;
      });
    });
    const coordinator = create(summary);
    for (let index = 0; index < 6; index += 1) {
      coordinator.invalidate(`s${index}`, 'summary', true, false);
    }

    await vi.advanceTimersByTimeAsync(125);
    expect(summary).toHaveBeenCalledTimes(6);
    for (let index = 6; index < 12; index += 1) {
      coordinator.invalidate(`s${index}`, 'summary', true, false);
    }
    await vi.runAllTimersAsync();
    expect(summary).toHaveBeenCalledTimes(6);
    for (const request of pending.splice(0)) request.resolve();
    await vi.runAllTimersAsync();
    expect(summary).toHaveBeenCalledTimes(12);
    expect(maxActive).toBe(6);
    for (const request of pending) request.resolve();
    await vi.runAllTimersAsync();
  });

  it('runs exactly one final list after structural invalidations during flight', async () => {
    const first = deferred<void>();
    const list = vi
      .fn()
      .mockReturnValueOnce(first.promise.then(() => ({ satisfiedIds: new Set() })))
      .mockResolvedValue({ satisfiedIds: new Set() });
    const coordinator = create(vi.fn(), list);
    coordinator.invalidate('s1', 'list', true, false);
    await vi.advanceTimersByTimeAsync(125);
    coordinator.invalidate('s1', 'list', true, false);
    coordinator.invalidate('s2', 'list', true, false);
    first.resolve();
    await vi.runAllTimersAsync();
    expect(list).toHaveBeenCalledTimes(2);
    expect(coordinator.diagnostics().queuedReruns).toBe(1);
  });

  it('resets context, rejects stale tickets, and disposes pending work', async () => {
    const coordinator = create(vi.fn());
    const ticket = coordinator.captureTicket('page:cursor')!;
    coordinator.setContext({ authorityEpoch: 2, viewKey: 'active' });
    expect(coordinator.isTicketCurrent(ticket)).toBe(false);
    coordinator.invalidate('s1', 'summary', true, false);
    coordinator.dispose();
    await vi.runAllTimersAsync();
  });

  it('rejects rows invalidated after a page ticket, including previously unseen rows', () => {
    const coordinator = create(vi.fn());
    const ticket = coordinator.captureTicket('page:c1')!;
    coordinator.invalidate('new-row', 'summary', false, false);
    expect(coordinator.isRowCurrent(ticket, 'new-row')).toBe(false);
  });

  it('owns cursor requests synchronously until released', () => {
    const coordinator = create(vi.fn());
    const ticket = coordinator.captureTicket('children:p1:c1')!;
    expect(ticket).not.toBeNull();
    expect(coordinator.captureTicket('children:p1:c1')).toBeNull();
    coordinator.release(ticket);
    expect(coordinator.captureTicket('children:p1:c1')).not.toBeNull();
  });

  it('does not let an old release clear a superseding view lease', () => {
    const coordinator = create(vi.fn());
    const oldTicket = coordinator.captureTicket('search:first', 'query=a')!;
    const nextTicket = coordinator.captureTicket('search:first', 'query=a&starred=true')!;
    coordinator.release(oldTicket);
    expect(coordinator.isTicketCurrent(nextTicket)).toBe(true);
    expect(coordinator.captureTicket('search:first', 'query=a&starred=true')).toBeNull();
  });

  it('validates and satisfies direct summaries only in their generation and context', () => {
    const coordinator = create(vi.fn());
    coordinator.invalidate('s1', 'summary', true, false);
    expect(coordinator.satisfyDirectSummary('s1', 1, context)).toBe(true);
    expect(coordinator.satisfyDirectSummary('s1', 0, context)).toBe(false);
    coordinator.setContext({ authorityEpoch: 2, viewKey: 'active' });
    expect(coordinator.satisfyDirectSummary('s1', 1, context)).toBe(false);
  });
});

function create(
  summary: (sessionId: string, generation: number, context: SessionIndexContext) => Promise<void>,
  list: (ticket: unknown) => Promise<{ satisfiedIds: ReadonlySet<string> }> = vi
    .fn()
    .mockResolvedValue({ satisfiedIds: new Set() }),
) {
  const coordinator = new SessionIndexCoordinator({ loadList: list, loadSummary: summary });
  coordinator.setContext(context);
  return coordinator;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}
