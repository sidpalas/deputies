import { createHash, randomUUID } from 'node:crypto';
import {
  CreateMicrovmAuthTokenCommand,
  GetMicrovmCommand,
  GetMicrovmImageCommand,
  GetMicrovmImageVersionCommand,
  LambdaMicrovmsClient,
  ResumeMicrovmCommand,
  RunMicrovmCommand,
  SuspendMicrovmCommand,
  TerminateMicrovmCommand,
  type RunMicrovmCommandInput,
} from '@aws-sdk/client-lambda-microvms';
import type {
  ConnectSandboxInput,
  CreateSandboxInput,
  FileStat,
  SandboxCapabilities,
  SandboxExecInput,
  SandboxExecResult,
  SandboxFileSystem,
  SandboxHandle,
  SandboxHealth,
  SandboxProvider,
  SandboxProviderCheck,
  SandboxRef,
  SandboxServiceEndpoint,
  SandboxServiceEndpointInput,
} from './types.js';

const defaultBridgePort = 3584;
const defaultHooksPort = 9000;
const defaultReadyTimeoutMs = 60_000;
const authTokenRefreshSkewCapMs = 5 * 60_000;

export const lambdaMicrovmCapabilities: SandboxCapabilities = {
  persistentFilesystem: true,
  // Lambda MicroVM images are snapshot-like, but this provider exposes no product snapshot/restore API yet.
  snapshots: false,
  stopStart: true,
  exec: true,
  filesystem: true,
  streamingLogs: false,
  portForwarding: true,
  serviceEndpoints: true,
  objectStorageArtifacts: false,
};

export type LambdaMicrovmSandboxProviderOptions = {
  client?: LambdaMicrovmClientLike;
  region?: string | undefined;
  imageIdentifier: string;
  imageVersion?: string | undefined;
  executionRoleArn?: string | undefined;
  ingressNetworkConnectors?: string[] | undefined;
  egressNetworkConnectors?: string[] | undefined;
  idleTimeoutMs?: number | undefined;
  suspendedDurationMs?: number | undefined;
  maximumDurationSeconds?: number | undefined;
  authTokenTtlMinutes?: number | undefined;
  workspacePath?: string | undefined;
  bridgePort?: number | undefined;
  bridgeSkippedCookieNames?: string | undefined;
  logGroup?: string | undefined;
  readyTimeoutMs?: number | undefined;
};

export type LambdaMicrovmInfo = {
  microvmId: string;
  endpoint: string;
  state: string;
  imageArn?: string;
  imageVersion?: string;
  stateReason?: string;
};

export type LambdaMicrovmRunInput = {
  imageIdentifier: string;
  imageVersion?: string;
  executionRoleArn?: string;
  ingressNetworkConnectors?: string[];
  egressNetworkConnectors?: string[];
  idlePolicy?: { maxIdleDurationSeconds: number; suspendedDurationSeconds: number; autoResumeEnabled: boolean };
  runHookPayload: string;
  maximumDurationSeconds?: number;
  logGroup?: string;
  clientToken?: string;
};

export type LambdaMicrovmClientLike = {
  checkImage(imageIdentifier: string, imageVersion?: string): Promise<void>;
  run(input: LambdaMicrovmRunInput): Promise<LambdaMicrovmInfo>;
  get(microvmId: string): Promise<LambdaMicrovmInfo>;
  createAuthToken(input: { microvmId: string; port: number; expirationInMinutes: number }): Promise<string>;
  suspend(microvmId: string): Promise<void>;
  resume(microvmId: string): Promise<void>;
  terminate(microvmId: string): Promise<void>;
};

type LambdaMicrovmDescriptor = {
  providerSandboxId: string;
  sessionId: string;
  workspacePath: string;
  endpoint: string;
  bridgePort: number;
  bridgeToken: string;
  metadata: Record<string, unknown>;
};

type LambdaMicrovmRef = SandboxRef & { secrets?: Record<string, string> };
type LambdaMicrovmExecInput = LambdaMicrovmRef & SandboxExecInput;
type LambdaMicrovmFileInput = LambdaMicrovmRef & { path: string };
type LambdaMicrovmWriteFileInput = LambdaMicrovmFileInput & { content: string | Uint8Array };
type LambdaMicrovmMkdirInput = LambdaMicrovmFileInput & { recursive?: boolean };
type LambdaMicrovmRmInput = LambdaMicrovmFileInput & { recursive?: boolean; force?: boolean };
type AuthTokenOptions = { forceRefresh?: boolean };
type CachedAuthToken = { token: string; expiresAt: number };

export class LambdaMicrovmSandboxProvider implements SandboxProvider {
  readonly name = 'lambda-microvm';
  readonly capabilities = lambdaMicrovmCapabilities;
  private readonly client: LambdaMicrovmClientLike;
  private readonly descriptors = new Map<string, LambdaMicrovmDescriptor>();
  private readonly authTokens = new Map<string, CachedAuthToken>();

  constructor(private readonly options: LambdaMicrovmSandboxProviderOptions) {
    this.client = options.client ?? createLambdaMicrovmClient(options);
  }

  async check(): Promise<SandboxProviderCheck> {
    try {
      await this.client.checkImage(this.options.imageIdentifier, this.options.imageVersion);
      return { status: 'ready', checkedAt: new Date() };
    } catch (error) {
      return {
        status: 'unhealthy',
        message: error instanceof Error ? error.message : 'Unknown Lambda MicroVM connectivity error',
        checkedAt: new Date(),
      };
    }
  }

  async create(input: CreateSandboxInput): Promise<SandboxHandle> {
    const bridgeToken = randomUUID();
    const info = await this.client.run(this.runInput(input, bridgeToken));
    const descriptor = this.descriptor(info, input.sessionId, bridgeToken, input.metadata ?? {});
    try {
      await waitForBridge(
        descriptor,
        (port, options) => this.authToken(descriptor.providerSandboxId, port, options),
        this.readyTimeoutMs,
      );
      this.descriptors.set(descriptor.providerSandboxId, descriptor);
      return this.toHandle(descriptor);
    } catch (error) {
      await this.destroy({ providerSandboxId: descriptor.providerSandboxId, sessionId: input.sessionId }).catch(
        () => undefined,
      );
      throw error;
    }
  }

  async connect(input: ConnectSandboxInput): Promise<SandboxHandle> {
    const existing = this.descriptors.get(input.providerSandboxId);
    if (existing) return this.toHandle(existing);

    const bridgeToken = input.secrets?.bridgeToken ?? readMetadata(input.metadata ?? {}).bridgeToken;
    if (!bridgeToken) throw new Error('Lambda MicroVM sandbox secrets are missing bridgeToken');
    const info = await this.client.get(input.providerSandboxId);
    const descriptor = this.descriptor(info, input.sessionId, bridgeToken, input.metadata ?? {});
    await waitForBridge(
      descriptor,
      (port, options) => this.authToken(descriptor.providerSandboxId, port, options),
      this.readyTimeoutMs,
    );
    this.descriptors.set(descriptor.providerSandboxId, descriptor);
    return this.toHandle(descriptor);
  }

  async start(input: SandboxRef): Promise<void> {
    await this.client.resume(input.providerSandboxId);
  }

  async stop(input: SandboxRef): Promise<void> {
    await this.client.suspend(input.providerSandboxId);
  }

  async destroy(input: SandboxRef): Promise<void> {
    try {
      await this.client.terminate(input.providerSandboxId);
      this.descriptors.delete(input.providerSandboxId);
      this.clearAuthTokens(input.providerSandboxId);
    } catch (error) {
      if (isLambdaMicrovmMissingError(error)) return;
      throw error;
    }
  }

  async health(input: SandboxRef): Promise<SandboxHealth> {
    try {
      return lambdaMicrovmHealth(await this.client.get(input.providerSandboxId));
    } catch (error) {
      if (isLambdaMicrovmMissingError(error)) return { status: 'missing', checkedAt: new Date() };
      throw error;
    }
  }

  async getServiceEndpoint(input: SandboxServiceEndpointInput): Promise<SandboxServiceEndpoint | null> {
    const descriptor = await this.connectedDescriptor(input);
    if (isInternalMicrovmPort(input.port, descriptor.bridgePort)) return null;
    return {
      port: input.port,
      targetUrl: `${microvmBaseUrl(descriptor.endpoint)}/preview/${input.port}`,
      targetHeaders: {
        authorization: `Bearer ${descriptor.bridgeToken}`,
        'x-aws-proxy-auth': await this.authToken(descriptor.providerSandboxId, descriptor.bridgePort),
        'x-aws-proxy-port': String(descriptor.bridgePort),
      },
      preserveTargetHost: true,
      forwardPreviewHost: true,
    };
  }

  async exec(input: LambdaMicrovmExecInput): Promise<SandboxExecResult> {
    const result = await readBridgeJson(
      await this.bridgeFetch(await this.connectedDescriptor(input), '/exec', {
        method: 'POST',
        body: JSON.stringify(execRequestBody(input)),
        ...(input.signal ? { signal: input.signal } : {}),
      }),
    );
    const body = readObject(result);
    return {
      exitCode: readNumber(body.exitCode, 'exitCode'),
      stdout: readString(body.stdout, 'stdout'),
      stderr: readString(body.stderr, 'stderr'),
      startedAt: new Date(readString(body.startedAt, 'startedAt')),
      completedAt: new Date(readString(body.completedAt, 'completedAt')),
    };
  }

  async readFile(input: LambdaMicrovmFileInput): Promise<Uint8Array> {
    const response = await this.bridgeFetch(
      await this.connectedDescriptor(input),
      `/fs/read?path=${encodeURIComponent(input.path)}`,
    );
    const body = new Uint8Array(await response.arrayBuffer());
    validateFileReadResponse(input.path, response, body);
    return body;
  }

  async writeFile(input: LambdaMicrovmWriteFileInput): Promise<void> {
    await this.bridgeFetch(await this.connectedDescriptor(input), `/fs/write?path=${encodeURIComponent(input.path)}`, {
      method: 'PUT',
      body: input.content,
    });
  }

  async stat(input: LambdaMicrovmFileInput): Promise<FileStat> {
    return parseFileStat(
      await readBridgeJson(
        await this.bridgeFetch(
          await this.connectedDescriptor(input),
          `/fs/stat?path=${encodeURIComponent(input.path)}`,
        ),
      ),
    );
  }

  async readdir(input: LambdaMicrovmFileInput): Promise<string[]> {
    const body = await readBridgeJson(
      await this.bridgeFetch(
        await this.connectedDescriptor(input),
        `/fs/readdir?path=${encodeURIComponent(input.path)}`,
      ),
    );
    return readStringArray(readObject(body).entries);
  }

  async exists(input: LambdaMicrovmFileInput): Promise<boolean> {
    const body = await readBridgeJson(
      await this.bridgeFetch(
        await this.connectedDescriptor(input),
        `/fs/exists?path=${encodeURIComponent(input.path)}`,
      ),
    );
    return readObject(body).exists === true;
  }

  async mkdir(input: LambdaMicrovmMkdirInput): Promise<void> {
    await this.bridgeFetch(await this.connectedDescriptor(input), '/fs/mkdir', {
      method: 'POST',
      body: JSON.stringify({ path: input.path, recursive: input.recursive }),
    });
  }

  async rm(input: LambdaMicrovmRmInput): Promise<void> {
    await this.bridgeFetch(await this.connectedDescriptor(input), '/fs/rm', {
      method: 'POST',
      body: JSON.stringify({ path: input.path, recursive: input.recursive, force: input.force }),
    });
  }

  private async connectedDescriptor(input: LambdaMicrovmRef): Promise<LambdaMicrovmDescriptor> {
    const existing = this.descriptors.get(input.providerSandboxId);
    if (existing) return existing;
    await this.connect(input);
    const descriptor = this.descriptors.get(input.providerSandboxId);
    if (!descriptor) throw new Error(`Lambda MicroVM descriptor not found after connect: ${input.providerSandboxId}`);
    return descriptor;
  }

  private async bridgeFetch(
    descriptor: LambdaMicrovmDescriptor,
    path: string,
    init: RequestInit = {},
  ): Promise<Response> {
    const response = await this.bridgeFetchOnce(descriptor, path, init);
    if (isAuthRejectedStatus(response.status)) {
      this.invalidateAuthToken(descriptor.providerSandboxId, descriptor.bridgePort);
      const retry = await this.bridgeFetchOnce(descriptor, path, init, { forceRefresh: true });
      if (!retry.ok) {
        throw await bridgeRequestError(retry);
      }
      return retry;
    }
    if (!response.ok) {
      throw await bridgeRequestError(response);
    }
    return response;
  }

  private async bridgeFetchOnce(
    descriptor: LambdaMicrovmDescriptor,
    path: string,
    init: RequestInit,
    authOptions?: AuthTokenOptions,
  ): Promise<Response> {
    return fetch(`${microvmBaseUrl(descriptor.endpoint)}${path}`, {
      ...init,
      headers: {
        ...headersToRecord(init.headers),
        authorization: `Bearer ${descriptor.bridgeToken}`,
        'x-aws-proxy-auth': await this.authToken(descriptor.providerSandboxId, descriptor.bridgePort, authOptions),
        'x-aws-proxy-port': String(descriptor.bridgePort),
      },
    });
  }

  private runInput(input: CreateSandboxInput, bridgeToken: string): LambdaMicrovmRunInput {
    return {
      imageIdentifier: this.options.imageIdentifier,
      ...(this.options.imageVersion ? { imageVersion: this.options.imageVersion } : {}),
      ...(this.options.executionRoleArn ? { executionRoleArn: this.options.executionRoleArn } : {}),
      ...(this.options.ingressNetworkConnectors?.length
        ? { ingressNetworkConnectors: this.options.ingressNetworkConnectors }
        : {}),
      ...(this.options.egressNetworkConnectors?.length
        ? { egressNetworkConnectors: this.options.egressNetworkConnectors }
        : {}),
      idlePolicy: {
        maxIdleDurationSeconds: Math.max(1, Math.ceil((this.options.idleTimeoutMs ?? 900_000) / 1000)),
        suspendedDurationSeconds: Math.max(1, Math.ceil((this.options.suspendedDurationMs ?? 3_600_000) / 1000)),
        autoResumeEnabled: true,
      },
      runHookPayload: JSON.stringify({
        sessionId: input.sessionId,
        workspacePath: this.workspacePath,
        bridgePort: this.bridgePort,
        bridgeToken,
        ...(this.options.bridgeSkippedCookieNames
          ? { bridgeSkippedCookieNames: this.options.bridgeSkippedCookieNames }
          : {}),
      }),
      ...(this.options.maximumDurationSeconds ? { maximumDurationSeconds: this.options.maximumDurationSeconds } : {}),
      ...(this.options.logGroup ? { logGroup: this.options.logGroup } : {}),
      clientToken: randomUUID(),
    };
  }

  private descriptor(
    info: LambdaMicrovmInfo,
    sessionId: string,
    bridgeToken: string,
    metadata: Record<string, unknown>,
  ): LambdaMicrovmDescriptor {
    return {
      providerSandboxId: info.microvmId,
      sessionId,
      workspacePath: this.workspacePath,
      endpoint: info.endpoint,
      bridgePort: this.bridgePort,
      bridgeToken,
      metadata: {
        ...metadata,
        microvmId: info.microvmId,
        endpoint: info.endpoint,
        imageArn: info.imageArn,
        imageVersion: info.imageVersion,
        workspacePath: this.workspacePath,
        bridgePort: this.bridgePort,
      },
    };
  }

  private toHandle(descriptor: LambdaMicrovmDescriptor): SandboxHandle {
    const ref = { providerSandboxId: descriptor.providerSandboxId, sessionId: descriptor.sessionId };
    const secrets = { bridgeToken: descriptor.bridgeToken };
    return {
      provider: this.name,
      providerSandboxId: descriptor.providerSandboxId,
      sessionId: descriptor.sessionId,
      workspacePath: descriptor.workspacePath,
      metadata: descriptor.metadata,
      secrets,
      capabilities: this.capabilities,
      fs: createLambdaMicrovmFileSystem(this, { ...ref, secrets }),
      exec: (input) => this.exec({ ...ref, secrets, ...input }),
    };
  }

  private async authToken(microvmId: string, port: number, options: AuthTokenOptions = {}): Promise<string> {
    const key = authTokenCacheKey(microvmId, port);
    const cached = this.authTokens.get(key);
    if (!options.forceRefresh && cached && Date.now() < cached.expiresAt) return cached.token;

    const ttlMinutes = this.options.authTokenTtlMinutes ?? 30;
    const ttlMs = ttlMinutes * 60_000;
    const refreshSkewMs = Math.min(ttlMs * 0.2, authTokenRefreshSkewCapMs);
    const token = await this.client.createAuthToken({
      microvmId,
      port,
      expirationInMinutes: ttlMinutes,
    });
    this.authTokens.set(key, { token, expiresAt: Date.now() + ttlMs - refreshSkewMs });
    return token;
  }

  private invalidateAuthToken(microvmId: string, port: number): void {
    this.authTokens.delete(authTokenCacheKey(microvmId, port));
  }

  private clearAuthTokens(microvmId: string): void {
    for (const key of this.authTokens.keys()) {
      if (key.startsWith(`${microvmId}:`)) this.authTokens.delete(key);
    }
  }

  private get workspacePath(): string {
    return this.options.workspacePath ?? '/workspace';
  }

  private get bridgePort(): number {
    return this.options.bridgePort ?? defaultBridgePort;
  }

  private get readyTimeoutMs(): number {
    return this.options.readyTimeoutMs ?? defaultReadyTimeoutMs;
  }
}

function authTokenCacheKey(microvmId: string, port: number): string {
  return `${microvmId}:${port}`;
}

function isAuthRejectedStatus(status: number): boolean {
  return status === 401 || status === 403;
}

function isInternalMicrovmPort(port: number, bridgePort: number): boolean {
  return port === bridgePort || port === defaultHooksPort;
}

function createLambdaMicrovmClient(
  options: Pick<LambdaMicrovmSandboxProviderOptions, 'region'>,
): LambdaMicrovmClientLike {
  const clientConfig: ConstructorParameters<typeof LambdaMicrovmsClient>[0] = {};
  if (options.region) clientConfig.region = options.region;
  const client = new LambdaMicrovmsClient(clientConfig);
  return {
    async checkImage(imageIdentifier: string, imageVersion?: string): Promise<void> {
      const image = await client.send(new GetMicrovmImageCommand({ imageIdentifier }));
      if (image.state !== 'CREATED' && image.state !== 'UPDATED') {
        throw new Error(`Lambda MicroVM image ${imageIdentifier} is not ready: ${image.state ?? 'unknown'}`);
      }
      if (!imageVersion) {
        if (!image.latestActiveImageVersion) {
          throw new Error(`Lambda MicroVM image ${imageIdentifier} has no latest active version`);
        }
        return;
      }
      const version = await client.send(new GetMicrovmImageVersionCommand({ imageIdentifier, imageVersion }));
      if (version.state !== 'SUCCESSFUL' || version.status !== 'ACTIVE') {
        throw new Error(
          `Lambda MicroVM image ${imageIdentifier}:${imageVersion} is not runnable: state=${version.state ?? 'unknown'} status=${version.status ?? 'unknown'}`,
        );
      }
    },
    async run(input: LambdaMicrovmRunInput): Promise<LambdaMicrovmInfo> {
      const commandInput: RunMicrovmCommandInput = {
        imageIdentifier: input.imageIdentifier,
        ...(input.imageVersion ? { imageVersion: input.imageVersion } : {}),
        ...(input.executionRoleArn ? { executionRoleArn: input.executionRoleArn } : {}),
        ...(input.ingressNetworkConnectors?.length ? { ingressNetworkConnectors: input.ingressNetworkConnectors } : {}),
        ...(input.egressNetworkConnectors?.length ? { egressNetworkConnectors: input.egressNetworkConnectors } : {}),
        ...(input.idlePolicy ? { idlePolicy: input.idlePolicy } : {}),
        ...(input.maximumDurationSeconds ? { maximumDurationInSeconds: input.maximumDurationSeconds } : {}),
        ...(input.logGroup ? { logging: { cloudWatch: { logGroup: input.logGroup } } } : {}),
        runHookPayload: input.runHookPayload,
        ...(input.clientToken ? { clientToken: input.clientToken } : {}),
      };
      return readMicrovmInfo(await client.send(new RunMicrovmCommand(commandInput)));
    },
    async get(microvmId: string): Promise<LambdaMicrovmInfo> {
      return readMicrovmInfo(await client.send(new GetMicrovmCommand({ microvmIdentifier: microvmId })));
    },
    async createAuthToken(input: { microvmId: string; port: number; expirationInMinutes: number }): Promise<string> {
      const result = await client.send(
        new CreateMicrovmAuthTokenCommand({
          microvmIdentifier: input.microvmId,
          expirationInMinutes: input.expirationInMinutes,
          allowedPorts: [{ port: input.port }],
        }),
      );
      const token =
        result.authToken?.['X-aws-proxy-auth'] ??
        result.authToken?.['x-aws-proxy-auth'] ??
        Object.values(result.authToken ?? {})[0];
      if (!token) throw new Error('Lambda MicroVM auth token response did not include X-aws-proxy-auth');
      return token;
    },
    async suspend(microvmId: string): Promise<void> {
      await client.send(new SuspendMicrovmCommand({ microvmIdentifier: microvmId }));
    },
    async resume(microvmId: string): Promise<void> {
      await client.send(new ResumeMicrovmCommand({ microvmIdentifier: microvmId }));
    },
    async terminate(microvmId: string): Promise<void> {
      await client.send(new TerminateMicrovmCommand({ microvmIdentifier: microvmId }));
    },
  };
}

function createLambdaMicrovmFileSystem(
  provider: LambdaMicrovmSandboxProvider,
  ref: LambdaMicrovmRef,
): SandboxFileSystem {
  return {
    async readFile(path) {
      return Buffer.from(await provider.readFile({ ...ref, path })).toString('utf-8');
    },
    async readFileBuffer(path) {
      return provider.readFile({ ...ref, path });
    },
    async writeFile(path, content) {
      await provider.writeFile({ ...ref, path, content });
    },
    async stat(path) {
      return provider.stat({ ...ref, path });
    },
    async readdir(path) {
      return provider.readdir({ ...ref, path });
    },
    async exists(path) {
      return provider.exists({ ...ref, path });
    },
    async mkdir(path, options) {
      const input: LambdaMicrovmMkdirInput = { ...ref, path };
      if (options?.recursive !== undefined) input.recursive = options.recursive;
      await provider.mkdir(input);
    },
    async rm(path, options) {
      const input: LambdaMicrovmRmInput = { ...ref, path };
      if (options?.recursive !== undefined) input.recursive = options.recursive;
      if (options?.force !== undefined) input.force = options.force;
      await provider.rm(input);
    },
  };
}

async function waitForBridge(
  descriptor: LambdaMicrovmDescriptor,
  authToken: (port: number, options?: AuthTokenOptions) => Promise<string>,
  timeoutMs: number,
): Promise<void> {
  const startedAt = Date.now();
  let lastError: unknown;
  let forceRefresh = false;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(`${microvmBaseUrl(descriptor.endpoint)}/health`, {
        headers: {
          authorization: `Bearer ${descriptor.bridgeToken}`,
          'x-aws-proxy-auth': await authToken(descriptor.bridgePort, forceRefresh ? { forceRefresh: true } : undefined),
          'x-aws-proxy-port': String(descriptor.bridgePort),
        },
      });
      if (response.ok) return;
      forceRefresh = isAuthRejectedStatus(response.status);
      lastError = new Error(await response.text());
    } catch (error) {
      forceRefresh = false;
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw lastError instanceof Error ? lastError : new Error('Lambda MicroVM sandbox bridge did not become ready');
}

async function bridgeRequestError(response: Response): Promise<Error> {
  const text = await response.text();
  return new Error(text || `Lambda MicroVM bridge request failed: ${response.status}`);
}

function lambdaMicrovmHealth(info: LambdaMicrovmInfo): SandboxHealth {
  const checkedAt = new Date();
  if (info.state === 'RUNNING') return { status: 'ready', checkedAt };
  if (info.state === 'PENDING' || info.state === 'SUSPENDING') return { status: 'starting', checkedAt };
  if (info.state === 'SUSPENDED')
    return { status: 'stopped', message: 'Lambda MicroVM is suspended with auto-resume', checkedAt };
  if (info.state === 'TERMINATED' || info.state === 'TERMINATING') return { status: 'missing', checkedAt };
  return { status: 'unhealthy', message: info.stateReason ?? `Lambda MicroVM state: ${info.state}`, checkedAt };
}

function microvmBaseUrl(endpoint: string): string {
  const trimmed = endpoint.replace(/\/$/, '');
  return /^https?:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`;
}

function readMicrovmInfo(value: {
  microvmId?: string | undefined;
  endpoint?: string | undefined;
  state?: string | undefined;
  imageArn?: string | undefined;
  imageVersion?: string | undefined;
  stateReason?: string | undefined;
}): LambdaMicrovmInfo {
  if (!value.microvmId) throw new Error('Lambda MicroVM response did not include microvmId');
  if (!value.endpoint) throw new Error('Lambda MicroVM response did not include endpoint');
  if (!value.state) throw new Error('Lambda MicroVM response did not include state');
  return {
    microvmId: value.microvmId,
    endpoint: value.endpoint,
    state: value.state,
    ...(value.imageArn ? { imageArn: value.imageArn } : {}),
    ...(value.imageVersion ? { imageVersion: value.imageVersion } : {}),
    ...(value.stateReason ? { stateReason: value.stateReason } : {}),
  };
}

function validateFileReadResponse(path: string, response: Response, body: Uint8Array): void {
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null) {
    const expectedLength = Number(contentLength);
    if (!Number.isSafeInteger(expectedLength) || expectedLength < 0) {
      throw new Error(`Lambda MicroVM bridge read returned invalid content-length for ${path}: ${contentLength}`);
    }
    if (body.byteLength !== expectedLength) {
      throw new Error(
        `Lambda MicroVM bridge read length mismatch for ${path}: expected ${expectedLength} bytes, received ${body.byteLength}`,
      );
    }
  }

  const expectedChecksum = response.headers.get('x-deputies-sha256');
  if (!expectedChecksum) return;
  const actualChecksum = createHash('sha256').update(body).digest('hex');
  if (actualChecksum !== expectedChecksum) {
    throw new Error(`Lambda MicroVM bridge read checksum mismatch for ${path}`);
  }
}

function execRequestBody<T extends SandboxExecInput>(input: T): Omit<T, 'signal'> {
  const { signal: _signal, ...body } = input;
  return body;
}

async function readBridgeJson(response: Response): Promise<unknown> {
  return response.json();
}

function parseFileStat(value: unknown): FileStat {
  const body = readObject(value);
  return {
    isFile: body.isFile === true,
    isDirectory: body.isDirectory === true,
    isSymbolicLink: body.isSymbolicLink === true,
    size: readNumber(body.size, 'size'),
    mtime: new Date(readString(body.mtime, 'mtime')),
  };
}

function readMetadata(metadata: Record<string, unknown>): { bridgeToken?: string } {
  const bridgeToken = metadata.bridgeToken;
  return typeof bridgeToken === 'string' && bridgeToken ? { bridgeToken } : {};
}

function headersToRecord(headers: RequestInit['headers'] | undefined): Record<string, string> {
  if (!headers) return {};
  return Object.fromEntries(new Headers(headers).entries());
}

function readObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected object');
  return value as Record<string, unknown>;
}

function readString(value: unknown, name: string): string {
  if (typeof value !== 'string') throw new Error(`Expected ${name} to be a string`);
  return value;
}

function readNumber(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`Expected ${name} to be a number`);
  return value;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new Error('Expected string array');
  }
  return value;
}

function isLambdaMicrovmMissingError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const name = 'name' in error ? error.name : undefined;
  const statusCode = '$metadata' in error && isRecord(error.$metadata) ? error.$metadata.httpStatusCode : undefined;
  return name === 'ResourceNotFoundException' || statusCode === 404;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
