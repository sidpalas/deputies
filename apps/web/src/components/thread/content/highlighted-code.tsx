import { useEffect, useRef, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { cn } from '../../../lib/utils.js';

type ResolvedColorTheme = 'light' | 'dark';

const HIGHLIGHTED_CODE_HTML_CACHE_LIMIT = 100;
const highlightedCodeHtmlCache = new Map<string, string>();
let shikiCodeToHtmlPromise: Promise<typeof import('shiki').codeToHtml> | null = null;

export function HighlightedCode(props: {
  code: string;
  language?: string;
  wrap?: boolean;
  chrome?: boolean;
  highlight?: boolean;
}) {
  const colorTheme = useResolvedColorTheme();
  const highlight = props.highlight ?? true;
  const cacheKey = highlightedCodeCacheKey(props.code, props.language, colorTheme);
  const [html, setHtml] = useState(() => (highlight ? (highlightedCodeHtmlCache.get(cacheKey) ?? '') : ''));
  const [copied, setCopied] = useState(false);
  const copiedResetTimer = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (copiedResetTimer.current !== null) window.clearTimeout(copiedResetTimer.current);
    };
  }, []);

  useEffect(() => {
    if (!highlight) {
      setHtml('');
      return;
    }

    const cachedHtml = highlightedCodeHtmlCache.get(cacheKey);
    if (cachedHtml) {
      setHtml(cachedHtml);
      return;
    }

    let cancelled = false;
    setHtml('');
    loadShikiCodeToHtml()
      .then((codeToHtml) =>
        codeToHtml(props.code, { lang: props.language ?? 'text', theme: codeHighlightTheme(colorTheme) }),
      )
      .then((nextHtml) => {
        cacheHighlightedCodeHtml(cacheKey, nextHtml);
        if (!cancelled) setHtml(nextHtml);
      })
      .catch(() => {
        if (!cancelled) setHtml('');
      });
    return () => {
      cancelled = true;
    };
  }, [cacheKey, highlight, props.code, props.language, colorTheme]);

  async function copyCode() {
    await navigator.clipboard.writeText(props.code);
    setCopied(true);
    if (copiedResetTimer.current !== null) window.clearTimeout(copiedResetTimer.current);
    copiedResetTimer.current = window.setTimeout(() => {
      copiedResetTimer.current = null;
      setCopied(false);
    }, 1400);
  }

  return (
    <figure className="my-3 w-full max-w-full min-w-0 overflow-hidden rounded-lg border border-border bg-card shadow-[0_12px_32px_rgb(0_0_0_/_0.18)]">
      {props.chrome !== false ? (
        <figcaption className="flex items-center justify-between border-b border-border bg-muted/80 px-3 py-1.5 text-[0.7rem] font-medium uppercase tracking-widest text-muted-foreground">
          <span>{props.language ?? 'text'}</span>
          <button
            className="inline-flex items-center gap-1 rounded border border-border bg-background px-2 py-1 text-[0.65rem] text-muted-foreground transition hover:text-foreground"
            type="button"
            onClick={copyCode}
            aria-label="Copy code"
          >
            {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
            {copied ? 'Copied' : 'Copy'}
          </button>
        </figcaption>
      ) : null}
      {html ? (
        <div
          className={cn(
            'highlighted-code text-sm leading-6',
            props.wrap ? 'highlighted-code-wrap overflow-hidden' : 'overflow-x-auto overflow-y-hidden',
          )}
          dangerouslySetInnerHTML={{ __html: html }}
        />
      ) : (
        <pre
          className={cn(
            'p-3 text-sm leading-6 text-foreground',
            props.wrap ? 'overflow-hidden whitespace-pre-wrap break-words' : 'overflow-x-auto overflow-y-hidden',
          )}
        >
          <code>{props.code}</code>
        </pre>
      )}
    </figure>
  );
}

function getResolvedColorTheme(): ResolvedColorTheme {
  return document.documentElement.classList.contains('dark') ? 'dark' : 'light';
}

function useResolvedColorTheme(): ResolvedColorTheme {
  const [theme, setTheme] = useState<ResolvedColorTheme>(getResolvedColorTheme);

  useEffect(() => {
    const updateTheme = () => setTheme(getResolvedColorTheme());
    const observer = new MutationObserver(updateTheme);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    updateTheme();

    return () => observer.disconnect();
  }, []);

  return theme;
}

function codeHighlightTheme(theme: ResolvedColorTheme): 'github-light-default' | 'github-dark-default' {
  return theme === 'dark' ? 'github-dark-default' : 'github-light-default';
}

function highlightedCodeCacheKey(code: string, language: string | undefined, theme: ResolvedColorTheme): string {
  return `${theme}\0${language ?? 'text'}\0${code}`;
}

function loadShikiCodeToHtml() {
  shikiCodeToHtmlPromise ??= import('shiki').then(({ codeToHtml }) => codeToHtml);
  return shikiCodeToHtmlPromise;
}

function cacheHighlightedCodeHtml(key: string, html: string) {
  if (highlightedCodeHtmlCache.has(key)) highlightedCodeHtmlCache.delete(key);
  highlightedCodeHtmlCache.set(key, html);
  while (highlightedCodeHtmlCache.size > HIGHLIGHTED_CODE_HTML_CACHE_LIMIT) {
    const oldestKey = highlightedCodeHtmlCache.keys().next().value;
    if (!oldestKey) return;
    highlightedCodeHtmlCache.delete(oldestKey);
  }
}
