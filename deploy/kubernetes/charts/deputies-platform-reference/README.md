# Deputies Platform Reference Chart

This chart is a reference implementation for quickly bootstrapping auxiliary services needed by a Deputies Kubernetes deployment.

It is not a production blueprint. Teams should use their own deployment patterns for ingress, database lifecycle, backups, object storage, observability, and secret management.

It installs:

- Traefik ingress controller, optionally with Gateway API provider enabled
- A simple Postgres StatefulSet with Deputies app credentials
- SeaweedFS with its S3-compatible API enabled
- Optional Kubernetes SIG agent-sandbox CRDs/controller from pinned release manifests

The chart uses Traefik's upstream Helm chart. Run `helm dependency update deploy/kubernetes/charts/deputies-platform-reference` before installing from a fresh checkout.

When `agentSandbox.enabled=true`, this chart installs agent-sandbox with the upstream release `manifest.yaml` because the project includes Helm chart source but does not currently publish a consumable Helm chart repository or packaged chart release. If upstream publishes one later, prefer replacing the installer job with a normal Helm dependency.

Traefik supports Gateway API, so this chart does not install Envoy Gateway by default. To use Gateway API with the reference platform, install the Gateway API v1.5.1 experimental CRDs first and enable Traefik's Gateway API provider:

```sh
kubectl apply --server-side=true -f https://github.com/kubernetes-sigs/gateway-api/releases/download/v1.5.1/experimental-install.yaml

helm upgrade --install deputies-platform deploy/kubernetes/charts/deputies-platform-reference \
  --namespace deputies \
  --create-namespace \
  --set traefik.providers.kubernetesGateway.enabled=true \
  --wait
```

This creates a `GatewayClass` named `traefik` and a `Gateway` named `traefik-gateway`. If you prefer Envoy Gateway or another Gateway API implementation, install it outside this reference chart and configure the app chart's `gateway.parentRef.*` values to attach to that Gateway.

Traefik 3.7 watches Gateway API route kinds beyond `HTTPRoute`, so the experimental Gateway API bundle is required for this reference chart even if Deputies only creates `HTTPRoute` resources.

The companion `deputies` chart defaults to these service names:

- Postgres service: `postgres-rw`
- Postgres app secret: `deputies-postgres-app`
- SeaweedFS S3 endpoint: `http://seaweedfs:8333`
- SeaweedFS secret: `<release-name>-seaweedfs`
- SeaweedFS credentials: `seaweed` / `seaweed`

For production, install `deputies` separately and point it at platform-managed Postgres and S3-compatible storage. This chart's Postgres StatefulSet is intentionally basic and is not production database guidance.

For local Portless routing through Traefik, enable forwarded header trust. This is required for wildcard service preview hosts; without it, `https://s-<port>-<session>.deputies-k8s.localhost` can route to the Deputies home page or setup guide instead of the sandbox service.

```sh
helm upgrade deputies-platform deploy/kubernetes/charts/deputies-platform-reference \
  --namespace deputies \
  --reuse-values \
  --set traefik.ports.web.forwardedHeaders.insecure=true \
  --set traefik.ports.websecure.forwardedHeaders.insecure=true \
  --wait
```
