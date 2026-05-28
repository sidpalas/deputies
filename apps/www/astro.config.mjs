import mdx from '@astrojs/mdx';
import { defineConfig } from 'astro/config';

export default defineConfig({
  site: 'https://deputies.dev',
  markdown: {
    rehypePlugins: [externalLinksNewTab],
  },
  integrations: [mdx()],
});

function externalLinksNewTab() {
  return (tree) => visitExternalLinks(tree);
}

function visitExternalLinks(node) {
  if (!node || typeof node !== 'object') return;

  if (node.type === 'element' && node.tagName === 'a' && isExternalUrl(node.properties?.href)) {
    node.properties.target = '_blank';
    node.properties.rel = mergeRel(node.properties.rel, ['noopener', 'noreferrer']);
  }

  if (Array.isArray(node.children)) {
    for (const child of node.children) visitExternalLinks(child);
  }
}

function isExternalUrl(href) {
  if (typeof href !== 'string' || !/^(https?:)?\/\//.test(href)) return false;

  return new URL(href, 'https://deputies.dev').origin !== 'https://deputies.dev';
}

function mergeRel(currentRel, requiredRel) {
  const current = Array.isArray(currentRel) ? currentRel : String(currentRel ?? '').split(/\s+/);
  return [...new Set([...current.filter(Boolean), ...requiredRel])].join(' ');
}
