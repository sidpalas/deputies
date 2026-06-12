import {
  type CallHandle,
  configureProvider,
  createAgent,
  type AgentProfile,
  type FlueHarness,
  type FlueSession,
  type ModelConfig,
  type SessionData,
  type SessionStore,
  type ShellOptions,
} from '@flue/runtime';
import { createFlueContext, InMemorySessionStore, resolveModel } from '@flue/runtime/internal';
import type { FlueAgentFactory, FlueAgentPort, FlueSessionPort } from './types.js';
import { sandboxHandleToFlueFactory } from './sandbox-factory.js';

const FLUE_INSTANCE_ID = 'deputies';
const FLUE_HARNESS_NAME = 'runner';
const FLUE_DEFAULT_SUBAGENT_DEPTH = 4;
const CURRENT_FLUE_SESSION_VERSION = 5;
const FLUE_AFFINITY_KEY_PATTERN = /^aff_[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const DEPUTIES_SYSTEM_PROMPT = [
  'You are a software engineering agent running in a sandbox for the Deputies product.',
  'When generating files for users, prefer broadly compatible formats that can be opened in modern browsers and common desktop tools.',
  'Before publishing an artifact, verify the file exists, has the expected format, and is the artifact the user should receive.',
  'Only tell the user an artifact or preview is available after the corresponding tool call succeeds.',
].join('\n');

export type RealFlueAgentFactoryOptions = {
  model: ModelConfig;
  providers?: Record<string, { apiKey?: string; baseUrl?: string; headers?: Record<string, string> }>;
  sessionStore?: SessionStore;
  env?: Record<string, unknown>;
};

export class RealFlueAgentFactory implements FlueAgentFactory {
  private readonly sessionStore: SessionStore;
  private readonly env: Record<string, unknown>;

  constructor(private readonly options: RealFlueAgentFactoryOptions) {
    this.sessionStore = new FreshStartUnsupportedSessionStore(options.sessionStore ?? new InMemorySessionStore());
    this.env = options.env ?? {};
    for (const [provider, settings] of Object.entries(options.providers ?? {})) {
      configureProvider(provider, settings);
    }
  }

  async create(input: Parameters<FlueAgentFactory['create']>[0]): Promise<FlueAgentPort> {
    const ctx = createFlueContext({
      id: FLUE_INSTANCE_ID,
      runId: input.sessionId,
      payload: {},
      env: this.env,
      agentConfig: {
        systemPrompt: '',
        skills: {},
        subagents: {},
        model: undefined,
        resolveModel,
      },
      createDefaultEnv: unsupportedEnv('default'),
      defaultStore: this.sessionStore,
    });
    ctx.setEventCallback(input.onEvent);

    const agent = createAgent(() => ({
      instructions: DEPUTIES_SYSTEM_PROMPT,
      sandbox: sandboxHandleToFlueFactory(input.sandbox),
      model: input.model ?? this.options.model,
      subagents: [createDefaultSubagent(FLUE_DEFAULT_SUBAGENT_DEPTH)],
      ...(input.cwd ? { cwd: input.cwd } : {}),
      ...(input.tools ? { tools: input.tools } : {}),
    }));

    return adaptHarness(await ctx.init(agent, { name: FLUE_HARNESS_NAME }), input.agentId, this.sessionStore);
  }

  async loadSession(id: string): Promise<SessionData | null> {
    return loadFlueSession(this.sessionStore, id, id);
  }

  async saveSession(id: string, data: SessionData): Promise<void> {
    await this.sessionStore.save(flueSessionStorageKey(id), data);
  }

  async deleteSession(id: string): Promise<void> {
    await Promise.all(flueSessionStorageKeys(id, id).map((key) => this.sessionStore.delete(key)));
  }
}

class FreshStartUnsupportedSessionStore implements SessionStore {
  private readonly warnedKeys = new Set<string>();

  constructor(private readonly inner: SessionStore) {}

  async save(id: string, data: SessionData): Promise<void> {
    this.warnedKeys.delete(id);
    await this.inner.save(id, data);
  }

  async load(id: string): Promise<SessionData | null> {
    const data = await this.inner.load(id);
    const reason = unsupportedSessionDataReason(data);
    if (!reason) {
      this.warnedKeys.delete(id);
      return data;
    }

    if (!this.warnedKeys.has(id)) {
      this.warnedKeys.add(id);
      console.warn(
        `[flue] Ignoring persisted pre-upgrade Flue session state for Deputies session "${sessionIdFromStorageKey(id)}" (${reason}); starting a fresh Flue session. Deputies session history is unaffected.`,
      );
    }
    return null;
  }

  async delete(id: string): Promise<void> {
    this.warnedKeys.delete(id);
    await this.inner.delete(id);
  }
}

function unsupportedSessionDataReason(data: SessionData | null): string | null {
  if (!data) return null;
  const candidate = data as { version?: unknown; affinityKey?: unknown };
  if (candidate.version !== CURRENT_FLUE_SESSION_VERSION) {
    return `session data version ${String(candidate.version)} is unsupported by @flue/runtime 0.11.1`;
  }
  if (typeof candidate.affinityKey !== 'string' || !FLUE_AFFINITY_KEY_PATTERN.test(candidate.affinityKey)) {
    return 'session data affinity key is missing or malformed for @flue/runtime 0.11.1';
  }
  return null;
}

function sessionIdFromStorageKey(key: string): string {
  if (!key.startsWith('agent-session:')) return key;
  try {
    const parts = JSON.parse(key.slice('agent-session:'.length)) as unknown;
    return Array.isArray(parts) && typeof parts.at(-1) === 'string' ? parts.at(-1) : key;
  } catch {
    return key;
  }
}

function flueSessionStorageKey(sessionId: string): string {
  return `agent-session:${JSON.stringify([FLUE_INSTANCE_ID, FLUE_HARNESS_NAME, sessionId])}`;
}

function legacyFlueSessionStorageKey(sessionId: string, legacyAgentId: string): string {
  return `agent-session:${JSON.stringify([legacyAgentId, legacyAgentId, sessionId])}`;
}

function preUpgradeFlueSessionStorageKey(sessionId: string): string {
  return `agent-session:${JSON.stringify([sessionId, sessionId])}`;
}

function flueSessionStorageKeys(sessionId: string, legacyAgentId: string): string[] {
  return [
    flueSessionStorageKey(sessionId),
    legacyFlueSessionStorageKey(sessionId, legacyAgentId),
    preUpgradeFlueSessionStorageKey(sessionId),
  ];
}

function createDefaultSubagent(depth: number): AgentProfile {
  const subagent: AgentProfile = {
    name: 'default',
    description: 'Use the default Deputies software engineering agent.',
  };
  if (depth > 1) subagent.subagents = [createDefaultSubagent(depth - 1)];
  return subagent;
}

async function loadFlueSession(
  store: SessionStore,
  sessionId: string,
  legacyAgentId: string,
): Promise<SessionData | null> {
  const key = flueSessionStorageKey(sessionId);
  const existing = await store.load(key);
  if (existing) return existing;

  for (const legacyKey of flueSessionStorageKeys(sessionId, legacyAgentId).slice(1)) {
    const legacy = await store.load(legacyKey);
    if (legacy) {
      await store.save(key, legacy);
      return legacy;
    }
  }
  return null;
}

function unsupportedEnv(kind: string) {
  return async () => {
    throw new Error(`Flue ${kind} sandbox is not available in the background worker`);
  };
}

function adaptHarness(harness: FlueHarness, legacyAgentId: string, sessionStore: SessionStore): FlueAgentPort {
  return {
    session: async (id?: string) => {
      const sessionId = id ?? 'default';
      await loadFlueSession(sessionStore, sessionId, legacyAgentId);
      const session = await harness.session(id);
      return adaptSession(session);
    },
    shell: (command, options) => harness.shell(command, toFlueShellOptions(options)),
  };
}

function adaptSession(session: FlueSession): FlueSessionPort {
  const activeCalls = new Set<CallHandle<unknown>>();

  const track = <T>(call: CallHandle<T>): CallHandle<T> => {
    activeCalls.add(call as CallHandle<unknown>);
    void Promise.resolve(call)
      .finally(() => {
        activeCalls.delete(call as CallHandle<unknown>);
      })
      .catch(() => {});
    return call;
  };

  return {
    prompt: (text, options) => track(session.prompt(text, options)),
    shell: (command, options) => track(session.shell(command, toFlueShellOptions(options))),
    abort: (reason) => {
      for (const call of activeCalls) call.abort(reason);
    },
  };
}

function toFlueShellOptions(options: Parameters<NonNullable<FlueSessionPort['shell']>>[1]): ShellOptions | undefined {
  if (!options) return undefined;
  const signal =
    options.timeout === undefined
      ? options.signal
      : AbortSignal.any([...(options.signal ? [options.signal] : []), AbortSignal.timeout(options.timeout)]);
  const flueOptions: ShellOptions = {};
  if (options.cwd !== undefined) flueOptions.cwd = options.cwd;
  if (options.env !== undefined) flueOptions.env = options.env;
  if (signal !== undefined) flueOptions.signal = signal;
  return flueOptions;
}
