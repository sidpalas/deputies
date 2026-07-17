import type { NormalizedEvent } from '../../src/events/types.js';
import { SkillInvocationRuntime } from '../../src/runner-pi/skill-invocation-runtime.js';
import type { PreparedSkillTrace } from '../../src/runner-pi/skill-types.js';

describe('SkillInvocationRuntime', () => {
  const skill: PreparedSkillTrace = {
    name: 'review',
    source: 'group',
    ref: 'skill-review',
    filePath: '/workspace/skills/review/SKILL.md',
  };

  it('reports a skill only after its read succeeds', () => {
    const onInvoked = vi.fn();
    const observer = new SkillInvocationRuntime([skill], onInvoked).createObserver('/workspace');

    observer.observe(toolStarted('failed', 'skills/review/SKILL.md'));
    observer.observe(toolFinished('failed', true));
    observer.observe(toolStarted('success', 'skills/review/SKILL.md'));
    observer.observe(toolFinished('success', false));

    expect(onInvoked).toHaveBeenCalledOnce();
    expect(onInvoked).toHaveBeenCalledWith(skill);
  });

  it('deduplicates invocations across parent and subagent observers', () => {
    const onInvoked = vi.fn();
    const runtime = new SkillInvocationRuntime([skill], onInvoked);
    const parent = runtime.createObserver('/workspace');
    const subagent = runtime.createObserver('/workspace/repository');

    parent.observe(toolStarted('parent', '/workspace/skills/review/SKILL.md'));
    parent.observe(toolFinished('parent', false));
    subagent.observe(toolStarted('child', '../skills/review/SKILL.md'));
    subagent.observe(toolFinished('child', false));

    expect(onInvoked).toHaveBeenCalledOnce();
  });
});

function toolStarted(toolCallId: string, filePath: string): NormalizedEvent {
  return {
    sessionId: 'session-1',
    runId: 'run-1',
    messageId: 'message-1',
    type: 'tool_started',
    payload: { toolName: 'read', toolCallId, args: { path: filePath } },
    createdAt: new Date(),
  };
}

function toolFinished(toolCallId: string, isError: boolean): NormalizedEvent {
  return {
    sessionId: 'session-1',
    runId: 'run-1',
    messageId: 'message-1',
    type: 'tool_finished',
    payload: { toolName: 'read', toolCallId, isError, result: {} },
    createdAt: new Date(),
  };
}
