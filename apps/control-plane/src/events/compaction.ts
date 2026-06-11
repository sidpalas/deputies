import {
  runWithOptionalAdvisoryLock,
  startPeriodicTask,
  type AdvisoryLockStore,
  type PeriodicTaskHandle,
} from '../app/periodic-task.js';
import type { EventDeltaCompactionInput } from '../store/types.js';

const eventCompactorLockId = 742_358_003;

export type EventCompactionStore = {
  compactFinalizedAgentTextDeltas(input: EventDeltaCompactionInput): Promise<number>;
};

export type EventCompactorOptions = {
  store: EventCompactionStore & Partial<AdvisoryLockStore>;
  retentionMs: number;
  batchSize?: number;
  intervalMs?: number;
  onError?: (error: unknown) => void;
};

export type EventCompactorHandle = PeriodicTaskHandle;

export async function runEventCompactorOnce(
  options: Pick<EventCompactorOptions, 'store' | 'retentionMs' | 'batchSize'>,
): Promise<number> {
  const run = async () => {
    return options.store.compactFinalizedAgentTextDeltas({
      finalizedBefore: new Date(Date.now() - options.retentionMs),
      limit: options.batchSize ?? 5_000,
    });
  };

  return runWithOptionalAdvisoryLock({ store: options.store, lockId: eventCompactorLockId, run, locked: 0 });
}

export function startEventCompactor(options: EventCompactorOptions): EventCompactorHandle {
  return startPeriodicTask({
    run: () => runEventCompactorOnce(options),
    intervalMs: options.intervalMs,
    onError: options.onError,
  });
}
