# Deputies Chart

This chart deploys the Deputies application components on Kubernetes.

Current topology:

- `control-plane`: ALL mode, running API and workers in one deployment
- `migrate`: one-shot database migration job, run as a Helm post-install/post-upgrade hook by default
- `web`: static web UI served by Caddy, proxying API routes to control-plane

The chart is currently oriented around `SANDBOX_PROVIDER=daytona` and does not mount the Docker socket.

For Portless plus a local Traefik forward, set `web.trustForwardedServiceHosts=true` so the web proxy routes wildcard service hosts from `X-Forwarded-Host`, matching the Docker Compose local Caddy behavior. Also configure Traefik to trust forwarded headers through the platform chart.

Install with the reference platform chart:

```sh
helm upgrade --install deputies deploy/kubernetes/charts/deputies --namespace deputies
```

For real agent work in production, reference a Kubernetes Secret instead of putting secret values in Helm values:

```sh
helm upgrade --install deputies deploy/kubernetes/charts/deputies \
  --namespace deputies \
  --set secrets.create=false \
  --set secrets.name=deputies-app-secrets
```

The referenced Secret should contain the environment-variable keys the app needs, such as `AUTH_SESSION_SECRET`, `DAYTONA_API_KEY`, `ANTHROPIC_API_KEY`, `ARTIFACT_STORAGE_S3_ACCESS_KEY_ID`, and `ARTIFACT_STORAGE_S3_SECRET_ACCESS_KEY`.

Inline secret values are acceptable for short-lived local validation, but production users should manage secrets through their normal mechanism, such as External Secrets Operator, SOPS, Sealed Secrets, Vault, or cloud provider secret sync.

By default, the chart consumes the `deputies-postgres-app` secret created by `deputies-platform-reference`. For externally managed Postgres, point `postgres.existingSecret` at your platform secret, or set it to an empty string and provide `postgres.*` values so this chart creates a simple connection secret.

For static session auth with service subdomains, include `AUTH_STATIC_USERNAME` and `AUTH_STATIC_PASSWORD` in the referenced Secret, then set `config.authCookieDomain=.deputies.localhost` so the browser sends the session cookie to `s-<port>-<session>.deputies.localhost` hosts.
