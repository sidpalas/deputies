import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import {
  deputyToolDescription,
  deputyToolParameters,
  executeDeputyTool,
  type DeputyToolServices,
} from '../sessions/deputy-tool.js';

const piDeputyToolParameters = deputyToolParameters as unknown as ToolDefinition['parameters'];

export function createPiDeputyToolDefinition(services: DeputyToolServices): ToolDefinition {
  return {
    name: 'deputies',
    label: 'deputies',
    description: deputyToolDescription,
    promptSnippet: 'Coordinate durable Deputies product sessions and child handoffs',
    promptGuidelines: [
      'Use deputies({ action: "spawn", prompt, title, repository, model, idempotencyKey, notifyOnComplete }) only when work should become a separate durable Deputies session visible to the user.',
      'For quick in-run delegation, use the Pi subagent tool instead of spawning a Deputies session.',
      'Do not busy-wait after spawning. Use get_session for explicit polling, end the turn when appropriate, or set notifyOnComplete so the child enqueues a parent follow-up when it completes.',
      'send_message and cancel are intentionally limited to direct child sessions you spawned from this session.',
      'Child sessions inherit this session group, visibility, and write policy. Parent run cancellation and parent archival do not cancel or archive children; explicitly use deputies({ action: "cancel", sessionId }) for direct children you no longer need.',
    ],
    parameters: piDeputyToolParameters,
    executionMode: 'sequential',
    async execute(_toolCallId, params) {
      const result = await executeDeputyTool(services, params);
      return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result };
    },
  };
}
