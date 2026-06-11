import {
  runWithOptionalAdvisoryLock,
  startPeriodicTask,
  type AdvisoryLockStore,
  type PeriodicTaskHandle,
} from '../app/periodic-task.js';
import { SandboxCleanupService } from './service.js';

const sandboxReaperLockId = 742_358_001;

export type SandboxReaperOptions = {
  cleanup: SandboxCleanupService;
  store: object & Partial<AdvisoryLockStore>;
  stopDelayMs: number;
  retentionMs: number;
  batchSize?: number;
  intervalMs?: number;
  onError?: (error: unknown) => void;
};

export type SandboxReaperHandle = PeriodicTaskHandle;

export async function runSandboxReaperOnce(
  options: Pick<SandboxReaperOptions, 'cleanup' | 'store' | 'stopDelayMs' | 'retentionMs' | 'batchSize'>,
): Promise<number> {
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

  return runWithOptionalAdvisoryLock({ store: options.store, lockId: sandboxReaperLockId, run, locked: 0 });
}

export function startSandboxReaper(options: SandboxReaperOptions): SandboxReaperHandle {
  return startPeriodicTask({
    run: () => runSandboxReaperOnce(options),
    intervalMs: options.intervalMs,
    onError: options.onError,
  });
}
