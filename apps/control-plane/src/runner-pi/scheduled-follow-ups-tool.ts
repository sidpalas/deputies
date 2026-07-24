import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import {
  executeScheduledFollowUpsTool,
  scheduledFollowUpsToolDescription,
  scheduledFollowUpsToolParameters,
  type ScheduledFollowUpToolServices,
} from '../scheduled-follow-ups/tool.js';
export function createPiScheduledFollowUpsToolDefinition(services: ScheduledFollowUpToolServices): ToolDefinition {
  return {
    name: 'scheduled_follow_ups',
    label: 'scheduled_follow_ups',
    description: scheduledFollowUpsToolDescription,
    promptSnippet: 'Schedule bounded future prompts in sessions available to this session.',
    promptGuidelines: [
      'Use a stable nonempty idempotencyKey for create retries.',
      'Use preview before creating recurrence when timing is uncertain.',
    ],
    parameters: scheduledFollowUpsToolParameters,
    prepareArguments(args) {
      if (!args || typeof args !== 'object' || Array.isArray(args)) return args as never;
      const prepared = { ...(args as Record<string, unknown>) };
      if (typeof prepared.schedule === 'string') {
        try {
          const parsed = JSON.parse(prepared.schedule) as unknown;
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) prepared.schedule = parsed;
        } catch {
          // Preserve invalid input so normal schema validation can report it.
        }
      }
      return prepared as never;
    },
    executionMode: 'sequential',
    async execute(_id, params) {
      const result = await executeScheduledFollowUpsTool(services, params);
      return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result };
    },
  };
}
