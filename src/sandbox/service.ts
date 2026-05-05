import { randomUUID } from 'node:crypto';
import type { AppStore, SandboxRecord } from '../store/types.js';
import type { SandboxHandle, SandboxProvider } from './types.js';

export type EnsureSandboxResult = {
  sandbox: SandboxHandle;
  record: SandboxRecord;
  created: boolean;
};

export class SandboxLifecycleService {
  constructor(
    private readonly store: AppStore,
    private readonly provider: SandboxProvider,
  ) {}

  async ensure(sessionId: string): Promise<EnsureSandboxResult> {
    const existing = await this.store.getActiveSandbox(sessionId, this.provider.name);
    if (existing) {
      const connected = await this.tryConnect(existing);
      if (connected) return { ...connected, created: false };
    }

    const sandbox = await this.provider.create({ sessionId });
    const now = new Date();
    const record = await this.store.createSandbox({
      id: randomUUID(),
      sessionId,
      provider: this.provider.name,
      providerSandboxId: sandbox.providerSandboxId,
      status: 'ready',
      workspacePath: sandbox.workspacePath,
      metadata: sandbox.metadata,
      createdAt: now,
      updatedAt: now,
    });

    return { sandbox, record, created: true };
  }

  private async tryConnect(record: SandboxRecord): Promise<Omit<EnsureSandboxResult, 'created'> | null> {
    const checkedAt = new Date();
    const health = await this.provider.health(record);
    const checkedRecord: SandboxRecord = {
      ...record,
      status: health.status === 'ready' ? 'ready' : 'unhealthy',
      lastHealthCheckAt: checkedAt,
      updatedAt: checkedAt,
    };
    await this.store.updateSandbox(checkedRecord);

    if (health.status !== 'ready') return null;

    try {
      const sandbox = await this.provider.connect({
        providerSandboxId: record.providerSandboxId,
        sessionId: record.sessionId,
        metadata: record.metadata,
      });
      const updated = await this.store.updateSandbox({
        ...checkedRecord,
        status: 'ready',
        workspacePath: sandbox.workspacePath,
        metadata: { ...record.metadata, ...sandbox.metadata },
        updatedAt: new Date(),
      });
      return { sandbox, record: updated };
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
