import { registerApiProvider, registerProvider } from '@flue/runtime';
import { randomUUID } from 'node:crypto';
import { RealFlueAgentFactory } from '../../src/runner-flue/agent-factory.js';
import type { SandboxHandle } from '../../src/sandbox/types.js';

const FLUE_SESSION_AFFINITY_KEY_PATTERN = /^aff_[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

describe('RealFlueAgentFactory', () => {
  it('does not capture process env by default', () => {
    const originalSecret = process.env.GITHUB_OAUTH_CLIENT_SECRET;
    process.env.GITHUB_OAUTH_CLIENT_SECRET = 'host-secret';
    try {
      const factory = new RealFlueAgentFactory({ model: false });

      expect((factory as unknown as { env: Record<string, unknown> }).env).toEqual({});
    } finally {
      if (originalSecret === undefined) delete process.env.GITHUB_OAUTH_CLIENT_SECRET;
      else process.env.GITHUB_OAUTH_CLIENT_SECRET = originalSecret;
    }
  });

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

  it('migrates valid legacy Flue session keys to the current storage key', async () => {
    const legacyData = {
      version: 5,
      affinityKey: 'aff_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      entries: [],
      leafId: null,
      metadata: {},
      createdAt: 'then',
      updatedAt: 'then',
    };
    const saved = new Map<string, unknown>([['agent-session:["agent-1","agent-1","thread-1"]', legacyData]]);
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

  it('starts a fresh Flue session when persisted pre-upgrade state is unsupported', async () => {
    const provider = `faux-${randomUUID()}`;
    const modelId = 'fresh-start';
    const registration = registerRuntimeFauxProvider({ provider, modelId });
    const preUpgradeData = {
      version: 4,
      entries: [],
      leafId: null,
      metadata: {},
      createdAt: 'then',
      updatedAt: 'then',
    };
    const saved = new Map<string, unknown>([['agent-session:["deputies","runner","thread-1"]', preUpgradeData]]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    registration.setResponses([assistantText('fresh answer')]);

    try {
      const agent = await new RealFlueAgentFactory({
        model: `${provider}/${modelId}`,
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

      const result = await (await agent.session('thread-1')).prompt('Continue the conversation.');

      expect(result.text).toBe('fresh answer');
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('thread-1'));
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('Deputies session history is unaffected'));
      expect(saved.get('agent-session:["deputies","runner","thread-1"]')).toMatchObject({
        version: 5,
        affinityKey: expect.stringMatching(FLUE_SESSION_AFFINITY_KEY_PATTERN),
      });
    } finally {
      warn.mockRestore();
    }
  });

  it('keeps nested default-subagent task affinity keys within the Codex cache limit', async () => {
    const provider = `faux-${randomUUID()}`;
    const modelId = 'task-default';
    const registration = registerRuntimeFauxProvider({ provider, modelId });
    const saved = new Map<string, unknown>();
    const sessionIds: string[] = [];
    registration.setResponses([
      (_context, options) => {
        sessionIds.push(options?.sessionId ?? '');
        return assistantToolCall('task', { prompt: 'Research this.', agent: 'default' });
      },
      (_context, options) => {
        sessionIds.push(options?.sessionId ?? '');
        return assistantToolCall('task', { prompt: 'Dig deeper.', agent: 'default' });
      },
      (_context, options) => {
        sessionIds.push(options?.sessionId ?? '');
        return assistantText('grandchild answer');
      },
      (_context, options) => {
        sessionIds.push(options?.sessionId ?? '');
        return assistantText('child used grandchild');
      },
      (_context, options) => {
        sessionIds.push(options?.sessionId ?? '');
        return assistantText('used child answer');
      },
    ]);

    const agent = await new RealFlueAgentFactory({
      model: `${provider}/${modelId}`,
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
    const session = await agent.session('thread-1');

    const result = await session.prompt('Use a task.');

    expect(result.text).toBe('used child answer');
    expect(sessionIds).toHaveLength(5);
    expect(sessionIds.every((sessionId) => sessionId.length <= 64)).toBe(true);
    expect(sessionIds.every((sessionId) => FLUE_SESSION_AFFINITY_KEY_PATTERN.test(sessionId))).toBe(true);
  });
});

type FauxProviderOptions = { sessionId?: string };
type FauxProviderContext = { messages: unknown[]; tools?: unknown[]; systemPrompt?: string };
type FauxProviderModel = { api: string; provider: string; id: string };
type FauxTextContent = { type: 'text'; text: string };
type FauxToolCall = { type: 'toolCall'; id: string; name: string; arguments: Record<string, unknown> };
type FauxAssistantMessage = {
  role: 'assistant';
  content: Array<FauxTextContent | FauxToolCall>;
  api: string;
  provider: string;
  model: string;
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    totalTokens: number;
    cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  };
  stopReason: 'stop' | 'toolUse';
  timestamp: number;
};
type FauxResponse =
  | FauxAssistantMessage
  | ((context: FauxProviderContext, options: FauxProviderOptions | undefined) => FauxAssistantMessage);

function registerRuntimeFauxProvider(input: { provider: string; modelId: string }) {
  const api = `${input.provider}-api`;
  const responses: FauxResponse[] = [];
  registerApiProvider({
    api,
    stream: (model: FauxProviderModel, context: FauxProviderContext, options?: FauxProviderOptions) =>
      streamAssistantResponse(takeResponse(responses, model, context, options)),
    streamSimple: (model: FauxProviderModel, context: FauxProviderContext, options?: FauxProviderOptions) =>
      streamAssistantResponse(takeResponse(responses, model, context, options)),
  } as never);
  registerProvider(input.provider, {
    api,
    baseUrl: 'https://fixture.invalid',
    models: { [input.modelId]: { contextWindow: 100_000, maxTokens: 4_096 } },
  });
  return {
    setResponses(next: FauxResponse[]) {
      responses.splice(0, responses.length, ...next);
    },
  };
}

function takeResponse(
  responses: FauxResponse[],
  model: FauxProviderModel,
  context: FauxProviderContext,
  options: FauxProviderOptions | undefined,
): FauxAssistantMessage {
  const response = responses.shift();
  if (!response) throw new Error('No faux Flue provider responses left');
  const message = typeof response === 'function' ? response(context, options) : response;
  return { ...message, api: model.api, provider: model.provider, model: model.id };
}

function streamAssistantResponse(message: FauxAssistantMessage) {
  return {
    async *[Symbol.asyncIterator]() {
      yield { type: 'start', partial: message };
      yield message.stopReason === 'toolUse'
        ? { type: 'done', reason: 'toolUse', message }
        : { type: 'done', reason: 'stop', message };
    },
    async result() {
      return message;
    },
  };
}

function assistantText(text: string): FauxAssistantMessage {
  return assistant([{ type: 'text', text }], 'stop');
}

function assistantToolCall(name: string, args: Record<string, unknown>): FauxAssistantMessage {
  return assistant([{ type: 'toolCall', id: `tool-${randomUUID()}`, name, arguments: args }], 'toolUse');
}

function assistant(
  content: FauxAssistantMessage['content'],
  stopReason: FauxAssistantMessage['stopReason'],
): FauxAssistantMessage {
  return {
    role: 'assistant',
    content,
    api: 'faux',
    provider: 'faux',
    model: 'faux',
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: Date.now(),
  };
}

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
      serviceEndpoints: false,
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
