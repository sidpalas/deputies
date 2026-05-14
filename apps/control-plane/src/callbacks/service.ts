import { randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import type { EventService } from '../events/service.js';
import type { RunnerArtifact, RunnerResult } from '../runner/types.js';
import type { ArtifactRecord, CallbackDeliveryRecord, CallbackStore, ClaimedMessage } from '../store/types.js';

const DEFAULT_HTTP_CALLBACK_TIMEOUT_MS = 10_000;

export type CompletionCallbackType = 'http' | 'slack' | 'github';

export type CompletionCallback = {
  type: CompletionCallbackType;
  target: Record<string, unknown>;
};

export type CompletionCallbackPayload = {
  event: 'message_completed';
  sessionId: string;
  runId: string;
  messageId: string;
  text: string;
  artifacts: CompletionCallbackArtifact[];
};

export type CompletionCallbackArtifact = {
  type: string;
  id?: string;
  sessionId?: string;
  runId?: string;
  messageId?: string;
  title?: string;
  url?: string;
  downloadUrl?: string;
  previewUrl?: string;
  contentType?: string;
  fileName?: string;
  createdAt?: string;
  payload?: Record<string, unknown>;
};

export type CompletionCallbackSender = {
  readonly type: CompletionCallbackType;
  deliver(callback: CompletionCallback, payload: CompletionCallbackPayload): Promise<void>;
};

export type CallbackDispatcherOptions = {
  now?: () => Date;
  batchSize?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  jitterRatio?: number;
};

export class CallbackService {
  constructor(
    private readonly store: CallbackStore,
    private readonly events?: EventService,
  ) {}

  async enqueueCompletion(input: {
    claimed: ClaimedMessage;
    result: RunnerResult;
    artifactRecords?: ArtifactRecord[];
  }): Promise<CallbackDeliveryRecord | null> {
    const callback = getCompletionCallback(input.claimed.message.context);
    if (!callback) return null;

    const now = new Date();
    const payload: CompletionCallbackPayload = {
      event: 'message_completed',
      sessionId: input.claimed.message.sessionId,
      runId: input.claimed.run.id,
      messageId: input.claimed.message.id,
      text: input.result.text,
      artifacts: input.artifactRecords
        ? input.artifactRecords.map(serializeArtifactRecord)
        : (input.result.artifacts ?? []).map(serializeRunnerArtifact),
    };
    const delivery = await this.store.createCallbackDelivery({
      id: randomUUID(),
      sessionId: input.claimed.message.sessionId,
      runId: input.claimed.run.id,
      messageId: input.claimed.message.id,
      targetType: callback.type,
      target: callback.target,
      eventType: 'message_completed',
      payload,
      createdAt: now,
      updatedAt: now,
      nextAttemptAt: now,
    });
    return delivery;
  }

  async list(input: { sessionId: string; messageId?: string }): Promise<CallbackDeliveryRecord[]> {
    return this.store.listCallbackDeliveries(input);
  }

  async requestReplay(input: { sessionId: string; deliveryId: string }): Promise<CallbackDeliveryRecord> {
    const requestedAt = new Date();
    const delivery = await this.store.requestCallbackReplay({
      sessionId: input.sessionId,
      deliveryId: input.deliveryId,
      requestedAt,
    });
    if (!delivery)
      throw new CallbackServiceError('conflict', 'Callback delivery is not failed or does not exist for this session');
    await this.events?.append({
      sessionId: delivery.sessionId,
      ...(delivery.runId ? { runId: delivery.runId } : {}),
      ...(delivery.messageId ? { messageId: delivery.messageId } : {}),
      type: 'callback_replay_requested',
      payload: { deliveryId: delivery.id, targetType: delivery.targetType, attempts: delivery.attempts },
    });
    return delivery;
  }
}

function serializeArtifactRecord(artifact: ArtifactRecord): CompletionCallbackArtifact {
  return {
    id: artifact.id,
    sessionId: artifact.sessionId,
    ...(artifact.runId ? { runId: artifact.runId } : {}),
    ...(artifact.messageId ? { messageId: artifact.messageId } : {}),
    type: artifact.type,
    ...(artifact.title ? { title: artifact.title } : {}),
    ...(artifact.url ? { url: artifact.url } : {}),
    ...(artifact.storageKey ? { downloadUrl: artifactDownloadUrl(artifact.sessionId, artifact.id) } : {}),
    ...(artifact.storageKey ? { previewUrl: artifactPreviewUrl(artifact.sessionId, artifact.id) } : {}),
    ...(typeof artifact.payload.contentType === 'string' ? { contentType: artifact.payload.contentType } : {}),
    ...(typeof artifact.payload.fileName === 'string' ? { fileName: artifact.payload.fileName } : {}),
    createdAt: artifact.createdAt.toISOString(),
    payload: sanitizeArtifactPayload(artifact.payload),
  };
}

function serializeRunnerArtifact(artifact: RunnerArtifact): CompletionCallbackArtifact {
  return {
    type: artifact.type,
    ...(artifact.title ? { title: artifact.title } : {}),
    ...(artifact.url ? { url: artifact.url } : {}),
    ...(artifact.contentType ? { contentType: artifact.contentType } : {}),
    ...(artifact.fileName ? { fileName: artifact.fileName } : {}),
    ...(artifact.payload ? { payload: sanitizeArtifactPayload(artifact.payload) } : {}),
  };
}

function sanitizeArtifactPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (key === 'content' || key === 'contentBase64' || key === 'storageKey') continue;
    sanitized[key] = sanitizeArtifactPayloadValue(value);
  }
  return sanitized;
}

function sanitizeArtifactPayloadValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeArtifactPayloadValue);
  if (!value || typeof value !== 'object') return value;

  const sanitized: Record<string, unknown> = {};
  for (const [key, nestedValue] of Object.entries(value)) {
    if (key === 'content' || key === 'contentBase64' || key === 'storageKey') continue;
    sanitized[key] = sanitizeArtifactPayloadValue(nestedValue);
  }
  return sanitized;
}

function artifactDownloadUrl(sessionId: string, artifactId: string): string {
  return `/sessions/${sessionId}/artifacts/${artifactId}/download`;
}

function artifactPreviewUrl(sessionId: string, artifactId: string): string {
  return `/sessions/${sessionId}/artifacts/${artifactId}/preview`;
}

export class CallbackServiceError extends Error {
  constructor(
    readonly code: 'conflict',
    message: string,
  ) {
    super(message);
  }
}

export class CallbackDispatcher {
  private readonly now: () => Date;
  private readonly batchSize: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly jitterRatio: number;

  constructor(
    private readonly store: CallbackStore,
    private readonly events: EventService,
    private readonly senders: CompletionCallbackSender[] = [new HttpCompletionCallbackSender()],
    options: CallbackDispatcherOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.batchSize = options.batchSize ?? 10;
    this.baseDelayMs = options.baseDelayMs ?? 30_000;
    this.maxDelayMs = options.maxDelayMs ?? 30 * 60_000;
    this.jitterRatio = options.jitterRatio ?? 0.2;
  }

  async dispatchDue(): Promise<number> {
    const deliveries = await this.store.claimDueCallbackDeliveries({ now: this.now(), limit: this.batchSize });
    for (const delivery of deliveries) await this.dispatch(delivery);
    return deliveries.length;
  }

  private async dispatch(delivery: CallbackDeliveryRecord): Promise<void> {
    const callback = { type: delivery.targetType, target: delivery.target } satisfies CompletionCallback;
    const sender = this.senders.find((candidate) => candidate.type === callback.type);
    try {
      if (!sender) throw new Error(`No callback sender configured for target type: ${callback.type}`);
      await sender.deliver(callback, delivery.payload as CompletionCallbackPayload);
      const sent = await this.store.markCallbackDeliverySent({ id: delivery.id, deliveredAt: this.now() });
      await this.events.append({
        sessionId: sent.sessionId,
        ...(sent.runId ? { runId: sent.runId } : {}),
        ...(sent.messageId ? { messageId: sent.messageId } : {}),
        type: 'callback_sent',
        payload: { deliveryId: sent.id, targetType: sent.targetType, attempts: sent.attempts },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown callback error';
      const terminal = delivery.attempts >= delivery.maxAttempts;
      const failed = await this.store.markCallbackDeliveryFailed({
        id: delivery.id,
        failedAt: this.now(),
        error: message,
        terminal,
        ...(terminal ? {} : { nextAttemptAt: this.nextAttemptAt(delivery.attempts) }),
      });
      await this.events.append({
        sessionId: failed.sessionId,
        ...(failed.runId ? { runId: failed.runId } : {}),
        ...(failed.messageId ? { messageId: failed.messageId } : {}),
        type: terminal ? 'callback_failed' : 'callback_retry_scheduled',
        payload: {
          deliveryId: failed.id,
          error: message,
          targetType: failed.targetType,
          attempts: failed.attempts,
          ...(failed.nextAttemptAt ? { nextAttemptAt: failed.nextAttemptAt.toISOString() } : {}),
        },
      });
    }
  }

  private nextAttemptAt(attempts: number): Date {
    const exponential = Math.min(this.maxDelayMs, this.baseDelayMs * 2 ** Math.max(0, attempts - 1));
    const jitter = this.jitterRatio > 0 ? exponential * this.jitterRatio * Math.random() : 0;
    return new Date(this.now().getTime() + exponential + jitter);
  }
}

export class HttpCompletionCallbackSender implements CompletionCallbackSender {
  readonly type = 'http';

  constructor(private readonly options: HttpCompletionCallbackSenderOptions = {}) {}

  async deliver(callback: CompletionCallback, payload: CompletionCallbackPayload): Promise<void> {
    const url = callback.target.url;
    if (typeof url !== 'string' || !url) throw new Error('HTTP callback target is missing url');
    const response = await postJsonToCallback(url, payload, this.options);
    if (response.statusCode < 200 || response.statusCode >= 300)
      throw new Error(`HTTP callback returned ${response.statusCode}`);
  }
}

export type HttpCompletionCallbackSenderOptions = {
  timeoutMs?: number;
  resolveHostname?: (hostname: string) => Promise<ResolvedAddress[]>;
  request?: (input: ValidatedHttpCallbackRequest) => Promise<{ statusCode: number }>;
};

export type ResolvedAddress = { address: string; family: 4 | 6 };

export type ValidatedHttpCallbackRequest = {
  url: URL;
  addresses: ResolvedAddress[];
  body: string;
  timeoutMs: number;
  signal: AbortSignal;
};

export function parseHttpCallbackUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('HTTP callback URL is invalid');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    throw new Error('HTTP callback URL must use http or https');
  if (url.username || url.password) throw new Error('HTTP callback URL must not include credentials');
  if (isBlockedHostname(url.hostname)) throw new Error('HTTP callback URL host is not allowed');
  const literalFamily = ipFamily(url.hostname);
  if (literalFamily && isBlockedIp(normalizeIpLiteral(url.hostname), literalFamily))
    throw new Error('HTTP callback URL IP is not allowed');
  return url;
}

async function postJsonToCallback(
  rawUrl: string,
  payload: CompletionCallbackPayload,
  options: HttpCompletionCallbackSenderOptions,
): Promise<{ statusCode: number }> {
  const url = parseHttpCallbackUrl(rawUrl);
  const timeoutMs = options.timeoutMs ?? DEFAULT_HTTP_CALLBACK_TIMEOUT_MS;
  const abortController = new AbortController();
  return withTimeout(
    (async () => {
      const addresses = await resolveSafeCallbackAddresses(url, options.resolveHostname);
      return (options.request ?? sendHttpCallbackRequest)({
        url,
        addresses,
        body: JSON.stringify(payload),
        timeoutMs,
        signal: abortController.signal,
      });
    })(),
    timeoutMs,
    () => abortController.abort(),
  );
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, onTimeout: () => void): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<T>((_, reject) => {
    timeout = setTimeout(() => {
      onTimeout();
      reject(new Error('HTTP callback timed out'));
    }, timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
}

async function resolveSafeCallbackAddresses(
  url: URL,
  resolveHostname: HttpCompletionCallbackSenderOptions['resolveHostname'],
): Promise<ResolvedAddress[]> {
  const literalFamily = ipFamily(url.hostname);
  const addresses = literalFamily
    ? [{ address: normalizeIpLiteral(url.hostname), family: literalFamily }]
    : await (resolveHostname ?? resolveCallbackHostname)(url.hostname);
  if (!addresses.length) throw new Error('HTTP callback URL host did not resolve');
  for (const resolved of addresses) {
    if (isBlockedIp(resolved.address, resolved.family))
      throw new Error('HTTP callback URL resolved to a blocked IP range');
  }
  return addresses;
}

async function resolveCallbackHostname(hostname: string): Promise<ResolvedAddress[]> {
  return lookup(hostname, { all: true, verbatim: true }) as Promise<ResolvedAddress[]>;
}

function sendHttpCallbackRequest(input: ValidatedHttpCallbackRequest): Promise<{ statusCode: number }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const request = (input.url.protocol === 'https:' ? httpsRequest : httpRequest)(
      {
        protocol: input.url.protocol,
        hostname: input.url.hostname,
        port: input.url.port,
        path: `${input.url.pathname}${input.url.search}`,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(input.body),
        },
        timeout: input.timeoutMs,
        lookup: createPinnedLookup(input.addresses),
      },
      (response) => {
        response.resume();
        response.on('end', () => {
          const statusCode = response.statusCode ?? 0;
          if (statusCode >= 300 && statusCode < 400) fail(new Error('HTTP callback redirects are not allowed'));
          else succeed({ statusCode });
        });
      },
    );

    const timeoutError = () => new Error('HTTP callback timed out');
    const cleanup = () => input.signal.removeEventListener('abort', abortRequest);
    const succeed = (response: { statusCode: number }) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(response);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const abortRequest = () => {
      const error = timeoutError();
      request.destroy(error);
      fail(error);
    };

    input.signal.addEventListener('abort', abortRequest, { once: true });
    request.on('timeout', () => request.destroy(timeoutError()));
    request.on('error', fail);
    if (input.signal.aborted) {
      abortRequest();
      return;
    }
    request.end(input.body);
  });
}

function createPinnedLookup(addresses: ResolvedAddress[]) {
  return (
    _hostname: string,
    _options: unknown,
    callback: (error: NodeJS.ErrnoException | null, address: string, family: number) => void,
  ) => {
    const address = addresses[0]!;
    callback(null, address.address, address.family);
  };
}

function isBlockedHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/\.$/, '');
  return (
    normalized === 'localhost' ||
    normalized.endsWith('.localhost') ||
    normalized === 'metadata' ||
    normalized === 'metadata.google.internal' ||
    normalized === 'instance-data' ||
    normalized === 'instance-data.ec2.internal'
  );
}

function ipFamily(hostname: string): 4 | 6 | 0 {
  const family = isIP(normalizeIpLiteral(hostname));
  return family === 4 || family === 6 ? family : 0;
}

function normalizeIpLiteral(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

function isBlockedIp(address: string, family: 4 | 6): boolean {
  if (family === 4) return !isGlobalIpv4(address);
  return isBlockedIpv6(address);
}

function isGlobalIpv4(address: string): boolean {
  const bytes = ipv4Bytes(address);
  if (!bytes) return false;
  const isBlocked = (<Array<[number, number]>>[
    [ipv4Range(0, 0, 0, 0), 8],
    [ipv4Range(10, 0, 0, 0), 8],
    [ipv4Range(100, 64, 0, 0), 10],
    [ipv4Range(127, 0, 0, 0), 8],
    [ipv4Range(169, 254, 0, 0), 16],
    [ipv4Range(172, 16, 0, 0), 12],
    [ipv4Range(192, 0, 0, 0), 24],
    [ipv4Range(192, 0, 2, 0), 24],
    [ipv4Range(192, 88, 99, 0), 24],
    [ipv4Range(192, 168, 0, 0), 16],
    [ipv4Range(198, 18, 0, 0), 15],
    [ipv4Range(198, 51, 100, 0), 24],
    [ipv4Range(203, 0, 113, 0), 24],
    [ipv4Range(224, 0, 0, 0), 4],
    [ipv4Range(240, 0, 0, 0), 4],
  ]).some(([range, bits]) => ipv4InCidr(bytes, range, bits));
  return !isBlocked;
}

function isBlockedIpv6(address: string): boolean {
  const normalized = address.toLowerCase();
  const bytes = ipv6Bytes(normalized);
  if (!bytes) return true;
  const mappedIpv4 = ipv4FromMappedIpv6(bytes);
  if (mappedIpv4) return !isGlobalIpv4(mappedIpv4);
  return !isGlobalIpv6(bytes);
}

function isGlobalIpv6(bytes: number[]): boolean {
  return (
    ipv6InCidr(bytes, [0x20, 0x00], 3) &&
    !(<Array<[number[], number]>>[
      [[0x20, 0x01], 23],
      [[0x20, 0x01, 0x00, 0x02], 48],
      [[0x20, 0x01, 0x0d, 0xb8], 32],
      [[0x20, 0x02], 16],
      [[0x3f, 0xfe], 16],
    ]).some(([range, bits]) => ipv6InCidr(bytes, range, bits))
  );
}

function ipv4Bytes(address: string): [number, number, number, number] | null {
  const parts = address.split('.').map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
  return parts as [number, number, number, number];
}

function ipv4InCidr(bytes: [number, number, number, number], range: number, bits: number): boolean {
  const value = bytes.reduce((acc, byte) => acc * 256 + byte, 0);
  return Math.floor(value / 2 ** (32 - bits)) === Math.floor(range / 2 ** (32 - bits));
}

function ipv4Range(a: number, b: number, c: number, d: number): number {
  return ((a * 256 + b) * 256 + c) * 256 + d;
}

function ipv6InCidr(bytes: number[], range: number[], bits: number): boolean {
  const fullBytes = Math.floor(bits / 8);
  for (let index = 0; index < fullBytes; index += 1) {
    if (bytes[index] !== range[index]) return false;
  }
  const remainingBits = bits % 8;
  if (!remainingBits) return true;
  const mask = 0xff << (8 - remainingBits);
  return (bytes[fullBytes]! & mask) === ((range[fullBytes] ?? 0) & mask);
}

function ipv4FromMappedIpv6(bytes: number[]): string | null {
  if (!bytes.slice(0, 10).every((byte) => byte === 0) || bytes[10] !== 0xff || bytes[11] !== 0xff) return null;
  return `${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`;
}

function ipv6Bytes(address: string): number[] | null {
  const ipv4Match = address.match(/(?<ipv4>\d+\.\d+\.\d+\.\d+)$/);
  let normalized = address;
  if (ipv4Match?.groups?.ipv4) {
    const parts = ipv4Match.groups.ipv4.split('.').map((part) => Number(part));
    if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
    normalized = address.replace(
      ipv4Match.groups.ipv4,
      `${((parts[0]! << 8) | parts[1]!).toString(16)}:${((parts[2]! << 8) | parts[3]!).toString(16)}`,
    );
  }
  const [head = '', tail = ''] = normalized.split('::');
  if (normalized.split('::').length > 2) return null;
  const headParts = head ? head.split(':') : [];
  const tailParts = tail ? tail.split(':') : [];
  const missing = 8 - headParts.length - tailParts.length;
  if (missing < 0 || (!normalized.includes('::') && missing !== 0)) return null;
  const groups = [...headParts, ...Array(missing).fill('0'), ...tailParts];
  if (groups.length !== 8) return null;
  const bytes: number[] = [];
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(group)) return null;
    const value = Number.parseInt(group, 16);
    bytes.push(value >> 8, value & 0xff);
  }
  return bytes;
}

function getCompletionCallback(context: Record<string, unknown> | undefined): CompletionCallback | null {
  const callback = context?.callback;
  if (!callback || typeof callback !== 'object' || Array.isArray(callback)) return null;
  const type = 'type' in callback ? callback.type : undefined;
  const url = 'url' in callback ? callback.url : undefined;
  if (type === 'http' && typeof url === 'string' && url) return { type: 'http', target: { url } };
  const channel = 'channel' in callback ? callback.channel : undefined;
  const threadTs = 'threadTs' in callback ? callback.threadTs : undefined;
  if (type === 'slack' && typeof channel === 'string' && channel && typeof threadTs === 'string' && threadTs) {
    const target: Record<string, unknown> = { channel, threadTs };
    const messageTs = 'messageTs' in callback ? callback.messageTs : undefined;
    if (typeof messageTs === 'string' && messageTs) target.messageTs = messageTs;
    copyExternalReplyMetadata(callback, target);
    return { type: 'slack', target };
  }
  const owner = 'owner' in callback ? callback.owner : undefined;
  const repo = 'repo' in callback ? callback.repo : undefined;
  const issueNumber = 'issueNumber' in callback ? callback.issueNumber : undefined;
  if (
    type === 'github' &&
    typeof owner === 'string' &&
    owner &&
    typeof repo === 'string' &&
    repo &&
    typeof issueNumber === 'number' &&
    Number.isInteger(issueNumber) &&
    issueNumber > 0
  ) {
    const target: Record<string, unknown> = { owner, repo, issueNumber };
    copyExternalReplyMetadata(callback, target);
    return { type: 'github', target };
  }
  return null;
}

function copyExternalReplyMetadata(source: object, target: Record<string, unknown>): void {
  const sessionUrl = 'sessionUrl' in source ? source.sessionUrl : undefined;
  if (typeof sessionUrl === 'string' && sessionUrl) target.sessionUrl = sessionUrl;

  const replyHint = 'replyHint' in source ? source.replyHint : undefined;
  if (typeof replyHint === 'string' && replyHint) target.replyHint = replyHint;

  const includeSessionLink = 'includeSessionLink' in source ? source.includeSessionLink : undefined;
  if (includeSessionLink === true) target.includeSessionLink = true;
}
