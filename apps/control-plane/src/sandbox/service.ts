import { randomUUID } from 'node:crypto';
import type { EventService } from '../events/service.js';
import type { SandboxRecord, SandboxStore } from '../store/types.js';
import { withNewSandboxRuntime, withSandboxRuntimeMetadata } from './runtime.js';
import type { SandboxHandle, SandboxProvider } from './types.js';

export type EnsureSandboxResult = {
  sandbox: SandboxHandle;
  record: SandboxRecord;
  created: boolean;
  restarted: boolean;
};

export class SandboxLifecycleService {
  constructor(
    private readonly store: SandboxStore,
    private readonly provider: SandboxProvider,
  ) {}

  async ensure(sessionId: string): Promise<EnsureSandboxResult> {
    const existing = await this.store.getActiveSandbox(sessionId, this.provider.name);
    if (existing) {
      const connected = await this.tryConnect(existing);
      if (connected) return { ...connected, created: false };
    }

    const sandbox = await this.provider.create({ sessionId });
    let record: SandboxRecord;
    try {
      const now = new Date();
      const metadata = withSandboxRuntimeMetadata(sandbox.metadata);
      record = await this.store.createSandbox({
        id: randomUUID(),
        sessionId,
        provider: this.provider.name,
        providerSandboxId: sandbox.providerSandboxId,
        status: 'ready',
        workspacePath: sandbox.workspacePath,
        metadata,
        createdAt: now,
        updatedAt: now,
      });
    } catch (error) {
      await this.provider.destroy(sandbox).catch(() => undefined);
      throw error;
    }

    return { sandbox: { ...sandbox, metadata: record.metadata }, record, created: true, restarted: false };
  }

  private async tryConnect(record: SandboxRecord): Promise<Omit<EnsureSandboxResult, 'created'> | null> {
    const checkedAt = new Date();
    const health = await this.provider.health(record);
    let restarted = record.status === 'stopped';
    const checkedRecord: SandboxRecord = {
      ...record,
      status: health.status === 'ready' ? 'ready' : health.status === 'stopped' ? 'stopped' : 'unhealthy',
      lastHealthCheckAt: checkedAt,
      updatedAt: checkedAt,
    };
    await this.store.updateSandbox(checkedRecord);

    if (health.status === 'stopped') {
      if (!this.provider.start) return null;
      await this.provider.start(record);
      restarted = true;
    } else if (health.status !== 'ready') {
      return null;
    }

    try {
      const sandbox = await this.provider.connect({
        providerSandboxId: record.providerSandboxId,
        sessionId: record.sessionId,
        metadata: record.metadata,
      });
      const baseRecord = restarted ? withNewSandboxRuntime(checkedRecord) : checkedRecord;
      const updated = await this.store.updateSandbox({
        ...baseRecord,
        status: 'ready',
        workspacePath: sandbox.workspacePath,
        metadata: { ...sandbox.metadata, ...baseRecord.metadata },
        updatedAt: new Date(),
      });
      return { sandbox: { ...sandbox, metadata: updated.metadata }, record: updated, restarted };
    } catch {
      await this.store.updateSandbox({
        ...checkedRecord,
        status: 'unhealthy',
        updatedAt: new Date(),
      });
      return null;
    }
  }
}

export type SandboxCleanupResult = {
  destroyed: number;
  stopped: number;
  failed: number;
};

export type SandboxKeepaliveResult = {
  record: SandboxRecord;
  keepaliveUntil: Date;
  providerSync: 'not_supported' | 'ok' | 'failed';
};

export class SandboxKeepaliveService {
  constructor(
    private readonly store: SandboxStore,
    private readonly events: EventService,
    private readonly provider: SandboxProvider,
  ) {}

  async extend(input: {
    sessionId: string;
    durationMs: number;
    maxDurationMs: number;
    port?: number;
  }): Promise<SandboxKeepaliveResult | null> {
    const sandbox = await this.store.getActiveSandbox(input.sessionId, this.provider.name);
    if (!sandbox || sandbox.status !== 'ready') return null;

    const durationMs = input.durationMs;
    const now = new Date();
    const baseTime = sandbox.keepaliveUntil && sandbox.keepaliveUntil > now ? sandbox.keepaliveUntil.getTime() : now.getTime();
    const maxUntilMs = now.getTime() + input.maxDurationMs;
    const requestedUntilMs = baseTime + durationMs;
    const keepaliveUntil = new Date(Math.min(requestedUntilMs, maxUntilMs));
    const updated = await this.store.updateSandbox({
      ...sandbox,
      keepaliveUntil,
      updatedAt: now,
    });
    const providerSync = await this.syncProviderKeepalive(updated, durationMs);
    await this.events.append({
      sessionId: sandbox.sessionId,
      type: 'sandbox_keepalive_extended',
      payload: {
        reason: 'manual_extend',
        provider: sandbox.provider,
        providerSandboxId: sandbox.providerSandboxId,
        keepaliveUntil: updated.keepaliveUntil!.toISOString(),
        extendedBySeconds: Math.ceil(durationMs / 1000),
        providerSync,
        ...(input.port ? { port: input.port } : {}),
      },
    });
    return { record: updated, keepaliveUntil: updated.keepaliveUntil!, providerSync };
  }

  private async syncProviderKeepalive(record: SandboxRecord, durationMs: number): Promise<SandboxKeepaliveResult['providerSync']> {
    if (!this.provider.refreshKeepalive) return 'not_supported';
    try {
      await this.provider.refreshKeepalive({
        providerSandboxId: record.providerSandboxId,
        sessionId: record.sessionId,
        durationMs,
      });
      return 'ok';
    } catch {
      return 'failed';
    }
  }
}

export class SandboxCleanupService {
  constructor(
    private readonly store: SandboxStore,
    private readonly events: EventService,
    private readonly provider: SandboxProvider,
  ) {}

  async destroySessionSandboxes(sessionId: string): Promise<SandboxCleanupResult> {
    const sandboxes = await this.store.listActiveSandboxes(sessionId, this.provider.name);
    const result = await this.destroySandboxes(sandboxes, 'archive', { respectKeepalive: false });
    return { ...result, stopped: 0 };
  }

  async destroyIdleSandboxes(input: { idleBefore: Date; limit: number }): Promise<SandboxCleanupResult> {
    const sandboxes = await this.store.listIdleSandboxes({
      provider: this.provider.name,
      idleBefore: input.idleBefore,
      limit: input.limit,
    });
    const result = await this.destroySandboxes(sandboxes, 'idle_reaper', { respectKeepalive: true });
    return { ...result, stopped: 0 };
  }

  async stopIdleSandboxes(input: { idleBefore: Date; limit: number }): Promise<SandboxCleanupResult> {
    if (!this.provider.stop) return { destroyed: 0, stopped: 0, failed: 0 };
    const sandboxes = await this.store.listStoppableSandboxes({
      provider: this.provider.name,
      idleBefore: input.idleBefore,
      limit: input.limit,
    });
    return this.stopSandboxes(sandboxes, 'idle_stop');
  }

  private async stopSandboxes(sandboxes: SandboxRecord[], reason: string): Promise<SandboxCleanupResult> {
    let stopped = 0;
    let failed = 0;

    for (const sandbox of sandboxes) {
      try {
        const current = await this.currentActiveSandbox(sandbox);
        if (!current || isKeepaliveActive(current)) continue;
        await this.provider.stop?.(current);
        const stoppedAt = new Date();
        await this.store.updateSandbox({ ...current, status: 'stopped', updatedAt: stoppedAt });
        await this.events.append({
          sessionId: current.sessionId,
          type: 'sandbox_stopped',
          payload: { reason, provider: current.provider, providerSandboxId: current.providerSandboxId },
        });
        stopped += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown sandbox stop error';
        await this.events.append({
          sessionId: sandbox.sessionId,
          type: 'sandbox_stop_failed',
          payload: { reason, provider: sandbox.provider, providerSandboxId: sandbox.providerSandboxId, error: message },
        });
        failed += 1;
      }
    }

    return { destroyed: 0, stopped, failed };
  }

  private async destroySandboxes(
    sandboxes: SandboxRecord[],
    reason: string,
    options: { respectKeepalive: boolean },
  ): Promise<Omit<SandboxCleanupResult, 'stopped'>> {
    let destroyed = 0;
    let failed = 0;

    for (const sandbox of sandboxes) {
      try {
        const current = await this.currentActiveSandbox(sandbox);
        if (!current || (options.respectKeepalive && isKeepaliveActive(current))) continue;
        await this.provider.destroy(current);
        const destroyedAt = new Date();
        await this.store.updateSandbox({
          ...current,
          status: 'destroyed',
          updatedAt: destroyedAt,
          destroyedAt,
        });
        await this.events.append({
          sessionId: current.sessionId,
          type: 'sandbox_destroyed',
          payload: {
            reason,
            provider: current.provider,
            providerSandboxId: current.providerSandboxId,
          },
        });
        destroyed += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown sandbox destroy error';
        await this.events.append({
          sessionId: sandbox.sessionId,
          type: 'sandbox_destroy_failed',
          payload: {
            reason,
            provider: sandbox.provider,
            providerSandboxId: sandbox.providerSandboxId,
            error: message,
          },
        });
        failed += 1;
      }
    }

    return { destroyed, failed };
  }

  private async currentActiveSandbox(sandbox: SandboxRecord): Promise<SandboxRecord | null> {
    const current = (await this.store.listActiveSandboxes(sandbox.sessionId, sandbox.provider)).find(
      (candidate) => candidate.id === sandbox.id,
    );
    return current ?? null;
  }
}

function isKeepaliveActive(sandbox: SandboxRecord): boolean {
  return Boolean(sandbox.keepaliveUntil && sandbox.keepaliveUntil > new Date());
}
