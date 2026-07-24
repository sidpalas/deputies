import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import type { Snippet } from '../../api.js';
import { ComposerPickerOverlay } from './shared.js';

export type SnippetQuery = { start: number; end: number; query: string };

const partialSlugPattern = /^[a-z0-9]*(?:-[a-z0-9]*)*$/;

export function snippetQueryAtCaret(prompt: string, selectionStart: number): SnippetQuery | null {
  const caret = Math.max(0, Math.min(selectionStart, prompt.length));
  const match = /(^|\s)\/\/([a-z0-9]*(?:-[a-z0-9]*)*)$/.exec(prompt.slice(0, caret));
  if (!match) return null;
  const start = match.index + match[1]!.length;
  let end = caret;
  while (end < prompt.length && /[a-z0-9-]/.test(prompt[end]!)) end += 1;
  const fullQuery = prompt.slice(start + 2, end);
  if (!partialSlugPattern.test(fullQuery) || prompt[end] === '/') return null;
  return { start, end, query: match[2]! };
}

export function matchingSnippets(snippets: Snippet[], prompt: string, selectionStart = prompt.length): Snippet[] {
  const match = snippetQueryAtCaret(prompt, selectionStart);
  if (!match) return [];
  const query = match.query.toLowerCase();
  return snippets
    .filter(
      (snippet) =>
        !snippet.archivedAt && (!query || snippet.name.includes(query) || snippet.body.toLowerCase().includes(query)),
    )
    .slice(0, 30);
}

/** Snippet selection intentionally returns only editable body text; no metadata enters message submission. */
export function insertSnippet(
  prompt: string,
  snippet: Snippet,
  selectionStart = prompt.length,
): { prompt: string; selectionStart: number } {
  const query = snippetQueryAtCaret(prompt, selectionStart);
  if (!query) return { prompt, selectionStart };
  const nextPrompt = `${prompt.slice(0, query.start)}${snippet.body}${prompt.slice(query.end)}`;
  return { prompt: nextPrompt, selectionStart: query.start + snippet.body.length };
}

export function useSnippetPicker(input: {
  snippets: Snippet[];
  enabled: boolean;
  prompt: string;
  onPromptChange: (prompt: string) => void;
}) {
  const [selectionStart, setSelectionStart] = useState(input.prompt.length);
  const query = snippetQueryAtCaret(input.prompt, selectionStart);
  const options = query ? matchingSnippets(input.snippets, input.prompt, selectionStart) : [];
  const open = input.enabled && Boolean(query);
  const [activeIndex, setActiveIndex] = useState(0);
  const activeRef = useRef<HTMLButtonElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const pendingSelectionRef = useRef<number | null>(null);
  useEffect(() => {
    setActiveIndex(0);
  }, [input.prompt, selectionStart]);
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);
  useEffect(() => {
    const pendingSelection = pendingSelectionRef.current;
    if (pendingSelection === null) return;
    pendingSelectionRef.current = null;
    textareaRef.current?.focus();
    textareaRef.current?.setSelectionRange(pendingSelection, pendingSelection);
    setSelectionStart(pendingSelection);
  }, [input.prompt]);

  function select(snippet: Snippet) {
    const inserted = insertSnippet(input.prompt, snippet, selectionStart);
    pendingSelectionRef.current = inserted.selectionStart;
    input.onPromptChange(inserted.prompt);
  }
  function keyDown(event: KeyboardEvent<HTMLTextAreaElement>): boolean {
    if (!open || !options.length) return false;
    let next = activeIndex;
    if (event.key === 'ArrowDown') next = (activeIndex + 1) % options.length;
    else if (event.key === 'ArrowUp') next = (activeIndex - 1 + options.length) % options.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = options.length - 1;
    else if (event.key === 'Enter' && !event.shiftKey) select(options[activeIndex] ?? options[0]!);
    else return false;
    event.preventDefault();
    if (event.key !== 'Enter') setActiveIndex(next);
    return true;
  }
  return {
    open,
    options,
    activeIndex,
    activeRef,
    textareaRef,
    selectionStart,
    setActiveIndex,
    setSelectionStart,
    select,
    keyDown,
  };
}

export function SnippetPicker(props: { controller: ReturnType<typeof useSnippetPicker> }) {
  if (!props.controller.open) return null;
  return (
    <div className="relative min-w-0">
      <ComposerPickerOverlay>
        <p className="flex h-8 items-center px-2 text-xs text-muted-foreground">Type a snippet name after //</p>
        <div
          className="composer-picker-results mt-1 max-h-[clamp(8rem,35dvh,16rem)] overflow-auto"
          role="listbox"
          aria-label="Personal snippets"
        >
          {props.controller.options.length ? (
            props.controller.options.map((snippet, index) => (
              <button
                key={snippet.id}
                ref={index === props.controller.activeIndex ? props.controller.activeRef : undefined}
                type="button"
                role="option"
                aria-selected={index === props.controller.activeIndex}
                className={`block w-full rounded-sm px-2 py-2 text-left hover:bg-accent hover:text-accent-foreground ${index === props.controller.activeIndex ? 'bg-accent text-accent-foreground' : ''}`}
                onMouseEnter={() => props.controller.setActiveIndex(index)}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => props.controller.select(snippet)}
              >
                <strong className="block truncate text-sm font-medium">//{snippet.name}</strong>
                <span className="mt-0.5 line-clamp-2 block text-xs text-muted-foreground">
                  {snippet.body.replace(/\s+/g, ' ').slice(0, 100)}
                </span>
              </button>
            ))
          ) : (
            <p className="px-2 py-1 text-sm text-muted-foreground">No matching snippets.</p>
          )}
        </div>
      </ComposerPickerOverlay>
    </div>
  );
}
