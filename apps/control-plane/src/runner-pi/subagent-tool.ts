import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { builtinAgentProfiles } from '../agent-profiles/builtins.js';
import { formatAgentProfileCatalog } from '../agent-profiles/types.js';

const subagentOutputMaxBytes = 50 * 1024;

export type PiSubagentProfile = {
  id: string;
  name: string;
  source: 'builtin' | 'managed';
  revision: string;
  hash?: string;
  description: string;
  instructions: string;
  model?: string;
  reasoningLevel?: string;
};

export type PiSubagentRunInput = {
  profileId: string;
  task: string;
  cwd?: string;
  signal?: AbortSignal;
  parentToolCallId?: string;
  parentActivityId?: string;
};

export type PiSubagentRunResult = {
  profileId: string;
  task: string;
  cwd: string;
  depth: number;
  text: string;
  model?: string;
  profileSource?: 'builtin' | 'managed';
  profileRevision?: string;
  profileHash?: string;
  usage?: unknown;
};

export type PiSubagentToolServices = {
  run: (input: PiSubagentRunInput) => Promise<PiSubagentRunResult>;
};

const profiles: PiSubagentProfile[] = builtinAgentProfiles.map(
  ({ id, name, source, revision, description, instructions, defaultModel, defaultReasoningLevel }) => ({
    id,
    name,
    source,
    revision,
    description,
    instructions,
    ...(defaultModel ? { model: defaultModel } : {}),
    ...(defaultReasoningLevel ? { reasoningLevel: defaultReasoningLevel } : {}),
  }),
);

export const piSubagentToolParameters = {
  type: 'object',
  additionalProperties: false,
  required: ['profileId', 'task'],
  properties: {
    profileId: {
      type: 'string',
      description: `Agent profile ID. Built-ins: ${profiles.map((profile) => profile.id).join(', ')}.`,
    },
    task: { type: 'string', description: 'Focused task to delegate to the subagent.' },
    cwd: { type: 'string', description: 'Optional sandbox working directory for the subagent.' },
  },
} as const;

export function createPiSubagentToolDefinition(
  services: PiSubagentToolServices,
  availableProfiles: PiSubagentProfile[] = profiles,
): ToolDefinition {
  return {
    name: 'subagent',
    label: 'subagent',
    description:
      'Delegate a focused task to an isolated Pi subagent with its own context window. Use this for independent research, planning, review, or larger delegated implementation work. The subagent returns only its final answer to this conversation.',
    promptSnippet: 'Delegate focused work to an isolated subagent context',
    promptGuidelines: [
      'Use subagent for independent exploration, planning, review, or larger delegated work that would clutter the main context.',
      'Do not use subagent for quick answers, tiny targeted edits, or latency-sensitive one-step work.',
      'Select a profileId compatible with subagent invocation.',
      'Subagents in this environment run inside the same Deputies sandbox and should generally return a concise final result to you.',
      'Nested subagent delegation is available but capped at 4 levels deep.',
    ],
    parameters: subagentToolParameters(availableProfiles),
    executionMode: 'sequential',
    async execute(toolCallId, params, signal) {
      const input = readSubagentInput(params as Record<string, unknown>, signal);
      input.parentToolCallId = toolCallId;
      const result = await services.run(input);
      const output = truncateOutput(result.text);
      return {
        content: [{ type: 'text', text: output.text || '(subagent completed with no text)' }],
        details: { ...result, truncated: output.truncated },
      };
    },
  };
}

function subagentToolParameters(availableProfiles: PiSubagentProfile[]) {
  return {
    ...piSubagentToolParameters,
    properties: {
      ...piSubagentToolParameters.properties,
      profileId: {
        ...piSubagentToolParameters.properties.profileId,
        description: `Agent profile ID. Available profiles: ${formatAgentProfileCatalog(availableProfiles)}.`,
      },
    },
  };
}

export function resolvePiSubagentProfile(value: string): PiSubagentProfile {
  const name = value?.trim();
  const profile = profiles.find((candidate) => candidate.id === name);
  if (profile) return profile;
  const available = profiles.map((candidate) => candidate.id).join(', ');
  throw new Error(`Unknown subagent profile: ${name}. Available profiles: ${available}.`);
}

export function piSubagentSystemPrompt(basePrompt: string, profile: PiSubagentProfile): string {
  return [
    basePrompt,
    '',
    `<subagent profile-id="${profile.id}">`,
    profile.instructions,
    '',
    'You are operating in an isolated child context. Generally return a concise final result to the parent agent. Do not ask the user questions directly; report blockers and decisions needed back to the parent.',
    '</subagent>',
  ].join('\n');
}

function readSubagentInput(params: Record<string, unknown>, signal?: AbortSignal): PiSubagentRunInput {
  const task = typeof params.task === 'string' ? params.task.trim() : '';
  if (!task) throw new Error('subagent task must be a non-empty string');
  const profileId = typeof params.profileId === 'string' ? params.profileId.trim() : '';
  if (!profileId) throw new Error('subagent profileId must be a non-empty string');
  // Resolution is deliberately deferred to the runner: managed profiles are
  // tenant data and can only be resolved asynchronously there.
  const input: PiSubagentRunInput = { profileId, task };
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
