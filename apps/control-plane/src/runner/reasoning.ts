export const REASONING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

export type ReasoningLevel = (typeof REASONING_LEVELS)[number];

export function isReasoningLevel(value: unknown): value is ReasoningLevel {
  return typeof value === 'string' && REASONING_LEVELS.includes(value as ReasoningLevel);
}
