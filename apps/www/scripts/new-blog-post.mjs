import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const siteRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const blogRoot = join(siteRoot, 'src/content/blog');

const options = parseArgs(process.argv.slice(2));

if (options.help) {
  printUsage();
  process.exit(0);
}

const timestamp = getTimestampParts();
const pubDate = parseDate(options.date ?? `${timestamp.year}-${timestamp.month}-${timestamp.day}`);
const title = `Draft post ${timestamp.title}`;
const slug = options.slug ?? `draft-post-${timestamp.slug}`;

const existingPost = findPostBySlug(slug);
if (existingPost) {
  throw new Error(`A blog post with slug "${slug}" already exists at ${existingPost}.`);
}

const [year, month] = pubDate.split('-');
const postDir = join(blogRoot, year, month, slug);
const postPath = join(postDir, 'index.mdx');
const assetsDir = join(postDir, 'assets');

const frontmatter = `---
title: ${toYamlString(title)}
description: ${toYamlString(options.description ?? 'TODO: Add a post description.')}
pubDate: ${pubDate}
author: ${toYamlString(options.author ?? 'Sid Palas')}
draft: true
---

Start writing here.
`;

if (options.dryRun) {
  console.log(`Would create ${relativeToSite(postPath)}`);
  console.log(`Would create ${relativeToSite(assetsDir)}/ for post-scoped assets`);
  process.exit(0);
}

mkdirSync(assetsDir, { recursive: true });
writeFileSync(postPath, frontmatter, { flag: 'wx' });

console.log(`Created ${relativeToSite(postPath)}`);
console.log(`Created ${relativeToSite(assetsDir)}/ for post-scoped assets`);

function parseArgs(args) {
  const parsed = {};

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === '--help' || arg === '-h') {
      parsed.help = true;
      continue;
    }

    if (arg === '--dry-run') {
      parsed.dryRun = true;
      continue;
    }

    if (arg.startsWith('--')) {
      const [name, inlineValue] = arg.slice(2).split('=', 2);
      const value = inlineValue ?? args[++index];

      if (!['slug', 'date', 'description', 'author'].includes(name)) {
        throw new Error(`Unknown option --${name}.`);
      }

      if (!value) {
        throw new Error(`Missing value for --${name}.`);
      }

      parsed[name] = value;
      continue;
    }

    throw new Error('This task generates a timestamped placeholder title automatically and does not accept a title.');
  }

  return parsed;
}

function printUsage() {
  console.log(`Usage: mise run //apps/www:blog:new -- [options]

Creates:
  src/content/blog/yyyy/mm/draft-post-yyyymmdd-hhmmss/index.mdx
  src/content/blog/yyyy/mm/draft-post-yyyymmdd-hhmmss/assets/

Options:
  --date YYYY-MM-DD       Publication date used for src/content/blog/yyyy/mm/ (default: today)
  --slug post-slug        URL/file slug (default: timestamped draft slug)
  --description text      Initial post description
  --author name           Author frontmatter (default: Sid Palas)
  --dry-run               Show paths without writing files

Example:
  mise run //apps/www:blog:new
  mise run //apps/www:blog:new -- --date 2026-05-28 --description "Short summary."`);
}

function getTimestampParts() {
  const now = new Date();
  const year = String(now.getFullYear());
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const hour = String(now.getHours()).padStart(2, '0');
  const minute = String(now.getMinutes()).padStart(2, '0');
  const second = String(now.getSeconds()).padStart(2, '0');

  return {
    year,
    month,
    day,
    slug: `${year}${month}${day}-${hour}${minute}${second}`,
    title: `${year}-${month}-${day} ${hour}:${minute}:${second}`,
  };
}

function parseDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`Invalid date "${value}". Use YYYY-MM-DD.`);
  }

  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));

  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new Error(`Invalid date "${value}".`);
  }

  return value;
}

function findPostBySlug(slug) {
  for (const filePath of listPostFiles(blogRoot)) {
    if (getPostFileSlug(filePath) === slug) return relativeToSite(filePath);
  }

  return undefined;
}

function listPostFiles(directory) {
  if (!existsSync(directory)) return [];

  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const filePath = join(directory, entry.name);

    if (entry.isDirectory()) return listPostFiles(filePath);
    if (entry.isFile() && /\.mdx?$/.test(entry.name)) return [filePath];
    return [];
  });
}

function getPostFileSlug(filePath) {
  const relativePath = relative(blogRoot, filePath);
  const extension = extname(relativePath);
  const withoutExtension = relativePath.slice(0, -extension.length);
  const segments = withoutExtension.split(/[\\/]+/);
  const lastSegment = segments.at(-1) ?? basename(withoutExtension);

  if (lastSegment === 'index' && segments.length > 1) {
    return segments.at(-2) ?? lastSegment;
  }

  return lastSegment;
}

function toYamlString(value) {
  return JSON.stringify(value);
}

function relativeToSite(filePath) {
  return filePath.replace(`${siteRoot}/`, '');
}
