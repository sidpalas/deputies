import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { formatAgentProfileCatalog, type AgentProfileCatalogEntry } from '../agent-profiles/types.js';
import {
  deputyToolDescription,
  deputyToolParameters,
  executeDeputyTool,
  type DeputyToolServices,
} from '../sessions/deputy-tool.js';

export function createPiDeputyToolDefinition(
  services: DeputyToolServices,
  availableProfiles: AgentProfileCatalogEntry[] = [],
): ToolDefinition {
  return {
    name: 'deputies',
    label: 'deputies',
    description: deputyToolDescription,
    promptSnippet: 'Coordinate durable Deputies product sessions and child handoffs',
    promptGuidelines: [
      `The current acting Deputies session ID is "${services.sessionId}". Use it as sessionId to target this session itself.`,
      'Use deputies({ action: "spawn", prompt, title, repository, model, profileId, idempotencyKey, notifyOnComplete }) only when work should become a separate durable Deputies session visible to the user.',
      'For spawn, omit profileId to inherit this session’s profile, or select an explicit profileId from the available agent-compatible profiles in the parameter description.',
      'Spawned child sessions are automatically titled from their initial prompt unless spawn provides an explicit title, and tagged "sub-deputy" so users can identify and filter them.',
      'For quick in-run delegation, use the Pi subagent tool instead of spawning a Deputies session.',
      'Do not busy-wait after spawning. Use get_session for explicit polling, end the turn when appropriate, or set notifyOnComplete so the child enqueues a parent follow-up when it completes.',
      'send_message, cancel, archive, and restore can target any session readable to this agent; omit sessionId to archive or restore the current session.',
      'Archived sessions are read-only until restored. Use deputies({ action: "restore", sessionId }) before sending an archived child more work.',
      'archive is idempotent; repeat it for an archived session when sandbox cleanup needs to be retried.',
      'Archiving the current session destroys its sandbox. Treat self-archive as the final sandbox-dependent action: the response may finish, but workspace tools will no longer work, and restoring the session does not restore the destroyed workspace.',
      'Child sessions initially inherit this session\'s access. Parent run cancellation and parent archival do not cancel or archive children; explicitly use deputies({ action: "cancel", sessionId }) for sessions you no longer need.',
    ],
    parameters: deputyParameters(availableProfiles),
    executionMode: 'sequential',
    async execute(_toolCallId, params) {
      const result = await executeDeputyTool(services, params);
      return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result };
    },
  };
}

function deputyParameters(availableProfiles: AgentProfileCatalogEntry[]) {
  return {
    ...deputyToolParameters,
    properties: {
      ...deputyToolParameters.properties,
      profileId: {
        ...deputyToolParameters.properties.profileId,
        description: `Optional agent profile ID. Inherits the parent profile when omitted. Available agent-compatible profiles: ${formatAgentProfileCatalog(availableProfiles)}.`,
      },
    },
  };
}
