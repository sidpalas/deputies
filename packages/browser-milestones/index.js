const maxMilestoneDurationMs = 10 * 60_000;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const browserMilestoneNames = ['session_detail_ready', 'session_outputs_ready', 'sandbox_services_ready'];
export const browserMilestoneResults = ['success', 'error', 'aborted'];
export const browserMilestoneTriggers = ['selection', 'refresh', 'startup_selection'];
export const browserMilestonePageVisibilities = ['visible', 'hidden'];
export const browserMilestoneAbortedByValues = ['selection_change', 'unmount'];
export const browserMilestoneFailedComponents = [
  'messages',
  'events',
  'artifacts',
  'external_resources',
  'callbacks',
  'services',
  'render',
];

const milestoneNames = new Set(browserMilestoneNames);
const results = new Set(browserMilestoneResults);
const triggers = new Set(browserMilestoneTriggers);
const pageVisibilities = new Set(browserMilestonePageVisibilities);
const abortedByValues = new Set(browserMilestoneAbortedByValues);
const failedComponents = new Set(browserMilestoneFailedComponents);
const allowedKeys = new Set([
  'name',
  'result',
  'durationMs',
  'interactionId',
  'attemptId',
  'trigger',
  'pageVisibility',
  'messageCount',
  'eventCount',
  'inlineArtifactCount',
  'artifactCount',
  'externalResourceCount',
  'callbackCount',
  'serviceCount',
  'reusedArtifacts',
  'failedComponent',
  'abortedBy',
]);

export function parseBrowserMilestone(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return 'Expected browser milestone object';
  }
  const unknownKey = Object.keys(value).find((key) => !allowedKeys.has(key));
  if (unknownKey) return `Unexpected browser milestone field: ${unknownKey}`;

  const name = parseEnumValue(value.name, milestoneNames);
  const result = parseEnumValue(value.result, results);
  const trigger = parseEnumValue(value.trigger, triggers);
  const pageVisibility = parseEnumValue(value.pageVisibility, pageVisibilities);
  const durationMs = typeof value.durationMs === 'number' ? value.durationMs : null;
  if (!name || !result || !trigger || !pageVisibility || durationMs === null) {
    return 'Browser milestone is missing required fields';
  }
  if (!Number.isFinite(durationMs) || durationMs < 0 || durationMs > maxMilestoneDurationMs) {
    return 'Browser milestone duration is out of range';
  }
  if (!isUuid(value.interactionId) || !isUuid(value.attemptId)) return 'Browser milestone IDs must be UUIDs';

  if (result === 'error' && !parseEnumValue(value.failedComponent, failedComponents)) {
    return 'Error milestones require failedComponent';
  }
  if (result !== 'error' && value.failedComponent !== undefined)
    return 'Only error milestones may include failedComponent';
  if (result === 'aborted' && !parseEnumValue(value.abortedBy, abortedByValues)) {
    return 'Aborted milestones require abortedBy';
  }
  if (result !== 'aborted' && value.abortedBy !== undefined) return 'Only aborted milestones may include abortedBy';

  const milestone = {
    name,
    result,
    durationMs,
    interactionId: value.interactionId,
    attemptId: value.attemptId,
    trigger,
    pageVisibility,
  };
  for (const key of [
    'messageCount',
    'eventCount',
    'inlineArtifactCount',
    'artifactCount',
    'externalResourceCount',
    'callbackCount',
    'serviceCount',
  ]) {
    const count = parseCount(value[key]);
    if (count === null) return `${key} must be a non-negative integer`;
    if (count !== undefined) milestone[key] = count;
  }
  if (typeof value.reusedArtifacts === 'boolean') milestone.reusedArtifacts = value.reusedArtifacts;
  else if (value.reusedArtifacts !== undefined) return 'reusedArtifacts must be a boolean';
  if (result === 'error') milestone.failedComponent = value.failedComponent;
  if (result === 'aborted') milestone.abortedBy = value.abortedBy;
  return milestone;
}

function parseEnumValue(value, allowed) {
  return typeof value === 'string' && allowed.has(value) ? value : null;
}

function parseCount(value) {
  if (value === undefined) return undefined;
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

function isUuid(value) {
  return typeof value === 'string' && uuidPattern.test(value);
}
