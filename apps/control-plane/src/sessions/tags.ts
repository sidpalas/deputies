const maxSessionTags = 20;
const maxSessionTagLength = 64;

export function normalizeSessionTags(input: unknown): string[] | null {
  if (!Array.isArray(input)) return null;

  const tags = new Set<string>();
  for (const item of input) {
    if (typeof item !== 'string') return null;
    const tag = item.trim().replace(/\s+/g, ' ').toLowerCase();
    if (!tag) continue;
    if (tag.length > maxSessionTagLength || tag.includes(',') || hasDisallowedTagCodePoint(tag)) return null;
    tags.add(tag);
  }

  if (tags.size > maxSessionTags) return null;
  return [...tags].sort(compareCodeUnits);
}

function hasDisallowedTagCodePoint(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0)!;
    if (code < 32 || code === 127) return true;
    if (isInvisibleFormatCodePoint(code)) return true;
  }
  return false;
}

function isInvisibleFormatCodePoint(code: number): boolean {
  return (
    code === 0x00ad ||
    code === 0x034f ||
    code === 0x061c ||
    code === 0x180e ||
    (code >= 0x200b && code <= 0x200f) ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2060 && code <= 0x206f) ||
    code === 0xfeff ||
    (code >= 0xfe00 && code <= 0xfe0f) ||
    (code >= 0xe0000 && code <= 0xe007f) ||
    (code >= 0xe0100 && code <= 0xe01ef)
  );
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
