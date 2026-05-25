# Deputies Chart

This chart deploys the Deputies application components on Kubernetes.

Current topology:

- `control-plane`: ALL mode, running API and workers in one deployment
- `migrate`: one-shot database migration job, run as a Helm post-install/post-upgrade hook by default
- `web`: static web UI served by Caddy, proxying API routes to control-plane

The chart is currently oriented around `SANDBOX_PROVIDER=daytona` and does not mount the Docker socket.

For Portless plus a local Traefik forward, set `web.trustForwardedServiceHosts=true` so the web proxy routes wildcard service hosts from `X-Forwarded-Host`, matching the Docker Compose local Caddy behavior. Also configure Traefik to trust forwarded headers through the platform chart.

The chart renders Kubernetes `Ingress` by default. Set `routing.mode=gateway` to render Gateway API `HTTPRoute` resources instead; the default parent is a `Gateway` named `traefik-gateway` in the release namespace. Override `gateway.parentRef.name`, `gateway.parentRef.namespace`, or `gateway.parentRef.sectionName` when using a different Gateway API controller or shared Gateway.

Install with the reference platform chart:

```sh
helm upgrade --install deputies deploy/kubernetes/charts/deputies --namespace deputies
```

Install with Gateway API routes:

```sh
helm upgrade --install deputies deploy/kubernetes/charts/deputies \
  --namespace deputies \
  --set routing.mode=gateway
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

For static session auth with service subdomains, include `AUTH_STATIC_USERNAME` and `AUTH_STATIC_PASSWORD` in the referenced Secret, then set `config.authCookieDomain=.deputies-k8s.localhost` so the browser sends the session cookie to `s-<port>-<session>.deputies-k8s.localhost` hosts.

## Workload Identity

The chart intentionally exposes generic Kubernetes hooks for cloud workload identity without modeling provider-specific auth modes before the app supports them.

Use `serviceAccount.annotations` for identity bindings such as AWS IRSA, EKS Pod Identity, or GKE Workload Identity. Use `serviceAccount.create=false` and `serviceAccount.name=<name>` to run the control-plane and migration job with a platform-managed Kubernetes service account.

Use per-workload pod metadata for identity systems that require labels or annotations on pods. The chart exposes `controlPlane.podLabels`, `controlPlane.podAnnotations`, `migrations.podLabels`, and `migrations.podAnnotations`. For example, Azure Workload Identity commonly requires `azure.workload.identity/use: "true"` on pods.

Current app-side limitations:

- S3-compatible artifact storage currently requires static `ARTIFACT_STORAGE_S3_ACCESS_KEY_ID` and `ARTIFACT_STORAGE_S3_SECRET_ACCESS_KEY` values. Ambient SDK credentials from workload identity need an app change before the chart should expose a first-class `ambient` S3 credential mode.
- Postgres currently uses a static `DATABASE_URL` built from the configured Postgres Secret. RDS IAM auth or similar token-based database auth needs an app change to generate and refresh database auth tokens before the chart should expose a first-class `postgres.authMode=aws-rds-iam` mode.

The reference platform's in-cluster Postgres and SeaweedFS are local validation services. Production installs should point this chart at platform-managed Postgres and object storage services.
