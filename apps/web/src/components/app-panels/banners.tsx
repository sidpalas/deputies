import { AlertTriangle, RotateCcw } from 'lucide-react';
import type { AppNotice } from '../../api.js';
import { Button } from '../ui/button.js';
import { Card } from '../ui/card.js';
import { connectionStatusHint, connectionStatusTitle } from './shared.js';
import type { ConnectionStatus } from './types.js';

export function LocalSandboxWarning() {
  return (
    <div
      className="border-b border-warning/50 bg-warning/15 px-3 py-2 text-sm text-warning-foreground dark:text-warning md:px-8 xl:px-20"
      role="alert"
    >
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
        <p>
          <strong>Unsafe local sandbox mode is not a security boundary.</strong> Commands run on the API/worker host
          runtime in a temporary workspace. Use it only for trusted local development.
        </p>
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
      </div>
    </div>
  );
}

export function AppNoticesBanner(props: { notices: AppNotice[] }) {
  if (!props.notices.length) return null;
  return (
    <div
      className="border-b border-warning/50 bg-warning/15 px-3 py-2 text-sm text-warning-foreground dark:text-warning md:px-8 xl:px-20"
      role="alert"
    >
      <div className="grid gap-1">
        {props.notices.map((notice) => (
          <p key={notice.code}>
            <strong>{notice.message}</strong> {notice.action ?? ''}
          </p>
        ))}
      </div>
    </div>
  );
}

export function ConnectionStatusBanner(props: { status: ConnectionStatus }) {
  return (
    <div
      className="pointer-events-none fixed left-3 right-3 top-3 z-50 rounded-md border border-warning/50 bg-warning/15 px-3 py-2 text-sm text-warning-foreground shadow-lg backdrop-blur dark:text-warning md:left-8 md:right-8 xl:left-20 xl:right-20"
      role="status"
    >
      <div className="flex flex-wrap items-start gap-2">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
        <p className="min-w-0 flex-1">
          <strong>{connectionStatusTitle(props.status)}</strong> {props.status.message}{' '}
          {connectionStatusHint(props.status)}
        </p>
      </div>
    </div>
  );
}

export function StartupLoadingPanel(props: { connectionStatus: ConnectionStatus }) {
  return (
    <section className="grid min-h-screen place-items-center px-4">
      <Card className="max-w-lg p-6 text-center">
        <h2 className="text-lg font-semibold">Loading Deputies</h2>
        <p className="mt-2 text-sm text-muted-foreground">Restoring your session and workspace.</p>
        {props.connectionStatus.state !== 'ok' ? (
          <div
            className="mt-4 rounded-md border border-warning/50 bg-warning/10 p-3 text-left text-sm text-warning-foreground dark:text-warning"
            role="status"
          >
            <strong>{connectionStatusTitle(props.connectionStatus)}</strong>
            <p className="mt-1">
              {props.connectionStatus.message} {connectionStatusHint(props.connectionStatus)}
            </p>
          </div>
        ) : null}
      </Card>
    </section>
  );
}

export function ArchivedSessionNotice(props: { onRestore: () => void }) {
  return (
    <Card className="mb-3 flex shrink-0 flex-wrap items-center justify-between gap-3 border-warning/50 bg-warning/10 p-3">
      <div>
        <p className="text-sm font-medium text-warning-foreground dark:text-warning">This session is archived.</p>
        <p className="text-xs text-warning-foreground/80 dark:text-warning/80">
          Restore it before sending a new message.
        </p>
      </div>
      <Button type="button" variant="secondary" onClick={props.onRestore}>
        <RotateCcw className="h-4 w-4" /> Restore session
      </Button>
    </Card>
  );
}
