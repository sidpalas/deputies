export type SandboxCapabilities = {
  persistentFilesystem: boolean;
  snapshots: boolean;
  stopStart: boolean;
  exec: boolean;
  filesystem: boolean;
  streamingLogs: boolean;
  portForwarding: boolean;
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

export type SandboxExecInput = {
  command: string;
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  stdin?: string;
};

export type SandboxExecResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  startedAt: Date;
  completedAt: Date;
};

export type SandboxHandle = SandboxRef & {
  provider: string;
  workspacePath: string;
  metadata: Record<string, unknown>;
  capabilities: SandboxCapabilities;
  exec(input: SandboxExecInput): Promise<SandboxExecResult>;
};

export interface SandboxProvider {
  readonly name: string;
  readonly capabilities: SandboxCapabilities;
  create(input: CreateSandboxInput): Promise<SandboxHandle>;
  connect(input: ConnectSandboxInput): Promise<SandboxHandle>;
  destroy(input: SandboxRef): Promise<void>;
  health(input: SandboxRef): Promise<SandboxHealth>;
}
