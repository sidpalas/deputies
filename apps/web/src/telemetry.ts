import {
  sendBrowserMilestone,
  type BrowserMilestone,
  type BrowserMilestoneName,
  type BrowserMilestoneTrigger,
} from './browser-milestones.js';

export type { BrowserMilestoneTrigger } from './browser-milestones.js';

type MilestoneCounts = Partial<
  Pick<
    BrowserMilestone,
    | 'messageCount'
    | 'eventCount'
    | 'inlineArtifactCount'
    | 'artifactCount'
    | 'externalResourceCount'
    | 'callbackCount'
    | 'serviceCount'
    | 'reusedArtifacts'
  >
>;

export type MilestoneAttempt = {
  name: BrowserMilestoneName;
  traceparent(): string;
  success(counts?: MilestoneCounts): void;
  error(failedComponent: NonNullable<BrowserMilestone['failedComponent']>, counts?: MilestoneCounts): void;
  abort(abortedBy: NonNullable<BrowserMilestone['abortedBy']>): void;
};

export type SessionMilestoneInteraction = {
  interactionId: string;
  detail: MilestoneAttempt;
  outputs: MilestoneAttempt;
  services: MilestoneAttempt;
  abort(abortedBy: NonNullable<BrowserMilestone['abortedBy']>): void;
};

export function startSessionMilestoneInteraction(input: {
  token: string;
  trigger: BrowserMilestoneTrigger;
}): SessionMilestoneInteraction {
  const interactionId = randomUuid();
  const traceId = randomHex(16);
  const startedAt = performance.now();
  const attempts = {
    detail: createAttempt('session_detail_ready', input, interactionId, traceId, startedAt),
    outputs: createAttempt('session_outputs_ready', input, interactionId, traceId, startedAt),
    services: createAttempt('sandbox_services_ready', input, interactionId, traceId, startedAt),
  };
  return {
    interactionId,
    ...attempts,
    abort(abortedBy) {
      attempts.detail.abort(abortedBy);
      attempts.outputs.abort(abortedBy);
      attempts.services.abort(abortedBy);
    },
  };
}

function createAttempt(
  name: BrowserMilestoneName,
  input: { token: string; trigger: BrowserMilestoneTrigger },
  interactionId: string,
  traceId: string,
  startedAt: number,
): MilestoneAttempt {
  let finished = false;
  const attemptId = randomUuid();

  const finish = (
    milestone: Omit<
      BrowserMilestone,
      'name' | 'durationMs' | 'interactionId' | 'attemptId' | 'trigger' | 'pageVisibility'
    >,
  ) => {
    if (finished) return;
    finished = true;
    const send = () => {
      const payload: BrowserMilestone = {
        name,
        durationMs: Math.max(0, performance.now() - startedAt),
        interactionId,
        attemptId,
        trigger: input.trigger,
        pageVisibility: document.visibilityState === 'hidden' ? 'hidden' : 'visible',
        ...milestone,
      };
      sendBrowserMilestone({ milestone: payload, token: input.token, traceparent: traceparent(traceId) }).catch(
        () => undefined,
      );
    };
    if (milestone.result === 'success') afterPaint(send);
    else send();
  };

  return {
    name,
    traceparent: () => traceparent(traceId),
    success(counts = {}) {
      finish({ result: 'success', ...counts });
    },
    error(failedComponent, counts = {}) {
      finish({ result: 'error', failedComponent, ...counts });
    },
    abort(abortedBy) {
      finish({ result: 'aborted', abortedBy });
    },
  };
}

function afterPaint(fn: () => void): void {
  const schedule = (callback: FrameRequestCallback) => {
    if (window.requestAnimationFrame) window.requestAnimationFrame(callback);
    else window.setTimeout(callback, 0);
  };
  schedule(() => schedule(fn));
}

function traceparent(traceId: string): string {
  return `00-${traceId}-${randomHex(8)}-01`;
}

function randomUuid(): string {
  if (crypto.randomUUID) return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function randomHex(bytesLength: number): string {
  while (true) {
    const bytes = new Uint8Array(bytesLength);
    crypto.getRandomValues(bytes);
    const value = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
    if (!/^0+$/.test(value)) return value;
  }
}
