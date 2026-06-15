import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { sandboxBridgeSkipCookieNamesEnv } from './bridge-env.js';
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
  SandboxServiceEndpoint,
  SandboxServiceEndpointInput,
  SandboxProvider,
  SandboxProviderCheck,
  SandboxRef,
} from './types.js';

const bridgePort = 3584;
const defaultDockerCliTimeoutMs = 30_000;

export const dockerCapabilities: SandboxCapabilities = {
  persistentFilesystem: true,
  snapshots: false,
  stopStart: true,
  exec: true,
  filesystem: true,
  streamingLogs: false,
  portForwarding: false,
  serviceEndpoints: true,
  objectStorageArtifacts: false,
};

export type DockerSandboxDescriptor = {
  providerSandboxId: string;
  sessionId: string;
  workspacePath: string;
  bridgeUrl: string;
  bridgeToken: string;
  metadata: Record<string, unknown>;
};

export type DockerSandboxProviderOptions = {
  orchestrator: DockerOrchestrator;
};

export type InProcessDockerOrchestratorOptions = {
  image?: string | undefined;
  workspacePath?: string | undefined;
  bridgeHost?: string | undefined;
  network?: string | undefined;
  memory?: string | undefined;
  cpus?: string | undefined;
  dockerCliTimeoutMs?: number | undefined;
  bridgeSkippedCookieNames?: string | undefined;
};

export type HttpDockerOrchestratorClientOptions = {
  baseUrl: string;
  token?: string | undefined;
};

export type DockerCreateSandboxInput = CreateSandboxInput;
export type DockerConnectSandboxInput = ConnectSandboxInput;
export type DockerSandboxRef = SandboxRef & { secrets?: Record<string, string> };

export type DockerExecInput = DockerSandboxRef & SandboxExecInput;
export type DockerFileInput = DockerSandboxRef & { path: string };
export type DockerWriteFileInput = DockerFileInput & { content: string | Uint8Array };
export type DockerMkdirInput = DockerFileInput & { recursive?: boolean };
export type DockerRmInput = DockerFileInput & { recursive?: boolean; force?: boolean };
export type DockerServiceEndpointInput = DockerSandboxRef & { port: number };

export interface DockerOrchestrator {
  check?(): Promise<SandboxProviderCheck>;
  create(input: DockerCreateSandboxInput): Promise<DockerSandboxDescriptor>;
  connect(input: DockerConnectSandboxInput): Promise<DockerSandboxDescriptor>;
  health(input: DockerSandboxRef): Promise<SandboxHealth>;
  start(input: DockerSandboxRef): Promise<void>;
  stop(input: DockerSandboxRef): Promise<void>;
  destroy(input: DockerSandboxRef): Promise<void>;
  exec(input: DockerExecInput): Promise<SandboxExecResult>;
  readFile(input: DockerFileInput): Promise<Uint8Array>;
  writeFile(input: DockerWriteFileInput): Promise<void>;
  stat(input: DockerFileInput): Promise<FileStat>;
  readdir(input: DockerFileInput): Promise<string[]>;
  exists(input: DockerFileInput): Promise<boolean>;
  mkdir(input: DockerMkdirInput): Promise<void>;
  rm(input: DockerRmInput): Promise<void>;
  getServiceEndpoint?(input: DockerServiceEndpointInput): Promise<SandboxServiceEndpoint | null>;
}

export class DockerSandboxProvider implements SandboxProvider {
  readonly name = 'docker';
  readonly capabilities = dockerCapabilities;

  constructor(private readonly options: DockerSandboxProviderOptions) {}

  async check(): Promise<SandboxProviderCheck> {
    if (!this.options.orchestrator.check) return { status: 'ready', checkedAt: new Date() };
    return this.options.orchestrator.check();
  }

  async create(input: CreateSandboxInput): Promise<SandboxHandle> {
    return this.toHandle(await this.options.orchestrator.create(input));
  }

  async connect(input: ConnectSandboxInput): Promise<SandboxHandle> {
    return this.toHandle(await this.options.orchestrator.connect(input));
  }

  async start(input: SandboxRef): Promise<void> {
    await this.options.orchestrator.start(input);
  }

  async stop(input: SandboxRef): Promise<void> {
    await this.options.orchestrator.stop(input);
  }

  async destroy(input: SandboxRef): Promise<void> {
    await this.options.orchestrator.destroy(input);
  }

  async health(input: SandboxRef): Promise<SandboxHealth> {
    return this.options.orchestrator.health(input);
  }

  async getServiceEndpoint(input: SandboxServiceEndpointInput): Promise<SandboxServiceEndpoint | null> {
    return this.options.orchestrator.getServiceEndpoint?.(input) ?? null;
  }

  private toHandle(descriptor: DockerSandboxDescriptor): SandboxHandle {
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
      fs: createDockerFileSystem(this.options.orchestrator, { ...ref, secrets }),
      exec: (input) => this.options.orchestrator.exec({ ...ref, secrets, ...input }),
    };
  }
}

export class InProcessDockerOrchestrator implements DockerOrchestrator {
  private readonly image: string;
  private readonly workspacePath: string;
  private readonly bridgeHost: string;
  private readonly dockerCliTimeoutMs: number;
  private readonly descriptors = new Map<string, DockerSandboxDescriptor>();

  constructor(private readonly options: InProcessDockerOrchestratorOptions = {}) {
    this.image = options.image ?? 'deputies-sandbox:local';
    this.workspacePath = options.workspacePath ?? '/workspace';
    this.bridgeHost = options.bridgeHost ?? '127.0.0.1';
    this.dockerCliTimeoutMs = options.dockerCliTimeoutMs ?? defaultDockerCliTimeoutMs;
  }

  async check(): Promise<SandboxProviderCheck> {
    await this.docker(['info', '--format', '{{.ServerVersion}}']);
    return { status: 'ready', checkedAt: new Date() };
  }

  async create(input: DockerCreateSandboxInput): Promise<DockerSandboxDescriptor> {
    const bridgeToken = randomUUID();
    const name = `deputies-${safeId(input.sessionId)}-${randomUUID().slice(0, 8)}`;
    const args = [
      'run',
      '-d',
      '--name',
      name,
      '--label',
      'deputies.sandbox-provider=docker',
      '--label',
      `deputies.session-id=${input.sessionId}`,
      '-e',
      `DEPUTIES_SANDBOX_TOKEN=${bridgeToken}`,
      '-e',
      `DEPUTIES_WORKSPACE=${this.workspacePath}`,
      '-p',
      `127.0.0.1::${bridgePort}`,
    ];
    if (this.options.bridgeSkippedCookieNames) {
      args.push('-e', `${sandboxBridgeSkipCookieNamesEnv}=${this.options.bridgeSkippedCookieNames}`);
    }
    if (this.options.network) args.push('--network', this.options.network);
    if (this.options.memory) args.push('--memory', this.options.memory);
    if (this.options.cpus) args.push('--cpus', this.options.cpus);
    args.push(this.image);

    const containerId = (await this.docker(args)).stdout.trim();
    try {
      const bridgeUrl = await this.bridgeUrl(containerId);
      const descriptor = this.descriptor({
        providerSandboxId: containerId,
        sessionId: input.sessionId,
        bridgeUrl,
        bridgeToken,
        metadata: input.metadata ?? {},
      });
      await waitForBridge(descriptor);
      this.descriptors.set(containerId, descriptor);
      return descriptor;
    } catch (error) {
      await this.destroy({ providerSandboxId: containerId, sessionId: input.sessionId }).catch(() => undefined);
      throw error;
    }
  }

  async connect(input: DockerConnectSandboxInput): Promise<DockerSandboxDescriptor> {
    const existing = this.descriptors.get(input.providerSandboxId);
    if (existing) {
      const descriptor = await this.refreshDescriptor(existing);
      await waitForBridge(descriptor);
      this.descriptors.set(input.providerSandboxId, descriptor);
      return descriptor;
    }

    const inspected = await this.inspect(input.providerSandboxId);
    const metadata = readMetadata(input.metadata ?? {});
    const bridgeUrl = metadata.bridgeUrl ?? (await this.bridgeUrl(input.providerSandboxId));
    const bridgeToken = input.secrets?.bridgeToken ?? metadata.bridgeToken;
    if (!bridgeToken) throw new Error('Docker sandbox secrets are missing bridgeToken');
    const descriptor = this.descriptor({
      providerSandboxId: inspected.id,
      sessionId: input.sessionId,
      bridgeUrl,
      bridgeToken,
      metadata: input.metadata ?? {},
    });
    await waitForBridge(descriptor);
    this.descriptors.set(inspected.id, descriptor);
    return descriptor;
  }

  async health(input: DockerSandboxRef): Promise<SandboxHealth> {
    try {
      const inspected = await this.inspect(input.providerSandboxId);
      if (inspected.state === 'running') return { status: 'ready', checkedAt: new Date() };
      if (inspected.state === 'created' || inspected.state === 'restarting')
        return { status: 'starting', checkedAt: new Date() };
      if (inspected.state === 'exited') return { status: 'stopped', checkedAt: new Date() };
      return { status: 'unhealthy', message: `Docker container state: ${inspected.state}`, checkedAt: new Date() };
    } catch (error) {
      if (isDockerMissingError(error)) return { status: 'missing', checkedAt: new Date() };
      throw error;
    }
  }

  async start(input: DockerSandboxRef): Promise<void> {
    await this.docker(['start', input.providerSandboxId]);
  }

  async stop(input: DockerSandboxRef): Promise<void> {
    await this.docker(['stop', input.providerSandboxId]);
  }

  async destroy(input: DockerSandboxRef): Promise<void> {
    const result = await this.docker(['rm', '-f', input.providerSandboxId], { allowFailure: true });
    this.descriptors.delete(input.providerSandboxId);
    if (result.exitCode !== 0 && !isMissingDockerOutput(result.stderr)) throw new Error(result.stderr || result.stdout);
  }

  async exec(input: DockerExecInput): Promise<SandboxExecResult> {
    return execBridge(await this.connectedDescriptor(input), input);
  }

  async readFile(input: DockerFileInput): Promise<Uint8Array> {
    const response = await bridgeFetch(
      await this.connectedDescriptor(input),
      `/fs/read?path=${encodeURIComponent(input.path)}`,
    );
    return new Uint8Array(await response.arrayBuffer());
  }

  async writeFile(input: DockerWriteFileInput): Promise<void> {
    await bridgeFetch(await this.connectedDescriptor(input), `/fs/write?path=${encodeURIComponent(input.path)}`, {
      method: 'PUT',
      body: input.content,
    });
  }

  async stat(input: DockerFileInput): Promise<FileStat> {
    const body = await readBridgeJson(
      await bridgeFetch(await this.connectedDescriptor(input), `/fs/stat?path=${encodeURIComponent(input.path)}`),
    );
    return parseFileStat(body);
  }

  async readdir(input: DockerFileInput): Promise<string[]> {
    const body = await readBridgeJson(
      await bridgeFetch(await this.connectedDescriptor(input), `/fs/readdir?path=${encodeURIComponent(input.path)}`),
    );
    return readStringArray(readObject(body).entries);
  }

  async exists(input: DockerFileInput): Promise<boolean> {
    const body = await readBridgeJson(
      await bridgeFetch(await this.connectedDescriptor(input), `/fs/exists?path=${encodeURIComponent(input.path)}`),
    );
    return readObject(body).exists === true;
  }

  async mkdir(input: DockerMkdirInput): Promise<void> {
    await bridgeFetch(await this.connectedDescriptor(input), '/fs/mkdir', {
      method: 'POST',
      body: JSON.stringify({ path: input.path, recursive: input.recursive }),
    });
  }

  async rm(input: DockerRmInput): Promise<void> {
    await bridgeFetch(await this.connectedDescriptor(input), '/fs/rm', {
      method: 'POST',
      body: JSON.stringify({ path: input.path, recursive: input.recursive, force: input.force }),
    });
  }

  async getServiceEndpoint(input: DockerServiceEndpointInput): Promise<SandboxServiceEndpoint | null> {
    const descriptor = await this.connectedDescriptor(input);
    return {
      port: input.port,
      targetUrl: `${descriptor.bridgeUrl}/preview/${input.port}`,
      targetHeaders: { authorization: `Bearer ${descriptor.bridgeToken}` },
      forwardPreviewHost: true,
    };
  }

  private async connectedDescriptor(input: DockerSandboxRef): Promise<DockerSandboxDescriptor> {
    const existing = this.descriptors.get(input.providerSandboxId);
    if (existing) return existing;
    const connectInput: DockerConnectSandboxInput = {
      providerSandboxId: input.providerSandboxId,
      sessionId: input.sessionId,
    };
    if (input.secrets) connectInput.secrets = input.secrets;
    return this.connect(connectInput);
  }

  private descriptor(input: Omit<DockerSandboxDescriptor, 'workspacePath'>): DockerSandboxDescriptor {
    return {
      ...input,
      workspacePath: this.workspacePath,
      metadata: {
        ...input.metadata,
        containerId: input.providerSandboxId,
        image: this.image,
        workspacePath: this.workspacePath,
        bridgeUrl: input.bridgeUrl,
      },
    };
  }

  private async refreshDescriptor(descriptor: DockerSandboxDescriptor): Promise<DockerSandboxDescriptor> {
    const bridgeUrl = await this.bridgeUrl(descriptor.providerSandboxId);
    return {
      ...descriptor,
      bridgeUrl,
      metadata: {
        ...descriptor.metadata,
        bridgeUrl,
      },
    };
  }

  private async inspect(providerSandboxId: string): Promise<{ id: string; state: string }> {
    const result = await this.docker(['inspect', providerSandboxId]);
    const inspected = JSON.parse(result.stdout) as Array<{ Id?: string; State?: { Status?: string } }>;
    const container = inspected[0];
    if (!container?.Id) throw new Error(`Docker container not found: ${providerSandboxId}`);
    return { id: container.Id, state: container.State?.Status ?? 'unknown' };
  }

  private async bridgeUrl(providerSandboxId: string): Promise<string> {
    const result = await this.docker(['port', providerSandboxId, `${bridgePort}/tcp`]);
    const hostPort = result.stdout.trim().split('\n')[0]?.split(':').pop();
    if (!hostPort) throw new Error(`Docker bridge port is not published for ${providerSandboxId}`);
    return `http://${this.bridgeHost}:${hostPort}`;
  }

  private docker(args: string[], options: { allowFailure?: boolean } = {}) {
    return docker(args, { ...options, timeoutMs: this.dockerCliTimeoutMs });
  }
}

export class HttpDockerOrchestratorClient implements DockerOrchestrator {
  private readonly baseUrl: string;

  constructor(private readonly options: HttpDockerOrchestratorClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
  }

  async check(): Promise<SandboxProviderCheck> {
    const response = await fetch(`${this.baseUrl}/health`, { headers: this.headers() });
    const text = await response.text();
    const parsed = text ? (JSON.parse(text) as unknown) : {};
    if (!response.ok) {
      const error = readObject(parsed).error;
      throw new Error(
        typeof error === 'string' ? error : `Docker orchestrator health check failed: ${response.status}`,
      );
    }
    const body = readObject(parsed);
    return {
      status: body.status === 'ready' ? 'ready' : 'unhealthy',
      ...(typeof body.message === 'string' ? { message: body.message } : {}),
      checkedAt: typeof body.checkedAt === 'string' ? new Date(body.checkedAt) : new Date(),
    };
  }

  create(input: DockerCreateSandboxInput): Promise<DockerSandboxDescriptor> {
    return this.post('/sandboxes', input) as Promise<DockerSandboxDescriptor>;
  }

  connect(input: DockerConnectSandboxInput): Promise<DockerSandboxDescriptor> {
    return this.post(
      `/sandboxes/${encodeURIComponent(input.providerSandboxId)}/connect`,
      input,
    ) as Promise<DockerSandboxDescriptor>;
  }

  health(input: DockerSandboxRef): Promise<SandboxHealth> {
    return this.post(`/sandboxes/${encodeURIComponent(input.providerSandboxId)}/health`, input).then(
      parseSandboxHealth,
    );
  }

  async start(input: DockerSandboxRef): Promise<void> {
    await this.post(`/sandboxes/${encodeURIComponent(input.providerSandboxId)}/start`, input);
  }

  async stop(input: DockerSandboxRef): Promise<void> {
    await this.post(`/sandboxes/${encodeURIComponent(input.providerSandboxId)}/stop`, input);
  }

  async destroy(input: DockerSandboxRef): Promise<void> {
    await this.post(`/sandboxes/${encodeURIComponent(input.providerSandboxId)}/destroy`, input);
  }

  exec(input: DockerExecInput): Promise<SandboxExecResult> {
    return this.post(
      `/sandboxes/${encodeURIComponent(input.providerSandboxId)}/exec`,
      execRequestBody(input),
      input.signal ? { signal: input.signal } : {},
    ).then(parseExecResult);
  }

  async readFile(input: DockerFileInput): Promise<Uint8Array> {
    const body = readObject(
      await this.post(`/sandboxes/${encodeURIComponent(input.providerSandboxId)}/fs/read`, input),
    );
    if (typeof body.contentBase64 !== 'string') throw new Error('Invalid Docker orchestrator readFile response');
    return new Uint8Array(Buffer.from(body.contentBase64, 'base64'));
  }

  async writeFile(input: DockerWriteFileInput): Promise<void> {
    await this.post(`/sandboxes/${encodeURIComponent(input.providerSandboxId)}/fs/write`, {
      ...input,
      contentBase64: Buffer.from(input.content).toString('base64'),
    });
  }

  async stat(input: DockerFileInput): Promise<FileStat> {
    return parseFileStat(await this.post(`/sandboxes/${encodeURIComponent(input.providerSandboxId)}/fs/stat`, input));
  }

  async readdir(input: DockerFileInput): Promise<string[]> {
    return readStringArray(
      readObject(await this.post(`/sandboxes/${encodeURIComponent(input.providerSandboxId)}/fs/readdir`, input))
        .entries,
    );
  }

  async exists(input: DockerFileInput): Promise<boolean> {
    return (
      readObject(await this.post(`/sandboxes/${encodeURIComponent(input.providerSandboxId)}/fs/exists`, input))
        .exists === true
    );
  }

  async mkdir(input: DockerMkdirInput): Promise<void> {
    await this.post(`/sandboxes/${encodeURIComponent(input.providerSandboxId)}/fs/mkdir`, input);
  }

  async rm(input: DockerRmInput): Promise<void> {
    await this.post(`/sandboxes/${encodeURIComponent(input.providerSandboxId)}/fs/rm`, input);
  }

  async getServiceEndpoint(input: DockerServiceEndpointInput): Promise<SandboxServiceEndpoint | null> {
    const body = readObject(
      await this.post(`/sandboxes/${encodeURIComponent(input.providerSandboxId)}/service-endpoint`, input),
    );
    if (body.targetUrl === null) return null;
    const headers =
      body.targetHeaders === undefined ? undefined : readStringRecord(body.targetHeaders, 'targetHeaders');
    return {
      port: readNumber(body.port, 'port'),
      targetUrl: readString(body.targetUrl, 'targetUrl'),
      ...(headers ? { targetHeaders: headers } : {}),
    };
  }

  private async post(path: string, body: unknown, init: { signal?: AbortSignal } = {}): Promise<unknown> {
    const request: RequestInit = {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
    };
    if (init.signal) request.signal = init.signal;
    const response = await fetch(`${this.baseUrl}${path}`, request);
    const text = await response.text();
    const parsed = text ? (JSON.parse(text) as unknown) : {};
    if (!response.ok) {
      const error = readObject(parsed).error;
      throw new Error(typeof error === 'string' ? error : `Docker orchestrator request failed: ${response.status}`);
    }
    return parsed;
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.options.token) headers.authorization = `Bearer ${this.options.token}`;
    return headers;
  }
}

export function createDockerOrchestratorHttpHandler(
  orchestrator: DockerOrchestrator,
  token?: string,
): (request: Request) => Promise<Response> {
  return async (request) => {
    try {
      if (token && request.headers.get('authorization') !== `Bearer ${token}`)
        return jsonResponse(401, { error: 'unauthorized' });
      const url = new URL(request.url);
      const match = url.pathname.match(/^\/sandboxes\/([^/]+)\/(.+)$/);
      if (request.method === 'GET' && url.pathname === '/health') {
        const check = orchestrator.check
          ? await orchestrator.check()
          : { status: 'ready' as const, checkedAt: new Date() };
        return jsonResponse(200, check);
      }
      if (request.method === 'POST' && url.pathname === '/sandboxes')
        return jsonResponse(200, await orchestrator.create((await request.json()) as DockerCreateSandboxInput));
      if (request.method !== 'POST' || !match) return jsonResponse(404, { error: 'not_found' });
      const body = readObject(await request.json());
      const ref = { providerSandboxId: decodeURIComponent(match[1]!), sessionId: readSessionId(body) };
      const secrets = readStringRecordOrUndefined(body.secrets);
      const refWithSecrets = secrets ? { ...ref, secrets } : ref;
      switch (match[2]) {
        case 'connect':
          return jsonResponse(
            200,
            await orchestrator.connect({ ...refWithSecrets, metadata: readObject(body.metadata ?? {}) }),
          );
        case 'health':
          return jsonResponse(200, await orchestrator.health(ref));
        case 'start':
          await orchestrator.start(ref);
          return jsonResponse(200, { ok: true });
        case 'stop':
          await orchestrator.stop(ref);
          return jsonResponse(200, { ok: true });
        case 'destroy':
          await orchestrator.destroy(ref);
          return jsonResponse(200, { ok: true });
        case 'exec':
          return jsonResponse(
            200,
            await orchestrator.exec({ ...dockerExecInput(refWithSecrets, body), signal: request.signal }),
          );
        case 'fs/read':
          return jsonResponse(200, {
            contentBase64: Buffer.from(
              await orchestrator.readFile({ ...refWithSecrets, path: readString(body.path, 'path') }),
            ).toString('base64'),
          });
        case 'fs/write':
          await orchestrator.writeFile({
            ...refWithSecrets,
            path: readString(body.path, 'path'),
            content: Buffer.from(readString(body.contentBase64, 'contentBase64'), 'base64'),
          });
          return jsonResponse(200, { ok: true });
        case 'fs/stat':
          return jsonResponse(200, await orchestrator.stat({ ...refWithSecrets, path: readString(body.path, 'path') }));
        case 'fs/readdir':
          return jsonResponse(200, {
            entries: await orchestrator.readdir({ ...refWithSecrets, path: readString(body.path, 'path') }),
          });
        case 'fs/exists':
          return jsonResponse(200, {
            exists: await orchestrator.exists({ ...refWithSecrets, path: readString(body.path, 'path') }),
          });
        case 'fs/mkdir':
          await orchestrator.mkdir({
            ...refWithSecrets,
            path: readString(body.path, 'path'),
            recursive: body.recursive === true,
          });
          return jsonResponse(200, { ok: true });
        case 'fs/rm':
          await orchestrator.rm({
            ...refWithSecrets,
            path: readString(body.path, 'path'),
            recursive: body.recursive === true,
            force: body.force === true,
          });
          return jsonResponse(200, { ok: true });
        case 'service-endpoint': {
          const port = readNumber(body.port, 'port');
          const endpoint = (await orchestrator.getServiceEndpoint?.({ ...refWithSecrets, port })) ?? null;
          return jsonResponse(200, endpoint ?? { port, targetUrl: null });
        }
        default:
          return jsonResponse(404, { error: 'not_found' });
      }
    } catch (error) {
      return jsonResponse(500, { error: error instanceof Error ? error.message : 'Unknown Docker orchestrator error' });
    }
  };
}

function createDockerFileSystem(orchestrator: DockerOrchestrator, ref: DockerSandboxRef): SandboxFileSystem {
  return {
    async readFile(path) {
      return Buffer.from(await orchestrator.readFile({ ...ref, path })).toString('utf-8');
    },
    async readFileBuffer(path) {
      return orchestrator.readFile({ ...ref, path });
    },
    async writeFile(path, content) {
      await orchestrator.writeFile({ ...ref, path, content });
    },
    async stat(path) {
      return orchestrator.stat({ ...ref, path });
    },
    async readdir(path) {
      return orchestrator.readdir({ ...ref, path });
    },
    async exists(path) {
      return orchestrator.exists({ ...ref, path });
    },
    async mkdir(path, options) {
      const input: DockerMkdirInput = { ...ref, path };
      if (options?.recursive !== undefined) input.recursive = options.recursive;
      await orchestrator.mkdir(input);
    },
    async rm(path, options) {
      const input: DockerRmInput = { ...ref, path };
      if (options?.recursive !== undefined) input.recursive = options.recursive;
      if (options?.force !== undefined) input.force = options.force;
      await orchestrator.rm(input);
    },
  };
}

async function execBridge(descriptor: DockerSandboxDescriptor, input: SandboxExecInput): Promise<SandboxExecResult> {
  const result = await readBridgeJson(
    await bridgeFetch(descriptor, '/exec', {
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

function execRequestBody<T extends SandboxExecInput>(input: T): Omit<T, 'signal'> {
  const { signal: _signal, ...body } = input;
  return body;
}

async function bridgeFetch(
  descriptor: DockerSandboxDescriptor,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const response = await fetch(`${descriptor.bridgeUrl}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${descriptor.bridgeToken}`, ...init.headers },
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `Docker sandbox bridge request failed: ${response.status}`);
  }
  return response;
}

async function readBridgeJson(response: Response): Promise<unknown> {
  return response.json();
}

async function waitForBridge(descriptor: DockerSandboxDescriptor): Promise<void> {
  const startedAt = Date.now();
  let lastError: unknown;
  while (Date.now() - startedAt < 10_000) {
    try {
      await bridgeFetch(descriptor, '/health');
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Docker sandbox bridge did not become ready');
}

function docker(
  args: string[],
  options: { allowFailure?: boolean; timeoutMs?: number } = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolveResult, reject) => {
    const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timeout: NodeJS.Timeout | undefined;
    child.stdout.setEncoding('utf-8');
    child.stderr.setEncoding('utf-8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    const settle = (complete: () => void) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      complete();
    };
    timeout = options.timeoutMs
      ? setTimeout(() => {
          const message = `docker ${args[0] ?? ''} timed out after ${options.timeoutMs}ms`;
          child.kill('SIGKILL');
          if (options.allowFailure) settle(() => resolveResult({ exitCode: 1, stdout, stderr: stderr || message }));
          else settle(() => reject(new Error(stderr || stdout || message)));
        }, options.timeoutMs)
      : undefined;
    timeout?.unref?.();
    child.on('error', (error) => settle(() => reject(error)));
    child.on('close', (code) => {
      const exitCode = code ?? 1;
      if (exitCode !== 0 && !options.allowFailure)
        settle(() => reject(new Error(stderr || stdout || `docker ${args[0] ?? ''} failed`)));
      else settle(() => resolveResult({ exitCode, stdout, stderr }));
    });
  });
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

function parseSandboxHealth(value: unknown): SandboxHealth {
  const body = readObject(value);
  const status = readString(body.status, 'status');
  if (
    status !== 'starting' &&
    status !== 'ready' &&
    status !== 'stopped' &&
    status !== 'unhealthy' &&
    status !== 'missing'
  )
    throw new Error(`Invalid sandbox health status: ${status}`);
  const health: SandboxHealth = { status, checkedAt: new Date(readString(body.checkedAt, 'checkedAt')) };
  if (typeof body.message === 'string') health.message = body.message;
  return health;
}

function parseExecResult(value: unknown): SandboxExecResult {
  const body = readObject(value);
  return {
    exitCode: readNumber(body.exitCode, 'exitCode'),
    stdout: readString(body.stdout, 'stdout'),
    stderr: readString(body.stderr, 'stderr'),
    startedAt: new Date(readString(body.startedAt, 'startedAt')),
    completedAt: new Date(readString(body.completedAt, 'completedAt')),
  };
}

function readMetadata(metadata: Record<string, unknown>): { bridgeUrl?: string; bridgeToken?: string } {
  const result: { bridgeUrl?: string; bridgeToken?: string } = {};
  if (typeof metadata.bridgeUrl === 'string') result.bridgeUrl = metadata.bridgeUrl;
  if (typeof metadata.bridgeToken === 'string') result.bridgeToken = metadata.bridgeToken;
  return result;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function readObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Expected object');
  return value as Record<string, unknown>;
}

function readString(value: unknown, name: string): string {
  if (typeof value !== 'string') throw new Error(`${name} must be a string`);
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

function optionalStringRecord(value: unknown): Record<string, string> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const record: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) if (typeof item === 'string') record[key] = item;
  return record;
}

function readStringRecord(value: unknown, name: string): Record<string, string> {
  const record = optionalStringRecord(value);
  if (!record) throw new Error(`${name} must be a string record`);
  return record;
}

function readStringRecordOrUndefined(value: unknown): Record<string, string> | undefined {
  return value === undefined ? undefined : readStringRecord(value, 'secrets');
}

function readSessionId(body: Record<string, unknown>): string {
  return readString(body.sessionId, 'sessionId');
}

function readNumber(value: unknown, name: string): number {
  if (typeof value !== 'number') throw new Error(`${name} must be a number`);
  return value;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string'))
    throw new Error('Expected string array');
  return value;
}

function safeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/g, '-').slice(0, 48) || 'session';
}

function isDockerMissingError(error: unknown): boolean {
  return error instanceof Error && isMissingDockerOutput(error.message);
}

function isMissingDockerOutput(value: string): boolean {
  return value.includes('No such container') || value.includes('No such object');
}

function dockerExecInput(ref: DockerSandboxRef, body: Record<string, unknown>): DockerExecInput {
  const input: DockerExecInput = { ...ref, command: readString(body.command, 'command') };
  const cwd = optionalString(body.cwd);
  const env = optionalStringRecord(body.env);
  const timeoutMs = optionalNumber(body.timeoutMs);
  const stdin = optionalString(body.stdin);
  if (cwd !== undefined) input.cwd = cwd;
  if (env !== undefined) input.env = env;
  if (timeoutMs !== undefined) input.timeoutMs = timeoutMs;
  if (stdin !== undefined) input.stdin = stdin;
  return input;
}
