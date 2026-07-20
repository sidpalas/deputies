import { useState } from 'react';
import { CornerUpLeft, PanelLeftClose, Plus } from 'lucide-react';
import type { Snippet } from '../../api.js';
import { Button } from '../ui/button.js';
import { Input } from '../ui/input.js';
import { SidebarFooter, type SidebarFooterProps } from './sidebar-footer.js';
import { SidebarArchiveRestoreAction } from './shared.js';
import { useFilteredSnippets } from './snippets-panel.js';

export function SnippetsSidebar(props: {
  snippets: Snippet[];
  selectedId: string;
  loading: boolean;
  mutationPending: boolean;
  footerProps: SidebarFooterProps;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onBack: () => void;
  onCollapse: () => void;
  onArchive: (id: string) => void;
  onRestore: (id: string) => void;
}) {
  const [search, setSearch] = useState('');
  const items = useFilteredSnippets(props.snippets, search);
  const active = items.filter((item) => !item.archivedAt);
  const archived = items.filter((item) => item.archivedAt);
  const list = (values: Snippet[]) =>
    values.map((item) => (
      <div
        key={item.id}
        className={`group flex w-full min-w-0 items-center gap-2 rounded border border-transparent p-2 text-left hover:bg-accent ${item.id === props.selectedId ? 'border-primary bg-primary/15' : ''} ${item.archivedAt ? 'opacity-70' : ''}`}
      >
        <button
          type="button"
          className="block min-w-0 flex-1 overflow-hidden bg-transparent p-0 text-left text-sm"
          onClick={() => props.onSelect(item.id)}
        >
          <span className="font-medium">{item.name}</span>
          <span className="block truncate text-xs text-muted-foreground">{item.body}</span>
        </button>
        <SidebarArchiveRestoreAction
          archived={Boolean(item.archivedAt)}
          resourceLabel={`${item.name} snippet`}
          resourceType="snippet"
          className="w-8 shrink-0 p-0 md:w-auto md:px-2.5 md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100"
          disabled={props.mutationPending}
          onClick={() => (item.archivedAt ? props.onRestore(item.id) : props.onArchive(item.id))}
        />
      </div>
    ));
  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="mb-3 flex items-center gap-2">
        <Button variant="ghost" size="icon" onClick={props.onCollapse} aria-label="Hide sidebar">
          <PanelLeftClose className="h-4 w-4" />
        </Button>
        <h2 className="flex-1 text-sm font-semibold">Snippets</h2>
        <Button variant="secondary" size="icon" onClick={props.onBack} aria-label="Back to sessions">
          <CornerUpLeft className="h-4 w-4" />
        </Button>
        <Button size="icon" onClick={props.onCreate} aria-label="New snippet">
          <Plus className="h-4 w-4" />
        </Button>
      </div>
      <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search snippets..." />
      <div className="mt-3 min-h-0 flex-1 overflow-auto">
        {list(active)}
        {archived.length ? (
          <details className="mt-4 border-t border-border pt-3">
            <summary className="text-sm text-muted-foreground">Archived · {archived.length}</summary>
            <div className="mt-2 opacity-70">{list(archived)}</div>
          </details>
        ) : null}
        {!items.length ? (
          <p className="p-2 text-sm text-muted-foreground">{props.loading ? 'Loading snippets...' : 'No snippets.'}</p>
        ) : null}
      </div>
      <SidebarFooter {...props.footerProps} />
    </div>
  );
}
