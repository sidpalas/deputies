import type { Attributes } from '@opentelemetry/api';
import type { AppStore } from '../store/types.js';
import { traceAsync } from './index.js';

export type StoreKind = 'memory' | 'postgres';

type StoreMethod = keyof AppStore;
type StoreFunction = (...args: unknown[]) => unknown;
type AdvisoryLockStore = {
  withAdvisoryLock?<T>(lockId: number, fn: () => Promise<T>): Promise<T | null>;
};
type InstrumentableStore = AppStore & AdvisoryLockStore;

const storeMethods = [
  'appendEvent',
  'appendEventWithNextSequence',
  'appendEventWithNextSequenceForRun',
  'archiveAutomation',
  'archiveSession',
  'cancelPendingMessage',
  'claimAutomation',
  'claimDueCallbackDeliveries',
  'claimNextDueScheduledAutomation',
  'claimNextPendingMessage',
  'claimNextPendingMessageBatch',
  'compactFinalizedAgentTextDeltas',
  'completeRun',
  'completeRunBatch',
  'completeScheduledAutomationClaim',
  'createArtifact',
  'createAuthSession',
  'createAutomation',
  'createAutomationInvocation',
  'createCallbackDelivery',
  'createExternalResource',
  'createExternalThread',
  'createGroup',
  'createIntegrationDelivery',
  'createMessage',
  'createSandbox',
  'createSandboxWithSecrets',
  'createSession',
  'createSessionWithFirstMessage',
  'createWebhookSource',
  'deleteAuthSession',
  'deleteGroupMember',
  'failRun',
  'failRunBatch',
  'finalizeRunCancellation',
  'getActiveSandbox',
  'getArtifacts',
  'getAuthUserBySession',
  'getAutomation',
  'getAutomationInvocationBySchedule',
  'getBlockingAutomationSession',
  'getEvents',
  'getExternalResources',
  'getExternalThread',
  'getGroup',
  'getGroupMember',
  'getLatestEventByType',
  'getLatestRunForSession',
  'getLatestSandbox',
  'getMessage',
  'getMessages',
  'getSessionMessageSummary',
  'getSessionTranscript',
  'getRun',
  'getSandboxSecrets',
  'getSearchIndexCursor',
  'getSession',
  'getWebhookSource',
  'listActiveSandboxes',
  'listAuthUsers',
  'listAutomationInvocations',
  'listAutomations',
  'listCallbackDeliveries',
  'listEvents',
  'listGroupMembers',
  'listGroups',
  'listChildSessions',
  'listIdleSandboxes',
  'listSessionsForAgent',
  'listSessions',
  'listSessionsWithLatestSandbox',
  'listStoppableSandboxes',
  'listUserGroupMemberships',
  'markCallbackDeliveryFailed',
  'markCallbackDeliverySent',
  'markIntegrationDeliveryFailed',
  'markIntegrationDeliveryProcessed',
  'nextEventSequence',
  'nextMessageSequence',
  'pauseSessionQueue',
  'recoverStaleRuns',
  'releaseAutomationClaim',
  'requestCallbackReplay',
  'requestRunCancellation',
  'renewRunLease',
  'resumeSessionQueue',
  'setSandboxSecrets',
  'setSearchIndexCursor',
  'searchSessions',
  'unarchiveAutomation',
  'updateAuthUserRole',
  'updateAutomation',
  'updateAutomationInvocation',
  'updateGroup',
  'updatePendingMessage',
  'updateSandbox',
  'updateSession',
  'updateSessionWithEvent',
  'updateSessionForRun',
  'upsertSessionSearchDocs',
  'upsertAuthUserForAccount',
  'upsertGroupMember',
  'withExternalThreadLock',
] as const satisfies readonly StoreMethod[];

type MissingStoreMethod = Exclude<StoreMethod, (typeof storeMethods)[number]>;
type AssertTrue<T extends true> = T;
type _StoreMethodsAreExhaustive = AssertTrue<
  MissingStoreMethod extends never ? true : { missingStoreMethods: MissingStoreMethod }
>;

const untracedPollingMethods = new Set<StoreMethod>([
  'claimDueCallbackDeliveries',
  'claimNextDueScheduledAutomation',
  'claimNextPendingMessageBatch',
  'recoverStaleRuns',
]);

export function instrumentStore<TStore extends InstrumentableStore>(
  store: TStore,
  options: { kind: StoreKind },
): TStore {
  const wrapped = {} as TStore;
  for (const method of storeMethods) bindStoreMethod(wrapped, store, method, options);
  bindExtraMethod(wrapped, store, 'withAdvisoryLock');
  return wrapped;
}

export function storeAttributes(kind: StoreKind, method: string): Attributes {
  return { 'deputies.store.kind': kind, 'deputies.store.method': method };
}

function bindStoreMethod<TStore extends InstrumentableStore>(
  wrapped: TStore,
  store: TStore,
  method: StoreMethod,
  options: { kind: StoreKind },
): void {
  const original = store[method] as unknown;
  if (typeof original !== 'function') return;
  const bound = original.bind(store) as StoreFunction;
  defineMethod(
    wrapped,
    method,
    untracedPollingMethods.has(method) ? bound : traceStoreMethod(options.kind, method, bound),
  );
}

function bindExtraMethod<TStore extends InstrumentableStore>(
  wrapped: TStore,
  store: TStore,
  method: keyof AdvisoryLockStore,
): void {
  const original = store[method] as unknown;
  if (typeof original === 'function') defineMethod(wrapped, method, original.bind(store) as StoreFunction);
}

function traceStoreMethod(kind: StoreKind, method: StoreMethod, fn: StoreFunction): StoreFunction {
  return (...args) => traceAsync(`store.${method}`, storeAttributes(kind, method), () => Promise.resolve(fn(...args)));
}

function defineMethod(target: object, method: PropertyKey, value: StoreFunction): void {
  Object.defineProperty(target, method, { enumerable: false, value });
}
