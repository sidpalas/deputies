import { randomUUID } from 'node:crypto';
import { basename, dirname } from 'node:path/posix';
import { Sandbox } from '@opencomputer/sdk';
import type { EntryInfo, ProcessResult, RunOpts, SandboxOpts } from '@opencomputer/sdk';
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
  SandboxPreviewUrl,
  SandboxPreviewUrlInput,
  SandboxProvider,
  SandboxProviderCheck,
  SandboxRef,
} from './types.js';

const defaultWorkspacePath = '/workspace';
const defaultOpenComputerMemoryMb = 1024;
const openComputerBridgePort = 3584;
const openComputerExecReadinessRetryMs = 30_000;
const openComputerExecCommandRetryMs = 5_000;
const openComputerProxyCaPath = '/usr/local/share/ca-certificates/opensandbox-proxy.crt';
const openComputerProxyEnvNames = ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy'];
const clearOpenComputerProxyCommand = `unset ${openComputerProxyEnvNames.join(' ')}`;

export type OpenComputerCreateSandboxOptions = Omit<SandboxOpts, 'apiKey' | 'apiUrl'>;

export type OpenComputerClientLike = {
  create(params?: OpenComputerCreateSandboxOptions): Promise<OpenComputerSandboxLike>;
  connect(id: string): Promise<OpenComputerSandboxLike>;
};

export type OpenComputerSandboxLike = {
  sandboxId: string;
  status: string;
  domain: string;
  getPreviewDomain(port: number): string;
  kill(): Promise<void>;
  hibernate(): Promise<void>;
  wake(opts?: { timeout?: number }): Promise<void>;
  setTimeout(timeout: number): Promise<void>;
  createPreviewURL?(opts: { port: number; domain?: string; authConfig?: Record<string, unknown> }): Promise<{
    hostname?: string;
  }>;
  exec: {
    run(command: string, opts?: RunOpts): Promise<ProcessResult>;
    start?(
      command: string,
      opts?: RunOpts & {
        args?: string[];
        onStdout?: (data: Uint8Array) => void;
        onStderr?: (data: Uint8Array) => void;
      },
    ): Promise<{
      done: Promise<number>;
      kill(signal?: number): Promise<void>;
      close(): void;
    }>;
  };
  files: {
    read(path: string): Promise<string>;
    readBytes(path: string): Promise<Uint8Array>;
    write(path: string, content: string | Uint8Array): Promise<void>;
    list(path?: string): Promise<EntryInfo[]>;
    makeDir(path: string): Promise<void>;
    remove(path: string): Promise<void>;
    exists(path: string): Promise<boolean>;
  };
};

export type OpenComputerSandboxProviderOptions = {
  client?: OpenComputerClientLike;
  apiKey?: string;
  apiUrl?: string;
  template?: string;
  snapshot?: string;
  secretStore?: string;
  workspacePath?: string;
  idleTimeoutMs?: number;
  envVars?: Record<string, string>;
  metadata?: Record<string, string>;
  cpuCount?: number;
  memoryMB?: number;
  diskMB?: number;
};

export const openComputerCapabilities: SandboxCapabilities = {
  persistentFilesystem: true,
  snapshots: true,
  stopStart: true,
  exec: true,
  filesystem: true,
  streamingLogs: false,
  portForwarding: true,
  previewUrls: true,
  objectStorageArtifacts: false,
};

export class OpenComputerSandboxProvider implements SandboxProvider {
  readonly name = 'opencomputer';
  readonly capabilities = openComputerCapabilities;
  private readonly client: OpenComputerClientLike;

  constructor(private readonly options: OpenComputerSandboxProviderOptions = {}) {
    this.client = options.client ?? createOpenComputerClient(options);
  }

  async check(): Promise<SandboxProviderCheck> {
    try {
      await this.client.connect('__deputies_setup_connectivity_check__');
      return { status: 'ready', checkedAt: new Date() };
    } catch (error) {
      if (isNotFoundError(error)) return { status: 'ready', checkedAt: new Date() };
      return {
        status: 'unhealthy',
        message: error instanceof Error ? error.message : 'Unknown OpenComputer connectivity error',
        checkedAt: new Date(),
      };
    }
  }

  async create(input: CreateSandboxInput): Promise<SandboxHandle> {
    const bridgeToken = randomUUID();
    const sandbox = await this.client.create(this.createParams(input));
    try {
      await waitForOpenComputerExec(sandbox);
      await ensureWorkspace(sandbox, this.workspacePath);
      return this.toHandle(sandbox, input.sessionId, input.metadata ?? {}, { bridgeToken });
    } catch (error) {
      await sandbox.kill().catch(() => undefined);
      throw error;
    }
  }

  async connect(input: ConnectSandboxInput): Promise<SandboxHandle> {
    const sandbox = await this.client.connect(input.providerSandboxId);
    await waitForOpenComputerExec(sandbox);
    await ensureWorkspace(sandbox, this.workspacePath);
    return this.toHandle(sandbox, input.sessionId, input.metadata ?? {}, input.secrets);
  }

  async destroy(input: SandboxRef): Promise<void> {
    try {
      const sandbox = await this.client.connect(input.providerSandboxId);
      await sandbox.kill();
    } catch (error) {
      if (isNotFoundError(error)) return;
      throw error;
    }
  }

  async start(input: SandboxRef): Promise<void> {
    const sandbox = await this.client.connect(input.providerSandboxId);
    await wakeOpenComputerSandbox(sandbox, openComputerTimeoutSeconds(this.options.idleTimeoutMs) ?? 0);
    await waitForOpenComputerExec(sandbox);
  }

  async stop(input: SandboxRef): Promise<void> {
    const sandbox = await this.client.connect(input.providerSandboxId);
    await sandbox.hibernate();
  }

  async health(input: SandboxRef): Promise<SandboxHealth> {
    try {
      const sandbox = await this.client.connect(input.providerSandboxId);
      const status = openComputerHealthStatus(sandbox.status);
      if (status === 'ready') return openComputerExecHealth(sandbox);
      return {
        status,
        ...(status === 'unhealthy' ? { message: `OpenComputer sandbox status: ${sandbox.status || 'unknown'}` } : {}),
        checkedAt: new Date(),
      };
    } catch (error) {
      if (isNotFoundError(error)) return { status: 'missing', checkedAt: new Date() };
      throw error;
    }
  }

  async getPreviewUrl(input: SandboxPreviewUrlInput): Promise<SandboxPreviewUrl | null> {
    const sandbox = await this.client.connect(input.providerSandboxId);
    const bridgeToken = input.secrets?.bridgeToken ?? randomUUID();
    await ensureOpenComputerBridge(sandbox, this.workspacePath, bridgeToken);
    const hostname =
      sandbox.getPreviewDomain(openComputerBridgePort) ||
      (await createOpenComputerPreviewHostname(sandbox, openComputerBridgePort));
    if (!hostname) return null;
    return {
      port: input.port,
      targetUrl: openComputerBridgePreviewUrl(`https://${hostname}`, input.port),
      targetHeaders: { authorization: `Bearer ${bridgeToken}` },
      preserveTargetHost: true,
      forwardPreviewHost: true,
      secrets: { bridgeToken },
    };
  }

  async refreshKeepalive(input: SandboxRef & { durationMs: number }): Promise<void> {
    const requestedSeconds = Math.max(1, Math.ceil(input.durationMs / 1000));
    const fallbackSeconds = openComputerTimeoutSeconds(this.options.idleTimeoutMs) ?? 0;
    if (requestedSeconds <= fallbackSeconds) return;
    const sandbox = await this.client.connect(input.providerSandboxId);
    await sandbox.setTimeout(requestedSeconds);
  }

  private get workspacePath(): string {
    return this.options.workspacePath ?? defaultWorkspacePath;
  }

  private createParams(input: CreateSandboxInput): OpenComputerCreateSandboxOptions {
    const params: OpenComputerCreateSandboxOptions = {
      timeout: openComputerTimeoutSeconds(this.options.idleTimeoutMs) ?? 0,
      memoryMB: this.options.memoryMB ?? defaultOpenComputerMemoryMb,
      envs: {
        ...(this.options.envVars ?? {}),
        DEPUTIES_WORKSPACE: this.workspacePath,
        DEPUTIES_SANDBOX_BRIDGE_HOST: '0.0.0.0',
        DEPUTIES_SANDBOX_BRIDGE_PORT: String(openComputerBridgePort),
      },
      metadata: {
        ...(this.options.metadata ?? {}),
        'deputies-session-id': input.sessionId,
      },
    };
    if (this.options.template) params.template = this.options.template;
    if (this.options.snapshot) params.snapshot = this.options.snapshot;
    if (this.options.secretStore) params.secretStore = this.options.secretStore;
    if (this.options.cpuCount !== undefined) params.cpuCount = this.options.cpuCount;
    if (this.options.diskMB !== undefined) params.diskMB = this.options.diskMB;
    return params;
  }

  private toHandle(
    sandbox: OpenComputerSandboxLike,
    sessionId: string,
    metadata: Record<string, unknown>,
    secrets: Record<string, string> | undefined,
  ): SandboxHandle {
    return {
      provider: this.name,
      providerSandboxId: sandbox.sandboxId,
      sessionId,
      workspacePath: this.workspacePath,
      metadata: {
        ...metadata,
        status: sandbox.status,
        ...(sandbox.domain ? { domain: sandbox.domain } : {}),
      },
      capabilities: this.capabilities,
      ...(secrets?.bridgeToken ? { secrets: { bridgeToken: secrets.bridgeToken } } : {}),
      fs: createOpenComputerFileSystem(sandbox),
      exec: (command) =>
        execOpenComputerCommand(sandbox, command, { useProxyEgress: Boolean(this.options.secretStore) }),
    };
  }
}

function createOpenComputerClient(options: OpenComputerSandboxProviderOptions): OpenComputerClientLike {
  const sdkOptions = openComputerSdkOptions(options);
  return {
    create(params) {
      return Sandbox.create({ ...sdkOptions, ...(params ?? {}) });
    },
    connect(id) {
      return Sandbox.connect(id, sdkOptions);
    },
  };
}

function openComputerSdkOptions(options: OpenComputerSandboxProviderOptions): Pick<SandboxOpts, 'apiKey' | 'apiUrl'> {
  const sdkOptions: Pick<SandboxOpts, 'apiKey' | 'apiUrl'> = {};
  if (options.apiKey) sdkOptions.apiKey = options.apiKey;
  if (options.apiUrl) sdkOptions.apiUrl = options.apiUrl;
  return sdkOptions;
}

function createOpenComputerFileSystem(sandbox: OpenComputerSandboxLike): SandboxFileSystem {
  return {
    readFile(path: string): Promise<string> {
      return sandbox.files.read(path);
    },
    readFileBuffer(path: string): Promise<Uint8Array> {
      return sandbox.files.readBytes(path);
    },
    writeFile(path: string, content: string | Uint8Array): Promise<void> {
      return sandbox.files.write(path, content);
    },
    async stat(path: string): Promise<FileStat> {
      const entry = await openComputerPathEntry(sandbox, path);
      return {
        isFile: !entry.isDir,
        isDirectory: entry.isDir,
        isSymbolicLink: false,
        size: entry.size ?? 0,
        mtime: new Date(0),
      };
    },
    async readdir(path: string): Promise<string[]> {
      const entries = await sandbox.files.list(path);
      return entries.map((entry) => entry.name).filter(Boolean);
    },
    async exists(path: string): Promise<boolean> {
      if (path === '/') return true;
      if (await openComputerFileExists(sandbox, path)) return true;
      try {
        return Boolean(await openComputerParentEntry(sandbox, path));
      } catch (error) {
        if (isOpenComputerMissingPathError(error)) return false;
        throw error;
      }
    },
    mkdir(path: string): Promise<void> {
      return sandbox.files.makeDir(path);
    },
    async rm(path: string, options?: { force?: boolean }): Promise<void> {
      try {
        await sandbox.files.remove(path);
      } catch (error) {
        if (options?.force && isNotFoundError(error)) return;
        throw error;
      }
    },
  };
}

async function openComputerFileExists(sandbox: OpenComputerSandboxLike, path: string): Promise<boolean> {
  try {
    return await sandbox.files.exists(path);
  } catch (error) {
    if (isOpenComputerMissingPathError(error)) return false;
    throw error;
  }
}

async function openComputerPathEntry(sandbox: OpenComputerSandboxLike, path: string): Promise<EntryInfo> {
  if (path === '/') return { name: '/', isDir: true, path: '/', size: 0 };
  const parentEntry = await openComputerParentEntry(sandbox, path);
  if (parentEntry) return parentEntry;
  try {
    await sandbox.files.list(path);
    return { name: basename(path), isDir: true, path, size: 0 };
  } catch (error) {
    if (isOpenComputerMissingPathError(error)) {
      throw Object.assign(new Error(`OpenComputer file not found: ${path}`), { statusCode: 404 });
    }
    throw error;
  }
}

async function openComputerParentEntry(sandbox: OpenComputerSandboxLike, path: string): Promise<EntryInfo | null> {
  const entries = await sandbox.files.list(dirname(path));
  const name = basename(path);
  return entries.find((item) => item.name === name || item.path === path) ?? null;
}

async function execOpenComputerCommand(
  sandbox: OpenComputerSandboxLike,
  input: SandboxExecInput,
  options: { useProxyEgress: boolean },
): Promise<SandboxExecResult> {
  if (input.signal?.aborted) throw abortError();
  const startedAt = new Date();
  const command = openComputerCommand(input, options);
  const runOptions = openComputerRunOptions(input, options);
  const response =
    input.signal && sandbox.exec.start
      ? await runOpenComputerStartedCommand(sandbox, command, runOptions, input.signal)
      : await runOpenComputerCommand(sandbox, command, runOptions, input.signal ? { signal: input.signal } : {});
  return {
    exitCode: response.exitCode,
    stdout: response.stdout,
    stderr: response.stderr,
    startedAt,
    completedAt: new Date(),
  };
}

function openComputerCommand(input: SandboxExecInput, options: { useProxyEgress: boolean }): string {
  const command = input.stdin === undefined ? input.command : `printf %s ${quoteShell(input.stdin)} | ${input.command}`;
  return options.useProxyEgress || hasExplicitProxyEnv(input.env)
    ? command
    : `${clearOpenComputerProxyCommand}; ${command}`;
}

function hasExplicitProxyEnv(env: Record<string, string> | undefined): boolean {
  return Boolean(env && openComputerProxyEnvNames.some((name) => Object.hasOwn(env, name)));
}

function openComputerRunOptions(input: SandboxExecInput, egress: { useProxyEgress: boolean }): RunOpts {
  const runOptions: RunOpts = {};
  if (input.cwd) runOptions.cwd = input.cwd;
  const env = openComputerCommandEnv(input.env, egress);
  if (env) runOptions.env = env;
  if (input.timeoutMs !== undefined) runOptions.timeout = Math.max(1, Math.ceil(input.timeoutMs / 1000));
  return runOptions;
}

function openComputerCommandEnv(
  env: Record<string, string> | undefined,
  options: { useProxyEgress: boolean },
): Record<string, string> | undefined {
  if (!options.useProxyEgress) return env;
  return {
    GIT_SSL_CAINFO: openComputerProxyCaPath,
    ...(env ?? {}),
  };
}

function openComputerTimeoutSeconds(timeoutMs: number | undefined): number | undefined {
  return timeoutMs === undefined ? undefined : Math.max(1, Math.ceil(timeoutMs / 1000));
}

async function ensureWorkspace(sandbox: OpenComputerSandboxLike, workspacePath: string): Promise<void> {
  const response = await runOpenComputerCommand(sandbox, `mkdir -p ${quoteShell(workspacePath)}`, { timeout: 10 });
  if (response.exitCode !== 0) {
    throw new Error(response.stderr || response.stdout || `Failed to create OpenComputer workspace: ${workspacePath}`);
  }
}

async function wakeOpenComputerSandbox(sandbox: OpenComputerSandboxLike, timeout: number): Promise<void> {
  try {
    await sandbox.wake({ timeout });
  } catch (error) {
    if (isOpenComputerNoActiveHibernationError(error)) return;
    throw error;
  }
}

async function waitForOpenComputerExec(sandbox: OpenComputerSandboxLike): Promise<void> {
  try {
    const response = await runOpenComputerCommand(
      sandbox,
      'true',
      { timeout: 5 },
      { retryMs: openComputerExecReadinessRetryMs },
    );
    if (response.exitCode === 0) {
      await waitForOpenComputerFiles(sandbox);
      return;
    }
    throw new Error(response.stderr || response.stdout || 'OpenComputer sandbox exec probe failed');
  } catch (error) {
    if (isOpenComputerSandboxRoutingRace(error)) {
      throw new Error(
        `OpenComputer sandbox exec did not become available within ${openComputerExecReadinessRetryMs / 1000}s`,
      );
    }
    throw error;
  }
}

async function waitForOpenComputerFiles(sandbox: OpenComputerSandboxLike): Promise<void> {
  const deadline = Date.now() + openComputerExecReadinessRetryMs;
  let delayMs = 250;

  for (;;) {
    try {
      await sandbox.files.list('/');
      return;
    } catch (error) {
      if (!isOpenComputerRouteReadinessError(error) || Date.now() + delayMs > deadline) throw error;
      await sleep(delayMs);
      delayMs = Math.min(delayMs * 2, 1000);
    }
  }
}

async function openComputerExecHealth(sandbox: OpenComputerSandboxLike): Promise<SandboxHealth> {
  const checkedAt = new Date();
  try {
    const response = await runOpenComputerCommand(sandbox, 'true', { timeout: 5 }, { retryMs: 0 });
    if (response.exitCode === 0) {
      await sandbox.files.list('/');
      return { status: 'ready', checkedAt };
    }
    return {
      status: 'unhealthy',
      message: response.stderr || response.stdout || 'OpenComputer sandbox exec probe failed',
      checkedAt,
    };
  } catch (error) {
    if (isOpenComputerRouteReadinessError(error)) {
      return { status: 'starting', message: 'OpenComputer sandbox routes are not available yet', checkedAt };
    }
    throw error;
  }
}

function openComputerBridgePreviewUrl(targetUrl: string, port: number): string {
  const target = new URL(targetUrl);
  const base = target.pathname.endsWith('/') ? target.pathname.slice(0, -1) : target.pathname;
  target.pathname = `${base}/preview/${port}`;
  return target.toString();
}

async function ensureOpenComputerBridge(
  sandbox: OpenComputerSandboxLike,
  workspacePath: string,
  bridgeToken: string,
): Promise<void> {
  const pidFile = '/tmp/deputies-sandbox-bridge.pid';
  const logFile = '/tmp/deputies-sandbox-bridge.log';
  const response = await runOpenComputerCommand(
    sandbox,
    [
      `TOKEN=${quoteShell(bridgeToken)};`,
      `WORKSPACE=${quoteShell(workspacePath)};`,
      `PID_FILE=${quoteShell(pidFile)};`,
      `LOG_FILE=${quoteShell(logFile)};`,
      `HEALTH_URL=${quoteShell(`http://127.0.0.1:${openComputerBridgePort}/health`)};`,
      'export TOKEN HEALTH_URL;',
      `HEALTH_CHECK=${quoteShell(
        'const http=require("node:http");const req=http.get(process.env.HEALTH_URL,{headers:{Authorization:"Bearer "+process.env.TOKEN}},res=>{res.resume();process.exit(res.statusCode===200?0:1);});req.on("error",()=>process.exit(1));req.setTimeout(1000,()=>{req.destroy();process.exit(1);});',
      )};`,
      'health() { node -e "$HEALTH_CHECK" >/dev/null 2>&1; };',
      'start_bridge() {',
      'DEPUTIES_SANDBOX_TOKEN="$TOKEN"',
      'DEPUTIES_WORKSPACE="$WORKSPACE"',
      'DEPUTIES_SANDBOX_BRIDGE_HOST=0.0.0.0',
      `DEPUTIES_SANDBOX_BRIDGE_PORT=${openComputerBridgePort}`,
      'DEPUTIES_SANDBOX_BRIDGE_PREVIEW_ONLY=1',
      'nohup node /opt/deputies/sandbox-bridge/dist/server.js >> "$LOG_FILE" 2>&1 & echo $! > "$PID_FILE";',
      '};',
      'if ! health; then',
      '[ -f "$PID_FILE" ] && kill "$(cat "$PID_FILE")" 2>/dev/null || true;',
      'start_bridge;',
      'fi;',
      'for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do',
      'health && exit 0;',
      'sleep 0.25;',
      'done;',
      'echo "deputies sandbox bridge did not become ready" >&2;',
      'exit 1;',
    ].join(' '),
    { timeout: 10 },
  );
  if (response.exitCode !== 0) {
    throw new Error(response.stderr || response.stdout || 'OpenComputer sandbox bridge did not become ready');
  }
}

async function createOpenComputerPreviewHostname(
  sandbox: OpenComputerSandboxLike,
  port: number,
): Promise<string | null> {
  const preview = await sandbox.createPreviewURL?.({ port });
  return preview?.hostname ?? null;
}

function openComputerHealthStatus(status: string): SandboxHealth['status'] {
  const normalized = status.toLowerCase();
  if (normalized === 'running') return 'ready';
  if (normalized === 'hibernated' || normalized === 'stopped') return 'stopped';
  if (
    normalized.includes('start') ||
    normalized.includes('wake') ||
    normalized.includes('pending') ||
    normalized.includes('provision') ||
    normalized.includes('creat') ||
    normalized.includes('boot')
  ) {
    return 'starting';
  }
  return 'unhealthy';
}

async function runOpenComputerCommand(
  sandbox: OpenComputerSandboxLike,
  command: string,
  opts?: RunOpts,
  options: { signal?: AbortSignal; retryMs?: number } = {},
): Promise<ProcessResult> {
  const deadline = Date.now() + (options.retryMs ?? openComputerExecCommandRetryMs);
  let delayMs = 250;

  for (;;) {
    if (options.signal?.aborted) throw abortError();

    try {
      return await abortable(sandbox.exec.run(command, opts), options.signal);
    } catch (error) {
      if (!isOpenComputerSandboxRoutingRace(error) || Date.now() + delayMs > deadline) throw error;
      await sleep(delayMs, options.signal);
      delayMs = Math.min(delayMs * 2, 1000);
    }
  }
}

async function runOpenComputerStartedCommand(
  sandbox: OpenComputerSandboxLike,
  command: string,
  opts: RunOpts,
  signal: AbortSignal,
): Promise<ProcessResult> {
  const stdout: Uint8Array[] = [];
  const stderr: Uint8Array[] = [];
  const session = await startOpenComputerCommand(sandbox, {
    ...opts,
    args: ['-c', command],
    onStdout: (data) => stdout.push(data),
    onStderr: (data) => stderr.push(data),
  });
  if (signal.aborted) {
    await session.kill().catch(() => undefined);
    session.close();
    throw abortError();
  }

  let aborted = false;
  const abort = () => {
    aborted = true;
    void session.kill().catch(() => undefined);
    session.close();
  };
  signal.addEventListener('abort', abort, { once: true });
  try {
    const exitCode = await session.done;
    if (aborted || signal.aborted) throw abortError();
    return {
      exitCode,
      stdout: Buffer.concat(stdout).toString('utf-8'),
      stderr: Buffer.concat(stderr).toString('utf-8'),
    };
  } finally {
    signal.removeEventListener('abort', abort);
    session.close();
  }
}

async function startOpenComputerCommand(
  sandbox: OpenComputerSandboxLike,
  opts: RunOpts & {
    args: string[];
    onStdout: (data: Uint8Array) => void;
    onStderr: (data: Uint8Array) => void;
  },
) {
  const deadline = Date.now() + openComputerExecCommandRetryMs;
  let delayMs = 250;

  for (;;) {
    try {
      return await sandbox.exec.start!('sh', opts);
    } catch (error) {
      if (!isOpenComputerSandboxRoutingRace(error) || Date.now() + delayMs > deadline) throw error;
      await sleep(delayMs);
      delayMs = Math.min(delayMs * 2, 1000);
    }
  }
}

function isOpenComputerSandboxRoutingRace(error: unknown): boolean {
  return isNotFoundError(error) && error instanceof Error && /sandbox not found/i.test(error.message);
}

function isOpenComputerRouteReadinessError(error: unknown): boolean {
  return isOpenComputerSandboxRoutingRace(error) || isNotFoundError(error);
}

function isOpenComputerNoActiveHibernationError(error: unknown): boolean {
  return error instanceof Error && /no active hibernation found/i.test(error.message);
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort);
      reject(abortError());
    };
    signal.addEventListener('abort', abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      },
    );
  });
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) {
    await new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
    return;
  }
  const abortSignal = signal;
  if (abortSignal.aborted) throw abortError();

  await new Promise<void>((resolveSleep, reject) => {
    const timeout = setTimeout(done, ms);
    function done() {
      abortSignal.removeEventListener('abort', aborted);
      resolveSleep();
    }
    function aborted() {
      clearTimeout(timeout);
      abortSignal.removeEventListener('abort', aborted);
      reject(abortError());
    }
    abortSignal.addEventListener('abort', aborted, { once: true });
  });
}

function abortError(): DOMException {
  return new DOMException('Operation aborted', 'AbortError');
}

function quoteShell(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function isNotFoundError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const named = error as Error & { code?: string; statusCode?: number; status?: number };
  return (
    named.name.includes('NotFound') ||
    named.code === 'not_found' ||
    named.statusCode === 404 ||
    named.status === 404 ||
    /\b404\b/.test(error.message)
  );
}

function isOpenComputerMissingPathError(error: unknown): boolean {
  if (isNotFoundError(error)) return true;
  return error instanceof Error && /^Failed to (?:list|read|remove) .+: (?:404|500)$/.test(error.message);
}
