import { FlueRunner } from '../../src/runner-flue/runner.js';
import { RealFlueAgentFactory } from '../../src/runner-flue/agent-factory.js';
import type { FlueAgentFactory } from '../../src/runner-flue/types.js';
import type { SessionData, SessionStore } from '@flue/sdk';
import type { NormalizedEvent } from '../../src/events/types.js';
import type { RepositoryAccessProvider } from '../../src/repositories/setup.js';
import { FakeSandboxProvider } from '../../src/sandbox/fake.js';

describe('FlueRunner', () => {
  it('uses stable product session IDs for Flue agent and session identity', async () => {
    const calls: Parameters<FlueAgentFactory['create']>[0][] = [];
    const factory: FlueAgentFactory = {
      async create(input) {
        calls.push(input);
        return {
          async session(id) {
            expect(id).toBe('session-1');
            return {
              async prompt(text) {
                return { text: `flue: ${text}` };
              },
              abort() {},
            };
          },
        };
      },
    };
    const sandbox = await new FakeSandboxProvider().create({ sessionId: 'session-1' });
    const events: NormalizedEvent[] = [];

    const result = await new FlueRunner(factory).run({
      sessionId: 'session-1',
      runId: 'run-1',
      messageId: 'message-1',
      prompt: 'hello',
      context: {},
      sandbox,
      emit: async (event) => {
        events.push(event);
      },
    });

    expect(calls).toMatchObject([{ agentId: 'session-1', sessionId: 'session-1', sandbox, cwd: '/workspace' }]);
    expect(calls[0]?.onEvent).toEqual(expect.any(Function));
    expect(result.text).toBe('flue: hello');
    expect(events.map((event) => event.type)).toEqual(['run_started', 'agent_text_delta', 'run_completed']);
  });

  it('normalizes Flue live events into product events', async () => {
    const factory: FlueAgentFactory = {
      async create(input) {
        return {
          async session() {
            return {
              async prompt() {
                input.onEvent?.({ type: 'text_delta', text: 'hello', sessionId: 'flue-session' });
                input.onEvent?.({
                  type: 'tool_start',
                  toolName: 'shell',
                  toolCallId: 'tool-1',
                  args: { command: 'pwd' },
                  sessionId: 'flue-session',
                });
                input.onEvent?.({
                  type: 'tool_end',
                  toolName: 'shell',
                  toolCallId: 'tool-1',
                  isError: false,
                  result: 'ok',
                  sessionId: 'flue-session',
                });
                input.onEvent?.({ type: 'command_start', command: 'gh', args: ['issue', 'list'] });
                input.onEvent?.({ type: 'command_end', command: 'gh', exitCode: 0 });
                input.onEvent?.({ type: 'task_start', taskId: 'task-1', prompt: 'research', cwd: '/workspace' });
                input.onEvent?.({ type: 'task_end', taskId: 'task-1', isError: false, result: 'done' });
                return { text: 'hello' };
              },
              abort() {},
            };
          },
        };
      },
    };
    const sandbox = await new FakeSandboxProvider().create({ sessionId: 'session-1' });
    const events: NormalizedEvent[] = [];

    await new FlueRunner(factory).run({
      sessionId: 'session-1',
      runId: 'run-1',
      messageId: 'message-1',
      prompt: 'hello',
      context: {},
      sandbox,
      emit: async (event) => {
        events.push(event);
      },
    });

    expect(events.map((event) => event.type)).toEqual([
      'run_started',
      'agent_text_delta',
      'tool_started',
      'tool_finished',
      'tool_started',
      'tool_finished',
      'tool_started',
      'tool_finished',
      'run_completed',
    ]);
    expect(events.filter((event) => event.type === 'agent_text_delta')).toHaveLength(1);
    expect(events[1]?.payload).toMatchObject({ text: 'hello', flueSessionId: 'flue-session' });
    expect(events[2]?.payload).toMatchObject({ toolName: 'shell', toolCallId: 'tool-1' });
    expect(events[4]?.payload).toMatchObject({ toolName: 'command', command: 'gh' });
    expect(events[6]?.payload).toMatchObject({ toolName: 'task', taskId: 'task-1' });
  });

  it('refreshes GitHub repositories through Flue shell setup without persisting tokens to events', async () => {
    const calls: Parameters<FlueAgentFactory['create']>[0][] = [];
    const shells: Array<{ command: string; env?: Record<string, string>; cwd?: string }> = [];
    const factory: FlueAgentFactory = {
      async create(input) {
        calls.push(input);
        return {
          async session() {
            return {
              async shell(command, options) {
                const shell: { command: string; env?: Record<string, string>; cwd?: string } = { command };
                if (options?.env) shell.env = options.env;
                if (options?.cwd) shell.cwd = options.cwd;
                shells.push(shell);
                return { stdout: 'cloned', stderr: '', exitCode: 0 };
              },
              async prompt(text) {
                return { text: `done: ${text}` };
              },
              abort() {},
            };
          },
        };
      },
    };
    const sandbox = await new FakeSandboxProvider().create({ sessionId: 'session-1' });
    const events: NormalizedEvent[] = [];

    await new FlueRunner(factory, { repositoryAccess: { github: new StaticGitHubAccessProvider('ghs_secret_token') } }).run({
      sessionId: 'session-1',
      runId: 'run-1',
      messageId: 'message-1',
      prompt: 'work on repo',
      context: { repository: { provider: 'github', owner: 'manaflow-ai', repo: 'manaflow' } },
      sandbox,
      emit: async (event) => { events.push(event); },
    });

    expect(calls[0]).toMatchObject({ cwd: '/workspace/manaflow' });
    expect(calls[0]?.tools?.map((tool) => tool.name)).toEqual(['repository', 'gh', 'git']);
    expect(shells).toHaveLength(1);
    expect(shells[0]!.cwd).toBe('/workspace');
    expect(shells[0]!.command).toContain('git -c http.extraHeader="$GITHUB_AUTH_HEADER" clone');
    expect(shells[0]!.command).toContain("git -C '/workspace/manaflow' config user.name 'Deputies'");
    expect(shells[0]!.command).not.toContain('ghs_secret_token');
    expect(shells[0]!.env).toEqual({
      GITHUB_AUTH_HEADER: `Authorization: Basic ${Buffer.from('x-access-token:ghs_secret_token').toString('base64')}`,
    });

    const eventsJson = JSON.stringify(events);
    expect(events.map((event) => event.type)).toEqual(['run_started', 'repository_ready', 'agent_text_delta', 'run_completed']);
    expect(eventsJson).toContain('/workspace/manaflow');
    expect(eventsJson).not.toContain('ghs_secret_token');
  });

  it('restores persisted Flue session state after abort', async () => {
    const previousSession = {
      version: 2 as const,
      entries: [
        {
          type: 'message' as const,
          id: 'entry-1',
          parentId: null,
          timestamp: '2026-05-06T00:00:00.000Z',
          message: { role: 'user' as const, content: [{ type: 'text' as const, text: 'previous completed work' }], timestamp: 1 },
          source: 'prompt' as const,
        },
      ],
      leafId: 'entry-1',
      metadata: {},
      createdAt: '2026-05-06T00:00:00.000Z',
      updatedAt: '2026-05-06T00:00:00.000Z',
    };
    const deleted: string[] = [];
    const saved: unknown[] = [];
    const loaded: string[] = [];
    const abort = new AbortController();
    const factory: FlueAgentFactory = {
      async create() {
        return {
          async session() {
            return {
              async prompt() {
                abort.abort();
                return { text: 'partial response' };
              },
              abort() {},
            };
          },
        };
      },
      async loadSession() {
        loaded.push('session-1');
        return previousSession;
      },
      async saveSession(_id, data) {
        saved.push(data);
      },
      async deleteSession(id) {
        deleted.push(id);
      },
    };
    const sandbox = await new FakeSandboxProvider().create({ sessionId: 'session-1' });

    await expect(
      new FlueRunner(factory).run({
        sessionId: 'session-1',
        runId: 'run-1',
        messageId: 'message-1',
        prompt: 'sleep for 5 seconds',
        context: {},
        sandbox,
        signal: abort.signal,
        emit: async () => {},
      }),
    ).rejects.toThrow('Operation aborted');

    expect(loaded).toEqual(['session-1']);
    expect(saved).toEqual([previousSession]);
    expect(deleted).toEqual([]);
  });

  it('deletes aborted Flue session state when there was no prior snapshot', async () => {
    const deleted: string[] = [];
    const abort = new AbortController();
    const factory: FlueAgentFactory = {
      async create() {
        return {
          async session() {
            return {
              async prompt() {
                abort.abort();
                return { text: 'partial response' };
              },
              abort() {},
            };
          },
        };
      },
      async loadSession() {
        return null;
      },
      async deleteSession(id) {
        deleted.push(id);
      },
    };
    const sandbox = await new FakeSandboxProvider().create({ sessionId: 'session-1' });

    await expect(
      new FlueRunner(factory).run({
        sessionId: 'session-1',
        runId: 'run-1',
        messageId: 'message-1',
        prompt: 'sleep for 5 seconds',
        context: {},
        sandbox,
        signal: abort.signal,
        emit: async () => {},
      }),
    ).rejects.toThrow('Operation aborted');

    expect(deleted).toEqual(['session-1']);
  });

  it('maps product session IDs to Flue storage keys for snapshots', async () => {
    const keys: string[] = [];
    const data = { version: 2, entries: [], leafId: null, metadata: {}, createdAt: 'now', updatedAt: 'now' } satisfies SessionData;
    const store: SessionStore = {
      async load(id) {
        keys.push(`load:${id}`);
        return data;
      },
      async save(id) {
        keys.push(`save:${id}`);
      },
      async delete(id) {
        keys.push(`delete:${id}`);
      },
    };
    const factory = new RealFlueAgentFactory({ model: false, sessionStore: store });

    await factory.loadSession('session-1');
    await factory.saveSession('session-1', data);
    await factory.deleteSession('session-1');

    const key = 'agent-session:["session-1","session-1"]';
    expect(keys).toEqual([`load:${key}`, `save:${key}`, `delete:${key}`]);
  });

});

class StaticGitHubAccessProvider implements RepositoryAccessProvider {
  constructor(private readonly token: string) {}

  async getRepositoryAccess() {
    return {
      provider: 'github' as const,
      owner: 'manaflow-ai',
      repo: 'manaflow',
      cloneUrl: 'https://github.com/manaflow-ai/manaflow.git',
      expiresAt: new Date('2026-05-06T01:00:00.000Z'),
      auth: { type: 'bearer' as const, token: this.token },
    };
  }
}
