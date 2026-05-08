import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';

const root = process.cwd();
const srcRoot = join(root, 'src');

describe('architecture boundaries', () => {
  it('keeps provider SDKs isolated to provider adapters', async () => {
    const files = await sourceFiles();
    const offenders: string[] = [];

    const rules = [
      { sdk: '@flue/sdk', allowed: (path: string) => path.startsWith('runner-flue/') },
      { sdk: '@daytona/sdk', allowed: (path: string) => path === 'sandbox/daytona.ts' },
    ];

    for (const file of files) {
      const text = await readFile(file, 'utf8');

      for (const rule of rules) {
        if (!importSpecifiers(text).some((specifier) => specifier === rule.sdk || specifier.startsWith(`${rule.sdk}/`))) continue;
        if (!rule.allowed(relative(srcRoot, file))) offenders.push(relative(root, file));
      }
    }

    expect(offenders).toEqual([]);
  });

  it('prevents integrations from importing runner implementations', async () => {
    const files = (await sourceFiles()).filter((file) => relative(srcRoot, file).startsWith('integrations/'));
    const offenders: string[] = [];

    for (const file of files) {
      const text = await readFile(file, 'utf8');
      if (internalImports(file, text).some((path) => path.startsWith('runner/') || path.startsWith('runner-flue/'))) {
        offenders.push(relative(root, file));
      }
    }

    expect(offenders).toEqual([]);
  });

  it('allows only index.ts to compose api/app with runner-flue', async () => {
    const files = (await sourceFiles()).filter((file) => relative(srcRoot, file).startsWith('app/'));
    const offenders: string[] = [];

    for (const file of files) {
      const text = await readFile(file, 'utf8');
      if (internalImports(file, text).some((path) => path.startsWith('runner-flue/'))) offenders.push(relative(root, file));
    }

    expect(offenders).toEqual([]);
  });

  it('documents index.ts as the composition root for concrete wiring', async () => {
    const text = await readFile(join(srcRoot, 'index.ts'), 'utf8');
    const imports = internalImports(join(srcRoot, 'index.ts'), text);

    expect(imports.some((path) => path.startsWith('store/'))).toBe(true);
    expect(imports.some((path) => path.startsWith('runner-flue/'))).toBe(true);
    expect(imports.some((path) => path.startsWith('sandbox/'))).toBe(true);
    expect(imports.some((path) => path.startsWith('integrations/'))).toBe(true);
  });

  it('prevents sessions and messages from importing integrations', async () => {
    const files = (await sourceFiles()).filter((file) => {
      const path = relative(srcRoot, file);
      return path.startsWith('sessions/') || path.startsWith('messages/');
    });
    const offenders: string[] = [];

    for (const file of files) {
      const text = await readFile(file, 'utf8');
      if (internalImports(file, text).some((path) => path.startsWith('integrations/'))) offenders.push(relative(root, file));
    }

    expect(offenders).toEqual([]);
  });

  it('prevents runner-flue from importing api/app or integrations', async () => {
    const files = (await sourceFiles()).filter((file) => relative(srcRoot, file).startsWith('runner-flue/'));
    const offenders: string[] = [];

    for (const file of files) {
      const text = await readFile(file, 'utf8');
      if (internalImports(file, text).some((path) => path.startsWith('app/') || path.startsWith('integrations/'))) offenders.push(relative(root, file));
    }

    expect(offenders).toEqual([]);
  });

  it('prevents store implementations from importing domain services', async () => {
    const files = (await sourceFiles()).filter((file) => relative(srcRoot, file).startsWith('store/'));
    const offenders: string[] = [];

    for (const file of files) {
      const text = await readFile(file, 'utf8');
      if (internalImports(file, text).some((path) => path.endsWith('/service') || path.includes('/service/'))) offenders.push(relative(root, file));
    }

    expect(offenders).toEqual([]);
  });

  it('keeps callback core independent from concrete integrations', async () => {
    const files = (await sourceFiles()).filter((file) => relative(srcRoot, file).startsWith('callbacks/'));
    const offenders: string[] = [];

    for (const file of files) {
      const text = await readFile(file, 'utf8');
      if (internalImports(file, text).some((path) => path.startsWith('integrations/'))) offenders.push(relative(root, file));
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

function importSpecifiers(text: string): string[] {
  const imports = text.matchAll(/\bimport(?:\s+type)?(?:[\s\S]*?\sfrom\s*)?['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]\s*\)/g);
  return [...imports].map((match) => match[1] ?? match[2]).filter((specifier): specifier is string => Boolean(specifier));
}

function internalImports(file: string, text: string): string[] {
  return importSpecifiers(text)
    .filter((specifier) => specifier.startsWith('.'))
    .map((specifier) => normalizeInternalImport(relative(srcRoot, file), specifier));
}

function normalizeInternalImport(file: string, specifier: string): string {
  return join(dirname(file), specifier.replace(/\.(js|ts)$/, '')).replace(/\\/g, '/');
}
