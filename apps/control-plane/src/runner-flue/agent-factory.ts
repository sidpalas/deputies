import {
  createFlueContext,
  InMemorySessionStore,
  resolveModel,
} from "@flue/sdk/internal";
import type {
  AgentInit,
  FlueHarness,
  FlueSession,
  SessionData,
  SessionStore,
  ShellOptions,
} from "@flue/sdk";
import { configureProvider } from '@flue/sdk/app';
import type { FlueAgentFactory, FlueAgentPort, FlueSessionPort } from "./types.js";
import { sandboxHandleToFlueFactory } from "./sandbox-factory.js";

const FLUE_INSTANCE_ID = 'deputies';
const FLUE_HARNESS_NAME = 'runner';

export type RealFlueAgentFactoryOptions = {
  model: AgentInit["model"];
  providers?: Record<string, { apiKey?: string; baseUrl?: string; headers?: Record<string, string> }>;
  sessionStore?: SessionStore;
  env?: Record<string, unknown>;
};

export class RealFlueAgentFactory implements FlueAgentFactory {
  private readonly sessionStore: SessionStore;
  private readonly env: Record<string, unknown>;

  constructor(private readonly options: RealFlueAgentFactoryOptions) {
    this.sessionStore = options.sessionStore ?? new InMemorySessionStore();
    this.env = options.env ?? process.env;
    for (const [provider, settings] of Object.entries(options.providers ?? {})) {
      configureProvider(provider, settings);
    }
  }

  async create(
    input: Parameters<FlueAgentFactory["create"]>[0],
  ): Promise<FlueAgentPort> {
    const ctx = createFlueContext({
      id: FLUE_INSTANCE_ID,
      runId: input.sessionId,
      payload: {},
      env: this.env,
      agentConfig: {
        systemPrompt: "",
        skills: {},
        roles: {},
        model: undefined,
        resolveModel,
      },
      createDefaultEnv: unsupportedEnv("default"),
      createLocalEnv: unsupportedEnv("local"),
      defaultStore: this.sessionStore,
    });
    ctx.setEventCallback(input.onEvent);

    const initOptions: AgentInit = {
      name: FLUE_HARNESS_NAME,
      sandbox: sandboxHandleToFlueFactory(input.sandbox),
      model: this.options.model,
      persist: this.sessionStore,
    };
    if (input.cwd) initOptions.cwd = input.cwd;
    if (input.tools) initOptions.tools = input.tools;

    return adaptHarness(await ctx.init(initOptions), input.agentId, this.sessionStore);
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
  return [flueSessionStorageKey(sessionId), legacyFlueSessionStorageKey(sessionId, legacyAgentId), preUpgradeFlueSessionStorageKey(sessionId)];
}

async function loadFlueSession(store: SessionStore, sessionId: string, legacyAgentId: string): Promise<SessionData | null> {
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
    throw new Error(
      `Flue ${kind} sandbox is not available in the background worker`,
    );
  };
}

function adaptHarness(harness: FlueHarness, legacyAgentId: string, sessionStore: SessionStore): FlueAgentPort {
  return {
    session: async (id?: string) => {
      const sessionId = id ?? "default";
      await loadFlueSession(sessionStore, sessionId, legacyAgentId);
      const session = await harness.session(id);
      return adaptSession(session);
    },
    shell: (command, options) =>
      harness.shell(command, toFlueShellOptions(options)),
  };
}

function adaptSession(session: FlueSession): FlueSessionPort {
  return {
    prompt: (text) => session.prompt(text),
    shell: (command, options) =>
      session.shell(command, toFlueShellOptions(options)),
  };
}

function toFlueShellOptions(
  options: Parameters<NonNullable<FlueSessionPort["shell"]>>[1],
): ShellOptions | undefined {
  if (!options) return undefined;
  const signal =
    options.timeout === undefined
      ? options.signal
      : AbortSignal.any([
          ...(options.signal ? [options.signal] : []),
          AbortSignal.timeout(options.timeout),
        ]);
  const flueOptions: ShellOptions = {};
  if (options.cwd !== undefined) flueOptions.cwd = options.cwd;
  if (options.env !== undefined) flueOptions.env = options.env;
  if (signal !== undefined) flueOptions.signal = signal;
  return flueOptions;
}
