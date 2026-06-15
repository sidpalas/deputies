import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
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
const defaultNamespacePath = '/var/run/secrets/kubernetes.io/serviceaccount/namespace';
const defaultTokenPath = '/var/run/secrets/kubernetes.io/serviceaccount/token';
const defaultCaPath = '/var/run/secrets/kubernetes.io/serviceaccount/ca.crt';
const agentSandboxApiVersion = 'v1alpha1';

export const agentSandboxCapabilities: SandboxCapabilities = {
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

export type AgentSandboxDescriptor = {
  providerSandboxId: string;
  sessionId: string;
  workspacePath: string;
  bridgeUrl: string;
  bridgeToken: string;
  metadata: Record<string, unknown>;
};

export type AgentSandboxProviderOptions = {
  orchestrator: AgentSandboxOrchestrator;
};

export type InProcessAgentSandboxOrchestratorOptions = {
  namespace?: string | undefined;
  image?: string | undefined;
  workspacePath?: string | undefined;
  storageSize?: string | undefined;
  storageClassName?: string | undefined;
  bridgeSkippedCookieNames?: string | undefined;
};

export type HttpAgentSandboxOrchestratorClientOptions = {
  baseUrl: string;
  token?: string | undefined;
};

export type AgentSandboxCreateInput = CreateSandboxInput;
export type AgentSandboxConnectInput = ConnectSandboxInput;
export type AgentSandboxRef = SandboxRef & { secrets?: Record<string, string> };
export type AgentSandboxExecInput = AgentSandboxRef & SandboxExecInput;
export type AgentSandboxFileInput = AgentSandboxRef & { path: string };
export type AgentSandboxWriteFileInput = AgentSandboxFileInput & { content: string | Uint8Array };
export type AgentSandboxMkdirInput = AgentSandboxFileInput & { recursive?: boolean };
export type AgentSandboxRmInput = AgentSandboxFileInput & { recursive?: boolean; force?: boolean };
export type AgentSandboxServiceEndpointInput = AgentSandboxRef & { port: number };

export interface AgentSandboxOrchestrator {
  check?(): Promise<SandboxProviderCheck>;
  create(input: AgentSandboxCreateInput): Promise<AgentSandboxDescriptor>;
  connect(input: AgentSandboxConnectInput): Promise<AgentSandboxDescriptor>;
  health(input: AgentSandboxRef): Promise<SandboxHealth>;
  start(input: AgentSandboxRef): Promise<void>;
  stop(input: AgentSandboxRef): Promise<void>;
  destroy(input: AgentSandboxRef): Promise<void>;
  exec(input: AgentSandboxExecInput): Promise<SandboxExecResult>;
  readFile(input: AgentSandboxFileInput): Promise<Uint8Array>;
  writeFile(input: AgentSandboxWriteFileInput): Promise<void>;
  stat(input: AgentSandboxFileInput): Promise<FileStat>;
  readdir(input: AgentSandboxFileInput): Promise<string[]>;
  exists(input: AgentSandboxFileInput): Promise<boolean>;
  mkdir(input: AgentSandboxMkdirInput): Promise<void>;
  rm(input: AgentSandboxRmInput): Promise<void>;
  getServiceEndpoint?(input: AgentSandboxServiceEndpointInput): Promise<SandboxServiceEndpoint | null>;
}

export class AgentSandboxProvider implements SandboxProvider {
  readonly name = 'k8s-agent-sandbox';
  readonly capabilities = agentSandboxCapabilities;

  constructor(private readonly options: AgentSandboxProviderOptions) {}

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

  private toHandle(descriptor: AgentSandboxDescriptor): SandboxHandle {
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
      fs: createAgentSandboxFileSystem(this.options.orchestrator, { ...ref, secrets }),
      exec: (input) => this.options.orchestrator.exec({ ...ref, secrets, ...input }),
    };
  }
}

export class InProcessAgentSandboxOrchestrator implements AgentSandboxOrchestrator {
  private readonly namespace: string;
  private readonly image: string;
  private readonly workspacePath: string;
  private readonly storageSize: string;
  private readonly storageClassName: string | undefined;
  private readonly bridgeSkippedCookieNames: string | undefined;
  private readonly kube: KubernetesApiClient;
  private readonly descriptors = new Map<string, AgentSandboxDescriptor>();

  constructor(options: InProcessAgentSandboxOrchestratorOptions = {}) {
    this.namespace = options.namespace ?? readOptionalFile(defaultNamespacePath) ?? 'default';
    this.image = options.image ?? 'ghcr.io/sidpalas/deputies-docker-sandbox:sha-ac8a459';
    this.workspacePath = options.workspacePath ?? '/workspace';
    this.storageSize = options.storageSize ?? '1Gi';
    this.storageClassName = options.storageClassName;
    this.bridgeSkippedCookieNames = options.bridgeSkippedCookieNames;
    this.kube = new KubernetesApiClient();
  }

  async check(): Promise<SandboxProviderCheck> {
    await this.kube.get(`/apis/agents.x-k8s.io/${agentSandboxApiVersion}`);
    return { status: 'ready', checkedAt: new Date() };
  }

  async create(input: AgentSandboxCreateInput): Promise<AgentSandboxDescriptor> {
    const bridgeToken = randomUUID();
    const name = `deputies-${safeId(input.sessionId)}-${randomUUID().slice(0, 8)}`;
    await this.kube.post(this.secretPath(), this.bridgeTokenSecret(name, input.sessionId, bridgeToken));
    try {
      const resource = this.sandboxResource(name, input.sessionId, input.metadata ?? {});
      await this.kube.post(this.sandboxPath(), resource);
      const descriptor = await this.descriptor({
        providerSandboxId: name,
        sessionId: input.sessionId,
        bridgeToken,
        metadata: input.metadata ?? {},
      });
      await waitForBridge(descriptor);
      this.descriptors.set(name, descriptor);
      return descriptor;
    } catch (error) {
      await this.destroy({ providerSandboxId: name, sessionId: input.sessionId }).catch(() => undefined);
      throw error;
    }
  }

  async connect(input: AgentSandboxConnectInput): Promise<AgentSandboxDescriptor> {
    const existing = this.descriptors.get(input.providerSandboxId);
    if (existing) {
      const descriptor = await this.refreshDescriptor(existing);
      await waitForBridge(descriptor);
      this.descriptors.set(input.providerSandboxId, descriptor);
      return descriptor;
    }

    const metadata = readMetadata(input.metadata ?? {});
    const bridgeToken = input.secrets?.bridgeToken ?? metadata.bridgeToken;
    if (!bridgeToken) throw new Error('Agent Sandbox secrets are missing bridgeToken');
    const descriptor = await this.descriptor({
      providerSandboxId: input.providerSandboxId,
      sessionId: input.sessionId,
      bridgeToken,
      metadata: input.metadata ?? {},
    });
    await waitForBridge(descriptor);
    this.descriptors.set(input.providerSandboxId, descriptor);
    return descriptor;
  }

  async health(input: AgentSandboxRef): Promise<SandboxHealth> {
    try {
      const sandbox = await this.getSandbox(input.providerSandboxId);
      const ready = findCondition(sandbox, 'Ready');
      const suspended = findCondition(sandbox, 'Suspended');
      const finished = findCondition(sandbox, 'Finished');
      const checkedAt = new Date();
      if (readReplicas(sandbox.spec.replicas) === 0) return { status: 'stopped', checkedAt };
      if (finished?.status === 'True') return sandboxHealth('stopped', checkedAt, finished.reason);
      if (suspended?.status === 'True') return sandboxHealth('stopped', checkedAt, suspended.reason);
      if (ready?.status === 'True') return { status: 'ready', checkedAt };
      if (ready?.status === 'False') return sandboxHealth('starting', checkedAt, ready.reason);
      return { status: 'starting', checkedAt };
    } catch (error) {
      if (error instanceof KubernetesApiError && error.statusCode === 404)
        return { status: 'missing', checkedAt: new Date() };
      throw error;
    }
  }

  async start(input: AgentSandboxRef): Promise<void> {
    await this.patchSandbox(input.providerSandboxId, { spec: { replicas: 1 } });
  }

  async stop(input: AgentSandboxRef): Promise<void> {
    await this.patchSandbox(input.providerSandboxId, { spec: { replicas: 0 } });
  }

  async destroy(input: AgentSandboxRef): Promise<void> {
    const result = await this.kube.delete(this.sandboxPath(input.providerSandboxId), { allowNotFound: true });
    await this.kube.delete(this.secretPath(input.providerSandboxId), { allowNotFound: true });
    this.descriptors.delete(input.providerSandboxId);
    if (result === null) return;
  }

  async exec(input: AgentSandboxExecInput): Promise<SandboxExecResult> {
    return execBridge(await this.connectedDescriptor(input), input);
  }

  async readFile(input: AgentSandboxFileInput): Promise<Uint8Array> {
    const response = await bridgeFetch(
      await this.connectedDescriptor(input),
      `/fs/read?path=${encodeURIComponent(input.path)}`,
    );
    return new Uint8Array(await response.arrayBuffer());
  }

  async writeFile(input: AgentSandboxWriteFileInput): Promise<void> {
    await bridgeFetch(await this.connectedDescriptor(input), `/fs/write?path=${encodeURIComponent(input.path)}`, {
      method: 'PUT',
      body: input.content,
    });
  }

  async stat(input: AgentSandboxFileInput): Promise<FileStat> {
    return parseFileStat(
      await readBridgeJson(
        await bridgeFetch(await this.connectedDescriptor(input), `/fs/stat?path=${encodeURIComponent(input.path)}`),
      ),
    );
  }

  async readdir(input: AgentSandboxFileInput): Promise<string[]> {
    const body = readObject(
      await readBridgeJson(
        await bridgeFetch(await this.connectedDescriptor(input), `/fs/readdir?path=${encodeURIComponent(input.path)}`),
      ),
    );
    return readStringArray(body.entries);
  }

  async exists(input: AgentSandboxFileInput): Promise<boolean> {
    const body = readObject(
      await readBridgeJson(
        await bridgeFetch(await this.connectedDescriptor(input), `/fs/exists?path=${encodeURIComponent(input.path)}`),
      ),
    );
    return body.exists === true;
  }

  async mkdir(input: AgentSandboxMkdirInput): Promise<void> {
    await bridgeFetch(await this.connectedDescriptor(input), '/fs/mkdir', {
      method: 'POST',
      body: JSON.stringify({ path: input.path, recursive: input.recursive }),
    });
  }

  async rm(input: AgentSandboxRmInput): Promise<void> {
    await bridgeFetch(await this.connectedDescriptor(input), '/fs/rm', {
      method: 'POST',
      body: JSON.stringify({ path: input.path, recursive: input.recursive, force: input.force }),
    });
  }

  async getServiceEndpoint(input: AgentSandboxServiceEndpointInput): Promise<SandboxServiceEndpoint | null> {
    const descriptor = await this.connectedDescriptor(input);
    return {
      port: input.port,
      targetUrl: `${descriptor.bridgeUrl}/preview/${input.port}`,
      targetHeaders: { authorization: `Bearer ${descriptor.bridgeToken}` },
      forwardPreviewHost: true,
    };
  }

  private async connectedDescriptor(input: AgentSandboxRef): Promise<AgentSandboxDescriptor> {
    const existing = this.descriptors.get(input.providerSandboxId);
    if (existing) return existing;
    const connectInput: AgentSandboxConnectInput = {
      providerSandboxId: input.providerSandboxId,
      sessionId: input.sessionId,
    };
    if (input.secrets) connectInput.secrets = input.secrets;
    return this.connect(connectInput);
  }

  private async descriptor(
    input: Omit<AgentSandboxDescriptor, 'bridgeUrl' | 'workspacePath'>,
  ): Promise<AgentSandboxDescriptor> {
    const sandbox = await this.getSandbox(input.providerSandboxId);
    const bridgeUrl = this.bridgeUrl(sandbox, input.providerSandboxId);
    return {
      ...input,
      bridgeUrl,
      workspacePath: this.workspacePath,
      metadata: {
        ...input.metadata,
        namespace: this.namespace,
        sandboxName: input.providerSandboxId,
        image: this.image,
        workspacePath: this.workspacePath,
        bridgeUrl,
      },
    };
  }

  private async refreshDescriptor(descriptor: AgentSandboxDescriptor): Promise<AgentSandboxDescriptor> {
    return this.descriptor(descriptor);
  }

  private bridgeUrl(sandbox: AgentSandboxResource, providerSandboxId: string): string {
    const status = sandbox.status ?? {};
    const host =
      typeof status.serviceFQDN === 'string' && status.serviceFQDN
        ? status.serviceFQDN
        : `${providerSandboxId}.${this.namespace}.svc`;
    return `http://${host}:${bridgePort}`;
  }

  private async getSandbox(name: string): Promise<AgentSandboxResource> {
    return this.kube.get(this.sandboxPath(name)) as Promise<AgentSandboxResource>;
  }

  private async patchSandbox(name: string, patch: Record<string, unknown>): Promise<void> {
    await this.kube.patch(this.sandboxPath(name), patch);
  }

  private sandboxPath(name?: string): string {
    const base = `/apis/agents.x-k8s.io/${agentSandboxApiVersion}/namespaces/${encodeURIComponent(this.namespace)}/sandboxes`;
    return name ? `${base}/${encodeURIComponent(name)}` : base;
  }

  private secretPath(name?: string): string {
    const base = `/api/v1/namespaces/${encodeURIComponent(this.namespace)}/secrets`;
    return name ? `${base}/${encodeURIComponent(name)}` : base;
  }

  private bridgeTokenSecret(name: string, sessionId: string, bridgeToken: string): Record<string, unknown> {
    return {
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: { name, labels: this.labels(sessionId) },
      type: 'Opaque',
      stringData: { DEPUTIES_SANDBOX_TOKEN: bridgeToken },
    };
  }

  private labels(sessionId: string): Record<string, string> {
    return {
      'app.kubernetes.io/name': 'deputies-sandbox',
      'deputies.sandbox-provider': 'k8s-agent-sandbox',
      'deputies.session-id': sessionId,
    };
  }

  private sandboxResource(name: string, sessionId: string, _metadata: Record<string, unknown>): AgentSandboxResource {
    const labels = this.labels(sessionId);
    const pvcSpec: Record<string, unknown> = {
      accessModes: ['ReadWriteOnce'],
      resources: { requests: { storage: this.storageSize } },
    };
    if (this.storageClassName) pvcSpec.storageClassName = this.storageClassName;
    return {
      apiVersion: `agents.x-k8s.io/${agentSandboxApiVersion}`,
      kind: 'Sandbox',
      metadata: { name, labels },
      spec: {
        service: true,
        podTemplate: {
          metadata: { labels },
          spec: {
            restartPolicy: 'Never',
            containers: [
              {
                name: 'sandbox',
                image: this.image,
                ports: [{ name: 'bridge', containerPort: bridgePort }],
                env: [
                  {
                    name: 'DEPUTIES_SANDBOX_TOKEN',
                    valueFrom: { secretKeyRef: { name, key: 'DEPUTIES_SANDBOX_TOKEN' } },
                  },
                  { name: 'DEPUTIES_WORKSPACE', value: this.workspacePath },
                  ...(this.bridgeSkippedCookieNames
                    ? [{ name: sandboxBridgeSkipCookieNamesEnv, value: this.bridgeSkippedCookieNames }]
                    : []),
                ],
                volumeMounts: [{ name: 'workspace', mountPath: this.workspacePath }],
              },
            ],
            volumes: [{ name: 'workspace', persistentVolumeClaim: { claimName: 'workspace' } }],
          },
        },
        volumeClaimTemplates: [{ metadata: { name: 'workspace' }, spec: pvcSpec }],
      },
      status: {},
    };
  }
}

export class HttpAgentSandboxOrchestratorClient implements AgentSandboxOrchestrator {
  private readonly baseUrl: string;

  constructor(private readonly options: HttpAgentSandboxOrchestratorClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
  }

  async check(): Promise<SandboxProviderCheck> {
    const body = readObject(await this.request('GET', '/health'));
    return {
      status: body.status === 'ready' ? 'ready' : 'unhealthy',
      ...(typeof body.message === 'string' ? { message: body.message } : {}),
      checkedAt: typeof body.checkedAt === 'string' ? new Date(body.checkedAt) : new Date(),
    };
  }

  create(input: AgentSandboxCreateInput): Promise<AgentSandboxDescriptor> {
    return this.request('POST', '/sandboxes', input) as Promise<AgentSandboxDescriptor>;
  }

  connect(input: AgentSandboxConnectInput): Promise<AgentSandboxDescriptor> {
    return this.request(
      'POST',
      `/sandboxes/${encodeURIComponent(input.providerSandboxId)}/connect`,
      input,
    ) as Promise<AgentSandboxDescriptor>;
  }

  health(input: AgentSandboxRef): Promise<SandboxHealth> {
    return this.request('POST', `/sandboxes/${encodeURIComponent(input.providerSandboxId)}/health`, input).then(
      parseSandboxHealth,
    );
  }

  async start(input: AgentSandboxRef): Promise<void> {
    await this.request('POST', `/sandboxes/${encodeURIComponent(input.providerSandboxId)}/start`, input);
  }

  async stop(input: AgentSandboxRef): Promise<void> {
    await this.request('POST', `/sandboxes/${encodeURIComponent(input.providerSandboxId)}/stop`, input);
  }

  async destroy(input: AgentSandboxRef): Promise<void> {
    await this.request('POST', `/sandboxes/${encodeURIComponent(input.providerSandboxId)}/destroy`, input);
  }

  exec(input: AgentSandboxExecInput): Promise<SandboxExecResult> {
    return this.request(
      'POST',
      `/sandboxes/${encodeURIComponent(input.providerSandboxId)}/exec`,
      execRequestBody(input),
      input.signal ? { signal: input.signal } : {},
    ).then(parseExecResult);
  }

  async readFile(input: AgentSandboxFileInput): Promise<Uint8Array> {
    const body = readObject(
      await this.request('POST', `/sandboxes/${encodeURIComponent(input.providerSandboxId)}/fs/read`, input),
    );
    return new Uint8Array(Buffer.from(readString(body.contentBase64, 'contentBase64'), 'base64'));
  }

  async writeFile(input: AgentSandboxWriteFileInput): Promise<void> {
    await this.request('POST', `/sandboxes/${encodeURIComponent(input.providerSandboxId)}/fs/write`, {
      ...input,
      contentBase64: Buffer.from(input.content).toString('base64'),
    });
  }

  async stat(input: AgentSandboxFileInput): Promise<FileStat> {
    return parseFileStat(
      await this.request('POST', `/sandboxes/${encodeURIComponent(input.providerSandboxId)}/fs/stat`, input),
    );
  }

  async readdir(input: AgentSandboxFileInput): Promise<string[]> {
    return readStringArray(
      readObject(
        await this.request('POST', `/sandboxes/${encodeURIComponent(input.providerSandboxId)}/fs/readdir`, input),
      ).entries,
    );
  }

  async exists(input: AgentSandboxFileInput): Promise<boolean> {
    return (
      readObject(
        await this.request('POST', `/sandboxes/${encodeURIComponent(input.providerSandboxId)}/fs/exists`, input),
      ).exists === true
    );
  }

  async mkdir(input: AgentSandboxMkdirInput): Promise<void> {
    await this.request('POST', `/sandboxes/${encodeURIComponent(input.providerSandboxId)}/fs/mkdir`, input);
  }

  async rm(input: AgentSandboxRmInput): Promise<void> {
    await this.request('POST', `/sandboxes/${encodeURIComponent(input.providerSandboxId)}/fs/rm`, input);
  }

  async getServiceEndpoint(input: AgentSandboxServiceEndpointInput): Promise<SandboxServiceEndpoint | null> {
    const body = readObject(
      await this.request('POST', `/sandboxes/${encodeURIComponent(input.providerSandboxId)}/service-endpoint`, input),
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

  private async request(
    method: string,
    path: string,
    body?: unknown,
    init: { signal?: AbortSignal } = {},
  ): Promise<unknown> {
    const request: RequestInit = {
      method,
      headers: this.headers(),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    };
    if (init.signal) request.signal = init.signal;
    const response = await fetch(`${this.baseUrl}${path}`, request);
    const text = await response.text();
    const parsed = parseJsonOrText(text);
    if (!response.ok) {
      const error = readObject(parsed).error;
      throw new Error(
        typeof error === 'string' ? error : `Agent Sandbox orchestrator request failed: ${response.status}`,
      );
    }
    return parsed;
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.options.token) headers.authorization = `Bearer ${this.options.token}`;
    return headers;
  }
}

export function createAgentSandboxOrchestratorHttpHandler(
  orchestrator: AgentSandboxOrchestrator,
  token?: string,
): (request: Request) => Promise<Response> {
  return async (request) => {
    try {
      const url = new URL(request.url);
      const match = url.pathname.match(/^\/sandboxes\/([^/]+)\/(.+)$/);
      if (request.method === 'GET' && url.pathname === '/health') {
        const check = orchestrator.check
          ? await orchestrator.check()
          : { status: 'ready' as const, checkedAt: new Date() };
        return jsonResponse(200, check);
      }
      if (token && request.headers.get('authorization') !== `Bearer ${token}`)
        return jsonResponse(401, { error: 'unauthorized' });
      if (request.method === 'POST' && url.pathname === '/sandboxes')
        return jsonResponse(200, await orchestrator.create((await request.json()) as AgentSandboxCreateInput));
      if (request.method !== 'POST' || !match) return jsonResponse(404, { error: 'not_found' });
      const body = readObject(await request.json());
      const ref = {
        providerSandboxId: decodeURIComponent(match[1]!),
        sessionId: readString(body.sessionId, 'sessionId'),
      };
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
            await orchestrator.exec({ ...execInput(refWithSecrets, body), signal: request.signal }),
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
      return jsonResponse(500, {
        error: error instanceof Error ? error.message : 'Unknown Agent Sandbox orchestrator error',
      });
    }
  };
}

type AgentSandboxResource = {
  apiVersion: string;
  kind: string;
  metadata: { name: string; labels?: Record<string, string>; [key: string]: unknown };
  spec: Record<string, unknown>;
  status?: Record<string, unknown>;
};

type KubernetesCondition = { type?: string; status?: string; reason?: string };

class KubernetesApiError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

class KubernetesApiClient {
  private readonly apiServer: URL;
  private readonly token: string | undefined;
  private readonly ca: Buffer | undefined;

  constructor() {
    this.apiServer = new URL(inClusterApiServer());
    this.token = readOptionalFile(defaultTokenPath);
    this.ca = readOptionalBuffer(defaultCaPath);
  }

  get(path: string): Promise<unknown> {
    return this.request('GET', path);
  }

  post(path: string, body: unknown): Promise<unknown> {
    return this.request('POST', path, body);
  }

  patch(path: string, body: unknown): Promise<unknown> {
    return this.request('PATCH', path, body, 'application/merge-patch+json');
  }

  async delete(path: string, options: { allowNotFound?: boolean } = {}): Promise<unknown | null> {
    try {
      return await this.request('DELETE', path);
    } catch (error) {
      if (options.allowNotFound && error instanceof KubernetesApiError && error.statusCode === 404) return null;
      throw error;
    }
  }

  private request(method: string, path: string, body?: unknown, contentType = 'application/json'): Promise<unknown> {
    const url = new URL(path, this.apiServer);
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const headers: Record<string, string | number> = { accept: 'application/json' };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    if (payload) {
      headers['content-type'] = contentType;
      headers['content-length'] = payload.length;
    }
    const client = url.protocol === 'http:' ? http : https;
    return new Promise((resolve, reject) => {
      const request = client.request(
        url,
        {
          method,
          headers,
          ...(url.protocol === 'https:' ? { ca: this.ca } : {}),
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => chunks.push(chunk));
          response.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf-8');
            const parsed = parseJsonOrText(text);
            const statusCode = response.statusCode ?? 500;
            if (statusCode < 200 || statusCode >= 300) {
              const errorBody = readObjectOrEmpty(parsed);
              const message =
                typeof errorBody.message === 'string'
                  ? errorBody.message
                  : `Kubernetes API request failed: ${statusCode}`;
              reject(new KubernetesApiError(statusCode, message));
              return;
            }
            resolve(parsed);
          });
        },
      );
      request.on('error', reject);
      if (payload) request.write(payload);
      request.end();
    });
  }
}

function createAgentSandboxFileSystem(orchestrator: AgentSandboxOrchestrator, ref: AgentSandboxRef): SandboxFileSystem {
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
      const input: AgentSandboxMkdirInput = { ...ref, path };
      if (options?.recursive !== undefined) input.recursive = options.recursive;
      await orchestrator.mkdir(input);
    },
    async rm(path, options) {
      const input: AgentSandboxRmInput = { ...ref, path };
      if (options?.recursive !== undefined) input.recursive = options.recursive;
      if (options?.force !== undefined) input.force = options.force;
      await orchestrator.rm(input);
    },
  };
}

async function execBridge(descriptor: AgentSandboxDescriptor, input: SandboxExecInput): Promise<SandboxExecResult> {
  return parseExecResult(
    await readBridgeJson(
      await bridgeFetch(descriptor, '/exec', {
        method: 'POST',
        body: JSON.stringify(execRequestBody(input)),
        ...(input.signal ? { signal: input.signal } : {}),
      }),
    ),
  );
}

function execRequestBody<T extends SandboxExecInput>(input: T): Omit<T, 'signal'> {
  const { signal: _signal, ...body } = input;
  return body;
}

async function bridgeFetch(
  descriptor: AgentSandboxDescriptor,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const response = await fetch(`${descriptor.bridgeUrl}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${descriptor.bridgeToken}`, ...init.headers },
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `Agent Sandbox bridge request failed: ${response.status}`);
  }
  return response;
}

async function readBridgeJson(response: Response): Promise<unknown> {
  return response.json();
}

async function waitForBridge(descriptor: AgentSandboxDescriptor): Promise<void> {
  const startedAt = Date.now();
  let lastError: unknown;
  while (Date.now() - startedAt < 30_000) {
    try {
      await bridgeFetch(descriptor, '/health');
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Agent Sandbox bridge did not become ready');
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

function sandboxHealth(status: SandboxHealth['status'], checkedAt: Date, message?: string): SandboxHealth {
  return message ? { status, message, checkedAt } : { status, checkedAt };
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

function findCondition(sandbox: AgentSandboxResource, type: string): KubernetesCondition | undefined {
  const conditions = sandbox.status?.conditions;
  if (!Array.isArray(conditions)) return undefined;
  return conditions.find((condition): condition is KubernetesCondition => readObjectOrEmpty(condition).type === type);
}

function readReplicas(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

function readMetadata(metadata: Record<string, unknown>): { bridgeToken?: string } {
  const result: { bridgeToken?: string } = {};
  if (typeof metadata.bridgeToken === 'string') result.bridgeToken = metadata.bridgeToken;
  return result;
}

function execInput(ref: AgentSandboxRef, body: Record<string, unknown>): AgentSandboxExecInput {
  const input: AgentSandboxExecInput = { ...ref, command: readString(body.command, 'command') };
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

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function parseJsonOrText(text: string): unknown {
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { message: text };
  }
}

function readObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Expected object');
  return value as Record<string, unknown>;
}

function readObjectOrEmpty(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function readString(value: unknown, name: string): string {
  if (typeof value !== 'string') throw new Error(`${name} must be a string`);
  return value;
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

function safeId(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'session'
  );
}

function inClusterApiServer(): string {
  const host = process.env.KUBERNETES_SERVICE_HOST ?? 'kubernetes.default.svc';
  const port = process.env.KUBERNETES_SERVICE_PORT ?? '443';
  return `https://${host}:${port}`;
}

function readOptionalFile(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf-8').trim();
  } catch {
    return undefined;
  }
}

function readOptionalBuffer(path: string): Buffer | undefined {
  try {
    return readFileSync(path);
  } catch {
    return undefined;
  }
}
