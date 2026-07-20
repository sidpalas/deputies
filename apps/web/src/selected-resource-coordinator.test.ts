import { SelectedResourceCoordinator, type SelectedResourceContext } from './selected-resource-coordinator.js';
import type { DetailResource } from './session-event-plan.js';

const context: SelectedResourceContext = { sessionId: 'session-1', authorityEpoch: 1, selectionVersion: 1 };

describe('SelectedResourceCoordinator', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('coalesces repeated resource invalidations into one request', async () => {
    const load = vi.fn().mockResolvedValue(['messages']);
    const apply = vi.fn();
    const coordinator = createCoordinator(load, apply);

    for (let index = 0; index < 10; index += 1) coordinator.invalidate(context, resources('messages'));
    await vi.advanceTimersByTimeAsync(125);

    expect(load).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledWith('messages', context.sessionId);
    expect(apply).toHaveBeenCalledOnce();
  });

  it('eventually flushes a resource during a continuous invalidation burst', async () => {
    const load = vi.fn().mockResolvedValue(['callbacks']);
    const coordinator = createCoordinator(load, vi.fn());

    coordinator.invalidate(context, resources('callbacks'));
    for (let elapsed = 0; elapsed < 500; elapsed += 100) {
      await vi.advanceTimersByTimeAsync(100);
      coordinator.invalidate(context, resources('callbacks'));
    }

    expect(load).toHaveBeenCalled();
  });

  it('discards an in-flight stale response and runs one final request', async () => {
    const first = deferred<unknown>();
    const load = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValueOnce(['current']);
    const apply = vi.fn();
    const coordinator = createCoordinator(load, apply);

    coordinator.invalidate(context, resources('messages'));
    await vi.advanceTimersByTimeAsync(125);
    coordinator.invalidate(context, resources('messages'));
    first.resolve(['stale']);
    await vi.runAllTimersAsync();

    expect(load).toHaveBeenCalledTimes(2);
    expect(apply).toHaveBeenCalledOnce();
    expect(apply.mock.calls[0]?.[1]).toEqual(['current']);
  });

  it('loads different dirty resources independently', async () => {
    const load = vi.fn(async (resource: DetailResource) => [resource]);
    const apply = vi.fn();
    const coordinator = createCoordinator(load, apply);

    coordinator.invalidate(context, resources('messages', 'callbacks', 'services'));
    await vi.advanceTimersByTimeAsync(125);

    expect(load.mock.calls.map(([resource]) => resource)).toEqual(['messages', 'callbacks', 'services']);
    expect(apply).toHaveBeenCalledTimes(3);
  });

  it('allows sibling resources to apply when one request fails', async () => {
    const error = new Error('callbacks unavailable');
    const load = vi.fn((resource: DetailResource) =>
      resource === 'callbacks' ? Promise.reject(error) : Promise.resolve([resource]),
    );
    const apply = vi.fn();
    const onError = vi.fn();
    const coordinator = createCoordinator(load, apply, onError);

    coordinator.invalidate(context, resources('messages', 'callbacks'));
    await vi.advanceTimersByTimeAsync(125);

    expect(apply).toHaveBeenCalledOnce();
    expect(apply.mock.calls[0]?.[0]).toBe('messages');
    expect(onError).toHaveBeenCalledWith(error, 'callbacks');
  });

  it('does not retry a failed resource without a newer invalidation', async () => {
    const load = vi.fn().mockRejectedValue(new Error('unavailable'));
    const coordinator = createCoordinator(load, vi.fn());

    coordinator.invalidate(context, resources('services'));
    await vi.runAllTimersAsync();

    expect(load).toHaveBeenCalledOnce();
  });

  it('makes old responses ineligible after selection changes', async () => {
    const request = deferred<unknown>();
    const load = vi.fn().mockReturnValue(request.promise);
    const apply = vi.fn();
    const coordinator = createCoordinator(load, apply);

    coordinator.invalidate(context, resources('messages'));
    await vi.advanceTimersByTimeAsync(125);
    coordinator.setContext({ ...context, sessionId: 'session-2', selectionVersion: 2 });
    request.resolve(['stale']);
    await Promise.resolve();

    expect(apply).not.toHaveBeenCalled();
  });

  it('clears pending work after authority changes', async () => {
    const load = vi.fn().mockResolvedValue([]);
    const coordinator = createCoordinator(load, vi.fn());

    coordinator.invalidate(context, resources('messages'));
    coordinator.setContext({ ...context, authorityEpoch: 2 });
    await vi.runAllTimersAsync();

    expect(load).not.toHaveBeenCalled();
  });

  it('makes an in-flight response stale when a direct update supersedes it', async () => {
    const request = deferred<unknown>();
    const load = vi.fn().mockReturnValue(request.promise);
    const apply = vi.fn();
    const coordinator = createCoordinator(load, apply);

    coordinator.invalidate(context, resources('services'));
    await vi.advanceTimersByTimeAsync(125);
    coordinator.supersede(context, resources('services'));
    request.resolve(['stale service']);
    await Promise.resolve();

    expect(apply).not.toHaveBeenCalled();
    expect(load).toHaveBeenCalledOnce();
  });

  it('reports only pending or in-flight resources displaced by supersession', async () => {
    const request = deferred<unknown>();
    const load = vi.fn().mockReturnValue(request.promise);
    const coordinator = createCoordinator(load, vi.fn());

    coordinator.invalidate(context, resources('messages', 'services'));
    await vi.advanceTimersByTimeAsync(125);

    expect(coordinator.supersede(context, resources('messages', 'services', 'callbacks'))).toEqual(
      resources('messages', 'services'),
    );
    request.resolve([]);
  });

  it('does not postpone a ready resource when only an in-flight resource is invalidated', async () => {
    const messagesRequest = deferred<unknown>();
    const load = vi.fn((resource: DetailResource) =>
      resource === 'messages' ? messagesRequest.promise : Promise.resolve([resource]),
    );
    const coordinator = createCoordinator(load, vi.fn());

    coordinator.invalidate(context, resources('messages'));
    await vi.advanceTimersByTimeAsync(125);
    coordinator.invalidate(context, resources('callbacks'));
    await vi.advanceTimersByTimeAsync(100);
    coordinator.invalidate(context, resources('messages'));
    await vi.advanceTimersByTimeAsync(25);

    expect(load).toHaveBeenCalledWith('callbacks', context.sessionId);
    messagesRequest.resolve([]);
  });
});

function createCoordinator(
  load: (resource: DetailResource, sessionId: string) => Promise<unknown>,
  apply: (resource: DetailResource, value: unknown, context: SelectedResourceContext) => void,
  onError: (error: unknown, resource: DetailResource) => void = vi.fn(),
): SelectedResourceCoordinator {
  const coordinator = new SelectedResourceCoordinator({ load, apply, onError });
  coordinator.setContext(context);
  return coordinator;
}

function resources(...values: DetailResource[]): ReadonlySet<DetailResource> {
  return new Set(values);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}
