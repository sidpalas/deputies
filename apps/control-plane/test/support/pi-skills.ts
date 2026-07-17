import path from 'node:path';
import type { ManagedSkillCandidate } from '../../src/runner-pi/skills.js';
import type { RunnerInput } from '../../src/runner/types.js';
import type { FileStat, SandboxFileSystem, SandboxHandle } from '../../src/sandbox/types.js';

export function managedSkill(
  name: string,
  description: string,
  body: string,
  source: ManagedSkillCandidate['source'],
  autoLoad = true,
  createdAt = '2026-01-15T00:00:00Z',
): ManagedSkillCandidate {
  const created = new Date(createdAt);
  return {
    id: `skill-${source}-${name}-${created.getTime()}`,
    revisionId: `revision-${source}-${name}-${created.getTime()}`,
    revisionNumber: 1,
    name,
    description,
    body,
    source,
    autoLoad,
    createdAt: created,
  };
}

export function skillDocument(name: string, description: string, disableModelInvocation = false): string {
  return `---\nname: ${name}\ndescription: ${description}\n${disableModelInvocation ? 'disable-model-invocation: true\n' : ''}---\nbody`;
}

export function runnerInput(overrides: Partial<RunnerInput> = {}): RunnerInput {
  return {
    sessionId: 'session-1',
    runId: 'run-1',
    messageId: 'message-1',
    ownerGroupId: 'group-1',
    prompt: 'request',
    context: {},
    sandbox: sandboxHandle(new MemorySandboxFileSystem('/workspace')),
    emit: async () => {},
    ...overrides,
  };
}

export function sandboxHandle(
  fs?: SandboxFileSystem,
  exec: SandboxHandle['exec'] | undefined = undefined,
  workspacePath = '/workspace',
): SandboxHandle {
  return {
    provider: 'test',
    providerSandboxId: 'sandbox-1',
    sessionId: 'session-1',
    workspacePath,
    metadata: {},
    capabilities: {
      persistentFilesystem: true,
      snapshots: false,
      stopStart: false,
      exec: true,
      filesystem: Boolean(fs),
      streamingLogs: false,
      portForwarding: false,
      serviceEndpoints: false,
      objectStorageArtifacts: false,
    },
    ...(fs ? { fs } : {}),
    exec: exec ?? (async () => execResult(1, '', 'unsupported')),
  };
}

export function execResult(exitCode: number, stdout = '', stderr = '') {
  const now = new Date();
  return { exitCode, stdout, stderr, startedAt: now, completedAt: now };
}

export class MemorySandboxFileSystem implements SandboxFileSystem {
  private readonly files = new Map<string, Uint8Array>();
  private readonly directories = new Set<string>();
  private readonly symlinks = new Set<string>();

  constructor(root: string) {
    this.addDirectory(root);
  }

  markSymlink(filePath: string): void {
    const normalized = this.normalize(filePath);
    this.addDirectory(path.posix.dirname(normalized));
    this.symlinks.add(normalized);
  }

  async readFile(filePath: string): Promise<string> {
    return Buffer.from(await this.readFileBuffer(filePath)).toString('utf8');
  }

  async readFileBuffer(filePath: string): Promise<Uint8Array> {
    const content = this.files.get(this.normalize(filePath));
    if (!content) throw new Error(`File not found: ${filePath}`);
    return content;
  }

  async writeFile(filePath: string, content: string | Uint8Array): Promise<void> {
    const normalized = this.normalize(filePath);
    this.addDirectory(path.posix.dirname(normalized));
    this.files.set(normalized, typeof content === 'string' ? Buffer.from(content) : content);
  }

  async stat(filePath: string): Promise<FileStat> {
    const normalized = this.normalize(filePath);
    if (this.symlinks.has(normalized)) {
      return { isFile: false, isDirectory: false, isSymbolicLink: true, size: 0, mtime: new Date() };
    }
    const content = this.files.get(normalized);
    if (content) {
      return { isFile: true, isDirectory: false, isSymbolicLink: false, size: content.byteLength, mtime: new Date() };
    }
    if (this.directories.has(normalized)) {
      return { isFile: false, isDirectory: true, isSymbolicLink: false, size: 0, mtime: new Date() };
    }
    throw new Error(`Path not found: ${filePath}`);
  }

  async readdir(dirPath: string): Promise<string[]> {
    const normalized = this.normalize(dirPath);
    const prefix = `${normalized.replace(/\/$/, '')}/`;
    const descendants = [...this.files.keys(), ...this.directories, ...this.symlinks];
    return [
      ...new Set(
        descendants
          .filter((entry) => entry.startsWith(prefix))
          .map((entry) => entry.slice(prefix.length).split('/')[0])
          .filter((entry): entry is string => Boolean(entry)),
      ),
    ];
  }

  async exists(filePath: string): Promise<boolean> {
    const normalized = this.normalize(filePath);
    return this.files.has(normalized) || this.directories.has(normalized) || this.symlinks.has(normalized);
  }

  async mkdir(dirPath: string): Promise<void> {
    this.addDirectory(dirPath);
  }

  async rm(filePath: string): Promise<void> {
    const normalized = this.normalize(filePath);
    const prefix = `${normalized}/`;
    for (const file of this.files.keys()) if (file === normalized || file.startsWith(prefix)) this.files.delete(file);
    for (const directory of this.directories) {
      if (directory === normalized || directory.startsWith(prefix)) this.directories.delete(directory);
    }
    for (const symlink of this.symlinks) {
      if (symlink === normalized || symlink.startsWith(prefix)) this.symlinks.delete(symlink);
    }
  }

  private addDirectory(dirPath: string): void {
    let current = this.normalize(dirPath);
    while (!this.directories.has(current)) {
      this.directories.add(current);
      const parent = path.posix.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }

  private normalize(filePath: string): string {
    return path.posix.resolve('/', filePath);
  }
}
