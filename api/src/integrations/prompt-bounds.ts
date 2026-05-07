export const maxPriorContextItems = 20;
export const maxPromptTextCharacters = 8000;

export function boundPromptText(text: string, maxCharacters = maxPromptTextCharacters): string {
  if (text.length <= maxCharacters) return text;
  return `${text.slice(0, maxCharacters)}\n[truncated]`;
}

export function boundPriorContext<T>(items: T[], maxItems = maxPriorContextItems): T[] {
  return items.length > maxItems ? items.slice(-maxItems) : items;
}
