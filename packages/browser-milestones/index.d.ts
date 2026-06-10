export declare const browserMilestoneNames: readonly [
  'session_detail_ready',
  'session_outputs_ready',
  'sandbox_services_ready',
];
export declare const browserMilestoneResults: readonly ['success', 'error', 'aborted'];
export declare const browserMilestoneTriggers: readonly ['selection', 'refresh', 'startup_selection'];
export declare const browserMilestonePageVisibilities: readonly ['visible', 'hidden'];
export declare const browserMilestoneAbortedByValues: readonly ['selection_change', 'unmount'];
export declare const browserMilestoneFailedComponents: readonly [
  'messages',
  'events',
  'artifacts',
  'external_resources',
  'callbacks',
  'services',
  'render',
];

export type BrowserMilestoneName = (typeof browserMilestoneNames)[number];
export type BrowserMilestoneResult = (typeof browserMilestoneResults)[number];
export type BrowserMilestoneTrigger = (typeof browserMilestoneTriggers)[number];
export type BrowserMilestoneFailedComponent = (typeof browserMilestoneFailedComponents)[number];
export type BrowserMilestoneAbortedBy = (typeof browserMilestoneAbortedByValues)[number];

export type BrowserMilestone = {
  name: BrowserMilestoneName;
  result: BrowserMilestoneResult;
  durationMs: number;
  interactionId: string;
  attemptId: string;
  trigger: BrowserMilestoneTrigger;
  pageVisibility: 'visible' | 'hidden';
  messageCount?: number;
  eventCount?: number;
  inlineArtifactCount?: number;
  artifactCount?: number;
  externalResourceCount?: number;
  callbackCount?: number;
  serviceCount?: number;
  reusedArtifacts?: boolean;
  failedComponent?: BrowserMilestoneFailedComponent;
  abortedBy?: BrowserMilestoneAbortedBy;
};

export declare function parseBrowserMilestone(value: unknown): BrowserMilestone | string;
