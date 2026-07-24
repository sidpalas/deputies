import { useEffect, useState } from 'react';
import { PanelLeftOpen } from 'lucide-react';
import { ApiError, listUsers, updateUserRole, type AuthUser } from '../../api.js';
import { Button } from '../ui/button.js';
import { Card } from '../ui/card.js';

export function InstanceAccessPanel(props: {
  token: string;
  currentUser: AuthUser;
  readOnlyUsers?: AuthUser[];
  showOpenSidebar: boolean;
  onOpenSidebar: () => void;
  onCurrentUserChanged: (user: AuthUser) => void;
}) {
  const [users, setUsers] = useState<AuthUser[]>(props.readOnlyUsers ?? []);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(!props.readOnlyUsers);
  const [pendingId, setPendingId] = useState('');

  useEffect(() => {
    if (props.readOnlyUsers) {
      setUsers(props.readOnlyUsers);
      setError('');
      setLoading(false);
      return;
    }

    let active = true;
    setLoading(true);
    listUsers({ token: props.token })
      .then((next) => active && setUsers(next))
      .catch((cause: unknown) => active && setError(cause instanceof Error ? cause.message : 'Could not load users.'))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [props.readOnlyUsers, props.token]);

  async function changeRole(user: AuthUser, role: AuthUser['role']) {
    if (props.readOnlyUsers) return;
    setPendingId(user.id);
    setError('');
    try {
      const updated = await updateUserRole({ userId: user.id, role, token: props.token });
      setUsers((current) => current.map((candidate) => (candidate.id === updated.id ? updated : candidate)));
      if (updated.id === props.currentUser.id) props.onCurrentUserChanged(updated);
    } catch (cause) {
      setError(
        cause instanceof ApiError && cause.code === 'last_admin'
          ? 'The last admin cannot be assigned another role.'
          : cause instanceof Error
            ? cause.message
            : 'Could not update this user.',
      );
    } finally {
      setPendingId('');
    }
  }

  return (
    <section className="h-full overflow-y-auto px-4 py-6 md:px-8 xl:px-14">
      <div className="mx-auto max-w-4xl">
        <div className="flex items-center gap-2">
          {props.showOpenSidebar ? (
            <Button variant="ghost" size="icon" onClick={props.onOpenSidebar} aria-label="Open users">
              <PanelLeftOpen className="h-4 w-4" />
            </Button>
          ) : null}
          <div>
            <h1 className="text-2xl font-semibold">Instance access</h1>
            <p className="text-sm text-muted-foreground">Manage each user's tenant-wide role.</p>
          </div>
        </div>
        {error ? (
          <p
            role="alert"
            className="mt-4 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive"
          >
            {error}
          </p>
        ) : null}
        <Card className="mt-5 p-5">
          {loading ? (
            <p className="text-sm text-muted-foreground">Loading users…</p>
          ) : (
            users.map((user) => (
              <div key={user.id} className="flex items-center gap-4 border-b border-border py-3 last:border-0">
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{user.displayName || user.username}</p>
                  <p className="truncate text-xs text-muted-foreground">{user.username}</p>
                </div>
                <label className="sr-only" htmlFor={`role-${user.id}`}>
                  Role for {user.username}
                </label>
                <select
                  id={`role-${user.id}`}
                  className="rounded-md border border-input bg-background px-3 py-2 text-sm"
                  value={user.role}
                  disabled={Boolean(props.readOnlyUsers) || pendingId === user.id}
                  onChange={(event) => void changeRole(user, event.target.value as AuthUser['role'])}
                >
                  <option value="viewer">Viewer</option>
                  <option value="member">Member</option>
                  <option value="admin">Admin</option>
                </select>
              </div>
            ))
          )}
        </Card>
      </div>
    </section>
  );
}
