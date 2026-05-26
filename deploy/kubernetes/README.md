# Kubernetes Deployment

This directory contains Helm charts and local validation helpers for running Deputies on Kubernetes.

Charts:

- `charts/deputies-platform-reference`: reference-only auxiliary platform services. It installs Traefik, a simple Postgres StatefulSet, and SeaweedFS S3-compatible artifact storage. Use this for local validation or as an example, not as a production platform blueprint.
- `charts/deputies`: Deputies application components. The current chart deploys the ALL variant: one control-plane deployment, one migration job, and the web deployment.

For production, prefer your organization's standard ingress, database, object storage, observability, and secret management patterns. Install `charts/deputies` against those services directly.

Traefik supports Gateway API. The reference platform chart keeps Traefik as the default controller and can enable Traefik's Gateway API provider instead of adding a second controller such as Envoy Gateway. If you prefer Envoy Gateway or another Gateway API implementation, install that platform controller separately and point `charts/deputies` at its `Gateway` with `gateway.parentRef.*` values.

The app chart includes generic workload identity hooks through Kubernetes service account annotations and per-workload pod labels/annotations. It does not yet provide first-class app modes for ambient S3 credentials or RDS IAM database auth; those require app-side credential handling changes before the Helm values should expose provider-specific auth modes.

## Mise Tasks

Run these from `deploy/kubernetes`:

```sh
mise run deps
mise run platform:install
mise run app:install:fake
mise run smoke:port-forward
```

For real Daytona-backed work, create or sync the app Secret first, then run:

```sh
mise run app:install:daytona
```

You can load credentials through 1Password when creating the referenced Secret:

```sh
op run --env-file=../../.env.local -- sh -c 'kubectl create secret generic deputies-app-secrets --namespace deputies --from-literal=AUTH_SESSION_SECRET="$(openssl rand -hex 32)" --from-literal=DAYTONA_API_KEY="$DAYTONA_API_KEY" --from-literal=ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" --from-literal=ARTIFACT_STORAGE_S3_ACCESS_KEY_ID=seaweed --from-literal=ARTIFACT_STORAGE_S3_SECRET_ACCESS_KEY=seaweed --dry-run=client -o yaml | kubectl apply -f -'
mise run app:install:daytona
```

## Install

Install the reference platform:

```sh
helm dependency update deploy/kubernetes/charts/deputies-platform-reference

helm upgrade --install deputies-platform deploy/kubernetes/charts/deputies-platform-reference \
  --namespace deputies \
  --create-namespace \
  --wait
```

Install Deputies in fake mode for validation:

```sh
helm upgrade --install deputies deploy/kubernetes/charts/deputies \
  --namespace deputies \
  --set config.runner=fake \
  --set config.sandboxProvider=fake \
  --set config.hideSetupPage=true \
  --wait
```

By default, the app chart creates host-matched Ingress or Gateway API routing for `deputies-k8s.localhost` and `*.deputies-k8s.localhost`. This is the intended shape for real clusters: use DNS records that point those hostnames at your ingress controller or Gateway load balancer. For local Portless development, use the hostless override documented below.

To use Gateway API instead of Ingress with the reference Traefik chart, install the Gateway API v1.5.1 experimental CRDs first, enable Traefik's Gateway API provider in the reference platform chart, and enable Gateway API routes in the app chart:

```sh
kubectl apply --server-side=true -f https://github.com/kubernetes-sigs/gateway-api/releases/download/v1.5.1/experimental-install.yaml

helm upgrade --install deputies-platform deploy/kubernetes/charts/deputies-platform-reference \
  --namespace deputies \
  --create-namespace \
  --set traefik.providers.kubernetesGateway.enabled=true \
  --wait

helm upgrade --install deputies deploy/kubernetes/charts/deputies \
  --namespace deputies \
  --set routing.mode=gateway \
  --set config.runner=fake \
  --set config.sandboxProvider=fake \
  --set config.hideSetupPage=true \
  --wait
```

With `routing.mode=gateway`, the app chart renders `HTTPRoute` resources instead of its default `Ingress` resource. The default parent is the reference platform Gateway named `traefik-gateway` in the same namespace.

Traefik 3.7 watches Gateway API route kinds beyond `HTTPRoute`, so the experimental Gateway API bundle is required for this reference chart even if Deputies only creates `HTTPRoute` resources.

Inline secret values are convenient for short-lived local validation. For production installs, do not put secret values in Helm values, shell history, or Git. Manage secrets the same way you manage other platform secrets, such as External Secrets Operator, SOPS, Sealed Secrets, Vault, or cloud provider secret sync. The app chart can reference the resulting Kubernetes Secret.

The app chart expects environment-variable style keys in the referenced Secret.

Example local secret creation for validation:

```sh
kubectl create secret generic deputies-app-secrets \
  --namespace deputies \
  --from-literal=AUTH_SESSION_SECRET="$(openssl rand -hex 32)" \
  --from-literal=DAYTONA_API_KEY="$DAYTONA_API_KEY" \
  --from-literal=ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
  --from-literal=ARTIFACT_STORAGE_S3_ACCESS_KEY_ID=seaweed \
  --from-literal=ARTIFACT_STORAGE_S3_SECRET_ACCESS_KEY=seaweed \
  --dry-run=client -o yaml | kubectl apply -f -
```

Install Deputies with Daytona by referencing that Secret:

```sh
helm upgrade --install deputies deploy/kubernetes/charts/deputies \
  --namespace deputies \
  --set secrets.create=false \
  --set secrets.name=deputies-app-secrets \
  --wait
```

For quick fake-mode validation, inline chart defaults are fine. For any shared or production install, use `secrets.create=false` and `secrets.name=<managed-secret-name>`.

If using static session auth with service subdomains in production, add those keys to the managed Secret. For local validation, creating the Secret directly is fine:

```sh
kubectl create secret generic deputies-app-secrets \
  --namespace deputies \
  --from-literal=AUTH_SESSION_SECRET="$(openssl rand -hex 32)" \
  --from-literal=AUTH_STATIC_USERNAME=admin \
  --from-literal=AUTH_STATIC_PASSWORD=password \
  --from-literal=ARTIFACT_STORAGE_S3_ACCESS_KEY_ID=seaweed \
  --from-literal=ARTIFACT_STORAGE_S3_SECRET_ACCESS_KEY=seaweed \
  --dry-run=client -o yaml | kubectl apply -f -
```

Then enable session auth and reference the Secret:

```sh
helm upgrade --install deputies deploy/kubernetes/charts/deputies \
  --namespace deputies \
  --reuse-values \
  --set secrets.create=false \
  --set secrets.name=deputies-app-secrets \
  --set config.apiAuthMode=session \
  --set config.authProvider=static \
  --wait
```

After changing cookie settings, log out/in or clear old cookies.

## Managed Services

When using managed object storage instead of the reference SeaweedFS service, override the S3 settings for your provider and keep static S3 credentials in the referenced app Secret. For example, Civo Object Store uses the provider endpoint and region, disables app-side bucket creation, and uses path-style requests:

```sh
kubectl patch secret deputies-app-secrets \
  --namespace deputies \
  --type merge \
  -p '{"stringData":{"ARTIFACT_STORAGE_S3_ACCESS_KEY_ID":"<access-key-id>","ARTIFACT_STORAGE_S3_SECRET_ACCESS_KEY":"<secret-access-key>"}}'

helm upgrade --install deputies deploy/kubernetes/charts/deputies \
  --namespace deputies \
  --reuse-values \
  --set config.artifactStorageS3Endpoint=https://objectstore.nyc1.civo.com \
  --set config.artifactStorageS3Region=nyc1 \
  --set config.artifactStorageS3Bucket=deputies-artifacts \
  --set config.artifactStorageS3ForcePathStyle=true \
  --set config.artifactStorageS3CreateBucket=false \
  --wait
```

Static session auth needs both Secret keys and Helm config. Put `AUTH_STATIC_USERNAME` and `AUTH_STATIC_PASSWORD` in the referenced app Secret, then set `config.apiAuthMode=session` and `config.authProvider=static`. Service previews use signed preview tokens and preview-only cookies, so no shared cookie domain is required.

## Kind Host Access

For kind clusters, run `cloud-provider-kind` when you want LoadBalancer-style access from the host while keeping real-cluster-style host-matched Ingress routing:

```sh
go install sigs.k8s.io/cloud-provider-kind@latest
sudo cloud-provider-kind
```

Keep `cloud-provider-kind` running in a separate terminal. It assigns an external IP to Traefik's `LoadBalancer` service and updates Ingress status.

Check the assigned IP:

```sh
kubectl get svc traefik -n deputies
kubectl get ingress deputies-web -n deputies
```

Direct test:

```sh
curl -H 'Host: deputies-k8s.localhost' http://<TRAEFIK_EXTERNAL_IP>/health
```

For browser access without Portless, add concrete hostnames to `/etc/hosts`:

```txt
<TRAEFIK_EXTERNAL_IP> deputies-k8s.localhost
<TRAEFIK_EXTERNAL_IP> s-3000-<session-id>.deputies-k8s.localhost
```

`/etc/hosts` does not support wildcards, so dynamic exposed service hosts need either concrete entries, a wildcard-capable local DNS resolver, or Portless.

## Portless Access

Portless is useful when you want trusted local HTTPS and wildcard `.localhost` routing without editing `/etc/hosts` for each service hostname. This is a local-development path, not the default real-cluster routing shape.

Portless aliases local ports, not arbitrary LoadBalancer IPs. Put a local forward in front of Traefik, then alias that local port:

```sh
socat TCP-LISTEN:15173,bind=127.0.0.1,reuseaddr,fork TCP:<TRAEFIK_EXTERNAL_IP>:80
pnpm dlx portless proxy start --wildcard
pnpm dlx portless alias deputies-k8s 15173 --force
```

On macOS, install `socat` with Homebrew if needed:

```sh
brew install socat
```

If you do not want `socat`, use `kubectl port-forward`:

```sh
kubectl port-forward -n deputies service/traefik 15173:80
pnpm dlx portless proxy start --wildcard
pnpm dlx portless alias deputies-k8s 15173 --force
```

For Portless plus Traefik, all of these settings are required. Turn off app-chart host matching, configure the web Caddy proxy to route forwarded service hosts, and configure Traefik to preserve forwarded host metadata:

```sh
helm upgrade deputies-platform deploy/kubernetes/charts/deputies-platform-reference \
  --namespace deputies \
  --reuse-values \
  --set traefik.ports.web.forwardedHeaders.insecure=true \
  --set traefik.ports.websecure.forwardedHeaders.insecure=true \
  --wait

helm upgrade deputies deploy/kubernetes/charts/deputies \
  --namespace deputies \
  --reuse-values \
  --set-string ingress.web.host= \
  --set ingress.services.enabled=false \
  --set-string gateway.web.host= \
  --set-string gateway.services.host= \
  --set web.trustForwardedServiceHosts=true \
  --wait
```

Why both are needed:

- Portless forwards requests to Traefik through a local port, so Traefik may see an upstream `Host` like `127.0.0.1:15173` instead of `deputies-k8s.localhost`; hostless Ingress or `HTTPRoute` matching avoids Traefik returning `404` before the request reaches the app.
- Portless forwards wildcard service requests with host metadata such as `X-Forwarded-Host: s-<port>-<session>.deputies-k8s.localhost` or `X-Original-Host: s-<port>-<session>.deputies-k8s.localhost`.
- Traefik must not discard the forwarded host metadata.
- The web Caddyfile must route service hosts from `Host`, `X-Forwarded-Host`, or `X-Original-Host`, matching the Docker Compose local Caddy behavior.

If a preview URL such as `https://s-3000-<session-id>.deputies-k8s.localhost` opens the Deputies home page or setup guide instead of the sandbox service, one of the local Portless settings above is missing or stale. Check the live state with:

```sh
helm get values deputies-platform --namespace deputies
helm get values deputies --namespace deputies
kubectl exec --namespace deputies deployment/deputies-web -- sed -n '1,45p' /etc/caddy/Caddyfile
```

The platform values must include both Traefik `forwardedHeaders.insecure=true` settings, and the app values must include `web.trustForwardedServiceHosts=true` with hostless local routing.

Keep the host-matched defaults for real cluster DNS/LB installs. Only use the hostless override for local Portless access.

Open the app:

```txt
https://deputies-k8s.localhost
```

Exposed service links use hosts like:

```txt
https://s-3000-<session-id>.deputies-k8s.localhost
```

## Smoke Test

Run the Kubernetes smoke test against an empty kind cluster:

```sh
pnpm smoke:kubernetes
```

Run both supported app topologies:

```sh
pnpm smoke:kubernetes:matrix
```

The smoke test installs both charts into `deputies-smoke`, runs the existing full-stack Playwright smoke, and validates artifact creation/download through SeaweedFS-backed storage.

Topology modes:

- `K8S_SMOKE_TOPOLOGY_MODE=combined`: deploys the default combined API/worker control-plane process.
- `K8S_SMOKE_TOPOLOGY_MODE=split`: deploys separate API and worker deployments.

Access modes:

- `K8S_SMOKE_ACCESS_MODE=cloud-provider-kind`: uses Traefik's LoadBalancer/Ingress IP. This is the default and expects `cloud-provider-kind` to be running.
- `K8S_SMOKE_ACCESS_MODE=portless`: starts Portless and port-forwards Traefik to a local port for `https://deputies-k8s.localhost`.
- `K8S_SMOKE_ACCESS_MODE=port-forward`: skips Portless and uses `http://deputies-k8s.localhost:15173`.

Keep resources for debugging:

```sh
K8S_SMOKE_KEEP=true pnpm smoke:kubernetes
```

The fake-runner smoke validates artifacts. Exposed sandbox service creation/access requires a real sandbox provider with preview URL support, such as Daytona, so it is not part of the default fake-runner smoke path.
