export const maxPreviewLabelLength = 80;
export const maxPreviewPathLength = 512;

export type PublishedPreview = {
  port: number;
  label?: string;
  path?: string;
  providerSandboxId?: string;
  runtimeId?: string;
};

export function readPreviews(context: Record<string, unknown>): PublishedPreview[] {
  const value = context.previews;
  if (!Array.isArray(value)) return [];
  const previews: PublishedPreview[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    if (!isValidPreviewPort(record.port)) continue;
    const preview: PublishedPreview = { port: record.port };
    if (typeof record.label === 'string' && record.label.trim())
      preview.label = record.label.slice(0, maxPreviewLabelLength);
    if (typeof record.path === 'string' && isValidPreviewPath(record.path))
      preview.path = record.path.slice(0, maxPreviewPathLength);
    if (typeof record.providerSandboxId === 'string' && record.providerSandboxId.trim()) {
      preview.providerSandboxId = record.providerSandboxId;
    }
    if (typeof record.runtimeId === 'string' && record.runtimeId.trim()) preview.runtimeId = record.runtimeId;
    previews.push(preview);
  }
  return previews;
}

export function isValidPreviewPath(value: string): boolean {
  return value.startsWith('/') && !/\s/.test(value);
}

function isValidPreviewPort(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65535;
}
