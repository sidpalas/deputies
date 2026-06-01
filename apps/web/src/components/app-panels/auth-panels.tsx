import type { FormEvent } from 'react';
import { githubLoginUrl } from '../../api.js';
import { Button } from '../ui/button.js';
import { Card } from '../ui/card.js';
import { Input } from '../ui/input.js';

export function BearerAuthPanel(props: {
  draftToken: string;
  setDraftToken: (value: string) => void;
  saveToken: (event: FormEvent) => void;
}) {
  return (
    <section className="grid min-h-screen place-items-center px-4">
      <Card className="w-full max-w-2xl p-5">
        <p className="text-xs font-semibold uppercase tracking-widest text-primary">Deputies</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight text-foreground">
          Engineering agents for delegated work.
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Assign work, track each step, and inspect the final output.
        </p>
        <form className="mt-6 grid gap-3" onSubmit={props.saveToken}>
          <div>
            <strong>API token required</strong>
            <p className="text-sm text-muted-foreground">
              Enter the backend bearer token. It stays in this browser's local storage.
            </p>
          </div>
          <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
            <Input
              type="password"
              value={props.draftToken}
              onChange={(event) => props.setDraftToken(event.target.value)}
              placeholder="Bearer token"
            />
            <Button type="submit">Use token</Button>
          </div>
        </form>
      </Card>
    </section>
  );
}

export function SessionAuthPanel(props: {
  provider: 'static' | 'github';
  username: string;
  password: string;
  onUsernameChange: (value: string) => void;
  onPasswordChange: (value: string) => void;
  onSubmit: (event: FormEvent) => void;
}) {
  return (
    <section className="grid min-h-screen place-items-center px-4">
      <Card className="w-full max-w-2xl p-5">
        <p className="text-xs font-semibold uppercase tracking-widest text-primary">Deputies</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight text-foreground">Sign in to Deputies.</h1>
        <p className="mt-2 text-sm text-muted-foreground">The API will set an HTTP-only session cookie after login.</p>
        {props.provider === 'github' ? (
          <div className="mt-6 grid gap-3">
            <div>
              <strong>GitHub login</strong>
              <p className="text-sm text-muted-foreground">
                Continue with a GitHub account allowed by this Deputies deployment.
              </p>
            </div>
            <Button
              className="justify-self-end"
              type="button"
              onClick={() => {
                window.location.href = githubLoginUrl();
              }}
            >
              Continue with GitHub
            </Button>
          </div>
        ) : (
          <form className="mt-6 grid gap-3" onSubmit={props.onSubmit}>
            <div>
              <strong>Operator login</strong>
              <p className="text-sm text-muted-foreground">
                Use the static credentials configured for this environment.
              </p>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              <Input
                value={props.username}
                onChange={(event) => props.onUsernameChange(event.target.value)}
                placeholder="Username"
                autoComplete="username"
              />
              <Input
                type="password"
                value={props.password}
                onChange={(event) => props.onPasswordChange(event.target.value)}
                placeholder="Password"
                autoComplete="current-password"
              />
            </div>
            <Button className="justify-self-end" type="submit" disabled={!props.username.trim() || !props.password}>
              Sign in
            </Button>
          </form>
        )}
      </Card>
    </section>
  );
}
