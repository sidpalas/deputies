# Sandbox Providers

## Goal

The system must support multiple sandbox providers without changing session, message, worker, integration, or Flue runner code. Provider-specific behavior belongs behind a stable sandbox provider interface plus capability flags.

Initial providers may include:

- `fake`: deterministic tests.
- `local`: local development with host subprocess execution in a temp workspace. This is convenient for getting started but is not a security sandbox. Commands inherit a minimal environment and discover executables through an allowlisted `.deputies-bin` path; configure `LOCAL_SANDBOX_ALLOWED_COMMANDS` to replace the built-in development allowlist.
- `local-docker`: local development and CI smoke tests.
- `daytona`: hosted persistent development sandboxes.
- `kubernetes`: pods/jobs inside a cluster.
- `ecs`: Fargate tasks in AWS.
- `modal` or others later, if desired.

## Design Rule

The worker coordinates product sandbox lifecycle through the provider interface. The Flue runner receives a Flue-compatible sandbox connector derived from the provider handle.

No module outside `sandbox` and provider-specific adapters should know whether a session is running on Docker, Daytona, Kubernetes, ECS, or a fake test provider.

Flue already defines the runtime sandbox shape through `SandboxFactory` and `SessionEnv`. Our provider interface should not become a second agent filesystem/tool runtime. It should own lifecycle concerns that Flue intentionally does not own for our product: create, reconnect, health, destroy, snapshots, persisted provider IDs, and provider capabilities.

## Provider Interface

```ts
export interface SandboxProvider {
  readonly name: string;
  readonly capabilities: SandboxCapabilities;

  create(input: CreateSandboxInput): Promise<SandboxHandle>;
  connect(input: ConnectSandboxInput): Promise<SandboxHandle>;
  destroy(input: DestroySandboxInput): Promise<void>;

  health(input: SandboxRef): Promise<SandboxHealth>;

  snapshot?(input: SnapshotSandboxInput): Promise<SandboxSnapshot>;
  restore?(input: RestoreSandboxInput): Promise<SandboxHandle>;
  stop?(input: StopSandboxInput): Promise<void>;
  start?(input: StartSandboxInput): Promise<SandboxHandle>;
  logs?(input: SandboxLogsInput): AsyncIterable<SandboxLogEvent>;
}
```

Only `create`, `connect`, `destroy`, and `health` are mandatory. Snapshot, restore, stop, start, and logs are optional capabilities.

## Core Types

```ts
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
  repo?: RepoRef;
  baseBranch?: string;
  workingBranch?: string;
  image?: string;
  env?: Record<string, string>;
  resources?: SandboxResources;
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

export type SandboxHandle = SandboxRef & {
  provider: string;
  workspacePath: string;
  metadata: Record<string, unknown>;
  capabilities: SandboxCapabilities;
  exec(command: SandboxExecInput): Promise<SandboxExecResult>;
  fs?: SandboxFileSystem;
  ports?: SandboxPorts;
};
```

## Execution API

Every production provider must support command execution directly or through an attached bridge.

```ts
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
```

Rules:

- Providers must not throw for non-zero process exit codes. Return `exitCode` instead.
- Providers should throw for infrastructure failures: sandbox missing, network failure, timeout connecting to provider API.
- Output should be bounded by provider or caller limits to avoid memory exhaustion.
- Secrets must not be logged by provider adapters.

## Filesystem API

Flue sandbox connectors need filesystem operations. A provider can implement these natively or by translating them into commands inside the sandbox.

```ts
export interface SandboxFileSystem {
  readFile(path: string): Promise<string>;
  readFileBuffer(path: string): Promise<Uint8Array>;
  writeFile(path: string, contents: string | Uint8Array): Promise<void>;
  stat(path: string): Promise<SandboxFileStat>;
  readdir(path: string): Promise<SandboxDirEntry[]>;
  exists(path: string): Promise<boolean>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
}
```

This mirrors the Flue connector shape closely enough that `runner-flue` can adapt a `SandboxHandle` into a Flue sandbox factory.

## Lifecycle Semantics

### Create

`create()` provisions a new sandbox and returns once it can accept commands.

Provider responsibilities:

- Provision the compute environment.
- Install or select a usable base image.
- Return a stable provider sandbox ID.
- Return the workspace path.
- Attach metadata needed to reconnect later.

Optional responsibilities by provider policy:

- Clone the repo.
- Run setup hooks.
- Start a bridge process.
- Preconfigure Git credentials.

### Connect

`connect()` reconnects to an existing provider sandbox ID after process restart or worker handoff.

Provider responsibilities:

- Validate the sandbox still exists.
- Return an executable handle.
- Avoid creating a new sandbox unless the provider explicitly documents reconnect-as-recreate behavior.

### Health

`health()` checks whether the sandbox exists and can accept work.

Suggested result:

```ts
export type SandboxHealth = {
  status: 'ready' | 'starting' | 'stopped' | 'unhealthy' | 'missing';
  message?: string;
  checkedAt: Date;
};
```

For providers with `exec`, a simple `echo ok` style command is acceptable as the default health check.

### Destroy

`destroy()` tears down provider resources.

Rules:

- It must be idempotent.
- Missing sandbox should be treated as success.
- It must not delete database state. The caller owns DB updates.

### Stop And Start

`stop()` and `start()` are optional. Providers that support them should preserve the workspace filesystem across stop/start.

Product lifecycle policy:

- `SANDBOX_IDLE_TIMEOUT_SECONDS` is passed to providers that have their own auto-stop mechanism. Daytona uses this for `autoStopInterval`.
- `SANDBOX_STOP_DELAY_SECONDS` controls the product reaper's first cleanup phase: stop idle ready sandboxes when the session is not active and has no pending messages.
- `SANDBOX_RETENTION_SECONDS` controls the destroy phase: destroy ready, stopped, or unhealthy sandboxes after retention expires.
- Archive destroys active session sandboxes immediately.
- Stopped sandboxes are still reusable when the provider supports `start()`; the lifecycle manager starts them before reconnecting.
- The Postgres reaper uses an advisory lock so only one instance runs cleanup work at a time.

### Snapshot And Restore

Snapshot support is optional.

Providers with snapshots should return:

```ts
export type SandboxSnapshot = {
  provider: string;
  snapshotId: string;
  sourceSandboxId: string;
  metadata: Record<string, unknown>;
  createdAt: Date;
};
```

The worker can use snapshots as an optimization, not as a correctness requirement.

## Provider Capabilities

Provider-specific differences should be expressed through capabilities, not `if provider === ...` checks scattered through the codebase.

Examples:

| Capability | Meaning |
|---|---|
| `persistentFilesystem` | Files survive between runs without snapshot restore. |
| `snapshots` | Provider can save and restore filesystem state. |
| `stopStart` | Provider can stop and later restart the same sandbox. |
| `exec` | Provider supports direct command execution. |
| `filesystem` | Provider supports file operations without shelling out. |
| `streamingLogs` | Provider can stream runtime logs. |
| `portForwarding` | Provider can expose dev server ports. |

The lifecycle manager should select behavior based on capabilities.

## Flue Connector Adapter

`runner-flue` should adapt `SandboxHandle` into Flue's `SandboxFactory` contract.

Conceptually:

```ts
function toFlueSandboxFactory(handle: SandboxHandle): SandboxFactory;
```

The returned `SandboxFactory` creates Flue `SessionEnv` instances backed by the provider handle.

Required mapping:

```txt
Flue exec -> SandboxHandle.exec
Flue readFile -> SandboxHandle.fs.readFile or shell fallback
Flue writeFile -> SandboxHandle.fs.writeFile or shell fallback
Flue readdir/stat/exists/mkdir/rm -> SandboxHandle.fs or shell fallback
```

If a provider lacks native filesystem APIs, the adapter may implement them with safe shell commands. That fallback must quote paths safely and reject unsupported path shapes.

## Provider Examples

### Fake Provider

Purpose:

- Unit, integration, and e2e tests.

Behavior:

- Always returns a ready sandbox.
- `exec()` returns scripted outputs.
- Filesystem is in memory.
- No network or real process execution.

### Local Docker Provider

Purpose:

- Local development and CI smoke tests.

Behavior:

- Creates Docker container per session.
- Uses bind mount or named volume for workspace.
- Executes commands via Docker exec.
- Destroy removes container and optional volume.

### Daytona Provider

Purpose:

- Hosted persistent dev environments.

Behavior:

- Creates Daytona sandbox/workspace.
- Reconnects by provider sandbox ID.
- Uses Daytona exec/filesystem APIs where available.
- May support persistent filesystem better than snapshots.

Current implementation:

- `api/src/sandbox/daytona.ts` wraps the Daytona TypeScript SDK behind the product `SandboxProvider` interface.
- `api/src/runner-flue/sandbox-factory.ts` adapts any filesystem-capable `SandboxHandle` into Flue's `SandboxFactory` using `createSandboxSessionEnv`.
- Daytona creation supports optional `DAYTONA_IMAGE`, `DAYTONA_SNAPSHOT`, `DAYTONA_API_URL`, and `DAYTONA_TARGET` configuration.
- Daytona creation sets `autoStopInterval` from `SANDBOX_IDLE_TIMEOUT_SECONDS` using Daytona's minute granularity. The default product timeout is 900 seconds.
- This follows Flue's documented connector shape: product code creates/configures the Daytona sandbox, then Flue receives a connector-wrapped sandbox.
- Provider sandbox IDs, workspace paths, metadata, health timestamps, and lifecycle status are persisted in `sandboxes`.
- Follow-up messages reconnect to the latest active sandbox for the session/provider when health is ready. Stopped sandboxes are restarted before reconnect so filesystem state can be reused. Unhealthy or missing sandboxes are marked unhealthy and replaced.
- `api/test/uat/real-daytona-flue.test.ts` provides an opt-in built-artifact UAT path for `RUNNER=flue` plus `SANDBOX_PROVIDER=daytona`; it is skipped unless `RUN_REAL_DAYTONA_FLUE_UAT=true` and required credentials are present.

### Kubernetes Provider

Purpose:

- Cluster-native deployments.

Behavior:

- Creates Pod or Job per session.
- Uses PVC for persistent workspace if needed.
- Executes commands via Kubernetes exec API.
- Health checks pod phase and optional exec probe.
- Destroy deletes pod/job and optional PVC depending on retention policy.

### ECS Provider

Purpose:

- AWS-native Fargate deployments.

Behavior:

- Starts task per session.
- Uses EFS for persistent workspace if needed.
- Requires a bridge or sidecar API for exec/filesystem operations, since ECS Exec is not ideal as a high-level filesystem API.
- Health checks task status and bridge readiness.
- Destroy stops task.

## Bridge Pattern

Some providers cannot provide convenient filesystem and exec APIs directly. Those providers should run a sandbox bridge inside the environment.

Bridge responsibilities:

- Expose authenticated HTTP or WebSocket control API.
- Execute commands.
- Perform filesystem operations.
- Stream logs/events.
- Report heartbeat.

The provider adapter then talks to the bridge instead of provider-native exec APIs.

This is especially useful for ECS, Kubernetes, and any provider with awkward remote exec semantics.

## Conformance Tests

Every provider must pass the same conformance suite.

Required tests:

- `create()` returns a handle with provider sandbox ID and workspace path.
- `health()` reports ready after create.
- `connect()` reconnects to the same sandbox.
- `exec()` returns stdout, stderr, and exit code.
- Non-zero command returns `exitCode`, not thrown error.
- `writeFile()` then `readFile()` round trips content.
- `mkdir()` and `readdir()` work.
- `rm()` removes files/directories.
- `destroy()` is idempotent.
- Optional `stop()` is idempotent and preserves workspace when `persistentFilesystem` is true.
- Optional `start()` reconnects to the same provider sandbox ID or returns an equivalent handle documented by the provider.
- Missing sandbox health returns `missing` or `unhealthy`.

Optional capability tests run only when capability flags are enabled:

- snapshot and restore preserve files.
- stop and start preserve workspace if `persistentFilesystem` is true.
- port forwarding exposes a test HTTP server.
- streaming logs produce expected output.

## Error Model

Provider errors should be normalized.

```ts
export class SandboxProviderError extends Error {
  provider: string;
  code:
    | 'not_found'
    | 'auth_failed'
    | 'quota_exceeded'
    | 'timeout'
    | 'network'
    | 'unhealthy'
    | 'unsupported'
    | 'unknown';
  retryable: boolean;
  details?: unknown;
}
```

The worker uses `retryable` to decide whether to retry, recreate, or fail the message.

## Persistence

Provider adapters return metadata. The sandbox module persists it in the `sandboxes` table.

Persisted fields:

- provider name.
- provider sandbox ID.
- session ID.
- status.
- workspace path.
- snapshot ID, if any.
- provider metadata needed to reconnect.

Provider adapters must not write directly to the database.

## Security

Rules:

- Provider adapters must not log raw environment variables or credentials.
- Any bridge API must require per-sandbox authentication.
- Sandbox tokens must be scoped to one sandbox/session.
- Provider metadata should not contain raw long-lived credentials.
- Destructive actions must be limited to the provider sandbox ID passed by the caller.
- Filesystem APIs must prevent accidental host path traversal for local providers.

## MVP Recommendation

Implement providers in this order:

1. `fake`, required for tests.
2. `daytona`, the first hosted provider because it matches Flue's remote sandbox docs.
3. `local-docker`, useful for local and CI validation.
4. Kubernetes or ECS depending on the first self-hosted deployment target.

This order proves the interface with both deterministic tests and a hosted persistent sandbox before committing to a self-hosted infrastructure platform.

## Relationship To Flue's Daytona Example

Flue's documented remote coding-agent example creates a Daytona sandbox, initializes a setup agent, clones the repo, installs dependencies, then initializes a second project-scoped agent in the same sandbox with `cwd` set to the cloned repo.

Our design should preserve that shape:

```txt
provider lifecycle manager
  -> create/connect sandbox and persist provider sandbox ID
  -> produce Flue SandboxFactory from provider handle

runner-flue
  -> use setup Flue agent for repo clone/sync/setup
  -> use project Flue agent with cwd=/workspace/project for user prompt
```

The difference from Flue's minimal example is durability and policy:

- The product records sandbox ownership in `sandboxes`.
- Follow-ups should reconnect to the same sandbox when possible.
- Repo clone should become repo sync after the first run.
- Setup/install hooks should be explicit and observable.
- Cleanup is controlled by product retention policy, not always `cleanup: true`.
