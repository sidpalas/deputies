# Deputies Chart

This chart deploys the Deputies application components on Kubernetes.

Topologies:

- `topology.mode=combined`: API and worker run in one control-plane deployment
- `topology.mode=split`: separate API and worker deployments
- `migrate`: one-shot database migration job, run as a Helm pre-install/pre-upgrade hook by default
- `web`: static web UI served by Caddy, proxying API routes to the stable API service

The chart supports `SANDBOX_PROVIDER=daytona` and `SANDBOX_PROVIDER=k8s-agent-sandbox`; it does not mount the Docker socket.

When `controlPlane.agentSandboxOrchestrator.enabled=true`, set a non-empty `secrets.agentSandboxOrchestratorToken` unless you provide the app Secret externally. The control-plane uses this bearer token when calling the separate in-cluster orchestrator, and the orchestrator rejects requests without it.

Agent Sandbox orchestration is same-namespace only for now. Leave `config.agentSandboxNamespace` empty or set it to the Helm release namespace.

For Portless plus a local Traefik forward, set `web.trustForwardedServiceHosts=true` so the web proxy routes wildcard service hosts from `Host`, `X-Forwarded-Host`, or `X-Original-Host`, matching the Docker Compose local Caddy behavior. Also configure Traefik to trust forwarded headers through the platform chart; otherwise service previews may open the Deputies home page or setup guide instead of the sandbox service.

The chart renders Kubernetes `Ingress` by default. Set `routing.mode=gateway` to render Gateway API `HTTPRoute` resources instead; the default parent is a `Gateway` named `traefik-gateway` in the release namespace. Override `gateway.parentRef.name`, `gateway.parentRef.namespace`, or `gateway.parentRef.sectionName` when using a different Gateway API controller or shared Gateway.

Default routing is host-matched and intended for real clusters: point DNS for `ingress.web.host` / `ingress.services.host` or `gateway.web.host` / `gateway.services.host` at your ingress controller or Gateway load balancer. For local Portless development through a forwarded Traefik port, use hostless routing by setting `ingress.web.host=''`, `ingress.services.enabled=false`, `gateway.web.host=''`, and `gateway.services.host=''`.

Required local Portless app-chart values:

```sh
--set-string ingress.web.host= \
--set ingress.services.enabled=false \
--set-string gateway.web.host= \
--set-string gateway.services.host= \
--set web.trustForwardedServiceHosts=true
```

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

Install with separate API and worker deployments:

```sh
helm upgrade --install deputies deploy/kubernetes/charts/deputies \
  --namespace deputies \
  --set topology.mode=split
```

For real agent work in production, reference a Kubernetes Secret instead of putting secret values in Helm values:

```sh
helm upgrade --install deputies deploy/kubernetes/charts/deputies \
  --namespace deputies \
  --set secrets.create=false \
  --set secrets.name=deputies-app-secrets
```

The referenced Secret should contain the environment-variable keys the app needs, such as `AUTH_SESSION_SECRET`, `GITHUB_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_SECRET`, `DAYTONA_API_KEY`, `ANTHROPIC_API_KEY`, `OPENCODE_API_KEY`, `ARTIFACT_STORAGE_S3_ACCESS_KEY_ID`, and `ARTIFACT_STORAGE_S3_SECRET_ACCESS_KEY`.

Inline secret values are acceptable for short-lived local validation, but production users should manage secrets through their normal mechanism, such as External Secrets Operator, SOPS, Sealed Secrets, Vault, or cloud provider secret sync.

By default, the chart consumes the `deputies-postgres-app` secret created by `deputies-platform-reference`. For externally managed Postgres, point `postgres.existingSecret` at your platform secret, or set it to an empty string and provide `postgres.*` values so this chart creates a simple connection secret. Set `postgres.sslMode` when the database requires SSL, for example `postgres.sslMode=require&uselibpqcompat=true` for providers that require TLS but present a self-signed certificate chain.

For static session auth, include `AUTH_STATIC_USERNAME` and `AUTH_STATIC_PASSWORD` in the referenced Secret. For GitHub session auth, set `config.apiAuthMode=session`, `config.authProvider=github`, `secrets.githubOAuthClientId`, `secrets.githubOAuthClientSecret`, and one or more access controls such as `config.authGithubAdminUsers`, `config.authGithubAllowedUsers`, or `config.authGithubAllowedOrganizations`. `config.authGithubDefaultGroupRole` controls default access-group membership for non-admin GitHub users, and `config.unsafeAuthGithubAllowAll=true` is only intended for public trial access.

Service subdomains use signed preview tokens and preview-only cookies; the main session cookie stays host-only.

Pods roll automatically when chart-rendered config or chart-created Secrets change. If you use externally managed Secrets, bump `rollout.revision` during `helm upgrade` after changing Secret data so Kubernetes replaces pods that consume those values as environment variables.

## Workload Identity

The chart intentionally exposes generic Kubernetes hooks for cloud workload identity without modeling provider-specific auth modes before the app supports them.

Use `serviceAccount.annotations` for identity bindings such as AWS IRSA, EKS Pod Identity, or GKE Workload Identity. Use `serviceAccount.create=false` and `serviceAccount.name=<name>` to run the control-plane API/worker workloads and migration job with a platform-managed Kubernetes service account.

When `controlPlane.agentSandboxOrchestrator.enabled=true`, the chart creates a separate orchestrator service account by default and binds Agent Sandbox RBAC to that service account instead of the control-plane service account. Override it with `controlPlane.agentSandboxOrchestrator.serviceAccount.*` when using a platform-managed identity for the orchestrator. In in-process mode, Agent Sandbox RBAC stays bound to the main `serviceAccount.*` account because the control-plane creates sandbox resources directly.

Use per-workload pod metadata for identity systems that require labels or annotations on pods. The chart exposes `controlPlane.all.podLabels`, `controlPlane.all.podAnnotations`, `controlPlane.api.podLabels`, `controlPlane.api.podAnnotations`, `controlPlane.worker.podLabels`, `controlPlane.worker.podAnnotations`, `migrations.podLabels`, and `migrations.podAnnotations`. For example, Azure Workload Identity commonly requires `azure.workload.identity/use: "true"` on pods.

Helm creates `pre-install` hooks before normal chart resources, so a first-install migration job cannot rely on a ServiceAccount created by the same chart. On first install, the migration job omits `serviceAccountName` and uses the namespace default ServiceAccount unless `migrations.serviceAccountName` is set. On upgrade, the chart-created ServiceAccount already exists, so the migration job uses it by default. For first-install workload identity on migrations, set `migrations.serviceAccountName` to a pre-provisioned ServiceAccount used only by the migration job, or set `serviceAccount.create=false` and point `serviceAccount.name` at an externally managed ServiceAccount.

Current app-side limitations:

- S3-compatible artifact storage currently requires static `ARTIFACT_STORAGE_S3_ACCESS_KEY_ID` and `ARTIFACT_STORAGE_S3_SECRET_ACCESS_KEY` values. Ambient SDK credentials from workload identity need an app change before the chart should expose a first-class `ambient` S3 credential mode.
- Postgres currently uses a static `DATABASE_URL` built from the configured Postgres Secret. RDS IAM auth or similar token-based database auth needs an app change to generate and refresh database auth tokens before the chart should expose a first-class `postgres.authMode=aws-rds-iam` mode.

The reference platform's in-cluster Postgres and SeaweedFS are local validation services. Production installs should point this chart at platform-managed Postgres and object storage services.
