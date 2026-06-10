import { cn } from '../../../lib/utils.js';
import { HighlightedCode } from './highlighted-code.js';

const DEBUG_CODE_MAX_TEXT_LENGTH = 2000;

export function JsonPayload(props: { value: unknown; label?: string }) {
  return (
    <DebugCode code={JSON.stringify(props.value, null, 2)} language="json" label={props.label ?? 'Debug details'} />
  );
}

export function DebugCode(props: { code: string; language: string; label: string }) {
  return (
    <div className="mt-2 min-w-0 rounded-md border border-border bg-muted/30" aria-label={props.label} role="region">
      <HighlightedCode code={truncateDebugText(props.code)} language={props.language} wrap chrome={false} />
    </div>
  );
}

export function truncateDebugText(value: string): string {
  if (value.length <= DEBUG_CODE_MAX_TEXT_LENGTH) return value;
  const omitted = value.length - DEBUG_CODE_MAX_TEXT_LENGTH;
  return `${value.slice(0, DEBUG_CODE_MAX_TEXT_LENGTH)}\n... truncated ${omitted} characters`;
}

export function DebugText(props: { text: string; tone?: 'error' }) {
  const text = truncateDebugText(props.text);
  const isLong = text.length > 480 || text.split('\n').length > 8;
  const textClassName = cn(
    'whitespace-pre-wrap break-words text-sm leading-6',
    props.tone === 'error' ? 'text-destructive' : 'text-muted-foreground',
  );

  if (!isLong) {
    return (
      <p
        className={cn(
          'mt-2',
          props.tone === 'error' ? 'rounded-md border border-destructive/40 bg-destructive/10 p-2' : '',
          textClassName,
        )}
      >
        {text}
      </p>
    );
  }

  return (
    <div
      className={cn(
        'mt-2 min-w-0 rounded-md border p-2',
        props.tone === 'error' ? 'border-destructive/40 bg-destructive/10' : 'border-border bg-muted/30',
      )}
      aria-label={props.tone === 'error' ? 'Diagnostic error' : 'Diagnostic output'}
      role="region"
    >
      <p className={textClassName}>{text}</p>
    </div>
  );
}
