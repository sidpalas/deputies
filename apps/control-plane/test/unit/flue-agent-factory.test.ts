import { RealFlueAgentFactory } from '../../src/runner-flue/agent-factory.js';
import type { SandboxHandle } from '../../src/sandbox/types.js';

describe('RealFlueAgentFactory', () => {
  it('creates a Flue agent backed by the product sandbox handle', async () => {
    const saved = new Map<string, unknown>();
    const agent = await new RealFlueAgentFactory({
      model: false,
      sessionStore: {
        async save(id, data) {
          saved.set(id, data);
        },
        async load(id) {
          return (saved.get(id) as never) ?? null;
        },
        async delete(id) {
          saved.delete(id);
        },
      },
      env: {},
    }).create({
      agentId: 'agent-1',
      sessionId: 'thread-1',
      cwd: '/workspace/project',
      sandbox: createSandboxHandle(),
    });

    await agent.session('thread-1');

    expect(saved.has('agent-session:["deputies","runner","thread-1"]')).toBe(true);
    expect(saved.has('agent-session:["agent-1","agent-1","thread-1"]')).toBe(false);
  });

  it('migrates long Flue affinity keys from the previous adapter', async () => {
    const legacyData = { version: 3, entries: [], leafId: null, metadata: {}, createdAt: 'then', updatedAt: 'then' };
    const saved = new Map<string, unknown>([
      ['agent-session:["agent-1","agent-1","thread-1"]', legacyData],
    ]);
    const agent = await new RealFlueAgentFactory({
      model: false,
      sessionStore: {
        async save(id, data) {
          saved.set(id, data);
        },
        async load(id) {
          return (saved.get(id) as never) ?? null;
        },
        async delete(id) {
          saved.delete(id);
        },
      },
      env: {},
    }).create({
      agentId: 'agent-1',
      sessionId: 'thread-1',
      cwd: '/workspace/project',
      sandbox: createSandboxHandle(),
    });

    await agent.session('thread-1');

    expect(saved.get('agent-session:["deputies","runner","thread-1"]')).toBe(legacyData);
  });
});

function createSandboxHandle(): SandboxHandle {
  return {
    provider: 'test',
    providerSandboxId: 'sandbox-1',
    sessionId: 'session-1',
    workspacePath: '/workspace',
    metadata: {},
    capabilities: {
      persistentFilesystem: true,
      snapshots: false,
      stopStart: false,
      exec: true,
      filesystem: true,
      streamingLogs: false,
      portForwarding: false,
      objectStorageArtifacts: false,
    },
    fs: {
      async readFile() {
        return '';
      },
      async readFileBuffer() {
        return new Uint8Array();
      },
      async writeFile() {},
      async stat() {
        return { isFile: false, isDirectory: false, isSymbolicLink: false, size: 0, mtime: new Date(0) };
      },
      async readdir() {
        return [];
      },
      async exists() {
        return false;
      },
      async mkdir() {},
      async rm() {},
    },
    async exec() {
      return { exitCode: 0, stdout: '', stderr: '', startedAt: new Date(0), completedAt: new Date(0) };
    },
  };
}
