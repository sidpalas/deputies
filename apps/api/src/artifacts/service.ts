import { randomUUID } from 'node:crypto';
import type { EventService } from '../events/service.js';
import type { RunnerResult } from '../runner/types.js';
import type { ArtifactRecord, CreateArtifactRecord } from '../store/types.js';

type ArtifactStore = {
  createArtifact(record: CreateArtifactRecord): Promise<ArtifactRecord>;
};

export class ArtifactService {
  constructor(
    private readonly store: ArtifactStore,
    private readonly events: EventService,
  ) {}

  async recordRunArtifacts(input: {
    sessionId: string;
    runId: string;
    messageId: string;
    result: RunnerResult;
  }): Promise<ArtifactRecord[]> {
    const artifacts = input.result.artifacts ?? [];
    const records: ArtifactRecord[] = [];

    for (const artifact of artifacts) {
      const create = {
        id: randomUUID(),
        sessionId: input.sessionId,
        runId: input.runId,
        messageId: input.messageId,
        type: artifact.type,
        payload: artifact.payload ?? {},
        createdAt: new Date(),
      };
      if (artifact.url) Object.assign(create, { url: artifact.url });
      const record = await this.store.createArtifact(create);
      records.push(record);
      await this.events.append({
        sessionId: input.sessionId,
        runId: input.runId,
        messageId: input.messageId,
        type: 'artifact_created',
        payload: { artifact: record },
      });
    }

    return records;
  }
}
