import type { ToolDefinition } from '@earendil-works/pi-coding-agent';

const subagentOutputMaxBytes = 50 * 1024;

export type PiSubagentProfile = {
  name: string;
  aliases: string[];
  description: string;
  instructions: string;
};

export type PiSubagentRunInput = {
  agent: string;
  task: string;
  cwd?: string;
  signal?: AbortSignal;
};

export type PiSubagentRunResult = {
  agent: string;
  task: string;
  cwd: string;
  depth: number;
  text: string;
  model?: string;
  usage?: unknown;
};

export type PiSubagentToolServices = {
  run: (input: PiSubagentRunInput) => Promise<PiSubagentRunResult>;
};

const profiles: PiSubagentProfile[] = [
  {
    name: 'general',
    aliases: ['general-purpose', 'worker'],
    description: 'General-purpose subagent for delegated implementation or investigation work.',
    instructions:
      'You are a general-purpose subagent. Work autonomously on the delegated task, use the available tools as needed, verify important claims, and return a concise final result with any files changed, checks run, and residual risks.',
  },
  {
    name: 'explore',
    aliases: ['scout'],
    description: 'Read-oriented codebase reconnaissance and context gathering.',
    instructions:
      'You are an exploration subagent. Focus on codebase reconnaissance, relevant files, data flow, risks, and open questions. Do not edit files or make persistent changes unless the task explicitly asks you to.',
  },
  {
    name: 'planner',
    aliases: ['plan'],
    description: 'Grounded implementation planning without making changes.',
    instructions:
      'You are a planning subagent. Read enough context to produce a concrete, grounded implementation plan. Do not edit files. Include assumptions, sequencing, validation steps, and risks.',
  },
  {
    name: 'reviewer',
    aliases: ['review'],
    description: 'Independent code review and verification.',
    instructions:
      'You are a review subagent. Review the delegated work for bugs, regressions, missing tests, security issues, and unnecessary complexity. Prefer findings with file or command evidence. Do not edit files unless explicitly instructed.',
  },
];

export const piSubagentToolParameters = {
  type: 'object',
  additionalProperties: false,
  required: ['task'],
  properties: {
    agent: {
      type: 'string',
      description: `Subagent profile. Available profiles: ${profiles
        .map((profile) => [profile.name, ...profile.aliases].join('/'))
        .join(', ')}. Defaults to general.`,
    },
    task: { type: 'string', description: 'Focused task to delegate to the subagent.' },
    cwd: { type: 'string', description: 'Optional sandbox working directory for the subagent.' },
  },
} as const;

const piSubagentToolParametersForPi = piSubagentToolParameters as unknown as ToolDefinition['parameters'];

export function createPiSubagentToolDefinition(services: PiSubagentToolServices): ToolDefinition {
  return {
    name: 'subagent',
    label: 'subagent',
    description:
      'Delegate a focused task to an isolated Pi subagent with its own context window. Use this for independent research, planning, review, or larger delegated implementation work. The subagent returns only its final answer to this conversation.',
    promptSnippet: 'Delegate focused work to an isolated subagent context',
    promptGuidelines: [
      'Use subagent for independent exploration, planning, review, or larger delegated work that would clutter the main context.',
      'Do not use subagent for quick answers, tiny targeted edits, or latency-sensitive one-step work.',
      'Prefer agent=explore for reconnaissance, agent=planner for plans, agent=reviewer for independent review, and agent=general or worker for implementation.',
      'Subagents in this environment run inside the same Deputies sandbox and return a concise final result to you.',
      'Nested subagent delegation is available but capped at 4 levels deep.',
    ],
    parameters: piSubagentToolParametersForPi,
    executionMode: 'sequential',
    async execute(_toolCallId, params, signal) {
      const input = readSubagentInput(params as Record<string, unknown>, signal);
      const result = await services.run(input);
      const output = truncateOutput(result.text);
      return {
        content: [{ type: 'text', text: output.text || '(subagent completed with no text)' }],
        details: { ...result, truncated: output.truncated },
      };
    },
  };
}

export function resolvePiSubagentProfile(value: string | undefined): PiSubagentProfile {
  const name = value?.trim() || 'general';
  const profile = profiles.find((candidate) => candidate.name === name || candidate.aliases.includes(name));
  if (profile) return profile;
  const available = profiles.map((candidate) => [candidate.name, ...candidate.aliases].join('/')).join(', ');
  throw new Error(`Unknown subagent profile: ${name}. Available profiles: ${available}.`);
}

export function piSubagentSystemPrompt(basePrompt: string, profile: PiSubagentProfile): string {
  return [
    basePrompt,
    '',
    `<subagent name="${profile.name}">`,
    profile.instructions,
    '',
    'You are operating in an isolated child context. Return a concise final answer for the parent agent. Do not ask the user questions directly; report blockers and decisions needed back to the parent.',
    '</subagent>',
  ].join('\n');
}

function readSubagentInput(params: Record<string, unknown>, signal?: AbortSignal): PiSubagentRunInput {
  const task = typeof params.task === 'string' ? params.task.trim() : '';
  if (!task) throw new Error('subagent task must be a non-empty string');
  const profile = resolvePiSubagentProfile(typeof params.agent === 'string' ? params.agent : undefined);
  const input: PiSubagentRunInput = { agent: profile.name, task };
  const cwd = typeof params.cwd === 'string' ? params.cwd.trim() : '';
  if (cwd) input.cwd = cwd;
  if (signal) input.signal = signal;
  return input;
}

function truncateOutput(text: string): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, 'utf8') <= subagentOutputMaxBytes) return { text, truncated: false };
  let truncated = text.slice(0, subagentOutputMaxBytes);
  while (Buffer.byteLength(truncated, 'utf8') > subagentOutputMaxBytes) truncated = truncated.slice(0, -1);
  return {
    text: `${truncated}\n\n[Subagent output truncated: ${Buffer.byteLength(text, 'utf8') - Buffer.byteLength(truncated, 'utf8')} bytes omitted.]`,
    truncated: true,
  };
}
