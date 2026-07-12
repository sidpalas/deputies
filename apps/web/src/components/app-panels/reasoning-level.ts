import type { ReasoningLevel } from '../../api.js';
import type { OptionPickerOption } from './option-picker.js';

export const REASONING_LEVEL_OPTIONS: OptionPickerOption[] = [
  { value: 'off', label: 'Off' },
  { value: 'minimal', label: 'Minimal' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'Extra high' },
  { value: 'max', label: 'Max' },
];

export function reasoningLevelFromContext(value: unknown): ReasoningLevel | '' {
  return REASONING_LEVEL_OPTIONS.some((option) => option.value === value) ? (value as ReasoningLevel) : '';
}

export function reasoningLevelLabel(value: ReasoningLevel): string {
  return REASONING_LEVEL_OPTIONS.find((option) => option.value === value)?.label ?? value;
}

export function defaultReasoningLevelLabel(value: ReasoningLevel | ''): string {
  return value ? `Default (${reasoningLevelLabel(value)})` : 'Default';
}
