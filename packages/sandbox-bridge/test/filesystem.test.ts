import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSandboxFilesystemOperation } from '../src/filesystem.js';

describe('runSandboxFilesystemOperation', () => {
  it('performs the filesystem operations used by SDK-backed providers', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'deputies-sandbox-filesystem-test-'));
    const file = join(directory, 'nested', 'note.txt');

    await runSandboxFilesystemOperation({ operation: 'mkdir', path: join(directory, 'nested'), recursive: true });
    await writeFile(file, 'hello');

    await expect(runSandboxFilesystemOperation({ operation: 'exists', path: file })).resolves.toEqual({ exists: true });
    await expect(
      runSandboxFilesystemOperation({ operation: 'readdir', path: join(directory, 'nested') }),
    ).resolves.toEqual({
      entries: ['note.txt'],
    });
    await expect(runSandboxFilesystemOperation({ operation: 'stat', path: file })).resolves.toMatchObject({
      isFile: true,
      isDirectory: false,
      size: 5,
    });

    await runSandboxFilesystemOperation({ operation: 'rm', path: file, force: true });
    await expect(readFile(file)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
