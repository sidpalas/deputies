export type SandboxCapabilities = {
  persistentFilesystem: boolean;
  snapshots: boolean;
  stopStart: boolean;
  exec: boolean;
  filesystem: boolean;
  streamingLogs: boolean;
  portForwarding: boolean;
  previewUrls: boolean;
  objectStorageArtifacts: boolean;
};

export type CreateSandboxInput = {
  sessionId: string;
  metadata?: Record<string, unknown>;
};

export type ConnectSandboxInput = {
  providerSandboxId: string;
  sessionId: string;
  metadata?: Record<string, unknown>;
  secrets?: Record<string, string>;
};

export type SandboxRef = {
  providerSandboxId: string;
  sessionId: string;
};

export type SandboxHealth = {
  status: 'ready' | 'starting' | 'stopped' | 'unhealthy' | 'missing';
  message?: string;
  checkedAt: Date;
};

export type SandboxProviderCheck = {
  status: 'ready' | 'unhealthy';
  message?: string;
  checkedAt: Date;
};

export type SandboxExecInput = {
  command: string;
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
  stdin?: string;
};

export type SandboxExecResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  startedAt: Date;
  completedAt: Date;
};

export type SandboxPreviewUrlInput = SandboxRef & {
  port: number;
  secrets?: Record<string, string>;
};

export type SandboxKeepaliveInput = SandboxRef & {
  durationMs: number;
};

export type SandboxPreviewUrl = {
  port: number;
  targetUrl: string;
  targetHeaders?: Record<string, string>;
};

export type SandboxFileSystem = {
  readFile(path: string): Promise<string>;
  readFileBuffer(path: string): Promise<Uint8Array>;
  writeFile(path: string, content: string | Uint8Array): Promise<void>;
  stat(path: string): Promise<FileStat>;
  readdir(path: string): Promise<string[]>;
  exists(path: string): Promise<boolean>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
};

export type FileStat = {
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
  size: number;
  mtime: Date;
};

export type SandboxHandle = SandboxRef & {
  provider: string;
  workspacePath: string;
  metadata: Record<string, unknown>;
  secrets?: Record<string, string>;
  capabilities: SandboxCapabilities;
  fs?: SandboxFileSystem;
  exec(input: SandboxExecInput): Promise<SandboxExecResult>;
};

export interface SandboxProvider {
  readonly name: string;
  readonly capabilities: SandboxCapabilities;
  check?(): Promise<SandboxProviderCheck>;
  create(input: CreateSandboxInput): Promise<SandboxHandle>;
  connect(input: ConnectSandboxInput): Promise<SandboxHandle>;
  start?(input: SandboxRef): Promise<void>;
  stop?(input: SandboxRef): Promise<void>;
  destroy(input: SandboxRef): Promise<void>;
  health(input: SandboxRef): Promise<SandboxHealth>;
  getPreviewUrl?(input: SandboxPreviewUrlInput): Promise<SandboxPreviewUrl | null>;
  refreshKeepalive?(input: SandboxKeepaliveInput): Promise<void>;
}
