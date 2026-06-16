import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { publicApiResponseEnvelopeFields, publicApiResponseSchemas } from '../../src/app/response-schemas.js';

const root = process.cwd();
const srcRoot = join(root, 'src');

describe('architecture boundaries', () => {
  it('keeps provider SDKs isolated to provider adapters', async () => {
    const files = await sourceFiles();
    const offenders: string[] = [];

    const rules = [
      { sdk: '@flue/runtime', allowed: (path: string) => path.startsWith('runner-flue/') },
      { sdk: '@daytona/sdk', allowed: (path: string) => path === 'sandbox/daytona.ts' },
    ];

    for (const file of files) {
      const text = await readFile(file, 'utf8');

      for (const rule of rules) {
        if (!importSpecifiers(text).some((specifier) => specifier === rule.sdk || specifier.startsWith(`${rule.sdk}/`)))
          continue;
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
      if (internalImports(file, text).some((path) => path.startsWith('runner-flue/')))
        offenders.push(relative(root, file));
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
      if (internalImports(file, text).some((path) => path.startsWith('integrations/')))
        offenders.push(relative(root, file));
    }

    expect(offenders).toEqual([]);
  });

  it('prevents runner-flue from importing api/app or integrations', async () => {
    const files = (await sourceFiles()).filter((file) => relative(srcRoot, file).startsWith('runner-flue/'));
    const offenders: string[] = [];

    for (const file of files) {
      const text = await readFile(file, 'utf8');
      if (internalImports(file, text).some((path) => path.startsWith('app/') || path.startsWith('integrations/')))
        offenders.push(relative(root, file));
    }

    expect(offenders).toEqual([]);
  });

  it('prevents store implementations from importing domain services', async () => {
    const files = (await sourceFiles()).filter((file) => relative(srcRoot, file).startsWith('store/'));
    const offenders: string[] = [];

    for (const file of files) {
      const text = await readFile(file, 'utf8');
      if (internalImports(file, text).some((path) => path.endsWith('/service') || path.includes('/service/')))
        offenders.push(relative(root, file));
    }

    expect(offenders).toEqual([]);
  });

  it('keeps callback core independent from concrete integrations', async () => {
    const files = (await sourceFiles()).filter((file) => relative(srcRoot, file).startsWith('callbacks/'));
    const offenders: string[] = [];

    for (const file of files) {
      const text = await readFile(file, 'utf8');
      if (internalImports(file, text).some((path) => path.startsWith('integrations/')))
        offenders.push(relative(root, file));
    }

    expect(offenders).toEqual([]);
  });

  it('installs CLIs required by authenticated repository tools in the runtime image', async () => {
    const text = await readFile(join(root, 'Dockerfile'), 'utf8');

    expect(text).toMatch(/(?:apk add --no-cache[^\n]*\bdocker-cli\b|apt-get install[^\n]*\bdocker\.io\b)/);
    expect(text).toMatch(/(?:apk add --no-cache[^\n]*\bgithub-cli\b|apt-get install[^\n]*\bgh\b)/);
  });

  it('declares source-owned schemas for public API response envelopes', async () => {
    const text = await readFile(join(srcRoot, 'app/server.ts'), 'utf8');
    const missingFields = [...jsonResponseEnvelopeFields(text)]
      .filter((field) => !publicApiResponseEnvelopeFields.has(field))
      .sort();

    expect(missingFields).toEqual([]);
    expect(Object.keys(publicApiResponseSchemas)).toEqual(
      expect.arrayContaining([
        'artifacts',
        'callback',
        'callbacks',
        'error',
        'events',
        'genericWebhook',
        'globalEvents',
        'health',
        'message',
        'messages',
        'session',
        'sessions',
      ]),
    );
    expect(publicApiResponseSchemas.genericWebhook.fields.session).toBe('optional:object');
    expect(publicApiResponseSchemas.genericWebhook.fields.message).toBe('optional:object');
  });
});

async function sourceFiles(dir = srcRoot): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const path = join(dir, entry.name);
      return entry.isDirectory() ? sourceFiles(path) : path.endsWith('.ts') ? [path] : [];
    }),
  );

  return files.flat();
}

function importSpecifiers(text: string): string[] {
  const imports = text.matchAll(
    /\bimport(?:\s+type)?(?:[\s\S]*?\sfrom\s*)?['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
  );
  return [...imports]
    .map((match) => match[1] ?? match[2])
    .filter((specifier): specifier is string => Boolean(specifier));
}

function internalImports(file: string, text: string): string[] {
  return importSpecifiers(text)
    .filter((specifier) => specifier.startsWith('.'))
    .map((specifier) => normalizeInternalImport(relative(srcRoot, file), specifier));
}

function normalizeInternalImport(file: string, specifier: string): string {
  return join(dirname(file), specifier.replace(/\.(js|ts)$/, '')).replace(/\\/g, '/');
}

function jsonResponseEnvelopeFields(text: string): Set<string> {
  const fields = new Set<string>();
  for (const match of text.matchAll(/c\.json\(\s*\{/g)) {
    const objectStart = match.index + match[0].length - 1;
    const objectEnd = matchingBraceIndex(text, objectStart);
    if (objectEnd === -1) continue;
    for (const field of topLevelObjectFields(text.slice(objectStart + 1, objectEnd))) fields.add(field);
  }
  return fields;
}

function matchingBraceIndex(text: string, openIndex: number): number {
  let depth = 0;
  let quote: string | null = null;

  for (let index = openIndex; index < text.length; index += 1) {
    const char = text[index]!;
    const previous = text[index - 1];
    if (quote) {
      if (char === quote && previous !== '\\') quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }

  return -1;
}

function topLevelObjectFields(body: string): string[] {
  const fields: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let fieldStart = 0;

  for (let index = 0; index <= body.length; index += 1) {
    const char = body[index] ?? ',';
    const previous = body[index - 1];
    if (quote) {
      if (char === quote && previous !== '\\') quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }
    if (char === '{' || char === '[' || char === '(') depth += 1;
    if (char === '}' || char === ']' || char === ')') depth -= 1;
    if (char !== ',' || depth !== 0) continue;

    const field = body.slice(fieldStart, index).match(/^\s*([A-Za-z_$][\w$]*)\s*(?::|$)/)?.[1];
    if (field) fields.push(field);
    fieldStart = index + 1;
  }

  return fields;
}
