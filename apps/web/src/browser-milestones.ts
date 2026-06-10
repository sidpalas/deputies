import type {
  BrowserMilestone,
  BrowserMilestoneName,
  BrowserMilestoneResult,
  BrowserMilestoneTrigger,
} from '@deputies/browser-milestones';
import { request } from './api-request.js';

export type { BrowserMilestone, BrowserMilestoneName, BrowserMilestoneResult, BrowserMilestoneTrigger };

export async function sendBrowserMilestone(input: {
  milestone: BrowserMilestone;
  token: string;
  traceparent: string;
}): Promise<void> {
  await request<void>('/telemetry/browser-milestones', {
    method: 'POST',
    token: input.token,
    traceparent: input.traceparent,
    body: input.milestone,
    expectJson: false,
    keepalive: true,
  });
}
