import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  SandboxKeepaliveInput,
  SandboxPreviewUrl,
  SandboxPreviewUrlInput,
  SandboxProvider,
  SandboxProviderCheck,
  SandboxRef,
} from './types.js';

const bridgePort = 3584;
const defaultWorkspacePath = '/workspace';
const defaultImage = 'ghcr.io/sidpalas/deputies-docker-sandbox:latest';
const maxOutputBytes = 1024 * 1024;

export const namespaceCapabilities: SandboxCapabilities = {
  persistentFilesystem: true,
  snapshots: false,
  stopStart: false,
  exec: true,
  filesystem: true,
  streamingLogs: false,
  portForwarding: false,
  previewUrls: true,
  objectStorageArtifacts: false,
};

export type NamespaceSandboxProviderOptions = {
  client?: NamespaceInstanceClientLike;
  region?: string | undefined;
  apiBaseUrl?: string | undefined;
  nscBinary?: string | undefined;
  cliTimeoutMs?: number | undefined;
  createTimeoutMs?: number | undefined;
  namePrefix?: string | undefined;
  image?: string | undefined;
  machineType?: string | undefined;
  duration?: string | undefined;
  workspacePath?: string | undefined;
  bridgeSkippedCookieNames?: string | undefined;
};

export type NamespaceInstanceCreateInput = {
  sessionId: string;
  containerName: string;
  image: string;
  workspacePath: string;
  duration: string;
  bridgeToken: string;
  bridgeSkippedCookieNames?: string | undefined;
  machineType?: string | undefined;
};

export type NamespaceInstanceDescriptor = {
  id: string;
  containerName?: string | undefined;
  bridgeUrl?: string | undefined;
  workspacePath?: string | undefined;
  state?: string | undefined;
  metadata: Record<string, unknown>;
};

export type NamespaceInstanceExecInput = SandboxExecInput & { instanceId: string; containerName?: string | undefined };
export type NamespaceInstanceFileInput = { instanceId: string; containerName?: string | undefined; path: string };
export type NamespaceInstanceWriteFileInput = NamespaceInstanceFileInput & { content: string | Uint8Array };
export type NamespaceInstanceMkdirInput = NamespaceInstanceFileInput & { recursive?: boolean };
export type NamespaceInstanceRmInput = NamespaceInstanceFileInput & { recursive?: boolean; force?: boolean };

export interface NamespaceInstanceClientLike {
  check(): Promise<void>;
  create(input: NamespaceInstanceCreateInput): Promise<NamespaceInstanceDescriptor>;
  describe(instanceId: string): Promise<NamespaceInstanceDescriptor | null>;
  exposeBridge(instanceId: string, containerName?: string): Promise<string | null>;
  destroy(instanceId: string): Promise<void>;
  extendDuration(instanceId: string, durationMs: number): Promise<void>;
  ingressAccessToken(instanceId: string): Promise<string>;
  exec(input: NamespaceInstanceExecInput): Promise<SandboxExecResult>;
  readFile(input: NamespaceInstanceFileInput): Promise<Uint8Array>;
  writeFile(input: NamespaceInstanceWriteFileInput): Promise<void>;
  stat(input: NamespaceInstanceFileInput): Promise<FileStat>;
  readdir(input: NamespaceInstanceFileInput): Promise<string[]>;
  exists(input: NamespaceInstanceFileInput): Promise<boolean>;
  mkdir(input: NamespaceInstanceMkdirInput): Promise<void>;
  rm(input: NamespaceInstanceRmInput): Promise<void>;
}

export class NamespaceSandboxProvider implements SandboxProvider {
  readonly name = 'namespace';
  readonly capabilities = namespaceCapabilities;
  private readonly client: NamespaceInstanceClientLike;

  constructor(private readonly options: NamespaceSandboxProviderOptions = {}) {
    this.client = options.client ?? new NscNamespaceInstanceClient(options);
  }

  async check(): Promise<SandboxProviderCheck> {
    try {
      await this.client.check();
      return { status: 'ready', checkedAt: new Date() };
    } catch (error) {
      return {
        status: 'unhealthy',
        message: error instanceof Error ? error.message : 'Unknown Namespace connectivity error',
        checkedAt: new Date(),
      };
    }
  }

  async create(input: CreateSandboxInput): Promise<SandboxHandle> {
    const bridgeToken = randomUUID();
    const containerName = `${safeName(this.options.namePrefix ?? 'deputies')}-${safeName(input.sessionId)}-${randomUUID().slice(0, 8)}`;
    const descriptor = await this.client.create({
      sessionId: input.sessionId,
      containerName,
      image: this.options.image ?? defaultImage,
      workspacePath: this.options.workspacePath ?? defaultWorkspacePath,
      duration: this.options.duration ?? '6h',
      bridgeToken,
      ...(this.options.bridgeSkippedCookieNames
        ? { bridgeSkippedCookieNames: this.options.bridgeSkippedCookieNames }
        : {}),
      ...(this.options.machineType ? { machineType: this.options.machineType } : {}),
    });
    try {
      return this.toHandle(descriptor, input.sessionId, input.metadata ?? {}, { bridgeToken });
    } catch (error) {
      await this.client.destroy(descriptor.id).catch(() => undefined);
      throw error;
    }
  }

  async connect(input: ConnectSandboxInput): Promise<SandboxHandle> {
    const descriptor = await this.client.describe(input.providerSandboxId);
    if (!descriptor) throw new Error(`Namespace instance ${input.providerSandboxId} was not found`);
    return this.toHandle(descriptor, input.sessionId, input.metadata ?? {}, input.secrets);
  }

  async destroy(input: SandboxRef): Promise<void> {
    await this.client.destroy(input.providerSandboxId);
  }

  async health(input: SandboxRef): Promise<SandboxHealth> {
    const descriptor = await this.client.describe(input.providerSandboxId);
    if (!descriptor) return { status: 'missing', checkedAt: new Date() };
    const state = descriptor.state?.toLowerCase();
    if (!state || ['active', 'ready', 'running', 'started'].includes(state))
      return { status: 'ready', checkedAt: new Date() };
    if (['creating', 'pending', 'provisioning', 'starting', 'waiting'].includes(state)) {
      return { status: 'starting', checkedAt: new Date() };
    }
    if (['stopped', 'stopping', 'suspended'].includes(state)) return { status: 'stopped', checkedAt: new Date() };
    if (['destroyed', 'expired', 'terminated'].includes(state)) return { status: 'missing', checkedAt: new Date() };
    return { status: 'unhealthy', message: `Namespace instance state: ${descriptor.state}`, checkedAt: new Date() };
  }

  async getPreviewUrl(input: SandboxPreviewUrlInput): Promise<SandboxPreviewUrl | null> {
    const bridgeToken = input.secrets?.bridgeToken;
    if (!bridgeToken) return null;
    const descriptor = await this.client.describe(input.providerSandboxId);
    if (!descriptor) return null;
    const bridgeUrl = descriptor.bridgeUrl ?? (await this.client.exposeBridge(descriptor.id, descriptor.containerName));
    if (!bridgeUrl) return null;
    const ingressAccessToken = await this.client.ingressAccessToken(descriptor.id);
    return {
      port: input.port,
      targetUrl: namespaceBridgePreviewUrl(bridgeUrl, input.port),
      targetHeaders: {
        authorization: `Bearer ${bridgeToken}`,
        'x-nsc-ingress-auth': `Bearer ${ingressAccessToken}`,
      },
      preserveTargetHost: true,
      forwardPreviewHost: true,
    };
  }

  async refreshKeepalive(input: SandboxKeepaliveInput): Promise<void> {
    await this.client.extendDuration(input.providerSandboxId, input.durationMs);
  }

  private toHandle(
    descriptor: NamespaceInstanceDescriptor,
    sessionId: string,
    metadata: Record<string, unknown>,
    secrets: Record<string, string> | undefined,
  ): SandboxHandle {
    const workspacePath = descriptor.workspacePath || this.options.workspacePath || defaultWorkspacePath;
    return {
      provider: this.name,
      providerSandboxId: descriptor.id,
      sessionId,
      workspacePath,
      metadata: {
        ...metadata,
        ...descriptor.metadata,
        namespaceInstanceId: descriptor.id,
        ...(descriptor.containerName ? { namespaceContainerName: descriptor.containerName } : {}),
        ...(descriptor.bridgeUrl ? { namespaceBridgeUrl: descriptor.bridgeUrl } : {}),
        ...(descriptor.state ? { state: descriptor.state } : {}),
      },
      ...(secrets?.bridgeToken ? { secrets: { bridgeToken: secrets.bridgeToken } } : {}),
      capabilities: this.capabilities,
      fs: createNamespaceFileSystem(this.client, descriptor.id, descriptor.containerName),
      exec: (command) =>
        this.client.exec({ ...command, instanceId: descriptor.id, containerName: descriptor.containerName }),
    };
  }
}

export class NscNamespaceInstanceClient implements NamespaceInstanceClientLike {
  private readonly nscBinary: string;
  private readonly cliTimeoutMs: number;
  private readonly createTimeoutMs: number;

  constructor(private readonly options: NamespaceSandboxProviderOptions = {}) {
    this.nscBinary = options.nscBinary ?? 'nsc';
    this.cliTimeoutMs = options.cliTimeoutMs ?? 30_000;
    this.createTimeoutMs = options.createTimeoutMs ?? 120_000;
  }

  async check(): Promise<void> {
    await this.runNsc(['instance', 'history', '--all', '--max_entries', '1', '-o', 'json']);
  }

  async create(input: NamespaceInstanceCreateInput): Promise<NamespaceInstanceDescriptor> {
    const args = [
      'run',
      '--image',
      input.image,
      '--name',
      input.containerName,
      '--duration',
      input.duration,
      '--publish',
      String(bridgePort),
      '--wait',
      '--wait_timeout',
      durationMsToNsc(this.createTimeoutMs),
      '-o',
      'json',
      '--documented_purpose',
      `Deputies sandbox for session ${input.sessionId}`,
      '--env',
      nscMapEntry('DEPUTIES_SANDBOX_TOKEN', input.bridgeToken),
      '--env',
      nscMapEntry('DEPUTIES_WORKSPACE', input.workspacePath),
      '--env',
      nscMapEntry('DEPUTIES_SANDBOX_BRIDGE_HOST', '0.0.0.0'),
      '--env',
      nscMapEntry('DEPUTIES_SANDBOX_BRIDGE_PORT', String(bridgePort)),
    ];
    if (input.bridgeSkippedCookieNames) {
      args.push('--env', nscMapEntry('DEPUTIES_SANDBOX_SKIP_COOKIE_NAMES', input.bridgeSkippedCookieNames));
    }
    if (input.machineType) args.push('--machine_type', input.machineType);

    const result = await this.runNsc(args, { timeoutMs: this.createTimeoutMs });
    const descriptor = descriptorFromNscJson(parseJson(result.stdout, 'nsc run'), {
      containerName: input.containerName,
      image: input.image,
      workspacePath: input.workspacePath,
    });
    if (!descriptor.id) throw new Error('Namespace run response did not include an instance id');
    return descriptor;
  }

  async describe(instanceId: string): Promise<NamespaceInstanceDescriptor | null> {
    try {
      const result = await this.runNsc(['describe', instanceId, '-o', 'json']);
      const descriptor = descriptorFromNscJson(parseJson(result.stdout, 'nsc describe'), {});
      return descriptor.id ? { ...descriptor, id: descriptor.id || instanceId } : { ...descriptor, id: instanceId };
    } catch (error) {
      if (isNamespaceNotFoundError(error)) return null;
      throw error;
    }
  }

  async exposeBridge(instanceId: string, containerName?: string): Promise<string | null> {
    const args = [
      'expose',
      'container',
      instanceId,
      '--container_port',
      String(bridgePort),
      '--source',
      'containerd',
      '-o',
      'json',
    ];
    if (containerName) args.push('--container', containerName);
    else args.push('--all');
    try {
      const result = await this.runNsc(args);
      return ingressUrlFromNscJson(parseJson(result.stdout, 'nsc expose'));
    } catch (error) {
      if (isNamespaceNotFoundError(error)) return null;
      throw error;
    }
  }

  async destroy(instanceId: string): Promise<void> {
    try {
      await this.runNsc(['instance', 'destroy', instanceId, '--force']);
    } catch (error) {
      if (isNamespaceNotFoundError(error)) return;
      throw error;
    }
  }

  async extendDuration(instanceId: string, durationMs: number): Promise<void> {
    await this.runNsc(['instance', 'extend-duration', instanceId, '--ensure_minimum', durationMsToNsc(durationMs)]);
  }

  async ingressAccessToken(instanceId: string): Promise<string> {
    const tokenFromFile = await namespaceTokenFileBearerToken(process.env.NSC_TOKEN_FILE);
    if (tokenFromFile) return tokenFromFile;
    const result = await this.runNsc(['ingress', 'generate-access-token', '--instance', instanceId]);
    const token = result.stdout.trim();
    if (!token) throw new Error('Namespace ingress token response was empty');
    return token;
  }

  async exec(input: NamespaceInstanceExecInput): Promise<SandboxExecResult> {
    const script = input.cwd ? `cd ${quoteShell(input.cwd)} && ${input.command}` : input.command;
    const command = `${shellEnvPrefix(input.env)}sh -lc ${quoteShell(script)}`;
    const startedAt = new Date();
    const runOptions: { stdin?: string; signal?: AbortSignal; timeoutMs?: number; allowFailure?: boolean } = {
      allowFailure: true,
    };
    if (input.stdin !== undefined) runOptions.stdin = input.stdin;
    if (input.signal !== undefined) runOptions.signal = input.signal;
    if (input.timeoutMs !== undefined) runOptions.timeoutMs = input.timeoutMs;
    const args = ['ssh', '--disable-pty'];
    if (input.containerName) args.push('--container_name', input.containerName);
    args.push(input.instanceId, command);
    const result = await this.runNsc(args, runOptions);
    return { ...result, startedAt, completedAt: new Date() };
  }

  async readFile(input: NamespaceInstanceFileInput): Promise<Uint8Array> {
    const dir = await mkdtemp(join(tmpdir(), 'deputies-namespace-download-'));
    const localPath = join(dir, 'file');
    try {
      await this.runNsc([
        'instance',
        'download',
        input.instanceId,
        input.path,
        localPath,
        ...(input.containerName ? ['--container_name', input.containerName] : []),
      ]);
      return await readFile(localPath);
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async writeFile(input: NamespaceInstanceWriteFileInput): Promise<void> {
    const dir = await mkdtemp(join(tmpdir(), 'deputies-namespace-upload-'));
    const localPath = join(dir, 'file');
    try {
      await writeFile(localPath, input.content);
      await this.runNsc([
        'instance',
        'upload',
        input.instanceId,
        localPath,
        input.path,
        '--mkdir',
        ...(input.containerName ? ['--container_name', input.containerName] : []),
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async stat(input: NamespaceInstanceFileInput): Promise<FileStat> {
    const result = await this.execJson<SerializedFileStat>(input.instanceId, input.containerName, fileStatScript, [
      input.path,
    ]);
    return { ...result, mtime: new Date(result.mtime) };
  }

  async readdir(input: NamespaceInstanceFileInput): Promise<string[]> {
    return this.execJson<string[]>(input.instanceId, input.containerName, readdirScript, [input.path]);
  }

  async exists(input: NamespaceInstanceFileInput): Promise<boolean> {
    return this.execJson<boolean>(input.instanceId, input.containerName, existsScript, [input.path]);
  }

  async mkdir(input: NamespaceInstanceMkdirInput): Promise<void> {
    await this.execJson(input.instanceId, input.containerName, mkdirScript, [
      input.path,
      input.recursive ? 'true' : 'false',
    ]);
  }

  async rm(input: NamespaceInstanceRmInput): Promise<void> {
    await this.execJson(input.instanceId, input.containerName, rmScript, [
      input.path,
      input.recursive ? 'true' : 'false',
      input.force ? 'true' : 'false',
    ]);
  }

  private async execJson<T>(
    instanceId: string,
    containerName: string | undefined,
    script: string,
    args: string[],
  ): Promise<T> {
    const result = await this.exec({
      instanceId,
      containerName,
      command: ['node', '-e', quoteShell(script), ...args.map(quoteShell)].join(' '),
      timeoutMs: this.cliTimeoutMs,
    });
    if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout || 'Namespace instance command failed');
    return JSON.parse(result.stdout) as T;
  }

  private async runNsc(
    args: string[],
    options: { stdin?: string; signal?: AbortSignal; timeoutMs?: number; allowFailure?: boolean } = {},
  ): Promise<Omit<SandboxExecResult, 'startedAt' | 'completedAt'>> {
    if (options.signal?.aborted) throw abortError();
    const allArgs = this.nscArgs(args);
    return new Promise((resolve, reject) => {
      const child = spawn(this.nscBinary, allArgs, { stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      let settled = false;
      let timedOut = false;
      let aborted = false;
      const timeoutMs = options.timeoutMs ?? this.cliTimeoutMs;
      const timer = timeoutMs
        ? setTimeout(() => {
            timedOut = true;
            child.kill('SIGKILL');
          }, timeoutMs)
        : undefined;
      const abort = () => {
        aborted = true;
        child.kill('SIGTERM');
      };
      options.signal?.addEventListener('abort', abort, { once: true });
      child.stdout?.on('data', (chunk: Buffer) => {
        stdout = appendBounded(stdout, chunk);
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr = appendBounded(stderr, chunk);
      });
      child.on('error', (error) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        options.signal?.removeEventListener('abort', abort);
        reject(error);
      });
      child.on('close', (code, signal) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        options.signal?.removeEventListener('abort', abort);
        if (aborted) {
          reject(abortError());
          return;
        }
        const exitCode = code ?? (signal ? 128 : 1);
        const result = { exitCode, stdout, stderr };
        if (timedOut) {
          reject(new Error(`${this.nscBinary} ${args[0] ?? 'command'} timed out after ${timeoutMs}ms`));
          return;
        }
        if (exitCode !== 0 && !options.allowFailure) {
          reject(new Error(stderr || stdout || `${this.nscBinary} exited with status ${exitCode}`));
          return;
        }
        resolve(result);
      });
      if (options.stdin) child.stdin?.write(options.stdin);
      child.stdin?.end();
    });
  }

  private nscArgs(args: string[]): string[] {
    const prefix: string[] = [];
    if (this.options.region) prefix.push('--region', this.options.region);
    if (this.options.apiBaseUrl) prefix.push('--endpoint', this.options.apiBaseUrl);
    return [...prefix, ...args];
  }
}

function createNamespaceFileSystem(
  client: NamespaceInstanceClientLike,
  instanceId: string,
  containerName: string | undefined,
): SandboxFileSystem {
  return {
    async readFile(path: string): Promise<string> {
      return Buffer.from(await client.readFile({ instanceId, containerName, path })).toString('utf-8');
    },
    async readFileBuffer(path: string): Promise<Uint8Array> {
      return client.readFile({ instanceId, containerName, path });
    },
    async writeFile(path: string, content: string | Uint8Array): Promise<void> {
      await client.writeFile({ instanceId, containerName, path, content });
    },
    async stat(path: string): Promise<FileStat> {
      return client.stat({ instanceId, containerName, path });
    },
    async readdir(path: string): Promise<string[]> {
      return client.readdir({ instanceId, containerName, path });
    },
    async exists(path: string): Promise<boolean> {
      return client.exists({ instanceId, containerName, path });
    },
    async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
      await client.mkdir({
        instanceId,
        containerName,
        path,
        ...(options?.recursive !== undefined ? { recursive: options.recursive } : {}),
      });
    },
    async rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void> {
      await client.rm({
        instanceId,
        containerName,
        path,
        ...(options?.recursive !== undefined ? { recursive: options.recursive } : {}),
        ...(options?.force !== undefined ? { force: options.force } : {}),
      });
    },
  };
}

function descriptorFromNscJson(
  value: unknown,
  fallback: { containerName?: string; image?: string; workspacePath?: string },
): NamespaceInstanceDescriptor {
  const id =
    findStringByKey(value, ['instance_id', 'instanceId', 'instanceID']) ??
    nestedString(value, ['instance', 'id']) ??
    findStringByKey(value, ['id']) ??
    '';
  const containerName =
    fallback.containerName ??
    findStringByKey(value, ['container_name', 'containerName']) ??
    nestedString(value, ['container', 'name']) ??
    firstNestedString(value, 'containers', ['name']) ??
    nscResourceString(value, 'nsc/containers', 'name') ??
    firstNestedString(value, 'container', ['id']) ??
    nestedString(value, ['container', 'id']) ??
    nscResourceString(value, 'nsc/containers', 'uid');
  const state = findStringByKey(value, ['state', 'status', 'phase']);
  const bridgeUrl = ingressUrlFromNscJson(value);
  return {
    id,
    ...(containerName ? { containerName } : {}),
    ...(bridgeUrl ? { bridgeUrl } : {}),
    ...(fallback.workspacePath ? { workspacePath: fallback.workspacePath } : {}),
    ...(state ? { state } : {}),
    metadata: {
      ...(fallback.image ? { image: fallback.image } : {}),
      ...(fallback.workspacePath ? { workspacePath: fallback.workspacePath } : {}),
      ...(containerName ? { containerName } : {}),
      ...(state ? { state } : {}),
      ...(findInstancePageUrl(value) ? { namespaceInstanceUrl: findInstancePageUrl(value) } : {}),
    },
  };
}

function ingressUrlFromNscJson(value: unknown): string | null {
  const urls = collectUrls(value);
  return (
    urls.find((url) => url.includes('.namespaced.app')) ??
    urls.find((url) => !url.includes('cloud.namespace.so')) ??
    null
  );
}

function findInstancePageUrl(value: unknown): string | null {
  return collectUrls(value).find((url) => url.includes('cloud.namespace.so') && url.includes('/instance/')) ?? null;
}

function collectUrls(value: unknown): string[] {
  const urls: string[] = [];
  visitJson(value, (item) => {
    if (typeof item !== 'string') return;
    for (const match of item.matchAll(/https?:\/\/[^\s"')]+/g)) urls.push(match[0]!);
    for (const match of item.matchAll(/[a-z0-9][a-z0-9.-]+\.namespaced\.app/g)) urls.push(`https://${match[0]}`);
  });
  return [...new Set(urls)];
}

function nscResourceString(value: unknown, resource: string, field: string): string | null {
  if (!Array.isArray(value)) return null;
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const entry = item as Record<string, unknown>;
    if (entry.resource !== resource || !entry.per_resource || typeof entry.per_resource !== 'object') continue;
    for (const resourceValue of Object.values(entry.per_resource)) {
      if (!resourceValue || typeof resourceValue !== 'object' || Array.isArray(resourceValue)) continue;
      const fieldValue = (resourceValue as Record<string, unknown>)[field];
      if (typeof fieldValue === 'string' && fieldValue) return fieldValue;
    }
  }
  return null;
}

function findStringByKey(value: unknown, keys: string[]): string | null {
  let found: string | null = null;
  visitJson(value, (item, key) => {
    if (found || !key || !keys.includes(key) || typeof item !== 'string' || !item) return;
    found = item;
  });
  return found;
}

function nestedString(value: unknown, path: string[]): string | null {
  let current = value;
  for (const part of path) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return null;
    current = (current as Record<string, unknown>)[part];
  }
  return typeof current === 'string' && current ? current : null;
}

function firstNestedString(value: unknown, arrayKey: string, path: string[]): string | null {
  if (!value || typeof value !== 'object') return null;
  const array = (value as Record<string, unknown>)[arrayKey];
  if (!Array.isArray(array)) return null;
  for (const item of array) {
    const result = nestedString(item, path);
    if (result) return result;
  }
  return null;
}

function visitJson(value: unknown, visit: (value: unknown, key?: string) => void): void {
  const seen = new Set<unknown>();
  const walk = (item: unknown, key?: string) => {
    visit(item, key);
    if (!item || typeof item !== 'object' || seen.has(item)) return;
    seen.add(item);
    if (Array.isArray(item)) {
      for (const child of item) walk(child);
      return;
    }
    for (const [childKey, child] of Object.entries(item)) walk(child, childKey);
  };
  walk(value);
}

function parseJson(value: string, command: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    throw new Error(
      `${command} returned invalid JSON: ${error instanceof Error ? error.message : 'unknown parse error'}`,
    );
  }
}

async function namespaceTokenFileBearerToken(path: string | undefined): Promise<string | null> {
  if (!path) return null;
  const parsed = parseJson(await readFile(path, 'utf-8'), 'NSC_TOKEN_FILE');
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  for (const key of ['bearer_token', 'token', 'access_token', 'accessToken']) {
    const value = record[key];
    if (typeof value === 'string' && value) return value;
  }
  return null;
}

function namespaceBridgePreviewUrl(bridgeUrl: string, port: number): string {
  const target = new URL(bridgeUrl);
  const base = target.pathname.replace(/\/$/, '');
  target.pathname = `${base}/preview/${port}`;
  target.search = '';
  target.hash = '';
  return target.toString();
}

type SerializedFileStat = Omit<FileStat, 'mtime'> & { mtime: string };

const fileStatScript = `
const fs = require('node:fs/promises');
(async () => {
  const stat = await fs.lstat(process.argv[1]);
  process.stdout.write(JSON.stringify({
    isFile: stat.isFile(),
    isDirectory: stat.isDirectory(),
    isSymbolicLink: stat.isSymbolicLink(),
    size: stat.size,
    mtime: stat.mtime.toISOString(),
  }));
})().catch((error) => { console.error(error.message); process.exit(1); });
`;

const readdirScript = `
const fs = require('node:fs/promises');
(async () => {
  process.stdout.write(JSON.stringify(await fs.readdir(process.argv[1])));
})().catch((error) => { console.error(error.message); process.exit(1); });
`;

const existsScript = `
const fs = require('node:fs/promises');
(async () => {
  try {
    await fs.lstat(process.argv[1]);
    process.stdout.write('true');
  } catch (error) {
    if (error && error.code === 'ENOENT') process.stdout.write('false');
    else throw error;
  }
})().catch((error) => { console.error(error.message); process.exit(1); });
`;

const mkdirScript = `
const fs = require('node:fs/promises');
(async () => {
  await fs.mkdir(process.argv[1], { recursive: process.argv[2] === 'true' });
  process.stdout.write('null');
})().catch((error) => { console.error(error.message); process.exit(1); });
`;

const rmScript = `
const fs = require('node:fs/promises');
(async () => {
  await fs.rm(process.argv[1], { recursive: process.argv[2] === 'true', force: process.argv[3] === 'true' });
  process.stdout.write('null');
})().catch((error) => { console.error(error.message); process.exit(1); });
`;

function shellEnvPrefix(env: Record<string, string> | undefined): string {
  if (!env) return '';
  const entries = Object.entries(env);
  if (!entries.length) return '';
  for (const [key] of entries) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`Invalid environment variable name: ${key}`);
  }
  return `env ${entries.map(([key, value]) => `${key}=${quoteShell(value)}`).join(' ')} `;
}

function nscMapEntry(key: string, value: string): string {
  return `${key}=${value.replace(/\\/g, '\\\\').replace(/,/g, '\\,')}`;
}

function durationMsToNsc(value: number): string {
  return `${Math.max(1, Math.ceil(value / 1000))}s`;
}

function quoteShell(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function appendBounded(current: string, chunk: Buffer): string {
  const next = current + chunk.toString('utf-8');
  return next.length > maxOutputBytes ? next.slice(next.length - maxOutputBytes) : next;
}

function abortError(): DOMException {
  return new DOMException('Operation aborted', 'AbortError');
}

function isNamespaceNotFoundError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return message.includes('not found') || message.includes('notfound') || message.includes('no such instance');
}

function safeName(value: string): string {
  const safe = value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return safe.slice(0, 40) || 'session';
}
