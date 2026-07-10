import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Image } from '@opencomputer/sdk/node';
import type { ImageManifest, SnapshotInfo } from '@opencomputer/sdk/node';

type SnapshotVariant = 'full' | 'slim' | 'bridge' | 'minimal';

type Args = {
  apiUrl?: string;
  codeServerVersion: string;
  dryRun: boolean;
  help: boolean;
  hunkdiffVersion: string;
  name: string;
  playwrightVersion: string;
  postgresVersion: string;
  revision?: string;
  timeoutPollSeconds: number;
  variant: SnapshotVariant;
};

type SnapshotClient = {
  apiKey: string;
  apiUrl: string;
};

type SnapshotClientOptions = {
  apiKey: string;
  apiUrl?: string;
};

const defaultFullSnapshotName = 'deputies-opencomputer-node24-pg16-playwright1-59-1';
const defaultSlimSnapshotName = 'deputies-opencomputer-node24-pg16-slim';
const defaultBridgeSnapshotName = 'deputies-opencomputer-base-bridge';
const defaultMinimalSnapshotName = 'deputies-opencomputer-base-minimal';
const defaultApiUrl = 'https://app.opencomputer.dev';
const defaultCodeServerVersion = '4.118.0';
const defaultHunkdiffVersion = '0.12.1';
const defaultPlaywrightVersion = '1.59.1';
const defaultPostgresVersion = '16';
const defaultTimeoutPollSeconds = 300;
const snapshotPollIntervalMs = 15_000;
const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '../../..');
const bridgePackagePath = resolve(repoRoot, 'packages/sandbox-bridge');
const bridgeStartupPath = resolve(repoRoot, 'deploy/sandboxes/base/ensure-sandbox-bridge.sh');

const aptPackages = [
  'ca-certificates',
  'curl',
  'fd-find',
  'git',
  'git-lfs',
  'gnupg',
  'jq',
  'openssh-client',
  'ripgrep',
  'rsync',
  'sudo',
  'ttyd',
  'unzip',
  'vim',
  'zsh',
];

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2), process.env);
  if (args.help) {
    printHelp();
    return;
  }

  const image = createImage(args);
  console.log(`OpenComputer snapshot name: ${args.name}`);
  console.log(`Snapshot variant: ${args.variant}`);
  console.log(`Image cache key: ${image.cacheKey()}`);

  if (args.dryRun) {
    console.log(JSON.stringify(redactedManifest(image.toJSON()), null, 2));
    return;
  }

  const apiKey = process.env.OPENCOMPUTER_API_KEY;
  if (!apiKey) {
    throw new Error('OPENCOMPUTER_API_KEY is required to create an OpenComputer snapshot.');
  }
  if (apiKey.startsWith('op://')) {
    throw new Error(
      'OPENCOMPUTER_API_KEY is a 1Password reference. Run this command through `op run --env-file .env.local -- ...` so the reference is resolved before calling OpenComputer.',
    );
  }

  const clientOptions: SnapshotClientOptions = { apiKey };
  if (args.apiUrl) clientOptions.apiUrl = args.apiUrl;
  const client = createSnapshotClient(clientOptions);

  console.log('Creating OpenComputer snapshot with SSE streaming. Build logs will stream below.');
  const snapshot = await createSnapshotWithTimeoutFallback(client, args.name, image, args.timeoutPollSeconds);

  printSnapshot(snapshot);
}

function createSnapshotClient(options: SnapshotClientOptions): SnapshotClient {
  return {
    apiKey: options.apiKey,
    apiUrl: resolveApiUrl(options.apiUrl ?? process.env.OPENCOMPUTER_API_URL ?? defaultApiUrl),
  };
}

function resolveApiUrl(url: string): string {
  const base = url.replace(/\/+$/, '');
  return base.endsWith('/api') ? base : `${base}/api`;
}

function printSnapshot(snapshot: SnapshotInfo): void {
  console.log(`Created OpenComputer snapshot ${snapshot.name}`);
  console.log(`Snapshot ID: ${snapshot.id}`);
  console.log(`Checkpoint ID: ${snapshot.checkpointId}`);
  console.log(`Status: ${snapshot.status}`);
  console.log(`Configure Deputies with OPENCOMPUTER_SNAPSHOT=${snapshot.name}`);
}

async function createSnapshotWithTimeoutFallback(
  client: SnapshotClient,
  name: string,
  image: Image,
  timeoutPollSeconds: number,
): Promise<SnapshotInfo> {
  try {
    return await createSnapshotWithSSE(client, name, image, (log) => {
      process.stdout.write(log.endsWith('\n') ? log : `${log}\n`);
    });
  } catch (error) {
    if (!isCloudflareTimeoutError(error)) throw error;

    if (timeoutPollSeconds <= 0) {
      throw new Error(createTimeoutMessage(name, timeoutPollSeconds));
    }

    console.warn('OpenComputer returned HTTP 524 before snapshot creation completed.');
    console.warn(`Polling for snapshot "${name}" for up to ${formatSeconds(timeoutPollSeconds)}.`);

    const snapshot = await waitForSnapshot(client, name, timeoutPollSeconds);
    if (snapshot) {
      console.log(`Snapshot "${name}" became available after the timeout.`);
      return snapshot;
    }

    throw new Error(createTimeoutMessage(name, timeoutPollSeconds));
  }
}

async function createSnapshotWithSSE(
  client: SnapshotClient,
  name: string,
  image: Image,
  onLog: (log: string) => void,
): Promise<SnapshotInfo> {
  // OpenComputer builds can run for minutes. Its Python SDK explicitly uses SSE
  // here because non-streaming snapshot requests can hit Cloudflare 524.
  const response = await fetch(`${client.apiUrl}/snapshots`, {
    method: 'POST',
    headers: createHeaders(client, 'text/event-stream'),
    body: JSON.stringify({
      name,
      image: image.toJSON(),
    }),
  });

  if (!response.ok) throw await createSnapshotError('create', response);

  if (response.headers.get('content-type')?.includes('text/event-stream')) {
    return parseSnapshotSSEStream(response, onLog);
  }

  return response.json() as Promise<SnapshotInfo>;
}

async function parseSnapshotSSEStream(response: Response, onLog: (log: string) => void): Promise<SnapshotInfo> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('No response body for OpenComputer snapshot SSE stream.');

  const decoder = new TextDecoder();
  let buffer = '';
  let result: SnapshotInfo | undefined;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split('\n\n');
    buffer = events.pop() ?? '';

    for (const event of events) {
      if (!event.trim() || event.startsWith(':')) continue;
      const parsed = parseSSEEvent(event);
      if (!parsed.data) continue;

      if (parsed.type === 'build_log') {
        onLog(parseBuildLog(parsed.data));
      } else if (parsed.type === 'error') {
        throw new Error(`Build failed: ${parseBuildError(parsed.data)}`);
      } else if (parsed.type === 'result') {
        result = JSON.parse(parsed.data) as SnapshotInfo;
      }
    }
  }

  const remaining = decoder.decode();
  if (remaining) buffer += remaining;
  if (buffer.trim() && !result) {
    const parsed = parseSSEEvent(buffer);
    if (parsed.type === 'result' && parsed.data) result = JSON.parse(parsed.data) as SnapshotInfo;
  }

  if (!result) throw new Error('No result received from OpenComputer snapshot SSE stream.');
  return result;
}

function parseSSEEvent(event: string): { data: string; type: string } {
  const data: string[] = [];
  let type = '';

  for (const line of event.split('\n')) {
    if (line.startsWith('event: ')) {
      type = line.slice('event: '.length);
    } else if (line.startsWith('data: ')) {
      data.push(line.slice('data: '.length));
    }
  }

  return { data: data.join('\n'), type };
}

function parseBuildLog(data: string): string {
  try {
    const parsed = JSON.parse(data) as { message?: unknown };
    return typeof parsed.message === 'string' ? parsed.message : data;
  } catch {
    return data;
  }
}

function parseBuildError(data: string): string {
  try {
    const parsed = JSON.parse(data) as { error?: unknown };
    return typeof parsed.error === 'string' ? parsed.error : data;
  } catch {
    return data;
  }
}

async function waitForSnapshot(
  client: SnapshotClient,
  name: string,
  timeoutPollSeconds: number,
): Promise<SnapshotInfo | undefined> {
  const deadline = Date.now() + timeoutPollSeconds * 1000;
  let lastStatus: string | undefined;

  while (Date.now() <= deadline) {
    const snapshot = await getSnapshotIfPresent(client, name);
    if (snapshot) {
      if (isFailedSnapshotStatus(snapshot.status)) {
        throw new Error(`OpenComputer snapshot "${name}" failed with status ${snapshot.status}.`);
      }
      if (snapshot.checkpointId) return snapshot;
      if (snapshot.status !== lastStatus) {
        console.log(`Snapshot "${name}" is ${snapshot.status}; waiting for checkpoint.`);
        lastStatus = snapshot.status;
      }
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    await sleep(Math.min(snapshotPollIntervalMs, remainingMs));
  }

  return undefined;
}

async function getSnapshotIfPresent(client: SnapshotClient, name: string): Promise<SnapshotInfo | undefined> {
  const response = await fetch(`${client.apiUrl}/snapshots/${encodeURIComponent(name)}`, {
    headers: createHeaders(client),
  });

  if (response.status === 404) return undefined;
  if (!response.ok) throw await createSnapshotError('get', response);

  return response.json() as Promise<SnapshotInfo>;
}

function createHeaders(client: SnapshotClient, accept?: string): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (accept) headers.Accept = accept;
  if (client.apiKey) headers['X-API-Key'] = client.apiKey;
  return headers;
}

async function createSnapshotError(action: 'create' | 'get', response: Response): Promise<Error> {
  const text = await response.text();
  return new Error(`Failed to ${action} snapshot: ${response.status} ${summarizeResponseText(text)}`);
}

function summarizeResponseText(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return '';
  if (trimmed.includes('524: A timeout occurred')) return 'Cloudflare 524: A timeout occurred';
  if (trimmed.length > 1000) return `${trimmed.slice(0, 1000)}...`;
  return trimmed;
}

function isCloudflareTimeoutError(error: unknown): boolean {
  const message = errorMessage(error);
  return message.includes('Failed to create snapshot: 524') || message.includes('Cloudflare 524: A timeout occurred');
}

function isFailedSnapshotStatus(status: string): boolean {
  return /fail|error|cancel/i.test(status);
}

function createTimeoutMessage(name: string, timeoutPollSeconds: number): string {
  return [
    'OpenComputer snapshot creation timed out with HTTP 524 before returning a result.',
    `Snapshot "${name}" was not available after ${formatSeconds(timeoutPollSeconds)} of post-timeout polling.`,
    'Re-run this command; if OpenComputer cached completed image steps, the retry may finish faster.',
    'Use --timeout-poll-seconds or OPENCOMPUTER_SNAPSHOT_TIMEOUT_POLL_SECONDS to change the post-timeout polling window.',
  ].join('\n');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function formatSeconds(seconds: number): string {
  if (seconds === 1) return '1 second';
  if (seconds < 60) return `${seconds} seconds`;

  const minutes = seconds / 60;
  if (Number.isInteger(minutes)) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  return `${seconds} seconds`;
}

function createImage(args: Args): Image {
  if (args.variant === 'minimal') return Image.base();

  let image = Image.base()
    .env({ DEBIAN_FRONTEND: 'noninteractive', TZ: 'Etc/UTC' })
    .runCommands(createHostnameResolutionCommand());
  if (args.variant !== 'bridge') {
    image = image.aptInstall(aptPackages);
    for (const command of createRunCommands(args)) image = image.runCommands(command);
  }

  const imageEnv: Record<string, string> = {
    DEBIAN_FRONTEND: 'noninteractive',
    DEPUTIES_OPENCOMPUTER_SNAPSHOT_VARIANT: args.variant,
    DEPUTIES_WORKSPACE: '/workspace',
    DEPUTIES_SANDBOX_BRIDGE_HOST: '0.0.0.0',
    DEPUTIES_SANDBOX_BRIDGE_PORT: '3584',
    TZ: 'Etc/UTC',
  };
  if (args.variant !== 'bridge') {
    imageEnv.PATH = `/usr/lib/postgresql/${args.postgresVersion}/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`;
    imageEnv.PGDATA = '/workspace/.deputies/postgres';
  }
  if (args.revision) imageEnv.DEPUTIES_OPENCOMPUTER_SNAPSHOT_REVISION = args.revision;
  if (args.variant === 'full') imageEnv.PLAYWRIGHT_BROWSERS_PATH = '/ms-playwright';

  image = image
    .addLocalDir(resolve(bridgePackagePath, 'dist'), '/opt/deputies/sandbox-bridge/dist')
    .addLocalFile(resolve(bridgePackagePath, 'package.json'), '/opt/deputies/sandbox-bridge/package.json')
    .addLocalFile(bridgeStartupPath, '/opt/deputies/ensure-sandbox-bridge.sh')
    .runCommands('sudo chmod 0755 /opt/deputies/ensure-sandbox-bridge.sh');

  if (args.variant !== 'bridge') image = image.runCommands(createBridgePermissionsCommand());

  return image.env(imageEnv).workdir('/workspace');
}

function createRunCommands(args: Args): string[] {
  const commands = [...createFdCommands(), ...createNodeCommands(), ...createPostgresCommands(args.postgresVersion)];

  if (args.variant === 'full') commands.push(createCodeServerCommand(args.codeServerVersion));
  commands.push(createHunkdiffCommand(args.hunkdiffVersion), ...createMiseCommands());
  if (args.variant === 'full') commands.push(...createPlaywrightCommands(args.playwrightVersion));
  commands.push(createWorkspaceCommand(), createCleanupCommand(args.postgresVersion));

  return commands;
}

function createHostnameResolutionCommand(): string {
  return [
    'hostname="$(hostname)"',
    `sudo -n sh -c 'grep -qE "(^|[[:space:]])$1([[:space:]]|$)" /etc/hosts || printf "127.0.1.1 %s\\n" "$1" >> /etc/hosts' sh "$hostname" 2>/dev/null`,
  ].join(' && ');
}

function createCleanupCommand(postgresVersion: string): string {
  return [
    'set -eux',
    `(sudo pg_dropcluster --stop ${postgresVersion} main 2>/dev/null || true)`,
    'sudo apt-get clean',
    'sudo rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/* /root/.cache',
    'npm cache clean --force',
    'rm -rf "$HOME/.cache" "$HOME/.npm/_cacache"',
  ].join(' && ');
}

function createFdCommands(): string[] {
  return [
    'set -eux && sudo ln -sf "$(command -v fdfind)" /usr/local/bin/fd',
    'set -eux && sudo git lfs install --system',
  ];
}

function createNodeCommands(): string[] {
  return [
    'set -eux && curl -fsSL https://deb.nodesource.com/setup_24.x | sudo bash -',
    'set -eux && sudo apt-get install -y --no-install-recommends nodejs',
    'set -eux && sudo corepack enable',
  ];
}

function createPostgresCommands(version: string): string[] {
  const packageVersion = postgresVersion(version);
  return [
    'set -eux && sudo install -d -m 0755 /usr/share/postgresql-common/pgdg',
    'set -eux && curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc | sudo gpg --dearmor --yes -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.gpg',
    'set -eux && . /etc/os-release && printf "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.gpg] https://apt.postgresql.org/pub/repos/apt %s-pgdg main\\n" "$VERSION_CODENAME" | sudo tee /etc/apt/sources.list.d/pgdg.list >/dev/null',
    'set -eux && sudo apt-get update',
    `set -eux && sudo apt-get install -y --no-install-recommends postgresql-${packageVersion} postgresql-contrib-${packageVersion}`,
    'set -eux && sudo rm -rf /var/lib/apt/lists/*',
  ];
}

function createCodeServerCommand(version: string): string {
  return `set -eux && curl -fsSL https://code-server.dev/install.sh | sudo sh -s -- --version ${quoteShell(version)}`;
}

function createHunkdiffCommand(version: string): string {
  return `set -eux && sudo npm install -g ${quoteShell(`hunkdiff@${version}`)}`;
}

function createMiseCommands(): string[] {
  return [
    'set -eux && curl -fsSL https://mise.run | sh',
    'set -eux && sudo install -m 0755 "$HOME/.local/bin/mise" /usr/local/bin/mise',
  ];
}

function createPlaywrightCommands(version: string): string[] {
  return [
    `set -eux && sudo npm install -g ${quoteShell(`playwright@${version}`)}`,
    'set -eux && sudo env DEBUG=pw:install PLAYWRIGHT_SKIP_BROWSER_GC=1 playwright install-deps chromium',
    'set -eux && sudo mkdir -p /ms-playwright',
    'set -eux && sudo chmod 0777 /ms-playwright',
    'set -eux && PLAYWRIGHT_SKIP_BROWSER_GC=1 PLAYWRIGHT_BROWSERS_PATH=/ms-playwright playwright install chromium',
    'set -eux && sudo chmod -R a+rX /ms-playwright',
  ];
}

function createWorkspaceCommand(): string {
  return 'set -eux && sudo mkdir -p /workspace /workspace/.deputies && sudo chmod 0777 /workspace /workspace/.deputies';
}

function createBridgePermissionsCommand(): string {
  return 'set -eux && sudo chmod -R a+rX /opt/deputies && sudo chmod 0755 /opt/deputies /opt/deputies/sandbox-bridge /opt/deputies/sandbox-bridge/dist';
}

function redactedManifest(manifest: ImageManifest): ImageManifest {
  return {
    ...manifest,
    steps: manifest.steps.map((step) => {
      if (step.type === 'add_file') {
        return { ...step, args: { ...step.args, content: redactedContent(step.args.content) } };
      }
      if (step.type !== 'add_dir' || !Array.isArray(step.args.files)) return step;
      return {
        ...step,
        args: {
          ...step.args,
          files: step.args.files.map((file) => {
            if (!isManifestFile(file)) return file;
            return { ...file, content: redactedContent(file.content) };
          }),
        },
      };
    }),
  };
}

function isManifestFile(value: unknown): value is { relativePath: string; content: string } {
  return Boolean(
    value &&
    typeof value === 'object' &&
    'relativePath' in value &&
    typeof value.relativePath === 'string' &&
    'content' in value &&
    typeof value.content === 'string',
  );
}

function redactedContent(value: unknown): unknown {
  return typeof value === 'string' ? `<base64:${value.length} chars>` : value;
}

function parseArgs(values: string[], env: NodeJS.ProcessEnv): Args {
  let nameProvided = Boolean(env.OPENCOMPUTER_SNAPSHOT_NAME);
  const variant = snapshotVariant(env.OPENCOMPUTER_SNAPSHOT_VARIANT ?? 'full', 'OPENCOMPUTER_SNAPSHOT_VARIANT');
  const timestamp = snapshotTimestamp(new Date());
  const args: Args = {
    codeServerVersion: env.CODE_SERVER_VERSION ?? defaultCodeServerVersion,
    dryRun: false,
    help: false,
    hunkdiffVersion: env.HUNKDIFF_VERSION ?? defaultHunkdiffVersion,
    name: env.OPENCOMPUTER_SNAPSHOT_NAME ?? defaultSnapshotName(variant, timestamp),
    playwrightVersion: env.PLAYWRIGHT_VERSION ?? defaultPlaywrightVersion,
    postgresVersion: env.POSTGRES_VERSION ?? defaultPostgresVersion,
    timeoutPollSeconds: parseSeconds(
      env.OPENCOMPUTER_SNAPSHOT_TIMEOUT_POLL_SECONDS ?? String(defaultTimeoutPollSeconds),
      'OPENCOMPUTER_SNAPSHOT_TIMEOUT_POLL_SECONDS',
    ),
    variant,
  };
  if (env.OPENCOMPUTER_API_URL) args.apiUrl = env.OPENCOMPUTER_API_URL;
  if (env.OPENCOMPUTER_SNAPSHOT_REVISION) args.revision = env.OPENCOMPUTER_SNAPSHOT_REVISION;

  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === '--help' || value === '-h') {
      args.help = true;
    } else if (value === '--dry-run') {
      args.dryRun = true;
    } else if (value === '--name') {
      args.name = requiredValue(values, (index += 1), value);
      nameProvided = true;
    } else if (value === '--api-url') {
      args.apiUrl = requiredValue(values, (index += 1), value);
    } else if (value === '--variant') {
      args.variant = snapshotVariant(requiredValue(values, (index += 1), value), value);
      if (!nameProvided) args.name = defaultSnapshotName(args.variant, timestamp);
    } else if (value === '--code-server-version') {
      args.codeServerVersion = requiredValue(values, (index += 1), value);
    } else if (value === '--hunkdiff-version') {
      args.hunkdiffVersion = requiredValue(values, (index += 1), value);
    } else if (value === '--playwright-version') {
      args.playwrightVersion = requiredValue(values, (index += 1), value);
    } else if (value === '--postgres-version') {
      args.postgresVersion = requiredValue(values, (index += 1), value);
    } else if (value === '--revision') {
      args.revision = requiredValue(values, (index += 1), value);
    } else if (value === '--timeout-poll-seconds') {
      args.timeoutPollSeconds = parseSeconds(requiredValue(values, (index += 1), value), value);
    } else if (value) {
      throw new Error(`Unknown argument: ${value}`);
    }
  }

  if (args.variant === 'full') {
    args.codeServerVersion = packageVersion(args.codeServerVersion, '--code-server-version');
    args.playwrightVersion = packageVersion(args.playwrightVersion, '--playwright-version');
  }
  args.hunkdiffVersion = packageVersion(args.hunkdiffVersion, '--hunkdiff-version');
  args.postgresVersion = postgresVersion(args.postgresVersion);
  if (args.revision) args.revision = revision(args.revision);
  if (!args.name.trim()) throw new Error('--name must not be empty.');

  return args;
}

function defaultSnapshotName(variant: SnapshotVariant, timestamp: string): string {
  const base =
    variant === 'minimal'
      ? defaultMinimalSnapshotName
      : variant === 'bridge'
        ? defaultBridgeSnapshotName
        : variant === 'slim'
          ? defaultSlimSnapshotName
          : defaultFullSnapshotName;
  return `${base}-${timestamp}`;
}

function snapshotTimestamp(date: Date): string {
  return date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
}

function snapshotVariant(value: string, flag: string): SnapshotVariant {
  if (value === 'full' || value === 'slim' || value === 'bridge' || value === 'minimal') return value;
  throw new Error(`${flag} must be full, slim, bridge, or minimal, got ${value}.`);
}

function requiredValue(values: string[], index: number, flag: string): string {
  const value = values[index];
  if (!value) throw new Error(`${flag} requires a value.`);
  return value;
}

function packageVersion(value: string, flag: string): string {
  if (!/^[0-9]+(?:\.[0-9]+)*(?:[-+._A-Za-z0-9]*)?$/.test(value)) {
    throw new Error(`${flag} must be a plain package version, got ${value}.`);
  }
  return value;
}

function postgresVersion(value: string): string {
  if (!/^\d+$/.test(value)) throw new Error(`--postgres-version must be a major version number, got ${value}.`);
  return value;
}

function parseSeconds(value: string, flag: string): number {
  if (!/^\d+$/.test(value)) throw new Error(`${flag} must be a non-negative integer number of seconds, got ${value}.`);
  const seconds = Number(value);
  if (!Number.isSafeInteger(seconds)) {
    throw new Error(`${flag} must be a safe integer number of seconds, got ${value}.`);
  }
  return seconds;
}

function revision(value: string): string {
  if (!/^[._A-Za-z0-9-]+$/.test(value)) {
    throw new Error(`--revision must contain only letters, numbers, dots, underscores, or hyphens, got ${value}.`);
  }
  return value;
}

function quoteShell(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function printHelp(): void {
  console.log(`Usage: pnpm snapshot:create [options]

Creates an OpenComputer snapshot with Deputies sandbox tooling.

Options:
  --name <name>                 Snapshot name. Defaults to OPENCOMPUTER_SNAPSHOT_NAME,
                                or a timestamped variant default.
  --api-url <url>               OpenComputer API URL. Defaults to OPENCOMPUTER_API_URL.
  --variant <variant>           full includes Playwright and code-server.
                                slim skips both. bridge only adds the Deputies bridge.
                                minimal has zero image steps.
                                Defaults to OPENCOMPUTER_SNAPSHOT_VARIANT or full.
  --playwright-version <ver>    Playwright version. Default: ${defaultPlaywrightVersion}
  --postgres-version <major>    PostgreSQL major version. Default: ${defaultPostgresVersion}
  --code-server-version <ver>   code-server version. Default: ${defaultCodeServerVersion}
  --hunkdiff-version <ver>      hunkdiff version. Default: ${defaultHunkdiffVersion}
  --revision <value>            Optional manifest revision marker to force a new
                                OpenComputer image cache hash.
  --timeout-poll-seconds <sec>  Poll this long after an OpenComputer 524 timeout.
                                Default: ${defaultTimeoutPollSeconds}
  --dry-run                     Print the image manifest without creating a snapshot.
  --help                        Show this help.

Default timestamped name prefixes:
  full: ${defaultFullSnapshotName}
  slim: ${defaultSlimSnapshotName}
  bridge: ${defaultBridgeSnapshotName}
  minimal: ${defaultMinimalSnapshotName}

OPENCOMPUTER_API_KEY must be set unless --dry-run is used.`);
}
