import mdx from '@astrojs/mdx';
import { defineConfig } from 'astro/config';

export default defineConfig({
  site: 'https://deputies.dev',
  markdown: {
    rehypePlugins: [headingAnchors, responsiveTables, externalLinksNewTab],
  },
  integrations: [mdx()],
});

function headingAnchors() {
  return (tree) => addHeadingAnchors(tree, new Set());
}

function externalLinksNewTab() {
  return (tree) => visitExternalLinks(tree);
}

function responsiveTables() {
  return (tree) => wrapTables(tree);
}

function addHeadingAnchors(node, usedIds) {
  if (!node || typeof node !== 'object') return;

  if (node.type === 'element' && isAnchoredHeading(node.tagName)) {
    const headingText = getTextContent(node).trim();
    const id = getHeadingId(node, headingText, usedIds);

    if (id && !hasHeadingAnchor(node, id)) {
      node.properties.id = id;
      node.children = [
        ...(node.children ?? []),
        {
          type: 'element',
          tagName: 'a',
          properties: {
            className: ['heading-anchor'],
            href: `#${id}`,
            ariaLabel: `Link to ${headingText || 'this section'}`,
          },
          children: [{ type: 'text', value: '#' }],
        },
      ];
    }
  }

  if (Array.isArray(node.children)) {
    for (const child of node.children) addHeadingAnchors(child, usedIds);
  }
}

function isAnchoredHeading(tagName) {
  return /^h[2-6]$/.test(tagName);
}

function getHeadingId(node, headingText, usedIds) {
  const existingId = typeof node.properties?.id === 'string' ? node.properties.id : undefined;

  if (existingId) {
    usedIds.add(existingId);
    return existingId;
  }

  const baseId = slugifyHeading(headingText) || 'section';
  let id = baseId;
  let count = 1;

  while (usedIds.has(id)) {
    id = `${baseId}-${count}`;
    count += 1;
  }

  usedIds.add(id);
  return id;
}

function slugifyHeading(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}

function hasHeadingAnchor(node, id) {
  return node.children?.some(
    (child) => child.type === 'element' && child.tagName === 'a' && child.properties?.href === `#${id}`,
  );
}

function getTextContent(node) {
  if (!node || typeof node !== 'object') return '';
  if (node.type === 'text') return node.value ?? '';
  if (!Array.isArray(node.children)) return '';
  return node.children.map(getTextContent).join('');
}

function wrapTables(node, insideTableScroll = false) {
  if (!node || typeof node !== 'object' || !Array.isArray(node.children)) return;

  const childInsideTableScroll = insideTableScroll || hasClassName(node, 'table-scroll');
  const children = [];
  let pendingTableClassNames = [];

  for (const child of node.children) {
    const tableClassNames = getTableClassNamesFromComment(child);
    if (tableClassNames) {
      pendingTableClassNames = tableClassNames;
      continue;
    }

    if (child.type === 'element' && child.tagName === 'table') {
      if (childInsideTableScroll) {
        children.push(child);
      } else {
        children.push({
          type: 'element',
          tagName: 'div',
          properties: { className: ['table-scroll', ...pendingTableClassNames] },
          children: [child],
        });
      }

      pendingTableClassNames = [];
      continue;
    }

    wrapTables(child, childInsideTableScroll);
    children.push(child);

    if (!isWhitespaceText(child)) pendingTableClassNames = [];
  }

  node.children = children;
}

function hasClassName(node, className) {
  const classNames = node.properties?.className;
  if (Array.isArray(classNames)) return classNames.includes(className);
  return typeof classNames === 'string' && classNames.split(/\s+/).includes(className);
}

function getTableClassNamesFromComment(node) {
  const value = typeof node.value === 'string' ? node.value.trim() : '';
  if (node.type === 'mdxFlowExpression' && value === '/* table:body-width */') {
    return ['table-scroll--body-width'];
  }
  if (node.type === 'mdxFlowExpression' && value === '/* table:wide-middle */') {
    return ['table-scroll--wide-middle'];
  }
  if (node.type === 'comment' && value === 'table:compact-leading') return ['table-scroll--compact-leading'];
  if (node.type === 'raw' && value === '<!-- table:compact-leading -->') return ['table-scroll--compact-leading'];
  if (node.type === 'mdxFlowExpression' && value === '/* table:compact-leading */') {
    return ['table-scroll--compact-leading'];
  }
  return undefined;
}

function isWhitespaceText(node) {
  return node.type === 'text' && /^\s*$/.test(node.value ?? '');
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
