# Deputies Platform Reference Chart

This chart is a reference implementation for quickly bootstrapping auxiliary services needed by a Deputies Kubernetes deployment.

It is not a production blueprint. Teams should use their own deployment patterns for ingress, database lifecycle, backups, object storage, observability, and secret management.

It installs:

- Traefik ingress controller
- A simple Postgres StatefulSet with Deputies app credentials
- SeaweedFS with its S3-compatible API enabled

The chart uses Traefik's upstream Helm chart. Run `helm dependency update deploy/kubernetes/charts/deputies-platform-reference` before installing from a fresh checkout.

The companion `deputies` chart defaults to these service names:

- Postgres service: `postgres-rw`
- Postgres app secret: `deputies-postgres-app`
- SeaweedFS S3 endpoint: `http://seaweedfs:8333`
- SeaweedFS secret: `<release-name>-seaweedfs`
- SeaweedFS credentials: `seaweed` / `seaweed`

For production, install `deputies` separately and point it at platform-managed Postgres and S3-compatible storage. This chart's Postgres StatefulSet is intentionally basic and is not production database guidance.

For local Portless routing through Traefik, enable forwarded header trust:

```sh
helm upgrade deputies-platform deploy/kubernetes/charts/deputies-platform-reference \
  --namespace deputies \
  --reuse-values \
  --set traefik.ports.web.forwardedHeaders.insecure=true \
  --set traefik.ports.websecure.forwardedHeaders.insecure=true \
  --wait
```
