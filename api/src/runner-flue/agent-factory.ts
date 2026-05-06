import { createFlueContext, InMemorySessionStore, resolveModel } from '@flue/sdk/internal';
import type { AgentInit, SessionData, SessionStore } from '@flue/sdk';
import type { FlueAgentFactory, FlueAgentPort } from './types.js';
import { sandboxHandleToFlueFactory } from './sandbox-factory.js';

export type RealFlueAgentFactoryOptions = {
  model: AgentInit['model'];
  sessionStore?: SessionStore;
  env?: Record<string, unknown>;
};

export class RealFlueAgentFactory implements FlueAgentFactory {
  private readonly sessionStore: SessionStore;
  private readonly env: Record<string, unknown>;

  constructor(private readonly options: RealFlueAgentFactoryOptions) {
    this.sessionStore = options.sessionStore ?? new InMemorySessionStore();
    this.env = options.env ?? process.env;
  }

  async create(input: Parameters<FlueAgentFactory['create']>[0]): Promise<FlueAgentPort> {
    const ctx = createFlueContext({
      id: input.agentId,
      payload: {},
      env: this.env,
      agentConfig: {
        systemPrompt: '',
        skills: {},
        roles: {},
        model: undefined,
        resolveModel,
      },
      createDefaultEnv: unsupportedEnv('default'),
      createLocalEnv: unsupportedEnv('local'),
      defaultStore: this.sessionStore,
    });
    ctx.setEventCallback(input.onEvent);

    const initOptions: AgentInit = {
      id: input.agentId,
      sandbox: sandboxHandleToFlueFactory(input.sandbox),
      model: this.options.model,
      persist: this.sessionStore,
    };
    if (input.cwd) initOptions.cwd = input.cwd;
    if (input.tools) initOptions.tools = input.tools;

    return ctx.init(initOptions);
  }

  async loadSession(id: string): Promise<SessionData | null> {
    return this.sessionStore.load(flueSessionStorageKey(id));
  }

  async saveSession(id: string, data: SessionData): Promise<void> {
    await this.sessionStore.save(flueSessionStorageKey(id), data);
  }

  async deleteSession(id: string): Promise<void> {
    await this.sessionStore.delete(flueSessionStorageKey(id));
  }
}

function flueSessionStorageKey(sessionId: string): string {
  return `agent-session:${JSON.stringify([sessionId, sessionId])}`;
}

function unsupportedEnv(kind: string) {
  return async () => {
    throw new Error(`Flue ${kind} sandbox is not available in the background worker`);
  };
}
