import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import {
  executeServiceTool,
  serviceToolDescription,
  serviceToolParameters,
  type ServiceToolServices,
} from '../sessions/service-tool.js';

const piServiceToolParameters = serviceToolParameters as unknown as ToolDefinition['parameters'];

export function createPiServiceToolDefinition(services: ServiceToolServices): ToolDefinition {
  return {
    name: 'service',
    label: 'service',
    description: serviceToolDescription,
    promptSnippet: 'Publish, list, extend, and unpublish live HTTP services for the user',
    promptGuidelines: [
      'If you start or identify a web server, app preview, code-server instance, API docs, notebook, dashboard, or other HTTP service the user should open, call service({ action: "publish", port, label, path, ttlSeconds }) after confirming the service is running.',
      'Use ttlSeconds of at least 300 for interactive services so the sandbox stays alive long enough for the user to open it. Multiple services may be visible at the same time.',
      'Use service({ action: "extend", port, ttlSeconds }) to keep an existing service sandbox alive longer, service({ action: "list" }) to inspect published services, and service({ action: "unpublish", port }) to remove stale links.',
      'Do not publish ports that are not serving an app, browser-accessible tool, or useful HTTP endpoint.',
      'For Vite dev servers published as services/previews, do not hard-code server.hmr.host, server.hmr.clientPort, or server.hmr.protocol to localhost; let Vite infer the browser URL unless the user specifically asks otherwise.',
    ],
    parameters: piServiceToolParameters,
    executionMode: 'sequential',
    async execute(_toolCallId, params) {
      const result = await executeServiceTool(services, params as Record<string, unknown>);
      return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result };
    },
  };
}
