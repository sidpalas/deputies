import { PanelLeftOpen, RefreshCw } from 'lucide-react';
import type { SetupStatus, SetupStatusItem } from '../../api.js';
import { Badge } from '../ui/badge.js';
import { Button } from '../ui/button.js';
import { Card } from '../ui/card.js';
import { formatDate, renderSetupText, setupStatusBadgeClass, setupStatusLabel } from './shared.js';

export function SetupGuidePanel(props: {
  canStartNewThread: boolean;
  loading: boolean;
  setupStatus: SetupStatus | null;
  setupError: string;
  showOpenSidebar: boolean;
  openSidebarLabel?: string;
  onOpenSidebar: () => void;
  onRefresh: () => void;
  onStartNewThread: () => void;
}) {
  const items = props.setupStatus?.items ?? [];
  const configured = items.filter((item) => item.state === 'configured').length;

  return (
    <section className="h-full overflow-auto px-3 py-6 md:px-8 xl:px-20">
      <div className="mx-auto max-w-5xl">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex min-w-0 items-start gap-2">
            {props.showOpenSidebar ? (
              <Button
                className="mt-1 h-8 w-8 shrink-0 p-0 md:hidden"
                variant="ghost"
                size="icon"
                onClick={props.onOpenSidebar}
                aria-label={props.openSidebarLabel ?? 'Open sessions'}
                title={props.openSidebarLabel ?? 'Open sessions'}
              >
                <PanelLeftOpen className="h-4 w-4" />
              </Button>
            ) : null}
            <div>
              <p className="text-sm font-medium text-muted-foreground">Admin setup</p>
              <h1 className="mt-1 text-2xl font-semibold tracking-tight">Setup guide</h1>
              <p className="mt-2 max-w-2xl text-sm text-muted-foreground">Quick checks for the Deputies deployment.</p>
              <p className="mt-1 max-w-2xl text-xs text-muted-foreground">
                To skip this page on startup, set {renderSetupText('HIDE_SETUP_PAGE=true')}.
              </p>
            </div>
          </div>
          <div className="flex shrink-0 gap-2">
            <Button variant="secondary" onClick={props.onRefresh} disabled={props.loading}>
              <RefreshCw className="h-4 w-4" /> Refresh
            </Button>
            <Button onClick={props.onStartNewThread} disabled={!props.canStartNewThread}>
              New session
            </Button>
          </div>
        </div>

        {props.setupError ? (
          <div className="mt-5 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
            {props.setupError}
          </div>
        ) : null}

        <Card className="mt-4 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <strong>
                {props.loading && !props.setupStatus ? 'Checking setup...' : `${configured}/${items.length} configured`}
              </strong>
              {props.setupStatus ? (
                <p className="mt-1 text-xs text-muted-foreground">
                  Last checked {formatDate(props.setupStatus.checkedAt)}
                </p>
              ) : null}
            </div>
            <a
              className="text-sm font-medium text-primary underline-offset-4 hover:underline"
              href="https://github.com/sidpalas/deputies"
              target="_blank"
              rel="noreferrer"
            >
              Open repo docs
            </a>
          </div>
        </Card>

        <div className="mt-3 grid gap-3 md:grid-cols-2">
          {items.map((item) => (
            <SetupStatusCard key={item.id} item={item} />
          ))}
        </div>
      </div>
    </section>
  );
}

function SetupStatusCard(props: { item: SetupStatusItem }) {
  return (
    <Card className="p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="font-semibold">{props.item.label}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{props.item.summary}</p>
        </div>
        <Badge className={setupStatusBadgeClass(props.item.state)}>{setupStatusLabel(props.item.state)}</Badge>
      </div>
      {props.item.guidance ? (
        <p className="mt-3 text-sm text-foreground">{renderSetupText(props.item.guidance)}</p>
      ) : null}
      {props.item.guidanceItems?.length ? (
        <ul className="mt-2 space-y-1 text-sm text-foreground">
          {props.item.guidanceItems.map((item) => (
            <li key={item}>{renderSetupText(item)}</li>
          ))}
        </ul>
      ) : null}
      {props.item.details?.length ? (
        <ul className="mt-3 space-y-1 text-xs text-muted-foreground">
          {props.item.details.map((detail) => (
            <li key={detail}>{detail}</li>
          ))}
        </ul>
      ) : null}
      <a
        className="mt-4 inline-flex text-sm font-medium text-primary underline-offset-4 hover:underline"
        href={`https://github.com/sidpalas/deputies/blob/main/${props.item.docsPath}`}
        target="_blank"
        rel="noreferrer"
      >
        Docs
      </a>
    </Card>
  );
}
