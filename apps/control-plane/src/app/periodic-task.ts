export type AdvisoryLockStore = {
  withAdvisoryLock<T>(lockId: number, fn: () => Promise<T>): Promise<T | null>;
};

export type PeriodicTaskHandle = {
  stop(): Promise<void>;
  close(): Promise<void>;
};

export type PeriodicTaskOptions = {
  run(): Promise<unknown>;
  intervalMs?: number | undefined;
  onError?: ((error: unknown) => void) | undefined;
};

export async function runWithOptionalAdvisoryLock<T>(options: {
  store: object & Partial<AdvisoryLockStore>;
  lockId: number;
  run(): Promise<T>;
  locked: T;
}): Promise<T> {
  if (!options.store.withAdvisoryLock) return options.run();
  return (await options.store.withAdvisoryLock(options.lockId, () => options.run())) ?? options.locked;
}

export function startPeriodicTask(options: PeriodicTaskOptions): PeriodicTaskHandle {
  let stopped = false;
  let inFlight: Promise<unknown> | null = null;

  const tick = () => {
    if (stopped || inFlight) return;
    inFlight = options
      .run()
      .catch((error: unknown) => {
        options.onError?.(error);
      })
      .finally(() => {
        inFlight = null;
      });
  };

  const timer = setInterval(tick, options.intervalMs ?? 60_000);
  tick();

  const stop = async (): Promise<void> => {
    stopped = true;
    clearInterval(timer);
    await inFlight;
  };

  return {
    stop,
    close: stop,
  };
}
