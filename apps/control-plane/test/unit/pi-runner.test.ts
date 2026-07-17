import { access, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import { ArtifactService } from '../../src/artifacts/service.js';
import { createServices } from '../../src/app/server.js';
import { FilesystemArtifactObjectStorage } from '../../src/artifacts/storage.js';
import { createArtifactFromSandbox } from '../../src/artifacts/tool.js';
import { EventService } from '../../src/events/service.js';
import type { NormalizedEvent } from '../../src/events/types.js';
import type { McpConnection } from '../../src/mcp/types.js';
import type { GitHubRepositoryAccess } from '../../src/repositories/setup.js';
import { PiRunner } from '../../src/runner-pi/runner.js';
import { createSandboxPiToolDefinitions } from '../../src/runner-pi/sandbox-tools.js';
import {
  PI_SESSION_DATA_VERSION,
  PostgresPiSessionStore,
  type PiSessionData,
} from '../../src/runner-pi/session-store.js';
import type { SandboxKeepaliveService } from '../../src/sandbox/service.js';
import type { SandboxHandle } from '../../src/sandbox/types.js';
import { MemoryStore } from '../../src/store/memory.js';
import { defaultGroupId } from '../../src/store/types.js';
import { MemorySandboxFileSystem } from '../support/pi-skills.js';

const piMock = vi.hoisted(() => ({
  createAgentSession: vi.fn(),
  openSessionCalls: [] as Array<{ sessionFile: string; agentDir: string; cwd: string; jsonl: string }>,
  openSessionError: undefined as Error | undefined,
  resourceLoaderOptions: [] as Array<{
    noSkills?: boolean;
    skillsOverride?: (base: { skills: unknown[]; diagnostics: unknown[] }) => {
      skills: unknown[];
      diagnostics: unknown[];
    };
  }>,
}));

type SandboxPiTool = ReturnType<typeof createSandboxPiToolDefinitions>[number];
type SandboxPiToolResult = Awaited<ReturnType<SandboxPiTool['execute']>>;
type ExecCall = { command: string; cwd?: string; env?: Record<string, string>; timeoutMs?: number };

vi.mock('@earendil-works/pi-coding-agent', async (importOriginal) => {
  const { readFileSync } = await import('node:fs');
  const actual = await importOriginal<typeof import('@earendil-works/pi-coding-agent')>();

  class FakeAuthStorage {
    static create() {
      return new FakeAuthStorage();
    }

    static inMemory() {
      return new FakeAuthStorage();
    }
  }

  class FakeModelRegistry {
    static create() {
      return new FakeModelRegistry();
    }

    getAll() {
      return [];
    }

    registerProvider() {}

    find(provider: string, id: string) {
      return {
        id,
        name: id,
        provider,
        api: 'openai-codex-responses',
        baseUrl: 'https://example.test',
        reasoning: id !== 'non-reasoning',
        ...(id === 'max-reasoning' ? { thinkingLevelMap: { max: 'max' } } : {}),
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 100_000,
        maxTokens: 16_000,
      };
    }
  }

  class FakeResourceLoader {
    constructor(options: (typeof piMock.resourceLoaderOptions)[number]) {
      piMock.resourceLoaderOptions.push(options);
    }

    async reload() {}
  }

  class FakeSessionManager {
    private id = 'pi-test-session';
    private header: unknown = { id: this.id };
    private entries: unknown[] = [];

    constructor(options: { header?: unknown; entries?: unknown[] } = {}) {
      if (options.header) this.header = options.header;
      if (options.entries) this.entries = options.entries;
    }

    static inMemory() {
      return new FakeSessionManager();
    }

    static open(sessionFile: string, agentDir: string, cwd: string) {
      const jsonl = readFileSync(sessionFile, 'utf8');
      piMock.openSessionCalls.push({ sessionFile, agentDir, cwd, jsonl });
      if (piMock.openSessionError) throw piMock.openSessionError;
      const [headerLine, ...entryLines] = jsonl.trim().split('\n');
      return new FakeSessionManager({
        header: headerLine ? JSON.parse(headerLine) : undefined,
        entries: entryLines.map((line) => JSON.parse(line)),
      });
    }

    newSession(options?: { id?: string }) {
      if (options?.id) this.id = options.id;
      this.header = { id: this.id };
    }

    getSessionId() {
      return this.id;
    }

    getHeader() {
      return this.header;
    }

    getEntries() {
      return this.entries;
    }
  }

  return {
    ...actual,
    AuthStorage: FakeAuthStorage,
    ModelRegistry: FakeModelRegistry,
    DefaultResourceLoader: FakeResourceLoader,
    SessionManager: FakeSessionManager,
    getAgentDir: () => '/tmp/pi-agent',
    createAgentSession: piMock.createAgentSession,
  };
});

describe('PiRunner', () => {
  beforeEach(() => {
    piMock.createAgentSession.mockReset();
    piMock.openSessionCalls.length = 0;
    piMock.openSessionError = undefined;
    piMock.resourceLoaderOptions.length = 0;
  });

  it('runs a Pi session and normalizes streamed text and tool events', async () => {
    const usage = {
      input: 10,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 15,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
    const messages = [
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'hello from pi' }],
        model: 'gpt-5.5',
        usage,
        stopReason: 'stop',
      },
    ];
    let listener: ((event: AgentSessionEvent) => void) | undefined;
    const prompt = vi.fn(async () => {
      listener?.({
        type: 'message_update',
        message: messages[0] as never,
        assistantMessageEvent: { type: 'text_delta', delta: 'hello from pi' } as never,
      });
      listener?.({ type: 'tool_execution_start', toolName: 'bash', toolCallId: 'tool-1', args: { command: 'pwd' } });
      listener?.({
        type: 'tool_execution_end',
        toolName: 'bash',
        toolCallId: 'tool-1',
        isError: false,
        result: { content: [{ type: 'text', text: '/workspace' }] },
      });
    });
    const dispose = vi.fn();

    piMock.createAgentSession.mockResolvedValue({
      session: {
        sessionId: 'pi-session',
        messages,
        prompt,
        abort: vi.fn(),
        dispose,
        subscribe(callback: (event: AgentSessionEvent) => void) {
          listener = callback;
          return () => {
            listener = undefined;
          };
        },
      },
      extensionsResult: {},
    });

    const events: NormalizedEvent[] = [];
    const result = await new PiRunner({
      model: 'openai-codex/gpt-5.5',
      authBase64: Buffer.from('{}').toString('base64'),
    }).run({
      sessionId: 'session-1',
      runId: 'run-1',
      messageId: 'message-1',
      prompt: 'hello',
      context: {},
      sandbox: createMemorySandbox(),
      emit: async (event) => {
        events.push(event);
      },
    });

    expect(prompt).toHaveBeenCalledWith('hello', { expandPromptTemplates: false });
    expect(piMock.createAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({
        noTools: 'builtin',
        customTools: expect.arrayContaining([
          expect.objectContaining({ name: 'read' }),
          expect.objectContaining({ name: 'bash' }),
          expect.objectContaining({ name: 'edit' }),
          expect.objectContaining({ name: 'write' }),
          expect.objectContaining({ name: 'grep' }),
          expect.objectContaining({ name: 'find' }),
          expect.objectContaining({ name: 'ls' }),
          expect.objectContaining({ name: 'subagent' }),
        ]),
      }),
    );
    expect(piMock.createAgentSession.mock.calls[0]![0].tools).toBeUndefined();
    expect(events.map((event) => event.type)).toEqual([
      'run_started',
      'skills_loaded',
      'agent_text_delta',
      'tool_started',
      'tool_finished',
      'run_completed',
    ]);
    expect(events[1]?.payload).toEqual({ skills: [], shadowed: [], diagnostics: [] });
    expect(events[2]?.payload).toMatchObject({ text: 'hello from pi' });
    expect(events[3]?.payload).toMatchObject({ toolName: 'bash', toolCallId: 'tool-1' });
    expect(result).toEqual({ text: 'hello from pi', model: 'gpt-5.5', usage });
    expect(dispose).toHaveBeenCalled();
  });

  it('traces explicit and successful model skill invocations once per run', async () => {
    const skillPath = '/workspace/.deputies-skills/group/skill-review/revision-review-1/review/SKILL.md';
    const messages = [
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'reviewed' }],
        model: 'gpt-5.5',
        stopReason: 'stop',
      },
    ];
    let listener: ((event: AgentSessionEvent) => void) | undefined;
    piMock.createAgentSession.mockResolvedValue({
      session: {
        sessionId: 'pi-session',
        messages,
        async prompt() {
          listener?.({
            type: 'tool_execution_start',
            toolName: 'read',
            toolCallId: 'read-failed',
            args: { path: skillPath },
          });
          listener?.({
            type: 'tool_execution_end',
            toolName: 'read',
            toolCallId: 'read-failed',
            isError: true,
            result: { content: [{ type: 'text', text: 'failed' }] },
          });
          for (const toolCallId of ['read-success', 'read-repeated']) {
            listener?.({ type: 'tool_execution_start', toolName: 'read', toolCallId, args: { path: skillPath } });
            listener?.({
              type: 'tool_execution_end',
              toolName: 'read',
              toolCallId,
              isError: false,
              result: { content: [{ type: 'text', text: '# Review' }] },
            });
          }
        },
        abort: vi.fn(),
        dispose: vi.fn(),
        subscribe(callback: (event: AgentSessionEvent) => void) {
          listener = callback;
          return () => {
            listener = undefined;
          };
        },
      },
      extensionsResult: {},
    });

    const events: NormalizedEvent[] = [];
    await new PiRunner({
      model: 'openai-codex/gpt-5.5',
      authBase64: Buffer.from('{}').toString('base64'),
      skills: {
        repoScanEnabled: false,
        listForRun: async () => [
          {
            id: 'skill-review',
            revisionId: 'revision-review-1',
            revisionNumber: 1,
            name: 'review',
            description: 'Review the implementation',
            body: 'Review carefully.',
            autoLoad: true,
            source: 'group',
            ownerGroupId: 'group-1',
            ownerGroupName: 'Engineering',
            createdAt: new Date('2026-01-01T00:00:00Z'),
          },
        ],
      },
    }).run({
      sessionId: 'session-1',
      runId: 'run-1',
      messageId: 'message-1',
      ownerGroupId: 'group-1',
      createdByUserId: 'user-1',
      prompt: 'review this',
      context: { skills: ['review'], skillRefs: [{ id: 'skill-review', name: 'review' }] },
      skillInvocations: [{ name: 'review', ref: 'skill-review' }],
      sandbox: createMemorySandbox(),
      emit: async (event) => {
        events.push(event);
      },
    });

    expect(events.filter((event) => event.type === 'skill_invoked').map((event) => event.payload)).toEqual([
      {
        name: 'review',
        source: 'group',
        trigger: 'user',
        ref: 'skill-review',
        filePath: skillPath,
        ownerGroupId: 'group-1',
        ownerGroupName: 'Engineering',
        skillId: 'skill-review',
        revisionId: 'revision-review-1',
        revisionNumber: 1,
      },
      {
        name: 'review',
        source: 'group',
        trigger: 'model',
        ref: 'skill-review',
        filePath: skillPath,
        ownerGroupId: 'group-1',
        ownerGroupName: 'Engineering',
        skillId: 'skill-review',
        revisionId: 'revision-review-1',
        revisionNumber: 1,
      },
    ]);
    expect(
      events.findIndex((event) => event.type === 'tool_finished' && event.payload.toolCallId === 'read-success'),
    ).toBeLessThan(events.findIndex((event) => event.type === 'skill_invoked' && event.payload.trigger === 'model'));
  });

  it('drains skill invocation events before surfacing a prompt failure', async () => {
    const skillPath = '/workspace/.deputies-skills/group/skill-review/revision-review-1/review/SKILL.md';
    let listener: ((event: AgentSessionEvent) => void) | undefined;
    piMock.createAgentSession.mockResolvedValue({
      session: {
        sessionId: 'pi-session',
        messages: [],
        async prompt() {
          listener?.({
            type: 'tool_execution_start',
            toolName: 'read',
            toolCallId: 'read-1',
            args: { path: skillPath },
          });
          listener?.({
            type: 'tool_execution_end',
            toolName: 'read',
            toolCallId: 'read-1',
            isError: false,
            result: { content: [{ type: 'text', text: '# Review' }] },
          });
          throw new Error('prompt failed');
        },
        abort: vi.fn(),
        dispose: vi.fn(),
        subscribe(callback: (event: AgentSessionEvent) => void) {
          listener = callback;
          return () => {
            listener = undefined;
          };
        },
      },
      extensionsResult: {},
    });

    const events: NormalizedEvent[] = [];
    const run = new PiRunner({
      model: 'openai-codex/gpt-5.5',
      authBase64: Buffer.from('{}').toString('base64'),
      skills: {
        repoScanEnabled: false,
        listForRun: async () => [
          {
            id: 'skill-review',
            revisionId: 'revision-review-1',
            revisionNumber: 1,
            name: 'review',
            description: 'Review the implementation',
            body: 'Review carefully.',
            autoLoad: true,
            source: 'group',
            createdAt: new Date('2026-01-01T00:00:00Z'),
          },
        ],
      },
    }).run({
      sessionId: 'session-1',
      runId: 'run-1',
      messageId: 'message-1',
      ownerGroupId: 'group-1',
      prompt: 'review this',
      context: {},
      sandbox: createMemorySandbox(),
      emit: async (event) => {
        if (event.type === 'tool_started') await new Promise((resolve) => setTimeout(resolve, 5));
        events.push(event);
      },
    });

    await expect(run).rejects.toThrow('prompt failed');
    expect(events.map((event) => event.type)).toContain('skill_invoked');
    expect(events.findIndex((event) => event.type === 'tool_finished')).toBeLessThan(
      events.findIndex((event) => event.type === 'skill_invoked'),
    );
  });

  it('keeps Bedrock model version suffixes in Pi model IDs', async () => {
    piMock.createAgentSession.mockResolvedValue({
      session: {
        sessionId: 'pi-session',
        messages: [
          {
            role: 'assistant',
            content: [{ type: 'text', text: 'ok' }],
            model: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
          },
        ],
        prompt: vi.fn(),
        abort: vi.fn(),
        dispose: vi.fn(),
        subscribe: () => () => {},
      },
      extensionsResult: {},
    });

    await new PiRunner({
      model: 'amazon-bedrock/us.anthropic.claude-haiku-4-5-20251001-v1:0',
      authBase64: Buffer.from('{}').toString('base64'),
    }).run({
      sessionId: 'session-1',
      runId: 'run-1',
      messageId: 'message-1',
      prompt: 'hello',
      context: {},
      sandbox: createMemorySandbox(),
      emit: async () => {},
    });

    expect(piMock.createAgentSession.mock.calls[0]![0]).toMatchObject({
      model: expect.objectContaining({
        provider: 'amazon-bedrock',
        id: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
      }),
    });
    expect(piMock.createAgentSession.mock.calls[0]![0].thinkingLevel).toBeUndefined();
  });

  it('uses explicit reasoning levels and safely falls back for unsupported models', async () => {
    piMock.createAgentSession.mockImplementation(async (options) => ({
      session: {
        sessionId: 'pi-session',
        messages: [
          {
            role: 'assistant',
            content: [{ type: 'text', text: 'ok' }],
            model: options.model.id,
            stopReason: 'stop',
          },
        ],
        prompt: vi.fn(),
        abort: vi.fn(),
        dispose: vi.fn(),
        subscribe: () => () => {},
      },
      extensionsResult: {},
    }));

    for (const [modelId, reasoningLevel] of [
      ['max-reasoning', 'max'],
      ['limited-reasoning', 'max'],
      ['non-reasoning', 'high'],
    ] as const) {
      await new PiRunner({
        model: `openai-codex/${modelId}`,
        authBase64: Buffer.from('{}').toString('base64'),
      }).run({
        sessionId: `session-${modelId}`,
        runId: `run-${modelId}`,
        messageId: `message-${modelId}`,
        prompt: 'hello',
        reasoningLevel,
        context: {},
        sandbox: createMemorySandbox(),
        emit: async () => {},
      });
    }

    await new PiRunner({
      model: 'openai-codex/max-reasoning',
      reasoningLevelDefault: 'minimal',
      authBase64: Buffer.from('{}').toString('base64'),
    }).run({
      sessionId: 'session-default-reasoning',
      runId: 'run-default-reasoning',
      messageId: 'message-default-reasoning',
      prompt: 'hello',
      context: {},
      sandbox: createMemorySandbox(),
      emit: async () => {},
    });

    expect(piMock.createAgentSession.mock.calls.map(([options]) => options.thinkingLevel)).toEqual([
      'max',
      'high',
      'off',
      'minimal',
    ]);
  });

  it('runs subagents in-process and caps nested registration at depth 4', async () => {
    let createCount = 0;
    const prompts: string[] = [];
    const listForRun = vi.fn(async () => [
      {
        id: 'skill-review',
        revisionId: 'revision-review-1',
        revisionNumber: 1,
        name: 'review',
        description: 'Review the implementation',
        body: 'Review carefully.',
        autoLoad: false,
        source: 'group' as const,
        createdAt: new Date('2026-01-01T00:00:00Z'),
      },
    ]);

    piMock.createAgentSession.mockImplementation(async (options) => {
      const index = createCount++;
      let listener: ((event: AgentSessionEvent) => void) | undefined;
      const messages = [
        {
          role: 'assistant',
          content: [{ type: 'text', text: '' }],
          model: 'gpt-5.5',
          stopReason: 'stop',
        },
      ];
      const subagentTool = options.customTools.find((candidate: { name: string }) => candidate.name === 'subagent');
      if (index < 4) expect(subagentTool).toBeTruthy();
      else expect(subagentTool).toBeUndefined();

      return {
        session: {
          sessionId: `pi-session-${index}`,
          messages,
          async prompt(prompt: string) {
            prompts.push(`${index}:${prompt}`);
            if (index < 4) {
              const toolResult = await subagentTool!.execute(
                `tool-${index}`,
                { agent: 'explore', task: `child-${index}` },
                undefined,
                undefined,
                undefined,
              );
              const content = toolResult.content[0];
              messages[0]!.content[0]!.text = content?.type === 'text' ? content.text : '';
              return;
            }

            listener?.({
              type: 'tool_execution_start',
              toolName: 'read',
              toolCallId: 'subagent-skill-read',
              args: { path: '/workspace/.deputies-skills/group/skill-review/revision-review-1/review/SKILL.md' },
            });
            listener?.({
              type: 'tool_execution_end',
              toolName: 'read',
              toolCallId: 'subagent-skill-read',
              isError: false,
              result: { content: [{ type: 'text', text: '# Review' }] },
            });
            messages[0]!.content[0]!.text = 'leaf result';
          },
          abort: vi.fn(),
          dispose: vi.fn(),
          subscribe: vi.fn((callback: (event: AgentSessionEvent) => void) => {
            listener = callback;
            return () => {
              listener = undefined;
            };
          }),
        },
        extensionsResult: {},
      };
    });

    const events: NormalizedEvent[] = [];
    const result = await new PiRunner({
      model: 'openai-codex/gpt-5.5',
      authBase64: Buffer.from('{}').toString('base64'),
      skills: { repoScanEnabled: false, listForRun },
    }).run({
      sessionId: 'session-1',
      runId: 'run-1',
      messageId: 'message-1',
      ownerGroupId: 'group-1',
      prompt: 'parent task',
      context: { skills: ['review'] },
      skillInvocations: [{ name: 'review' }],
      sandbox: createMemorySandbox(),
      emit: async (event) => {
        events.push(event);
      },
    });

    expect(result.text).toBe('leaf result');
    expect(createCount).toBe(5);
    expect(prompts[0]).toContain(
      '0:<skill name="review" location="/workspace/.deputies-skills/group/skill-review/revision-review-1/review/SKILL.md">',
    );
    expect(prompts[0]).toContain(
      'References are relative to /workspace/.deputies-skills/group/skill-review/revision-review-1/review.',
    );
    expect(prompts[0]).toContain('Review carefully.\n</skill>\n\nparent task');
    expect(prompts.slice(1)).toEqual(['1:child-0', '2:child-1', '3:child-2', '4:child-3']);
    expect(listForRun).toHaveBeenCalledTimes(2);
    expect(piMock.resourceLoaderOptions).toHaveLength(5);
    for (const loaderOptions of piMock.resourceLoaderOptions) {
      expect(loaderOptions.noSkills).toBe(true);
      expect(loaderOptions.skillsOverride?.({ skills: [], diagnostics: [] }).skills).toEqual([]);
    }
    expect(
      events
        .filter((event) => event.type === 'skill_invoked')
        .map((event) => [event.payload.trigger, event.payload.ref]),
    ).toEqual([['user', 'skill-review']]);
  });

  it('registers MCP tools, shares them with subagents, and closes connections', async () => {
    const close = vi.fn(async () => {});
    const callTool = vi.fn(async (_toolName: string, args: Record<string, unknown>) => `mcp:${String(args.query)}`);
    const connection: McpConnection = {
      name: 'executor',
      tools: [
        {
          name: 'mcp__executor__execute',
          originalName: 'execute',
          description: 'Run Executor code',
          parameters: { type: 'object', properties: { query: { type: 'string' } } },
        },
      ],
      callTool,
      close,
    };
    const connect = vi.fn(async () => connection);
    let createCount = 0;

    piMock.createAgentSession.mockImplementation(async (options) => {
      const index = createCount++;
      const messages = [
        {
          role: 'assistant',
          content: [{ type: 'text', text: '' }],
          model: 'gpt-5.5',
          stopReason: 'stop',
        },
      ];
      const mcpTool = options.customTools.find(
        (candidate: { name: string }) => candidate.name === 'mcp__executor__execute',
      );
      expect(mcpTool).toBeTruthy();
      return {
        session: {
          sessionId: `pi-session-${index}`,
          messages,
          async prompt() {
            if (index === 0) {
              const parentResult = await mcpTool!.execute(
                'tool-1',
                { query: 'parent' },
                undefined,
                undefined,
                undefined,
              );
              const subagentTool = options.customTools.find(
                (candidate: { name: string }) => candidate.name === 'subagent',
              );
              const childResult = await subagentTool!.execute(
                'tool-2',
                { agent: 'explore', task: 'child task' },
                undefined,
                undefined,
                undefined,
              );
              messages[0]!.content[0]!.text = `${parentResult.content[0]!.text}\n${childResult.content[0]!.text}`;
              return;
            }
            const childResult = await mcpTool!.execute('tool-3', { query: 'child' }, undefined, undefined, undefined);
            messages[0]!.content[0]!.text = childResult.content[0]!.text;
          },
          abort: vi.fn(),
          dispose: vi.fn(),
          subscribe: vi.fn(() => () => {}),
        },
        extensionsResult: {},
      };
    });

    const result = await new PiRunner({
      model: 'openai-codex/gpt-5.5',
      authBase64: Buffer.from('{}').toString('base64'),
      mcp: {
        servers: [{ name: 'executor', url: 'https://executor.example/mcp', transport: 'streamable-http' }],
        connectTimeoutMs: 10_000,
        toolTimeoutMs: 60_000,
        toolResultMaxChars: 100_000,
        responseMaxBytes: 5 * 1024 * 1024,
        connect,
      },
    }).run({
      sessionId: 'session-1',
      runId: 'run-1',
      messageId: 'message-1',
      prompt: 'use executor',
      context: {},
      sandbox: createMemorySandbox(),
      emit: async () => {},
    });

    expect(result.text).toBe('mcp:parent\nmcp:child');
    expect(connect).toHaveBeenCalledTimes(1);
    expect(callTool).toHaveBeenCalledTimes(2);
    expect(createCount).toBe(2);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('keeps Pi runs alive when an MCP server is unavailable and prepends a prompt note', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const prompt = vi.fn();
    piMock.createAgentSession.mockResolvedValue({
      session: {
        sessionId: 'pi-session',
        messages: [
          {
            role: 'assistant',
            content: [{ type: 'text', text: 'continued without mcp' }],
            model: 'gpt-5.5',
            stopReason: 'stop',
          },
        ],
        prompt,
        abort: vi.fn(),
        dispose: vi.fn(),
        subscribe: vi.fn(() => () => {}),
      },
      extensionsResult: {},
    });
    const connect = vi.fn(async () => {
      throw new Error('secret-token-from-transport');
    });

    const result = await new PiRunner({
      model: 'openai-codex/gpt-5.5',
      authBase64: Buffer.from('{}').toString('base64'),
      mcp: {
        servers: [{ name: 'executor', url: 'https://executor.example/mcp', transport: 'streamable-http' }],
        connectTimeoutMs: 10_000,
        toolTimeoutMs: 60_000,
        toolResultMaxChars: 100_000,
        responseMaxBytes: 5 * 1024 * 1024,
        connect,
      },
    }).run({
      sessionId: 'session-1',
      runId: 'run-1',
      messageId: 'message-1',
      prompt: 'hello',
      context: {},
      sandbox: createMemorySandbox(),
      emit: async () => {},
    });

    expect(result.text).toBe('continued without mcp');
    expect(prompt).toHaveBeenCalledWith(
      expect.stringContaining('Note: MCP tools from server "executor" are unavailable this run.'),
      { expandPromptTemplates: false },
    );
    expect(prompt.mock.calls[0]?.[0]).toContain('\n\nhello');
    expect(prompt.mock.calls[0]?.[0]).not.toContain('secret-token-from-transport');
    expect(warn).toHaveBeenCalledWith('MCP server "executor" is unavailable this run (unknown).');
  });

  it('continues archived environment sessions and prepends the saved-snapshot warning once', async () => {
    const services = createServices(new MemoryStore());
    const environment = await services.environments.create({
      name: 'Product surface',
      ownerGroupId: defaultGroupId,
      repositories: [{ provider: 'github', owner: 'manaflow-ai', repo: 'manaflow', primary: true }],
    });
    const snapshot = await services.environments.resolveForGroup({
      environmentId: environment.id,
      groupId: defaultGroupId,
    });
    await services.environments.archive(environment.id);
    const prompt = vi.fn();
    piMock.createAgentSession.mockResolvedValue({
      session: {
        sessionId: 'pi-session',
        messages: [
          {
            role: 'assistant',
            content: [{ type: 'text', text: 'continued from snapshot' }],
            model: 'gpt-5.5',
            stopReason: 'stop',
          },
        ],
        prompt,
        abort: vi.fn(),
        dispose: vi.fn(),
        subscribe: vi.fn(() => () => {}),
      },
      extensionsResult: {},
    });

    const result = await new PiRunner({
      model: 'openai-codex/gpt-5.5',
      authBase64: Buffer.from('{}').toString('base64'),
      environments: services.environments,
      repositoryAccess: {
        github: {
          async getRepositoryAccess() {
            return githubAccess;
          },
        },
      },
    }).run({
      sessionId: 'session-1',
      runId: 'run-1',
      messageId: 'message-1',
      prompt: 'continue',
      context: { environment: snapshot },
      ownerGroupId: defaultGroupId,
      sandbox: createMemorySandbox(),
      emit: async () => {},
    });

    expect(result.text).toBe('continued from snapshot');
    const prompted = prompt.mock.calls[0]?.[0] as string;
    expect(prompted.match(/saved environment snapshot/g)).toHaveLength(1);
    expect(prompted).toContain('\n\ncontinue');
  });

  it('closes MCP connections when Pi setup fails after connecting', async () => {
    const close = vi.fn(async () => {});
    const connection: McpConnection = {
      name: 'executor',
      tools: [],
      callTool: vi.fn(),
      close,
    };
    const connect = vi.fn(async () => connection);
    const sessionStore = {
      load: vi.fn(async () => {
        throw new Error('lease failed');
      }),
      save: vi.fn(async () => {}),
    };

    await expect(
      new PiRunner({
        model: 'openai-codex/gpt-5.5',
        authBase64: Buffer.from('{}').toString('base64'),
        sessionStore,
        mcp: {
          servers: [{ name: 'executor', url: 'https://executor.example/mcp', transport: 'streamable-http' }],
          connectTimeoutMs: 10_000,
          toolTimeoutMs: 60_000,
          toolResultMaxChars: 100_000,
          responseMaxBytes: 5 * 1024 * 1024,
          connect,
        },
      }).run({
        sessionId: 'session-1',
        runId: 'run-1',
        messageId: 'message-1',
        prompt: 'hello',
        context: {},
        sandbox: createMemorySandbox(),
        emit: async () => {},
      }),
    ).rejects.toThrow('lease failed');

    expect(connect).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(piMock.createAgentSession).not.toHaveBeenCalled();
  });

  it('closes MCP connections when a Pi run fails', async () => {
    const close = vi.fn(async () => {});
    const connection: McpConnection = {
      name: 'executor',
      tools: [],
      callTool: vi.fn(),
      close,
    };
    piMock.createAgentSession.mockResolvedValue({
      session: {
        sessionId: 'pi-session',
        messages: [
          { role: 'assistant', content: [{ type: 'text', text: '' }], stopReason: 'error', errorMessage: 'Pi failed' },
        ],
        prompt: vi.fn(async () => {}),
        abort: vi.fn(),
        dispose: vi.fn(),
        subscribe: vi.fn(() => () => {}),
      },
      extensionsResult: {},
    });

    await expect(
      new PiRunner({
        model: 'openai-codex/gpt-5.5',
        authBase64: Buffer.from('{}').toString('base64'),
        mcp: {
          servers: [{ name: 'executor', url: 'https://executor.example/mcp', transport: 'streamable-http' }],
          connectTimeoutMs: 10_000,
          toolTimeoutMs: 60_000,
          toolResultMaxChars: 100_000,
          responseMaxBytes: 5 * 1024 * 1024,
          connect: vi.fn(async () => connection),
        },
      }).run({
        sessionId: 'session-1',
        runId: 'run-1',
        messageId: 'message-1',
        prompt: 'hello',
        context: {},
        sandbox: createMemorySandbox(),
        emit: async () => {},
      }),
    ).rejects.toThrow('Pi failed');

    expect(close).toHaveBeenCalledTimes(1);
  });

  it('closes MCP connections when a Pi run is aborted', async () => {
    const close = vi.fn(async () => {});
    const controller = new AbortController();
    const abort = vi.fn();
    const connection: McpConnection = {
      name: 'executor',
      tools: [],
      callTool: vi.fn(),
      close,
    };
    piMock.createAgentSession.mockResolvedValue({
      session: {
        sessionId: 'pi-session',
        messages: [{ role: 'assistant', content: [{ type: 'text', text: 'late' }], stopReason: 'stop' }],
        prompt: vi.fn(async () => {
          controller.abort();
        }),
        abort,
        dispose: vi.fn(),
        subscribe: vi.fn(() => () => {}),
      },
      extensionsResult: {},
    });

    await expect(
      new PiRunner({
        model: 'openai-codex/gpt-5.5',
        authBase64: Buffer.from('{}').toString('base64'),
        mcp: {
          servers: [{ name: 'executor', url: 'https://executor.example/mcp', transport: 'streamable-http' }],
          connectTimeoutMs: 10_000,
          toolTimeoutMs: 60_000,
          toolResultMaxChars: 100_000,
          responseMaxBytes: 5 * 1024 * 1024,
          connect: vi.fn(async () => connection),
        },
      }).run({
        sessionId: 'session-1',
        runId: 'run-1',
        messageId: 'message-1',
        prompt: 'hello',
        context: {},
        sandbox: createMemorySandbox(),
        emit: async () => {},
        signal: controller.signal,
      }),
    ).rejects.toThrow('Operation aborted');

    expect(abort).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('passes MCP tool-call abort signals through the Pi tool adapter', async () => {
    const controller = new AbortController();
    const callTool = vi.fn(async (_toolName: string, _args: Record<string, unknown>, signal?: AbortSignal) => {
      expect(signal).toBe(controller.signal);
      return 'mcp ok';
    });
    const connection: McpConnection = {
      name: 'executor',
      tools: [
        {
          name: 'mcp__executor__execute',
          originalName: 'execute',
          description: 'Run Executor code',
          parameters: { type: 'object', properties: {} },
        },
      ],
      callTool,
      close: vi.fn(async () => {}),
    };

    piMock.createAgentSession.mockImplementation(async (options) => {
      const mcpTool = options.customTools.find(
        (candidate: { name: string }) => candidate.name === 'mcp__executor__execute',
      );
      const messages = [{ role: 'assistant', content: [{ type: 'text', text: '' }], stopReason: 'stop' }];
      return {
        session: {
          sessionId: 'pi-session',
          messages,
          async prompt() {
            const result = await mcpTool!.execute(
              'tool-1',
              { query: 'hello' },
              controller.signal,
              undefined,
              undefined,
            );
            messages[0]!.content[0]!.text = result.content[0]!.type === 'text' ? result.content[0]!.text : '';
          },
          abort: vi.fn(),
          dispose: vi.fn(),
          subscribe: vi.fn(() => () => {}),
        },
        extensionsResult: {},
      };
    });

    const result = await new PiRunner({
      model: 'openai-codex/gpt-5.5',
      authBase64: Buffer.from('{}').toString('base64'),
      mcp: {
        servers: [{ name: 'executor', url: 'https://executor.example/mcp', transport: 'streamable-http' }],
        connectTimeoutMs: 10_000,
        toolTimeoutMs: 60_000,
        toolResultMaxChars: 100_000,
        responseMaxBytes: 5 * 1024 * 1024,
        connect: vi.fn(async () => connection),
      },
    }).run({
      sessionId: 'session-1',
      runId: 'run-1',
      messageId: 'message-1',
      prompt: 'hello',
      context: {},
      sandbox: createMemorySandbox(),
      emit: async () => {},
    });

    expect(result.text).toBe('mcp ok');
    expect(callTool).toHaveBeenCalledTimes(1);
  });

  it('surfaces redacted MCP tool errors at the Pi runner level', async () => {
    const connection: McpConnection = {
      name: 'executor',
      tools: [
        {
          name: 'mcp__executor__execute',
          originalName: 'execute',
          description: 'Run Executor code',
          parameters: { type: 'object', properties: {} },
        },
      ],
      callTool: vi.fn(async () => {
        throw new Error('MCP tool "execute" from server "executor" failed (unauthorized).');
      }),
      close: vi.fn(async () => {}),
    };
    piMock.createAgentSession.mockImplementation(async (options) => {
      const mcpTool = options.customTools.find(
        (candidate: { name: string }) => candidate.name === 'mcp__executor__execute',
      );
      return {
        session: {
          sessionId: 'pi-session',
          messages: [{ role: 'assistant', content: [{ type: 'text', text: '' }], stopReason: 'stop' }],
          async prompt() {
            await mcpTool!.execute('tool-1', { query: 'hello' }, undefined, undefined, undefined);
          },
          abort: vi.fn(),
          dispose: vi.fn(),
          subscribe: vi.fn(() => () => {}),
        },
        extensionsResult: {},
      };
    });

    await expect(
      new PiRunner({
        model: 'openai-codex/gpt-5.5',
        authBase64: Buffer.from('{}').toString('base64'),
        mcp: {
          servers: [{ name: 'executor', url: 'https://executor.example/mcp', transport: 'streamable-http' }],
          connectTimeoutMs: 10_000,
          toolTimeoutMs: 60_000,
          toolResultMaxChars: 100_000,
          responseMaxBytes: 5 * 1024 * 1024,
          connect: vi.fn(async () => connection),
        },
      }).run({
        sessionId: 'session-1',
        runId: 'run-1',
        messageId: 'message-1',
        prompt: 'hello',
        context: {},
        sandbox: createMemorySandbox(),
        emit: async () => {},
      }),
    ).rejects.toThrow('MCP tool "execute" from server "executor" failed (unauthorized).');
  });

  it('rehydrates stored sessions and saves the updated Pi session data', async () => {
    const storedSession: PiSessionData = {
      version: PI_SESSION_DATA_VERSION,
      header: { id: 'session-1' } as never,
      entries: [{ type: 'message', role: 'user', content: 'previous prompt' } as never],
    };
    const sessionStore = {
      load: vi.fn(async () => storedSession),
      save: vi.fn(async () => {}),
    };
    const messages = [
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'continued' }],
        model: 'gpt-5.5',
        stopReason: 'stop',
      },
    ];

    piMock.createAgentSession.mockResolvedValue({
      session: {
        sessionId: 'pi-session',
        messages,
        prompt: vi.fn(async () => {}),
        abort: vi.fn(),
        dispose: vi.fn(),
        subscribe: vi.fn(() => () => {}),
      },
      extensionsResult: {},
    });

    const result = await new PiRunner({
      model: 'openai-codex/gpt-5.5',
      authBase64: Buffer.from('{}').toString('base64'),
      sessionStore,
    }).run({
      sessionId: 'session-1',
      runId: 'run-1',
      messageId: 'message-1',
      prompt: 'continue',
      context: {},
      sandbox: createMemorySandbox(),
      emit: async () => {},
    });

    expect(result).toEqual({ text: 'continued', model: 'gpt-5.5' });
    expect(sessionStore.load).toHaveBeenCalledWith('session-1');
    expect(piMock.openSessionCalls).toHaveLength(1);
    expect(piMock.openSessionCalls[0]).toMatchObject({ agentDir: expect.any(String), cwd: '/workspace' });
    expect(
      piMock.openSessionCalls[0]?.jsonl
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line)),
    ).toEqual([storedSession.header, ...storedSession.entries]);
    expect(sessionStore.save).toHaveBeenCalledWith('session-1', storedSession);
  });

  it('does not persist successful stored turns after losing run ownership', async () => {
    const storedSession: PiSessionData = {
      version: PI_SESSION_DATA_VERSION,
      header: { id: 'session-1' } as never,
      entries: [],
    };
    const sessionStore = {
      load: vi.fn(async () => storedSession),
      save: vi.fn(async () => {}),
    };

    piMock.createAgentSession.mockResolvedValue({
      session: {
        sessionId: 'pi-session',
        messages: [
          {
            role: 'assistant',
            content: [{ type: 'text', text: 'completed after lease loss' }],
            model: 'gpt-5.5',
            stopReason: 'stop',
          },
        ],
        prompt: vi.fn(async () => {}),
        abort: vi.fn(),
        dispose: vi.fn(),
        subscribe: vi.fn(() => () => {}),
      },
      extensionsResult: {},
    });

    const result = await new PiRunner({
      model: 'openai-codex/gpt-5.5',
      authBase64: Buffer.from('{}').toString('base64'),
      sessionStore,
    }).run({
      sessionId: 'session-1',
      runId: 'run-1',
      messageId: 'message-1',
      prompt: 'continue',
      context: {},
      sandbox: createMemorySandbox(),
      emit: async () => {},
      shouldPersist: async () => false,
    });

    expect(result.text).toBe('completed after lease loss');
    expect(sessionStore.save).not.toHaveBeenCalled();
  });

  it('does not persist failed stored turns', async () => {
    const storedSession: PiSessionData = {
      version: PI_SESSION_DATA_VERSION,
      header: { id: 'session-1' } as never,
      entries: [],
    };
    const sessionStore = {
      load: vi.fn(async () => storedSession),
      save: vi.fn(async () => {}),
    };

    piMock.createAgentSession.mockResolvedValue({
      session: {
        sessionId: 'pi-session',
        messages: [
          {
            role: 'assistant',
            content: [{ type: 'text', text: 'failed' }],
            stopReason: 'error',
            errorMessage: 'Pi failed',
          },
        ],
        prompt: vi.fn(async () => {}),
        abort: vi.fn(),
        dispose: vi.fn(),
        subscribe: vi.fn(() => () => {}),
      },
      extensionsResult: {},
    });

    await expect(
      new PiRunner({
        model: 'openai-codex/gpt-5.5',
        authBase64: Buffer.from('{}').toString('base64'),
        sessionStore,
      }).run({
        sessionId: 'session-1',
        runId: 'run-1',
        messageId: 'message-1',
        prompt: 'continue',
        context: {},
        sandbox: createMemorySandbox(),
        emit: async () => {},
      }),
    ).rejects.toThrow('Pi failed');

    expect(sessionStore.save).not.toHaveBeenCalled();
  });

  it('cleans up temporary session files when rehydration fails', async () => {
    const storedSession: PiSessionData = {
      version: PI_SESSION_DATA_VERSION,
      header: { id: 'session-1' } as never,
      entries: [],
    };
    const sessionStore = {
      load: vi.fn(async () => storedSession),
      save: vi.fn(async () => {}),
    };
    piMock.openSessionError = new Error('open failed');

    await expect(
      new PiRunner({
        model: 'openai-codex/gpt-5.5',
        authBase64: Buffer.from('{}').toString('base64'),
        sessionStore,
      }).run({
        sessionId: 'session-1',
        runId: 'run-1',
        messageId: 'message-1',
        prompt: 'continue',
        context: {},
        sandbox: createMemorySandbox(),
        emit: async () => {},
      }),
    ).rejects.toThrow('open failed');

    const tempDir = path.dirname(piMock.openSessionCalls[0]!.sessionFile);
    await expect(access(tempDir)).rejects.toThrow();
    expect(piMock.createAgentSession).not.toHaveBeenCalled();
  });

  it('registers artifact and stores sandbox files as product artifacts', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'deputies-pi-artifact-tool-'));
    try {
      const store = new MemoryStore();
      const eventsService = new EventService(store);
      const artifacts = new ArtifactService(store, eventsService, new FilesystemArtifactObjectStorage(tempDir));
      await store.createSession({
        id: 'session-1',
        status: 'active',
        title: 'Pi artifact session',
        ownerGroupId: defaultGroupId,
        visibility: 'organization',
        writePolicy: 'group_members',
        createdAt: new Date(),
        updatedAt: new Date(),
        context: {},
      });
      const sandbox = createMemorySandbox();
      await sandbox.fs!.writeFile('/workspace/report.txt', 'tool artifact');
      const messages = [
        {
          role: 'assistant',
          content: [{ type: 'text', text: '' }],
          model: 'gpt-5.5',
          stopReason: 'stop',
        },
      ];

      piMock.createAgentSession.mockImplementation(async (options) => {
        expect(options.noTools).toBe('builtin');
        expect(options.tools).toBeUndefined();
        const tool = options.customTools.find((candidate: { name: string }) => candidate.name === 'artifact');
        expect(tool).toBeTruthy();
        return {
          session: {
            sessionId: 'pi-session',
            messages,
            async prompt() {
              const toolResult = await tool!.execute(
                'tool-1',
                {
                  action: 'create',
                  path: '/workspace/report.txt',
                  type: 'report',
                  title: 'Report',
                  contentType: 'text/plain',
                },
                undefined,
                undefined,
                undefined,
              );
              const result = JSON.parse(toolResult.content[0]!.text) as { downloadUrl: string };
              messages[0]!.content[0]!.text = `Created ${result.downloadUrl}`;
            },
            abort: vi.fn(),
            dispose: vi.fn(),
            subscribe: vi.fn(() => () => {}),
          },
          extensionsResult: {},
        };
      });

      const result = await new PiRunner({
        model: 'openai-codex/gpt-5.5',
        authBase64: Buffer.from('{}').toString('base64'),
        artifacts,
        artifactToolMaxBytes: 1024,
      }).run({
        sessionId: 'session-1',
        runId: 'run-1',
        messageId: 'message-1',
        prompt: 'publish report',
        context: {},
        sandbox,
        emit: async () => {},
      });

      const records = await store.getArtifacts('session-1');
      expect(records).toMatchObject([
        {
          type: 'report',
          title: 'Report',
          storageKey: expect.any(String),
          payload: {
            sourcePath: '/workspace/report.txt',
            storage: 'internal',
            contentType: 'text/plain',
            fileName: 'report.txt',
          },
        },
      ]);
      expect(result.text).toContain(`/sessions/session-1/artifacts/${records[0]!.id}/download`);
      await expect(store.getEvents('session-1')).resolves.toMatchObject([{ type: 'artifact_created' }]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('registers service and updates published service context', async () => {
    const sandbox = createMemorySandbox();
    sandbox.metadata = { runtimeId: 'runtime-1' };
    let context: Record<string, unknown> = {};
    const messages = [
      {
        role: 'assistant',
        content: [{ type: 'text', text: '' }],
        model: 'gpt-5.5',
        stopReason: 'stop',
      },
    ];

    piMock.createAgentSession.mockImplementation(async (options) => {
      expect(options.noTools).toBe('builtin');
      expect(options.tools).toBeUndefined();
      const tool = options.customTools.find((candidate: { name: string }) => candidate.name === 'service');
      expect(tool).toBeTruthy();
      return {
        session: {
          sessionId: 'pi-session',
          messages,
          async prompt() {
            const toolResult = await tool!.execute(
              'tool-1',
              { action: 'publish', port: 5173, label: 'Web app', path: '/dashboard' },
              undefined,
              undefined,
              undefined,
            );
            const result = JSON.parse(toolResult.content[0]!.text) as { services: unknown[] };
            messages[0]!.content[0]!.text = `Published ${result.services.length} service`;
          },
          abort: vi.fn(),
          dispose: vi.fn(),
          subscribe: vi.fn(() => () => {}),
        },
        extensionsResult: {},
      };
    });

    const result = await new PiRunner({
      model: 'openai-codex/gpt-5.5',
      authBase64: Buffer.from('{}').toString('base64'),
      sandboxKeepalive: createKeepalive(),
    }).run({
      sessionId: 'session-1',
      runId: 'run-1',
      messageId: 'message-1',
      prompt: 'publish service',
      context,
      sandbox,
      async updateSessionContext(next) {
        context = { ...context, ...next };
        return context;
      },
      emit: async () => {},
    });

    expect(result.text).toBe('Published 1 service');
    expect(context.services).toEqual([
      {
        port: 5173,
        label: 'Web app',
        path: '/dashboard',
        providerSandboxId: 'sandbox-1',
        runtimeId: 'runtime-1',
      },
    ]);
  });

  it('registers repository, gh, and authenticated git tools', async () => {
    const sandbox = createMemorySandbox();
    const events: NormalizedEvent[] = [];
    const messages = [
      {
        role: 'assistant',
        content: [{ type: 'text', text: '' }],
        model: 'gpt-5.5',
        stopReason: 'stop',
      },
    ];
    const fetchImpl = vi.fn(async () => {
      return new Response(JSON.stringify({ html_url: 'https://github.com/manaflow-ai/manaflow/pull/7', number: 7 }), {
        status: 201,
      });
    });
    vi.stubGlobal('fetch', fetchImpl);

    piMock.createAgentSession.mockImplementation(async (options) => {
      expect(options.noTools).toBe('builtin');
      expect(options.tools).toBeUndefined();
      const repositoryTool = options.customTools.find((candidate: { name: string }) => candidate.name === 'repository');
      const gitTool = options.customTools.find((candidate: { name: string }) => candidate.name === 'git');
      const ghTool = options.customTools.find((candidate: { name: string }) => candidate.name === 'gh');
      expect(repositoryTool).toBeTruthy();
      expect(gitTool).toBeTruthy();
      expect(ghTool).toBeTruthy();
      return {
        session: {
          sessionId: 'pi-session',
          messages,
          async prompt() {
            await repositoryTool!.execute(
              'tool-1',
              { action: 'set', owner: 'manaflow-ai', repo: 'manaflow' },
              undefined,
              undefined,
              undefined,
            );
            const prepared = await repositoryTool!.execute(
              'tool-2',
              { action: 'prepare' },
              undefined,
              undefined,
              undefined,
            );
            const pushed = await gitTool!.execute(
              'tool-3',
              { args: ['push', 'origin', 'sp/test'] },
              undefined,
              undefined,
              undefined,
            );
            const pullRequest = await ghTool!.execute(
              'tool-4',
              {
                args: ['pr', 'create', '--title', 'Test PR', '--body', 'Body', '--head', 'sp/test', '--base', 'main'],
              },
              undefined,
              undefined,
              undefined,
            );
            messages[0]!.content[0]!.text = [
              prepared.content[0]!.type === 'text' ? prepared.content[0]!.text : '',
              pushed.content[0]!.type === 'text' ? pushed.content[0]!.text : '',
              pullRequest.content[0]!.type === 'text' ? pullRequest.content[0]!.text : '',
            ].join('\n');
          },
          abort: vi.fn(),
          dispose: vi.fn(),
          subscribe: vi.fn(() => () => {}),
        },
        extensionsResult: {},
      };
    });

    try {
      const result = await new PiRunner({
        model: 'openai-codex/gpt-5.5',
        authBase64: Buffer.from('{}').toString('base64'),
        repositoryAccess: {
          github: {
            async getRepositoryAccess() {
              return githubAccess;
            },
            listAllowedRepositories() {
              return ['manaflow-ai/manaflow'];
            },
          },
        },
      }).run({
        sessionId: 'session-1',
        runId: 'run-1',
        messageId: 'message-1',
        prompt: 'work in repo',
        context: {},
        sandbox,
        emit: async (event) => {
          events.push(event);
        },
      });

      expect(result.text).toContain('Repository prepared: manaflow-ai/manaflow');
      expect(result.text).toContain('exitCode: 0');
      expect(result.text).toContain('https://github.com/manaflow-ai/manaflow/pull/7');
      expect(fetchImpl).toHaveBeenCalledWith(
        'https://api.github.com/repos/manaflow-ai/manaflow/pulls',
        expect.objectContaining({ method: 'POST' }),
      );
      expect(events.map((event) => event.type)).toContain('repository_ready');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('runs repository setup scripts after repository_ready and sends failures to the prompt', async () => {
    const execCalls: ExecCall[] = [];
    const sandbox = createMemorySandbox();
    const execResponses = [
      { exitCode: 0, stdout: 'prepared\ndeputies-repo-setup:cloned=1\n', stderr: '' },
      { exitCode: 0, stdout: 'deputies-setup:run reason=cloned hash=abc123 exec=1\n', stderr: '' },
      { exitCode: 1, stdout: 'setup stdout', stderr: 'setup stderr' },
    ];
    sandbox.exec = async (input) => {
      execCalls.push({
        command: input.command,
        ...(input.cwd ? { cwd: input.cwd } : {}),
        ...(input.env ? { env: input.env } : {}),
        ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
      });
      const now = new Date();
      return {
        ...(execResponses.shift() ?? { exitCode: 0, stdout: '', stderr: '' }),
        startedAt: now,
        completedAt: now,
      };
    };
    const prompt = vi.fn();
    const messages = [
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'handled setup failure' }],
        model: 'gpt-5.5',
        stopReason: 'stop',
      },
    ];
    piMock.createAgentSession.mockResolvedValue({
      session: {
        sessionId: 'pi-session',
        messages,
        prompt,
        abort: vi.fn(),
        dispose: vi.fn(),
        subscribe: vi.fn(() => () => {}),
      },
      extensionsResult: {},
    });
    const events: NormalizedEvent[] = [];

    const result = await new PiRunner({
      model: 'openai-codex/gpt-5.5',
      authBase64: Buffer.from('{}').toString('base64'),
      repositoryAccess: {
        github: {
          async getRepositoryAccess() {
            return githubAccess;
          },
        },
      },
      setupScript: { enabled: true, timeoutMs: 600_000 },
    }).run({
      sessionId: 'session-1',
      runId: 'run-1',
      messageId: 'message-1',
      prompt: 'work in repo',
      context: { repository: { provider: 'github', owner: 'manaflow-ai', repo: 'manaflow' } },
      sandbox,
      emit: async (event) => {
        events.push(event);
      },
    });

    expect(result.text).toBe('handled setup failure');
    expect(execCalls).toHaveLength(3);
    expect(execCalls[0]?.cwd).toBe('/workspace');
    expect(execCalls[1]).toMatchObject({ cwd: '/workspace/manaflow-ai/manaflow', timeoutMs: 30_000 });
    expect(execCalls[2]).toMatchObject({
      cwd: '/workspace/manaflow-ai/manaflow',
      env: { DEPUTIES: '1', DEPUTIES_SETUP: '1' },
      timeoutMs: 600_000,
    });
    expect(events.map((event) => event.type)).toEqual([
      'run_started',
      'skills_loaded',
      'repository_ready',
      'setup_script_started',
      'setup_script_finished',
      'run_completed',
    ]);
    expect(events[4]?.payload).toMatchObject({ isError: true, stdoutTail: 'setup stdout', stderrTail: 'setup stderr' });
    expect(prompt).toHaveBeenCalledWith(expect.stringContaining('.agents/setup failed'), {
      expandPromptTemplates: false,
    });
    expect(prompt.mock.calls[0]?.[0]).toContain('setup stdout\nsetup stderr');
  });

  it('does not probe for disabled repository setup scripts', async () => {
    const execCalls: ExecCall[] = [];
    const sandbox = createMemorySandbox();
    sandbox.exec = async (input) => {
      execCalls.push({ command: input.command, ...(input.cwd ? { cwd: input.cwd } : {}) });
      const now = new Date();
      return {
        exitCode: 0,
        stdout: 'prepared\ndeputies-repo-setup:cloned=1\n',
        stderr: '',
        startedAt: now,
        completedAt: now,
      };
    };
    const messages = [
      { role: 'assistant', content: [{ type: 'text', text: 'done' }], model: 'gpt-5.5', stopReason: 'stop' },
    ];
    piMock.createAgentSession.mockResolvedValue({
      session: {
        sessionId: 'pi-session',
        messages,
        prompt: vi.fn(),
        abort: vi.fn(),
        dispose: vi.fn(),
        subscribe: vi.fn(() => () => {}),
      },
      extensionsResult: {},
    });

    await new PiRunner({
      model: 'openai-codex/gpt-5.5',
      authBase64: Buffer.from('{}').toString('base64'),
      repositoryAccess: {
        github: {
          async getRepositoryAccess() {
            return githubAccess;
          },
        },
      },
      setupScript: { enabled: false, timeoutMs: 600_000 },
    }).run({
      sessionId: 'session-1',
      runId: 'run-1',
      messageId: 'message-1',
      prompt: 'work in repo',
      context: { repository: { provider: 'github', owner: 'manaflow-ai', repo: 'manaflow' } },
      sandbox,
      emit: async () => {},
    });

    expect(execCalls).toHaveLength(1);
    expect(execCalls[0]?.command).toContain(
      'git -c \'http.https://github.com/manaflow-ai/manaflow.git.extraHeader\'="$auth_header" -c core.hooksPath=/dev/null clone',
    );
    expect(execCalls[0]?.command).toContain('unset GITHUB_AUTH_HEADER');
    expect(execCalls[0]?.command).toContain('export GIT_CONFIG_GLOBAL=/dev/null');
    expect(execCalls[0]?.command).toContain('export GIT_CONFIG_SYSTEM=/dev/null');
  });

  it('rejects artifact paths outside the sandbox workspace and enforces post-read size', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'deputies-pi-artifact-tool-'));
    try {
      const store = new MemoryStore();
      const eventsService = new EventService(store);
      const artifacts = new ArtifactService(store, eventsService, new FilesystemArtifactObjectStorage(tempDir));
      await store.createSession({
        id: 'session-1',
        status: 'active',
        title: 'Pi artifact session',
        ownerGroupId: defaultGroupId,
        visibility: 'organization',
        writePolicy: 'group_members',
        createdAt: new Date(),
        updatedAt: new Date(),
        context: {},
      });
      const sandbox = createMemorySandbox();
      const services = {
        artifacts,
        sandbox,
        sessionId: 'session-1',
        runId: 'run-1',
        messageId: 'message-1',
        maxBytes: 4,
      };

      await sandbox.fs!.writeFile('/workspace/large.txt', '12345');
      const stat = sandbox.fs!.stat.bind(sandbox.fs!);
      sandbox.fs!.stat = async (filePath) => ({ ...(await stat(filePath)), size: 1 });
      await expect(
        createArtifactFromSandbox(services, { action: 'create', path: '/workspace/large.txt', type: 'file' }),
      ).rejects.toThrow('exceeds max size');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

describe('createSandboxPiToolDefinitions', () => {
  it('backs read, write, edit, bash, grep, find, and ls with the sandbox handle', async () => {
    const execCalls: ExecCall[] = [];
    const sandbox = createMemorySandbox({ execCalls });
    const tools = createSandboxPiToolDefinitions(sandbox, sandbox.workspacePath);

    await executeTool(tools, 'write', { path: 'hello.txt', content: 'hello world' });
    await executeTool(tools, 'write', { path: 'src/app.ts', content: 'const greeting = "hello";\n' });
    await executeTool(tools, 'write', { path: 'src/notes.md', content: 'hello notes\n' });

    const readResult = await executeTool(tools, 'read', { path: 'hello.txt' });
    expect(textResult(readResult)).toBe('hello world');

    await executeTool(tools, 'edit', {
      path: 'hello.txt',
      edits: [{ oldText: 'world', newText: 'pi' }],
    });
    expect(await sandbox.fs!.readFile('/workspace/hello.txt')).toBe('hello pi');

    const bashResult = await executeTool(tools, 'bash', { command: 'pwd' });
    expect(textResult(bashResult)).toContain('ran: pwd');
    expect(execCalls).toHaveLength(1);
    expect(execCalls[0]).toMatchObject({ command: 'pwd', cwd: '/workspace' });
    expect(execCalls[0]?.env).toBeUndefined();

    const grepResult = await executeTool(tools, 'grep', { pattern: 'greeting', glob: '*.ts' });
    expect(textResult(grepResult)).toContain('src/app.ts:1: const greeting = "hello";');
    expect(textResult(grepResult)).not.toContain('notes.md');

    const cappedGrepResult = await executeTool(tools, 'grep', { pattern: 'greeting', context: 99, limit: 999 });
    expect(cappedGrepResult.details).toMatchObject({ contextCapped: 10, limitCapped: 200 });

    const findResult = await executeTool(tools, 'find', { pattern: '*.ts' });
    expect(textResult(findResult)).toContain('src/app.ts');
    expect(textResult(findResult)).not.toContain('src/notes.md');

    const highLimitFindResult = await executeTool(tools, 'find', { pattern: '*.ts', limit: 999_999 });
    expect(textResult(highLimitFindResult)).toContain('src/app.ts');

    const lsResult = await executeTool(tools, 'ls', { path: 'src' });
    expect(textResult(lsResult)).toContain('app.ts');
    expect(textResult(lsResult)).toContain('notes.md');
    expect(execCalls).toHaveLength(5);
    expect(execCalls[0]).toMatchObject({ command: 'pwd', cwd: '/workspace' });
    expect(execCalls[0]?.env).toBeUndefined();
    expect(execCalls[1]).toMatchObject({
      command: expect.stringContaining('rg --json'),
      cwd: '/workspace',
      timeoutMs: 30_000,
    });
    expect(execCalls[2]).toMatchObject({
      command: expect.stringContaining('--max-count 200'),
      cwd: '/workspace',
      timeoutMs: 30_000,
    });
    expect(execCalls[3]).toMatchObject({
      command: expect.stringContaining('fd'),
      cwd: '/workspace',
      timeoutMs: 30_000,
    });
    expect(execCalls[4]).toMatchObject({
      command: expect.stringContaining('--max-results 5000'),
      cwd: '/workspace',
      timeoutMs: 30_000,
    });
  });

  it('passes find cancellation to the sandbox exec call', async () => {
    const sandbox = createMemorySandbox();
    const controller = new AbortController();
    const exec = vi.fn(async () => {
      const now = new Date();
      return { exitCode: 0, stdout: '/workspace/src/app.ts\n', stderr: '', startedAt: now, completedAt: now };
    });
    sandbox.exec = exec;

    await executeTool(
      createSandboxPiToolDefinitions(sandbox, sandbox.workspacePath),
      'find',
      { pattern: '*.ts' },
      controller.signal,
    );

    expect(exec).toHaveBeenCalledWith(expect.objectContaining({ signal: controller.signal }));
  });

  it('reports sandbox find truncation when the requested limit exceeds the remote cap', async () => {
    const sandbox = createMemorySandbox();
    const now = new Date();
    sandbox.exec = vi.fn(async () => ({
      exitCode: 0,
      stdout: Array.from({ length: 5000 }, (_, index) => `/workspace/f${index}.ts`).join('\n'),
      stderr: '',
      startedAt: now,
      completedAt: now,
    }));

    const result = await executeTool(createSandboxPiToolDefinitions(sandbox, sandbox.workspacePath), 'find', {
      pattern: '*.ts',
      limit: 999_999,
    });

    expect(result.details).toMatchObject({ resultLimitReached: 5000 });
    expect(textResult(result)).toContain('[5000 results limit reached]');
    expect(sandbox.exec).toHaveBeenCalledWith(
      expect.objectContaining({ command: expect.stringContaining('--max-results 5000') }),
    );
  });

  it('does not pass Pi worker environment to sandbox bash commands', async () => {
    const originalSecret = process.env.GITHUB_OAUTH_CLIENT_SECRET;
    process.env.GITHUB_OAUTH_CLIENT_SECRET = 'worker-secret';
    try {
      const execCalls: ExecCall[] = [];
      const sandbox = createMemorySandbox({ execCalls });

      await executeTool(createSandboxPiToolDefinitions(sandbox, sandbox.workspacePath), 'bash', {
        command: 'printenv',
      });

      expect(execCalls).toHaveLength(1);
      expect(execCalls[0]?.env).toBeUndefined();
    } finally {
      if (originalSecret === undefined) delete process.env.GITHUB_OAUTH_CLIENT_SECRET;
      else process.env.GITHUB_OAUTH_CLIENT_SECRET = originalSecret;
    }
  });

  it('skips grep context reads for large files', async () => {
    const sandbox = createMemorySandbox();
    await sandbox.fs!.writeFile('/workspace/large.txt', Buffer.alloc(1024 * 1024 + 1, 65));
    const now = new Date();
    sandbox.exec = async () => ({
      exitCode: 0,
      stdout: `${JSON.stringify({
        type: 'match',
        data: {
          path: { text: '/workspace/large.txt' },
          line_number: 1,
          lines: { text: 'A\n' },
        },
      })}\n`,
      stderr: '',
      startedAt: now,
      completedAt: now,
    });

    const result = await executeTool(createSandboxPiToolDefinitions(sandbox, sandbox.workspacePath), 'grep', {
      pattern: 'A',
      path: 'large.txt',
      context: 1,
    });

    expect(textResult(result)).toContain('context skipped; file exceeds 1048576 bytes');
    expect(result.details).toMatchObject({ linesTruncated: true });
  });
});

describe('PostgresPiSessionStore', () => {
  it('uses two-int advisory lock keys instead of hashtext', async () => {
    const queries: Array<{ text: string; values?: unknown[] }> = [];
    const client = {
      query: vi.fn(async (text: string, values?: unknown[]) => {
        queries.push({ text, ...(values ? { values } : {}) });
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const pool = { connect: vi.fn(async () => client) };
    const store = new PostgresPiSessionStore(pool as never);

    await expect(store.withLock('00000000-0000-4000-8000-000000000701', async () => 'locked')).resolves.toBe('locked');

    expect(queries).toEqual([
      { text: 'SELECT pg_advisory_lock($1::int, $2::int)', values: [0, 1793] },
      { text: 'SELECT pg_advisory_unlock($1::int, $2::int)', values: [0, 1793] },
    ]);
    expect(client.release).toHaveBeenCalledOnce();
  });
});

async function executeTool(
  tools: ReturnType<typeof createSandboxPiToolDefinitions>,
  name: string,
  params: unknown,
  signal?: AbortSignal,
): Promise<SandboxPiToolResult> {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`Missing tool: ${name}`);
  return tool.execute('tool-call', params, signal, undefined, undefined as never);
}

function textResult(result: SandboxPiToolResult): string {
  return result.content
    .filter((item) => item.type === 'text')
    .map((item) => item.text)
    .join('\n');
}

function createKeepalive(): SandboxKeepaliveService {
  return {
    async extend() {
      return {
        keepaliveUntil: new Date('2026-05-15T00:00:00.000Z'),
        providerSync: 'not_supported' as const,
        record: {} as never,
      };
    },
  } as unknown as SandboxKeepaliveService;
}

const githubAccess: GitHubRepositoryAccess = {
  provider: 'github',
  owner: 'manaflow-ai',
  repo: 'manaflow',
  cloneUrl: 'https://github.com/manaflow-ai/manaflow.git',
  expiresAt: new Date('2026-05-06T01:00:00.000Z'),
  auth: { type: 'bearer', token: 'ghs_secret_token' },
};

function createMemorySandbox(options: { execCalls?: ExecCall[] } = {}): SandboxHandle {
  const fs = new MemorySandboxFileSystem('/workspace');
  return {
    provider: 'memory',
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
    fs,
    async exec(input) {
      options.execCalls?.push({
        command: input.command,
        ...(input.cwd ? { cwd: input.cwd } : {}),
        ...(input.env ? { env: input.env } : {}),
        ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
      });
      const now = new Date();
      if (input.command.startsWith('rg ')) {
        return {
          exitCode: 0,
          stdout: `${JSON.stringify({
            type: 'match',
            data: {
              path: { text: '/workspace/src/app.ts' },
              line_number: 1,
              lines: { text: 'const greeting = "hello";\n' },
            },
          })}\n`,
          stderr: '',
          startedAt: now,
          completedAt: now,
        };
      }
      if (input.command.includes('exec fd') || input.command.includes('exec fdfind')) {
        return { exitCode: 0, stdout: '/workspace/src/app.ts\n', stderr: '', startedAt: now, completedAt: now };
      }
      return { exitCode: 0, stdout: `ran: ${input.command}`, stderr: '', startedAt: now, completedAt: now };
    },
  };
}
