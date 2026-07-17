import path from 'node:path';
import type { NormalizedEvent } from '../events/types.js';
import type { PreparedSkillTrace } from './skill-types.js';

export class SkillInvocationRuntime {
  private readonly invoked = new Set<string>();

  constructor(
    private readonly skills: PreparedSkillTrace[],
    private readonly onInvoked: (skill: PreparedSkillTrace) => void,
  ) {}

  createObserver(cwd: string) {
    const skillsByPath = new Map(this.skills.map((skill) => [path.posix.normalize(skill.filePath), skill] as const));
    const pending = new Map<string, PreparedSkillTrace>();

    return {
      observe: (event: NormalizedEvent) => {
        if (event.type === 'tool_started' && event.payload.toolName === 'read') {
          const requestedPath = readToolPath(event.payload.args, cwd);
          const skill = requestedPath ? skillsByPath.get(requestedPath) : undefined;
          const toolCallId = event.payload.toolCallId;
          if (skill && toolCallId) pending.set(toolCallId, skill);
          return;
        }
        if (event.type !== 'tool_finished') return;
        const toolCallId = event.payload.toolCallId;
        const skill = toolCallId ? pending.get(toolCallId) : undefined;
        if (toolCallId) pending.delete(toolCallId);
        if (!skill || event.payload.isError || this.invoked.has(skill.ref)) return;
        this.invoked.add(skill.ref);
        this.onInvoked(skill);
      },
    };
  }
}

function readToolPath(args: unknown, cwd: string): string | null {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return null;
  const record = args as Record<string, unknown>;
  const value =
    typeof record.path === 'string' ? record.path : typeof record.filePath === 'string' ? record.filePath : '';
  if (!value) return null;
  return path.posix.normalize(path.posix.isAbsolute(value) ? value : path.posix.resolve(cwd, value));
}
