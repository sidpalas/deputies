# Nested Preview: Deputies Inside Deputies

This guide explains how to run a full inner Deputies instance inside a sandbox of an outer Deputies instance and use it through the outer service preview, e.g. for dogfooding a branch end to end.

## Terminology

- **Outer instance**: the main Deputies deployment that owns the session and sandbox.
- **Inner instance**: the Deputies control-plane and web app running inside that sandbox, exposed as a sandbox service.
- **Outer service host**: the preview hostname the outer instance assigns to the inner web port, e.g. `s-5173-<outer-session-id>.deputies.localhost`.

## How Routing Works

The outer instance routes `s-<port>-<session-id>.<service-base-domain>` hosts into the sandbox. The sandbox bridge forwards the original browser host to the target service in `Host`, `X-Forwarded-Host`, and `X-Original-Host`. That means the inner instance's web entrypoint receives requests whose host itself starts with `s-`.

Three pieces make this nesting work:

1. **Anchored service-host matching.** The web proxies (Caddy and the Vite dev server) decide whether a request targets a sandbox service by matching the host against `SERVICE_HOST_REGEX` (default `^s-`). The inner instance must override it so its own web host is not misrouted to its service proxy.
2. **Adjacent-label parsing.** The outer control-plane resolves the service label _adjacent to_ its service base domain, so a nested host such as `s-3000-<inner-session>.s-5173-<outer-session>.deputies.localhost` routes to the outer session `<outer-session>` port `5173`, with the full host forwarded for the inner instance to parse in turn. The outer preview cookie is scoped with `Domain=<service host>`, so nested hosts stay authorized at the outer proxy, and `/__preview_auth` on nested hosts proxies through to the inner instance.
3. **Distinct cookie names.** Both the outer service proxy and the sandbox bridge strip the platform cookie names (`dev_deputies_session`, `deputies_preview`) in both directions so the operator's outer session can never leak into a sandbox. The inner instance must use different names via `SESSION_COOKIE_NAME` and `PREVIEW_COOKIE_NAME`, or its own auth cookies are stripped and login never sticks. The outer instance should keep the default names; the sandbox bridge strips exactly those.

## Inner Instance Configuration

Determine the outer service host for the inner web port first (shown in the outer session's services panel). With `H=s-5173-<outer-session-id>.deputies.localhost`:

Inner control-plane environment:

```sh
WEB_BASE_URL=https://s-5173-<outer-session-id>.deputies.localhost
SERVICE_BASE_DOMAIN=s-5173-<outer-session-id>.deputies.localhost
SERVICE_TRUST_FORWARDED_HOSTS=true
SESSION_COOKIE_NAME=inner_deputies_session
PREVIEW_COOKIE_NAME=inner_deputies_preview
AUTH_COOKIE_SECURE=true
API_AUTH_MODE=session
AUTH_PROVIDER=static
AUTH_STATIC_USERNAME=dev
AUTH_STATIC_PASSWORD=dev-secret
AUTH_SESSION_SECRET=<random-secret>
```

Inner web environment (Caddy or `pnpm dev`):

```sh
# Only hosts below the inner instance's own web host are service hosts.
SERVICE_HOST_REGEX='^s-\d+-[^.]+\.s-5173-<outer-session-id>\.deputies\.localhost'
```

Notes:

- `SERVICE_BASE_DOMAIN` is the inner web host itself, so the inner instance generates service URLs as sub-subdomains, e.g. `s-3000-<inner-session-id>.s-5173-<outer-session-id>.deputies.localhost`.
- The Vite dev server's default `VITE_DEV_ALLOWED_HOSTS` already covers `.localhost` hosts.
- Without nested virtualization in the sandbox, use `SANDBOX_PROVIDER=fake` (or a cloud provider such as Daytona) for the inner instance's own sessions.

## Limitations

- **Real domains need multi-level wildcards.** Nested service hosts add a second subdomain level. `*.example.com` DNS records and TLS certificates cover only one label, so on a deployed outer domain the inner web app works at the outer service host, but the inner instance's _own_ service previews need DNS and certificates for `*.s-<port>-<id>.example.com`. Browsers resolve any depth of `*.localhost` to loopback, so local Portless setups are unaffected.
- **One nesting level for previews.** The outer proxy strips `Domain=` attributes from upstream `Set-Cookie` headers, so an inner instance's preview cookie is host-only and a third nesting level of previews is not supported.
- **Outer cookie names must stay default.** The sandbox bridge strips the default platform cookie names. Only the inner instance should override `SESSION_COOKIE_NAME` / `PREVIEW_COOKIE_NAME`.
