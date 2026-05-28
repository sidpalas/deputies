import type { Server } from 'node:http';
import { logger } from '../observability/logger.js';
import type { WorkerLoopHandle } from '../worker/service.js';

export type CloseableResource = {
  close(): Promise<void> | void;
};

export type AppLifecycleOptions = {
  server?: Server;
  workerLoop?: WorkerLoopHandle;
  resources?: CloseableResource[];
  shutdownTimeoutMs?: number;
  onError?: (error: unknown) => void;
};

export class AppLifecycle {
  private shuttingDown = false;

  constructor(private readonly options: AppLifecycleOptions) {}

  async shutdown(reason = 'shutdown'): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;

    await withTimeout(this.close(reason), this.options.shutdownTimeoutMs ?? 10_000);
  }

  private async close(reason: string): Promise<void> {
    const errors: unknown[] = [];

    if (this.options.server) {
      try {
        await closeServer(this.options.server);
      } catch (error) {
        errors.push(error);
      }
    }

    if (this.options.workerLoop) {
      try {
        await this.options.workerLoop.stop();
      } catch (error) {
        errors.push(error);
      }
    }

    for (const resource of this.options.resources ?? []) {
      try {
        await resource.close();
      } catch (error) {
        errors.push(error);
      }
    }

    for (const error of errors) this.options.onError?.(error);
    if (errors.length > 0) throw new AggregateError(errors, `Shutdown failed during ${reason}`);
  }
}

export function installProcessShutdownHandlers(lifecycle: AppLifecycle): void {
  const shutdown = (signal: NodeJS.Signals) => {
    lifecycle
      .shutdown(signal)
      .then(() => {
        process.exitCode = 0;
      })
      .catch((error: unknown) => {
        logger.error({ err: error }, 'Process shutdown failed');
        process.exitCode = 1;
      });
  };

  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Shutdown timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
