import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

const root = process.cwd();
const srcRoot = join(root, 'src');

describe('architecture boundaries', () => {
  it('keeps Flue SDK isolated to runner-flue', async () => {
    const files = await sourceFiles();
    const offenders: string[] = [];

    for (const file of files) {
      const text = await readFile(file, 'utf8');
      if (!text.includes('@flue')) continue;
      if (!relative(srcRoot, file).startsWith('runner-flue/')) offenders.push(relative(root, file));
    }

    expect(offenders).toEqual([]);
  });

  it('keeps Daytona SDK isolated to sandbox adapters', async () => {
    const files = await sourceFiles();
    const offenders: string[] = [];

    for (const file of files) {
      const text = await readFile(file, 'utf8');
      if (!text.includes('@daytona/sdk')) continue;
      if (!relative(srcRoot, file).startsWith('sandbox/')) offenders.push(relative(root, file));
    }

    expect(offenders).toEqual([]);
  });

  it('prevents integrations from importing runner implementations', async () => {
    const files = (await sourceFiles()).filter((file) => relative(srcRoot, file).startsWith('integrations/'));
    const offenders: string[] = [];

    for (const file of files) {
      const text = await readFile(file, 'utf8');
      if (text.includes('../runner') || text.includes('../../runner') || text.includes('runner-flue')) {
        offenders.push(relative(root, file));
      }
    }

    expect(offenders).toEqual([]);
  });

  it('prevents store implementations from importing domain services', async () => {
    const files = (await sourceFiles()).filter((file) => relative(srcRoot, file).startsWith('store/'));
    const forbidden = ['sessions/service', 'messages/service', 'events/service', 'worker/service', 'integrations/'];
    const offenders: string[] = [];

    for (const file of files) {
      const text = await readFile(file, 'utf8');
      if (forbidden.some((entry) => text.includes(entry))) offenders.push(relative(root, file));
    }

    expect(offenders).toEqual([]);
  });

  it('keeps callback core independent from concrete integrations', async () => {
    const files = (await sourceFiles()).filter((file) => relative(srcRoot, file).startsWith('callbacks/'));
    const offenders: string[] = [];

    for (const file of files) {
      const text = await readFile(file, 'utf8');
      if (text.includes('../integrations/') || text.includes('../../integrations/')) offenders.push(relative(root, file));
    }

    expect(offenders).toEqual([]);
  });
});

async function sourceFiles(dir = srcRoot): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map((entry) => {
      const path = join(dir, entry.name);
      return entry.isDirectory() ? sourceFiles(path) : path.endsWith('.ts') ? [path] : [];
    }),
  );

  return files.flat();
}
