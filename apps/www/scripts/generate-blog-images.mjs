import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import sharp from 'sharp';

const width = 1500;
const height = 600;
const scriptDir = dirname(fileURLToPath(import.meta.url));
const siteRoot = resolve(scriptDir, '..');
const outputDir = resolve(siteRoot, 'generated/blog-images');
const assetCacheDir = resolve(siteRoot, 'generated/blog-image-assets');

const logoSources = {
  docker: {
    url: 'https://icon.icepanel.io/Technology/svg/Docker.svg',
    fileName: 'docker.svg',
    mimeType: 'image/svg+xml',
  },
  kubernetes: {
    url: 'https://raw.githubusercontent.com/kubernetes/kubernetes/master/logo/logo.svg',
    fileName: 'kubernetes-logo.svg',
    mimeType: 'image/svg+xml',
  },
};

let imageAssets = {};

const blogImages = [
  {
    slug: 'what-is-deployability',
    name: 'Background agents deployability blog header',
    outputBase: 'what-is-deployability-header',
    eyebrow: 'Agent infrastructure',
    titleLines: ['Background agents', 'need to run where', 'the work lives'],
    ledeLines: [
      'Place the control plane close to code, CI, logs, and production systems without changing your infrastructure model.',
    ],
    pills: ['Containers', 'Postgres', 'Sandboxes'],
    environments: [
      {
        title: 'Hosted containers',
        subtitle: 'Managed database, fast start',
        label: 'Simple hosted path',
        icon: 'server',
        x: 820,
        y: 42,
        width: 320,
        height: 150,
      },
      {
        title: 'Docker server',
        subtitle: 'One machine, standard tooling',
        label: 'Small-team control',
        icon: 'docker',
        x: 650,
        y: 410,
        width: 320,
        height: 150,
      },
      {
        title: 'Kubernetes / VPC',
        subtitle: 'Inside IAM and network boundaries',
        label: 'Enterprise placement',
        icon: 'kubernetes',
        x: 1020,
        y: 410,
        width: 320,
        height: 150,
      },
    ],
  },
];

const controlPlaneBox = { x: 820, y: 226, width: 330, height: 160 };

const options = parseArgs(process.argv.slice(2));

if (options.help) {
  printUsage();
  process.exit(0);
}

if (options.list) {
  for (const image of blogImages) console.log(`${image.slug}\t${image.name}`);
  process.exit(0);
}

const selectedImages = options.only ? blogImages.filter((image) => image.slug === options.only) : blogImages;

if (options.only && selectedImages.length === 0) {
  throw new Error(`No blog image definition found for "${options.only}".`);
}

mkdirSync(outputDir, { recursive: true });
imageAssets = await loadImageAssets();

for (const image of selectedImages) {
  const svg = renderBlogHeaderImage(image);
  const svgPath = resolve(outputDir, `${image.outputBase}.svg`);
  const pngPath = resolve(outputDir, `${image.outputBase}.png`);

  writeFileSync(svgPath, svg);
  await sharp(Buffer.from(svg), { density: 192 }).resize(width, height).png().toFile(pngPath);

  console.log(`Generated ${image.name}:`);
  console.log(`  ${relative(siteRoot, svgPath)}`);
  console.log(`  ${relative(siteRoot, pngPath)}`);
}

function renderBlogHeaderImage(image) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(image.name)}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#020617" />
      <stop offset="0.54" stop-color="#0f172a" />
      <stop offset="1" stop-color="#172554" />
    </linearGradient>
    <radialGradient id="glow-left" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="translate(190 90) rotate(45) scale(430)">
      <stop stop-color="#60a5fa" stop-opacity="0.42" />
      <stop offset="1" stop-color="#60a5fa" stop-opacity="0" />
    </radialGradient>
    <radialGradient id="glow-right" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="translate(1160 470) rotate(35) scale(500)">
      <stop stop-color="#2563eb" stop-opacity="0.34" />
      <stop offset="1" stop-color="#2563eb" stop-opacity="0" />
    </radialGradient>
    <pattern id="grid" width="48" height="48" patternUnits="userSpaceOnUse">
      <path d="M 48 0 L 0 0 0 48" fill="none" stroke="#94a3b8" stroke-width="1" stroke-opacity="0.09" />
    </pattern>
    <filter id="shadow" x="-25%" y="-35%" width="150%" height="180%">
      <feDropShadow dx="0" dy="26" stdDeviation="24" flood-color="#000000" flood-opacity="0.34" />
    </filter>
    <filter id="soft-shadow" x="-20%" y="-30%" width="140%" height="170%">
      <feDropShadow dx="0" dy="18" stdDeviation="16" flood-color="#020617" flood-opacity="0.28" />
    </filter>
    <marker id="arrow" markerWidth="10" markerHeight="10" refX="7" refY="3" orient="auto" markerUnits="strokeWidth">
      <path d="M0,0 L0,6 L8,3 z" fill="#60a5fa" fill-opacity="0.72" />
    </marker>
    <style>
      .text { font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      .brand { fill: #dbeafe; font-size: 28px; font-weight: 760; letter-spacing: -0.02em; }
      .eyebrow { fill: #93c5fd; font-size: 22px; font-weight: 780; letter-spacing: 0.09em; text-transform: uppercase; }
      .title { fill: #f8fafc; font-size: 55px; font-weight: 850; letter-spacing: -0.034em; }
      .lede { fill: #cbd5e1; font-size: 24px; font-weight: 560; letter-spacing: -0.022em; }
      .pill { fill: #bfdbfe; font-size: 16px; font-weight: 760; }
      .node-title { fill: #f8fafc; font-size: 21px; font-weight: 820; letter-spacing: -0.025em; }
      .node-subtitle { fill: #cbd5e1; font-size: 15px; font-weight: 620; }
      .node-label { fill: #93c5fd; font-size: 12px; font-weight: 820; letter-spacing: 0.08em; text-transform: uppercase; }
      .chip { fill: #dbeafe; font-size: 13px; font-weight: 760; }
      .caption { fill: #94a3b8; font-size: 13px; font-weight: 700; letter-spacing: 0.03em; text-transform: uppercase; }
    </style>
  </defs>
  <rect width="${width}" height="${height}" fill="url(#bg)" />
  <rect width="${width}" height="${height}" fill="url(#glow-left)" />
  <rect width="${width}" height="${height}" fill="url(#glow-right)" />
  <rect width="${width}" height="${height}" fill="url(#grid)" opacity="0.9" />
  <path d="M520 92 C670 52 810 86 922 142" fill="none" stroke="#60a5fa" stroke-opacity="0.11" stroke-width="1.5" />
  <path d="M520 548 C710 520 846 570 1040 520" fill="none" stroke="#60a5fa" stroke-opacity="0.1" stroke-width="1.5" />

  ${renderBrand()}
  ${renderCopy(image)}
  ${renderDeployabilityMap(image)}
</svg>`;
}

function renderBrand() {
  return `<g class="text" transform="translate(72 64)">
    <rect width="52" height="52" rx="14" fill="#3b82f6" stroke="#bfdbfe" stroke-opacity="0.38" />
    <text x="26" y="35" text-anchor="middle" fill="#ffffff" font-size="25" font-weight="830">D</text>
    <text class="brand" x="66" y="35">Deputies</text>
  </g>`;
}

function renderCopy(image) {
  const title = renderTextLines(image.titleLines, 72, 224, 'title', 58);
  const lede = renderWrappedLines(image.ledeLines, 72, 404, 'lede', 31);
  const pills = renderPills(image.pills, 72, 500);

  return `<g class="text">
    <text class="eyebrow" x="72" y="164">${escapeHtml(image.eyebrow.toUpperCase())}</text>
    ${title}
    ${lede}
    ${pills}
  </g>`;
}

function renderDeployabilityMap(image) {
  const connectors = image.environments.map((target) => renderConnector(controlPlaneBox, target)).join('\n');
  const nodes = image.environments.map(renderEnvironmentNode).join('\n');

  return `<g>
    ${connectors}
    ${nodes}
    ${renderControlPlane()}
  </g>`;
}

function renderConnector(sourceBox, targetBox) {
  const sourceCenter = getBoxCenter(sourceBox);
  const targetCenter = getBoxCenter(targetBox);
  const start = getBoxEdgePoint(sourceBox, targetCenter);
  const end = getBoxEdgePoint(targetBox, sourceCenter);

  return `<path d="M${formatSvgNumber(start.x)} ${formatSvgNumber(start.y)} L${formatSvgNumber(end.x)} ${formatSvgNumber(end.y)}" fill="none" stroke="#60a5fa" stroke-width="2" stroke-opacity="0.48" marker-end="url(#arrow)" />`;
}

function getBoxCenter(box) {
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

function getBoxEdgePoint(box, toward) {
  const center = getBoxCenter(box);
  const dx = toward.x - center.x;
  const dy = toward.y - center.y;

  if (dx === 0 && dy === 0) return center;

  const scaleX = dx === 0 ? Infinity : box.width / 2 / Math.abs(dx);
  const scaleY = dy === 0 ? Infinity : box.height / 2 / Math.abs(dy);
  const scale = Math.min(scaleX, scaleY);

  return { x: center.x + dx * scale, y: center.y + dy * scale };
}

function formatSvgNumber(value) {
  return Number(value.toFixed(1)).toString();
}

function renderControlPlane() {
  const chips = [
    { label: 'API + worker', x: 900, y: 312, width: 102 },
    { label: 'OCI image', x: 1014, y: 312, width: 88 },
    { label: 'Agent runs', x: 900, y: 342, width: 90 },
    { label: 'Artifacts', x: 1002, y: 342, width: 78 },
  ];

  return `<g filter="url(#shadow)">
    <rect x="820" y="226" width="330" height="160" rx="22" fill="#020617" stroke="#60a5fa" stroke-opacity="0.5" />
    <rect x="820" y="226" width="330" height="44" rx="22" fill="#0f172a" stroke="#60a5fa" stroke-opacity="0.13" />
    <circle cx="847" cy="248" r="6" fill="#fb7185" />
    <circle cx="869" cy="248" r="6" fill="#facc15" />
    <circle cx="891" cy="248" r="6" fill="#4ade80" />
    <rect x="849" y="288" width="38" height="38" rx="10" fill="#2563eb" stroke="#bfdbfe" stroke-opacity="0.34" />
    <text class="text" x="868" y="313" text-anchor="middle" fill="#ffffff" font-size="18" font-weight="830">D</text>
    <text class="text node-title" x="900" y="303">Deputies</text>
    ${chips.map(renderChip).join('\n')}
  </g>`;
}

function renderEnvironmentNode(node) {
  const icon = renderEnvironmentIcon(node.icon, node.x + 25, node.y + 40);
  const subtitleLines = wrapLine(node.subtitle, Math.max(22, Math.floor((node.width - 95) / 8.5)));

  return `<g filter="url(#soft-shadow)">
    <rect x="${node.x}" y="${node.y}" width="${node.width}" height="${node.height}" rx="24" fill="#020617" fill-opacity="0.58" stroke="#93c5fd" stroke-opacity="0.38" stroke-dasharray="8 10" />
    <rect x="${node.x + 14}" y="${node.y + 14}" width="${node.width - 28}" height="${node.height - 28}" rx="18" fill="#0f172a" stroke="#60a5fa" stroke-opacity="0.28" />
    ${icon}
    <text class="text node-label" x="${node.x + 78}" y="${node.y + 45}">${escapeHtml(node.label)}</text>
    <text class="text node-title" x="${node.x + 78}" y="${node.y + 74}">${escapeHtml(node.title)}</text>
    ${subtitleLines
      .map(
        (line, index) =>
          `<text class="text node-subtitle" x="${node.x + 78}" y="${node.y + 99 + index * 20}">${escapeHtml(line)}</text>`,
      )
      .join('\n')}
  </g>`;
}

function renderEnvironmentIcon(icon, x, y) {
  if (icon === 'server') {
    return `<g transform="translate(${x} ${y})">
      <rect x="0" y="0" width="42" height="30" rx="7" fill="#1d4ed8" stroke="#93c5fd" stroke-opacity="0.5" />
      <rect x="7" y="8" width="18" height="4" rx="2" fill="#dbeafe" opacity="0.88" />
      <circle cx="33" cy="10" r="3" fill="#4ade80" />
      <rect x="0" y="37" width="42" height="30" rx="7" fill="#0f3a8f" stroke="#93c5fd" stroke-opacity="0.42" />
      <rect x="7" y="45" width="18" height="4" rx="2" fill="#dbeafe" opacity="0.76" />
      <circle cx="33" cy="47" r="3" fill="#60a5fa" />
    </g>`;
  }

  if (icon === 'docker') {
    if (imageAssets.docker) return renderLogoImage(imageAssets.docker, x - 12, y + 8, 64 * 1.1, 40 * 1.1);

    const blocks = [
      [20, 8],
      [38, 8],
      [2, 26],
      [20, 26],
      [38, 26],
      [56, 26],
    ];

    return `<g transform="translate(${x - 4} ${y + 13}) scale(0.65)">
      ${blocks.map(([blockX, blockY]) => `<rect x="${blockX}" y="${blockY}" width="15" height="15" rx="2" fill="#2496ed" stroke="#dbeafe" stroke-opacity="0.36" />`).join('')}
      <path d="M1 45 C8 43 14 43 20 46 H72 C69 58 57 65 39 65 H21 C10 65 3 59 0 48 C0 47 0 46 1 45Z" fill="#2496ed" stroke="#bfdbfe" stroke-opacity="0.32" />
      <path d="M66 41 C74 36 82 38 88 44 C80 45 75 49 71 57" fill="#2496ed" stroke="#bfdbfe" stroke-opacity="0.32" />
      <path d="M13 45 C10 39 7 36 1 35 C9 32 17 36 22 46" fill="#2496ed" stroke="#bfdbfe" stroke-opacity="0.32" />
      <circle cx="58" cy="51" r="3" fill="#dbeafe" />
    </g>`;
  }

  if (icon === 'kubernetes') {
    if (imageAssets.kubernetes) return renderLogoImage(imageAssets.kubernetes, x + 2, y + 8, 42, 42);

    const spokes = Array.from(
      { length: 7 },
      (_, index) =>
        `<line x1="0" y1="-28" x2="0" y2="-11" stroke-width="6.5" transform="rotate(${(360 / 7) * index})" />`,
    ).join('');

    return `<g transform="translate(${x} ${y + 6}) scale(0.76)">
      <path d="M33 0 L60 14 L66 43 L48 66 L18 66 L0 43 L6 14 Z" fill="#326ce5" stroke="#bfdbfe" stroke-opacity="0.42" />
      <g transform="translate(33 36)" fill="none" stroke="#ffffff" stroke-linecap="round" stroke-linejoin="round">
        <circle r="20" stroke-width="5.5" />
        ${spokes}
      </g>
      <path d="M33 26 L43 32 L40 44 L33 49 L24 44 L21 32 Z" fill="#326ce5" />
    </g>`;
  }

  return `<g transform="translate(${x} ${y})">
    <path d="M33 0 L61 16 L61 49 L33 66 L5 49 L5 16 Z" fill="#1d4ed8" stroke="#bfdbfe" stroke-opacity="0.46" />
    <circle cx="33" cy="33" r="12" fill="#0f172a" stroke="#bfdbfe" stroke-opacity="0.5" />
    <path d="M33 12 V22 M33 44 V54 M13 23 L22 28 M44 38 L53 43 M13 43 L22 38 M44 28 L53 23" stroke="#93c5fd" stroke-width="3" stroke-linecap="round" />
  </g>`;
}

function renderLogoImage(href, x, y, width, height) {
  return `<image href="${href}" x="${x}" y="${y}" width="${width}" height="${height}" preserveAspectRatio="xMidYMid meet" />`;
}

function renderChip(chip) {
  return `<g class="text">
    <rect x="${chip.x}" y="${chip.y}" width="${chip.width}" height="24" rx="8" fill="#172554" stroke="#60a5fa" stroke-opacity="0.28" />
    <text class="chip" x="${chip.x + 12}" y="${chip.y + 16}">${escapeHtml(chip.label)}</text>
  </g>`;
}

function renderTextLines(lines, x, y, className, lineHeight) {
  return lines
    .map(
      (line, index) => `<text class="${className}" x="${x}" y="${y + index * lineHeight}">${escapeHtml(line)}</text>`,
    )
    .join('\n');
}

function renderWrappedLines(lines, x, y, className, lineHeight) {
  return lines
    .flatMap((line) => wrapLine(line, 44))
    .map(
      (line, index) => `<text class="${className}" x="${x}" y="${y + index * lineHeight}">${escapeHtml(line)}</text>`,
    )
    .join('\n');
}

function renderPills(pills, startX, y) {
  let x = startX;

  return pills
    .map((pill) => {
      const pillWidth = pill.length * 9.5 + 30;
      const markup = `<g class="text">
        <rect x="${x}" y="${y}" width="${pillWidth}" height="40" rx="20" fill="#0f172a" fill-opacity="0.72" stroke="#bfdbfe" stroke-opacity="0.23" />
        <text class="pill" x="${x + 15}" y="${y + 26}">${escapeHtml(pill)}</text>
      </g>`;
      x += pillWidth + 12;
      return markup;
    })
    .join('\n');
}

function wrapLine(line, maxLength) {
  const words = line.split(' ');
  const lines = [];
  let currentLine = '';

  for (const word of words) {
    const nextLine = currentLine ? `${currentLine} ${word}` : word;
    if (nextLine.length > maxLength && currentLine) {
      lines.push(currentLine);
      currentLine = word;
    } else {
      currentLine = nextLine;
    }
  }

  if (currentLine) lines.push(currentLine);
  return lines;
}

async function loadImageAssets() {
  mkdirSync(assetCacheDir, { recursive: true });

  return Object.fromEntries(
    await Promise.all(
      Object.entries(logoSources).map(async ([name, source]) => [name, await loadLogoAsset(name, source)]),
    ),
  );
}

async function loadLogoAsset(name, source) {
  const filePath = resolve(assetCacheDir, source.fileName);

  if (!existsSync(filePath)) {
    try {
      const response = await fetch(source.url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      writeFileSync(filePath, Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      console.warn(`Could not download ${name} logo; using fallback icon. ${error.message}`);
      return undefined;
    }
  }

  return `data:${source.mimeType};base64,${readFileSync(filePath).toString('base64')}`;
}

function parseArgs(args) {
  const parsed = {};

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === '--') continue;

    if (arg === '--help' || arg === '-h') {
      parsed.help = true;
      continue;
    }

    if (arg === '--list') {
      parsed.list = true;
      continue;
    }

    if (arg === '--only') {
      parsed.only = args[++index];
      if (!parsed.only) throw new Error('Missing value for --only.');
      continue;
    }

    if (arg.startsWith('--only=')) {
      parsed.only = arg.slice('--only='.length);
      if (!parsed.only) throw new Error('Missing value for --only.');
      continue;
    }

    throw new Error(`Unknown option ${arg}.`);
  }

  return parsed;
}

function printUsage() {
  console.log(`Usage: pnpm generate:blog-images [options]

Generates gitignored crossposting images from definitions in scripts/generate-blog-images.mjs.

Options:
  --list              List available image definitions
  --only <slug>       Generate one image definition
  --help, -h          Show this help

Examples:
  pnpm generate:blog-images
  pnpm generate:blog-images -- --only what-is-deployability`);
}

function escapeHtml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
