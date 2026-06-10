import { parseBrowserMilestone, type BrowserMilestone } from '@deputies/browser-milestones';
import type { Hono } from 'hono';
import type { AppConfig } from '../config/index.js';
import { addSpanEvent, recordBrowserMilestone } from '../telemetry/index.js';
import { writeError } from './http-error.js';
import { readJsonBody } from './request.js';
import type { AppVariables } from './server.js';

export function registerTelemetryRoutes(app: Hono<{ Variables: AppVariables }>, config: AppConfig): void {
  app.post('/telemetry/browser-milestones', async (c) => {
    const body = await readJsonBody(c, config.maxJsonBodyBytes);
    const milestone = parseBrowserMilestone(body);
    if (typeof milestone === 'string') return writeError(c, 400, 'invalid_request', milestone);

    const attributes = milestoneAttributes(config, milestone);
    recordBrowserMilestone({ name: milestone.name, durationMs: milestone.durationMs, attributes });
    addSpanEvent('browser.milestone', {
      ...attributes,
      'deputies.interaction_id': milestone.interactionId,
      'deputies.attempt_id': milestone.attemptId,
      'deputies.duration_ms': milestone.durationMs,
    });
    return c.body(null, 204);
  });
}

function milestoneAttributes(config: AppConfig, milestone: BrowserMilestone) {
  return {
    'deputies.milestone': milestone.name,
    'deputies.result': milestone.result,
    'deputies.trigger': milestone.trigger,
    'deputies.page_visibility': milestone.pageVisibility,
    'deputies.api_auth_mode': config.apiAuthMode,
    ...(milestone.messageCount !== undefined
      ? { 'deputies.messages_bucket': messageBucket(milestone.messageCount) }
      : {}),
    ...(milestone.eventCount !== undefined ? { 'deputies.events_bucket': eventBucket(milestone.eventCount) } : {}),
    ...(milestone.inlineArtifactCount !== undefined
      ? { 'deputies.inline_artifacts_bucket': inlineArtifactBucket(milestone.inlineArtifactCount) }
      : {}),
    ...(milestone.artifactCount !== undefined
      ? { 'deputies.artifacts_bucket': outputBucket(milestone.artifactCount) }
      : {}),
    ...(milestone.externalResourceCount !== undefined
      ? { 'deputies.external_resources_bucket': outputBucket(milestone.externalResourceCount) }
      : {}),
    ...(milestone.callbackCount !== undefined
      ? { 'deputies.callbacks_bucket': callbackBucket(milestone.callbackCount) }
      : {}),
    ...(milestone.serviceCount !== undefined
      ? { 'deputies.services_bucket': serviceBucket(milestone.serviceCount) }
      : {}),
    ...(milestone.reusedArtifacts !== undefined ? { 'deputies.reused_artifacts': milestone.reusedArtifacts } : {}),
    ...(milestone.failedComponent ? { 'deputies.failed_component': milestone.failedComponent } : {}),
    ...(milestone.abortedBy ? { 'deputies.aborted_by': milestone.abortedBy } : {}),
  };
}

function messageBucket(count: number): string {
  if (count === 0) return '0';
  if (count <= 10) return '1-10';
  if (count <= 50) return '11-50';
  if (count <= 100) return '51-100';
  return '101+';
}

function eventBucket(count: number): string {
  if (count === 0) return '0';
  if (count <= 100) return '1-100';
  if (count <= 500) return '101-500';
  if (count <= 2_000) return '501-2000';
  return '2001+';
}

function inlineArtifactBucket(count: number): string {
  if (count === 0) return '0';
  if (count <= 5) return '1-5';
  if (count <= 20) return '6-20';
  return '21+';
}

function outputBucket(count: number): string {
  if (count === 0) return '0';
  if (count <= 10) return '1-10';
  if (count <= 50) return '11-50';
  return '51+';
}

function callbackBucket(count: number): string {
  if (count === 0) return '0';
  if (count <= 25) return '1-25';
  if (count <= 100) return '26-100';
  return '101+';
}

function serviceBucket(count: number): string {
  if (count === 0) return '0';
  if (count <= 5) return '1-5';
  return '6+';
}
