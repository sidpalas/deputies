import { SandboxCleanupService } from './service.js';

const sandboxReaperLockId = 742_358_001;

export type AdvisoryLockStore = {
  withAdvisoryLock<T>(lockId: number, fn: () => Promise<T>): Promise<T | null>;
};

export type SandboxReaperOptions = {
  cleanup: SandboxCleanupService;
  store: unknown;
  stopDelayMs: number;
  retentionMs: number;
  batchSize?: number;
  intervalMs?: number;
  onError?: (error: unknown) => void;
};

export type SandboxReaperHandle = {
  stop(): Promise<void>;
  close(): Promise<void>;
};

export async function runSandboxReaperOnce(options: Pick<SandboxReaperOptions, 'cleanup' | 'store' | 'stopDelayMs' | 'retentionMs' | 'batchSize'>): Promise<number> {
  const run = async () => {
    const stopResult = await options.cleanup.stopIdleSandboxes({
      idleBefore: new Date(Date.now() - options.stopDelayMs),
      limit: options.batchSize ?? 25,
    });
    const destroyResult = await options.cleanup.destroyIdleSandboxes({
      idleBefore: new Date(Date.now() - options.retentionMs),
      limit: options.batchSize ?? 25,
    });
    return stopResult.stopped + destroyResult.destroyed;
  };

  if (hasAdvisoryLock(options.store)) return (await options.store.withAdvisoryLock(sandboxReaperLockId, run)) ?? 0;
  return run();
}

export function startSandboxReaper(options: SandboxReaperOptions): SandboxReaperHandle {
  let stopped = false;
  let inFlight: Promise<void> | null = null;

  const tick = () => {
    if (stopped || inFlight) return;
    inFlight = runSandboxReaperOnce(options)
      .then(() => {})
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

function hasAdvisoryLock(store: unknown): store is AdvisoryLockStore {
  return Boolean(store && typeof store === 'object' && 'withAdvisoryLock' in store && typeof (store as AdvisoryLockStore).withAdvisoryLock === 'function');
}
