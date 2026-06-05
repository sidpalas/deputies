# Sandbox Providers

## Goal

The system must support multiple sandbox providers without changing session, message, worker, integration, or runner code. Provider-specific behavior belongs behind a stable sandbox provider interface plus capability flags.

Initial providers may include:

- `fake`: deterministic tests.
- `unsafe-local`: local development with host subprocess execution in a temp workspace. This is convenient for getting started but is not a security sandbox. Commands inherit a minimal environment and discover executables through an allowlisted `.deputies-bin` path; configure `LOCAL_SANDBOX_ALLOWED_COMMANDS` to replace the built-in development allowlist.
- `docker`: planned Docker Engine backed sandboxes. This can use a local or remote Docker daemon depending on deployment configuration.
- `daytona`: hosted persistent development sandboxes.
- `tensorlake`: hosted MicroVM sandboxes with direct exec, file operations, suspend/resume, snapshots, and exposed service ports.
- `superserve`: hosted Firecracker MicroVM sandboxes with direct exec/files, pause/resume, snapshots, and public port URLs routed through the authenticated Deputies bridge.
- `lambda-microvm`: AWS Lambda MicroVM sandboxes launched from a prebuilt MicroVM image through the AWS Lambda MicroVM APIs.
- `kubernetes`: pods/jobs inside a cluster.
- `modal` or others later, if desired.

Some sandbox providers create sandboxes from OCI/container images without supporting nested Docker or Docker Compose inside the sandbox. For those providers, Postgres-backed tests should start Postgres directly in the sandbox. The repo-owned Daytona image and scripts in `deploy/sandboxes/daytona/` install Postgres directly and expose `./deploy/sandboxes/daytona/start-postgres.sh` for this path.

Lambda MicroVM images are managed separately from app Terraform with `deploy/sandboxes/lambda-microvm` tasks. Terraform should manage supporting IAM, S3, logs, and app configuration, while the control plane manages individual MicroVM lifecycle at runtime.

Tensorlake sandboxes require `TENSORLAKE_REGISTERED_IMAGE` to name a registered Tensorlake sandbox image, such as `deputies`. Raw registry references like `ghcr.io/org/image:tag` cannot be passed directly to `Sandbox.create`; put the registry reference in `deploy/sandboxes/tensorlake/Dockerfile`, set `TENSORLAKE_REGISTERED_IMAGE` to the stable registered name/id, then run `mise run //deploy/sandboxes/tensorlake:image:create` before using the provider.

OpenComputer sandboxes require `OPENCOMPUTER_API_KEY` and `OPENCOMPUTER_SNAPSHOT`. Build the snapshot from `deploy/sandboxes/opencomputer` so `/opt/deputies/ensure-sandbox-bridge.sh` and the bridge runtime are available. OpenComputer's default template is its built-in base environment, not an alias for a named snapshot. `OPENCOMPUTER_SECRET_STORE` enables provider-managed proxy egress; CPU count and memory/disk MB requests are optional. With Postgres, configure `SANDBOX_SECRET_ENCRYPTION_KEY` so per-sandbox bridge credentials can be persisted securely. OpenComputer previews expose only the authenticated bridge port and route applications through `/preview/<port>`.

> **Warning:** Tensorlake's remote rootfs builder can struggle to export large container images, especially on free-tier builders limited to 1 vCPU and 1 GiB RAM. The build may complete every Dockerfile step and then fail while exporting layers with `rpc error: code = Unavailable` or `error reading from server: EOF`. Prefer a small provider-specific base and avoid adding browser binaries or unrelated developer tooling when they are not required. The `//deploy/sandboxes/tensorlake:uat` task uses the minimal `sandbox-provider-minimal-uat` base target for this reason.

The live provider UAT publishes the current checkout's bridge in a minimal, immutable base image, registers it separately as `deputies-uat`, and runs the gated test with `mise run //deploy/sandboxes/tensorlake:uat`. It intentionally omits developer tooling and must not be used as the local or production `TENSORLAKE_REGISTERED_IMAGE`.

### Tensorlake Service Previews Through The Deputies Bridge

Tensorlake exposes only the sandbox bridge port through its authenticated ingress. Browser-facing application traffic uses the same bridge-based preview path as Daytona, Superserve, Docker, Kubernetes, and Lambda MicroVMs, which gives the application Deputies-facing host rewriting and cookie/header isolation.

Browser-facing service previews use this path:

```text
Deputies service proxy
  -> Tensorlake authenticated ingress on bridge port 3584
  -> Deputies bridge /preview/<application-port>
  -> application
```

Tensorlake's native SDK APIs remain responsible for lifecycle, exec, and filesystem work. The bridge applies only to browser-facing service endpoints:

1. Start the bridge with the per-sandbox bridge token and workspace path, then expose only bridge port `3584` through Tensorlake ingress with `allowUnauthenticatedAccess: false`.
2. Address the two authentication layers without putting the Tensorlake API key in the sandbox: use `Authorization: Bearer <Tensorlake API key>` for ingress and add a dedicated bridge credential header such as `X-Deputies-Bridge-Token` for the bridge.
3. Extend the bridge to accept that dedicated header and strip both it and the ingress credential before proxying to the application. Do not reuse `Authorization` for the bridge token because Tensorlake ingress needs that header.
4. The Tensorlake UAT verifies the dedicated header reaches the sandbox bridge and neither it nor the ingress credential reaches the application.
5. Live Tensorlake UAT covers HTTP, WebSockets, host rewriting, cookie isolation, and an application login/session flow.

Superserve sandboxes require `SUPERSERVE_TEMPLATE` to name a ready Superserve template. Templates use the published Daytona image, which satisfies Superserve's Linux/amd64 glibc requirement and contains the Deputies bridge. Superserve preview URLs are public internet endpoints; Deputies protects the bridge with service authorization plus a per-sandbox bridge token, then forwards requested application ports through `/preview/<port>`. The bridge token protects the public endpoint from external callers but is a sandbox-visible capability, so sandbox code must be trusted with preview access.

> **Warning:** `SANDBOX_PROVIDER=unsafe-local` is for trusted local development only. It is not a security boundary; agent commands run on the API/worker host runtime in a temporary workspace.

## Design Rule

The worker coordinates product sandbox lifecycle through the provider interface. The Pi runner uses the provider handle through the generic sandbox tool layer. The deprecated Flue runner receives a Flue-compatible sandbox connector derived from the same provider handle while it remains supported.

No module outside `sandbox` and provider-specific adapters should know whether a session is running on Docker, Daytona, Kubernetes, Lambda MicroVMs, or a fake test provider.

Our provider interface should not become a second agent filesystem/tool runtime. It should own lifecycle concerns that runner SDKs intentionally do not own for our product: create, reconnect, health, destroy, stop/start when supported, managed service processes when available, persisted provider IDs, and provider capabilities. Deprecated Flue support adapts this handle into Flue's `SandboxFactory` and `SessionEnv` shape.

## Provider Interface

```ts
export interface SandboxProvider {
  readonly name: string;
  readonly capabilities: SandboxCapabilities;

  create(input: CreateSandboxInput): Promise<SandboxHandle>;
  connect(input: ConnectSandboxInput): Promise<SandboxHandle>;
  start?(input: SandboxRef): Promise<void>;
  stop?(input: SandboxRef): Promise<void>;
  destroy(input: SandboxRef): Promise<void>;
  health(input: SandboxRef): Promise<SandboxHealth>;
}
```

Only `create`, `connect`, `destroy`, and `health` are mandatory. The current implementation also supports optional `start` and `stop`. Snapshot, restore, and logs are represented only as capability concepts for future providers, not as current interface methods.

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
  serviceEndpoints: boolean;
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

export type SandboxHandle = SandboxRef & {
  provider: string;
  workspacePath: string;
  metadata: Record<string, unknown>;
  capabilities: SandboxCapabilities;
  fs?: SandboxFileSystem;
  exec(input: SandboxExecInput): Promise<SandboxExecResult>;
  startService?(input: SandboxServiceProcessInput): Promise<SandboxServiceProcess>;
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
  readdir(path: string): Promise<string[]>;
  exists(path: string): Promise<boolean>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
}
```

This is the stable sandbox contract used by Pi tools and other runner adapters. Deprecated `runner-flue` can also adapt a `SandboxHandle` into a Flue sandbox factory.

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

| Capability             | Meaning                                                     |
| ---------------------- | ----------------------------------------------------------- |
| `persistentFilesystem` | Files survive between runs without snapshot restore.        |
| `snapshots`            | Provider can save and restore filesystem state.             |
| `stopStart`            | Provider can stop and later restart the same sandbox.       |
| `exec`                 | Provider supports direct command execution.                 |
| `filesystem`           | Provider supports file operations without shelling out.     |
| `streamingLogs`        | Provider can stream runtime logs.                           |
| `portForwarding`       | Provider can expose dev server ports.                       |
| `serviceEndpoints`     | Provider can return controlled endpoints for sandbox ports. |

The lifecycle manager should select behavior based on capabilities.

## Legacy Flue Connector Adapter

New real-agent work uses Pi through generic sandbox handles and Pi tool definitions. This section documents the deprecated Flue adapter that remains only for legacy support and removal work.

Deprecated `runner-flue` adapts `SandboxHandle` into Flue's `SandboxFactory` contract.

Conceptually:

```ts
function toFlueSandboxFactory(handle: SandboxHandle): SandboxFactory;
```

The returned `SandboxFactory` creates Flue `SessionEnv` instances backed by the provider handle.

Required mapping:

```txt
Flue exec -> SandboxHandle.exec
Flue readFile -> SandboxHandle.fs.readFile
Flue writeFile -> SandboxHandle.fs.writeFile
Flue readdir/stat/exists/mkdir/rm -> SandboxHandle.fs
```

The current deprecated Flue adapter requires providers to expose `fs`; it does not implement shell-based filesystem fallbacks. Providers without native filesystem APIs need a bridge or adapter-level filesystem implementation before they can be used with `runner-flue`.

## Provider Examples

### Fake Provider

Purpose:

- Unit, integration, and e2e tests.

Behavior:

- Always returns a ready sandbox.
- `exec()` returns scripted outputs.
- Filesystem is in memory.
- No network or real process execution.

### Docker Provider

Purpose:

- Local development, CI smoke tests, and production deployments backed by isolated Docker hosts.

Behavior:

- Creates one Docker container per session.
- Uses the Docker Engine API only for lifecycle: create, start, stop, inspect, and destroy.
- Runs a small authenticated sandbox bridge inside each container for command execution and filesystem operations.
- Avoids host bind mounts by default so the provider works with local and remote Docker daemons.
- Destroys the container and any provider-owned Docker volume or container filesystem state when retention expires.

Implementation plan:

1. Use `docker` as the provider kind because the provider targets the Docker Engine API, not only a local daemon.
2. Add `DockerSandboxProvider` behind the existing `SandboxProvider` interface.
3. Add a narrow `DockerOrchestrator` interface used by `DockerSandboxProvider`.
4. Implement an in-process Docker orchestrator for single-service local/dev operation.
5. Keep the orchestrator boundary HTTP-compatible so production can run the same logic as a separate service without changing worker, lifecycle, or runner code.
6. Add a sandbox bridge process to the Docker image and use it for all runtime operations.
7. Add provider conformance tests and Docker-specific integration tests.

Provider capabilities for the first implementation should be:

```ts
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
```

If stop/start support complicates the first implementation, it is acceptable to ship `stopStart: false` and add it after create/connect/destroy/exec/filesystem are reliable.

#### Docker Architecture

The control plane should keep its existing product-level provider boundary:

```txt
worker
  -> SandboxLifecycleService
    -> DockerSandboxProvider
      -> DockerOrchestrator
        -> Docker Engine API
        -> sandbox bridge
```

`DockerSandboxProvider` should not call Docker Engine or the bridge directly. It should call `DockerOrchestrator`, then adapt returned sandbox descriptors into `SandboxHandle` values.

Recommended interfaces:

```ts
export interface DockerOrchestrator {
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
  getServiceEndpoint(input: DockerServiceEndpointInput): Promise<SandboxServiceEndpoint | null>;
}
```

Deployment modes:

```txt
Single-service mode:
control-plane process
  -> DockerSandboxProvider
    -> InProcessDockerOrchestrator
      -> Docker Engine API
      -> sandbox bridge

Split production mode:
control-plane process
  -> DockerSandboxProvider
    -> HttpDockerOrchestratorClient
      -> sandbox-orchestrator service
        -> Docker Engine API
        -> sandbox bridge
```

This adds one intentional seam without creating two provider implementations. The same `DockerSandboxProvider` should be used in both modes.

#### Docker Configuration

Suggested control-plane configuration:

```txt
SANDBOX_PROVIDER=docker
DOCKER_ORCHESTRATOR_MODE=in-process|http
DOCKER_ORCHESTRATOR_URL=https://sandbox-orchestrator.internal
DOCKER_SANDBOX_IMAGE=...
SANDBOX_WORKSPACE_PATH=/workspace
DOCKER_SANDBOX_NETWORK=bridge
DOCKER_SANDBOX_MEMORY=2g
DOCKER_SANDBOX_CPUS=2
```

In `in-process` mode, Docker daemon configuration lives with the control-plane process and can use standard Docker environment variables such as `DOCKER_HOST`, `DOCKER_TLS_VERIFY`, and `DOCKER_CERT_PATH`.

In `http` mode, Docker daemon credentials should live only in the orchestrator service. The control plane should only know `DOCKER_ORCHESTRATOR_URL` and orchestrator API credentials.

#### Docker Runtime Bridge

The Docker sandbox image should start a bridge process inside the container:

```sh
deputies-sandbox-bridge \
  --workspace /workspace \
  --listen 0.0.0.0:3584 \
  --token "$DEPUTIES_SANDBOX_TOKEN"
```

Bridge responsibilities:

- Authenticate every request with a per-sandbox token.
- Execute commands with `cwd`, `env`, `stdin`, and `timeoutMs` support.
- Return non-zero command exits as `exitCode`, not thrown infrastructure errors.
- Bound stdout and stderr output.
- Implement filesystem operations relative to the configured workspace.
- Reject filesystem and command working-directory paths that escape the workspace.
- Avoid logging command environment values or bridge tokens.
- Report health once the workspace and runtime dependencies are ready.

Minimal bridge API:

```txt
GET  /health
POST /exec
GET  /fs/read?path=...
PUT  /fs/write?path=...
GET  /fs/stat?path=...
GET  /fs/readdir?path=...
GET  /fs/exists?path=...
POST /fs/mkdir
POST /fs/rm
```

Example exec request:

```json
{
  "command": "pnpm test",
  "cwd": "/workspace/repo",
  "env": { "NODE_ENV": "test" },
  "timeoutMs": 120000,
  "stdin": "optional"
}
```

Example exec response:

```json
{
  "exitCode": 0,
  "stdout": "...",
  "stderr": "...",
  "startedAt": "2026-05-11T00:00:00.000Z",
  "completedAt": "2026-05-11T00:00:03.000Z"
}
```

The sandbox container does not need outbound connectivity back to the control plane for bridge control traffic. The orchestrator should initiate connections to the bridge and optionally proxy those calls for the control plane. Containers may still need outbound internet access for task work such as `git clone` and package installation.

Current bridge implementation:

- `packages/sandbox-bridge` contains the in-container HTTP bridge process.
- `deploy/sandboxes/docker/Dockerfile` builds a sandbox image that runs the bridge as the non-root `sandbox` user.
- The Docker sandbox image mirrors the Daytona sandbox core tooling: Ubuntu 24.04, Postgres, Git LFS, SSH, jq, rsync, zsh, vim, sudo, Node.js 24, and Corepack/pnpm. Playwright browsers are optional in Docker builds because they add significant image size.
- `deploy/sandboxes/docker/README.md` documents local image build and smoke-test commands.

Current provider implementation:

- `apps/control-plane/src/sandbox/docker.ts` implements `DockerSandboxProvider`, `InProcessDockerOrchestrator`, `HttpDockerOrchestratorClient`, and the shared HTTP orchestrator handler.
- `apps/control-plane/src/sandbox/docker-orchestrator-server.ts` is the split-service entrypoint for running the Docker orchestrator separately from the main API/worker process.
- `DOCKER_ORCHESTRATOR_MODE=in-process` runs Docker orchestration inside the control-plane process for single-service operation.
- `DOCKER_ORCHESTRATOR_MODE=http` makes the control-plane call an external Docker orchestrator service.
- `pnpm --dir apps/control-plane docker-orchestrator:dev` starts the orchestrator service from source for development.

#### Docker Persistence

Persist provider metadata needed to reconnect without storing long-lived credentials:

```json
{
  "containerId": "...",
  "containerName": "...",
  "workspacePath": "/workspace",
  "bridge": {
    "url": "http://...",
    "tokenRef": "provider-managed"
  },
  "image": "..."
}
```

If bridge tokens are persisted, they must be treated as secrets. Prefer an orchestrator-owned token store or encrypted storage over raw metadata when running in production.

#### Runner Integration

No Docker-specific logic should be added to `runner-pi` or deprecated `runner-flue`.

The Docker provider must return a normal filesystem-capable `SandboxHandle`:

```ts
{
  provider: 'docker',
  providerSandboxId: containerId,
  workspacePath: '/workspace',
  capabilities: dockerCapabilities,
  fs: createDockerBridgeFileSystem(orchestrator, ref),
  exec: (input) => orchestrator.exec({ ...ref, ...input }),
}
```

`apps/control-plane/src/runner-pi/sandbox-tools.ts` should continue using `SandboxHandle` directly. While deprecated Flue support exists, `apps/control-plane/src/runner-flue/sandbox-factory.ts` should continue adapting `SandboxHandle` into Flue's `SandboxFactory` and fail early with a clear error when `RUNNER=flue` is paired with a provider handle that lacks `fs`.

#### Docker Security

Required controls:

- Do not mount the Docker socket into sandbox containers.
- Do not use host bind mounts by default.
- Use one container per session.
- Generate a unique bridge token per sandbox.
- Keep the bridge reachable only from the orchestrator when possible.
- Apply memory and CPU limits by default in production deployments.
- Use an image allowlist for production orchestrators.
- Avoid privileged containers unless explicitly required for a trusted deployment.
- Do not pass arbitrary parent process environment variables into containers.
- Do not persist raw Docker daemon credentials in sandbox metadata.

### Daytona Provider

Purpose:

- Hosted persistent dev environments.

Behavior:

- Creates Daytona sandbox/workspace.
- Reconnects by provider sandbox ID.
- Uses Daytona exec/filesystem APIs where available.
- May support persistent filesystem better than snapshots.

Current implementation:

- `apps/control-plane/src/sandbox/daytona.ts` wraps the Daytona TypeScript SDK behind the product `SandboxProvider` interface.
- `apps/control-plane/src/runner-pi/sandbox-tools.ts` exposes sandbox-backed shell and filesystem tools for Pi.
- Deprecated `apps/control-plane/src/runner-flue/sandbox-factory.ts` adapts any filesystem-capable `SandboxHandle` into Flue's `SandboxFactory` using `createSandboxSessionEnv`.
- Daytona creation supports optional `DAYTONA_IMAGE`, `DAYTONA_SNAPSHOT`, `DAYTONA_API_URL`, and `DAYTONA_TARGET` configuration.
- Daytona creation supports optional deployment-level resource requests through `DAYTONA_SANDBOX_CPU`, `DAYTONA_SANDBOX_GPU`, `DAYTONA_SANDBOX_MEMORY_GIB`, and `DAYTONA_SANDBOX_DISK_GIB`. These map to Daytona SDK `resources` values; CPU/GPU are counts, memory/disk are GiB.
- Resource sizing is intentionally deployment-level policy. If the product needs per-session sizing later, the session API should accept an allowlisted resource profile instead of raw CPU, memory, and disk values.
- Daytona creation sets `autoStopInterval` from `SANDBOX_IDLE_TIMEOUT_SECONDS` using Daytona's minute granularity. The default product timeout is 900 seconds.
- Daytona exec cancellation is best-effort. Deputies observes `AbortSignal`s before and during SDK `executeCommand` calls so the worker can stop waiting and mark a run cancelled, but Daytona's direct exec API does not expose a remote command cancel/kill handle. If cancellation happens after a command starts, that command may keep running and may continue mutating the persistent sandbox filesystem until it exits or hits its timeout.
- Deprecated Flue support follows Flue's documented connector shape: product code creates/configures the Daytona sandbox, then Flue receives a connector-wrapped sandbox.
- Provider sandbox IDs, workspace paths, metadata, health timestamps, and lifecycle status are persisted in `sandboxes`.
- Follow-up messages reconnect to the latest active sandbox for the session/provider when health is ready. Stopped sandboxes are restarted before reconnect so filesystem state can be reused. Unhealthy or missing sandboxes are marked unhealthy and replaced.
- `apps/control-plane/test/uat/real-daytona-flue.test.ts` provides an opt-in legacy built-artifact UAT path for `RUNNER=flue` plus `SANDBOX_PROVIDER=daytona`; it is skipped unless `RUN_REAL_DAYTONA_FLUE_UAT=true` and required credentials are present.

### Kubernetes Provider

Purpose:

- Cluster-native deployments.

Behavior:

- Creates Pod or Job per session.
- Uses PVC for persistent workspace if needed.
- Executes commands via Kubernetes exec API.
- Health checks pod phase and optional exec probe.
- Destroy deletes pod/job and optional PVC depending on retention policy.

## Bridge Pattern

Some providers cannot provide convenient filesystem and exec APIs directly. Those providers should run a sandbox bridge inside the environment.

Bridge responsibilities:

- Expose authenticated HTTP or WebSocket control API.
- Execute commands.
- Perform filesystem operations.
- Stream logs/events.
- Report heartbeat.

The provider adapter then talks to the bridge instead of provider-native exec APIs.

This is especially useful for Docker, Kubernetes, Lambda MicroVMs, and any provider with awkward remote exec semantics.

Docker should use the bridge pattern from the first implementation rather than using `docker exec` as the product runtime API. `docker exec` is acceptable for diagnostics or bootstrapping, but the provider-grade runtime should use the bridge so Docker, Kubernetes, Lambda MicroVMs, and future providers can converge on one exec/filesystem contract.

## Planned Conformance Tests

Every provider should eventually pass the same conformance suite. The current code has focused unit coverage for fake, local, and Daytona behavior, but a reusable provider conformance suite is still planned.

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

Current implemented providers are `fake`, `unsafe-local`, `docker`, `daytona`, `tensorlake`, `k8s-agent-sandbox`, and `lambda-microvm`. Docker is named for the Docker Engine API rather than local-only operation, because the same provider can target a local or remote Docker daemon.

Docker MVP order:

1. Standardize `SandboxExecInput.timeoutMs` as milliseconds across all providers.
2. Add the sandbox bridge image/process and bridge client.
3. Add `DockerOrchestrator` with an in-process implementation.
4. Add `DockerSandboxProvider` that wraps the orchestrator and returns normal `SandboxHandle` values.
5. Wire `SANDBOX_PROVIDER=docker` in control-plane startup.
6. Add conformance tests shared by `unsafe-local`, `daytona` mocks, and Docker.
7. Add opt-in Docker integration tests that require a Docker daemon.
8. Add `HttpDockerOrchestratorClient` and a separate orchestrator service only when production isolation is needed.

Docker testing approach:

- Unit test `DockerSandboxProvider` against a fake `DockerOrchestrator`.
- Unit test bridge client request/response mapping, auth headers, binary file reads, and error handling.
- Unit test bridge path validation and command timeout behavior inside the bridge package.
- Run provider conformance tests against the fake orchestrator and against real Docker when enabled.
- Add real Docker integration tests guarded by an environment variable such as `RUN_DOCKER_SANDBOX_TESTS=true`.
- Add one Pi adapter integration test using a Docker handle to verify repository setup and command execution still use the generic `SandboxHandle` path.
- Add cleanup tests for idempotent destroy, missing containers, stopped containers, and orphaned resources.

## Legacy Relationship To Flue's Daytona Example

This section records the deprecated Flue runner's original Daytona shape. Flue's documented remote coding-agent example creates a Daytona sandbox, initializes a setup agent, clones the repo, installs dependencies, then initializes a second project-scoped agent in the same sandbox with `cwd` set to the cloned repo.

Our design should preserve that shape:

```txt
provider lifecycle manager
  -> create/connect sandbox and persist provider sandbox ID
  -> produce Flue SandboxFactory from provider handle

deprecated runner-flue
  -> use setup Flue agent for repo clone/sync/setup
  -> use project Flue agent with cwd=/workspace/project for user prompt
```

The difference from Flue's minimal example is durability and policy:

- The product records sandbox ownership in `sandboxes`.
- Follow-ups should reconnect to the same sandbox when possible.
- Repo clone should become repo sync after the first run.
- Setup/install hooks should be explicit and observable.
- Cleanup is controlled by product retention policy, not always `cleanup: true`.
