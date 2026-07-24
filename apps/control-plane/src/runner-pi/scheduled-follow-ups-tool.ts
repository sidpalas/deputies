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
    executionMode: 'sequential',
    async execute(_id, params) {
      const result = await executeScheduledFollowUpsTool(services, params);
      return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result };
    },
  };
}
