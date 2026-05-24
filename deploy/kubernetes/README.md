# Kubernetes Deployment

This directory contains Helm charts and local validation helpers for running Deputies on Kubernetes.

Charts:

- `charts/deputies-platform-reference`: reference-only auxiliary platform services. It installs Traefik, a simple Postgres StatefulSet, and SeaweedFS S3-compatible artifact storage. Use this for local validation or as an example, not as a production platform blueprint.
- `charts/deputies`: Deputies application components. The current chart deploys the ALL variant: one control-plane deployment, one migration job, and the web deployment.

For production, prefer your organization's standard ingress, database, object storage, observability, and secret management patterns. Install `charts/deputies` against those services directly.

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

Then set a domain-scoped cookie and reference the Secret:

```sh
helm upgrade --install deputies deploy/kubernetes/charts/deputies \
  --namespace deputies \
  --reuse-values \
  --set secrets.create=false \
  --set secrets.name=deputies-app-secrets \
  --set config.apiAuthMode=session \
  --set config.authProvider=static \
  --set config.authCookieDomain=.deputies.localhost \
  --wait
```

After changing cookie domain, log out/in or clear old host-only cookies.

## Kind Host Access

For kind clusters, run `cloud-provider-kind` when you want LoadBalancer-style access from the host:

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
curl -H 'Host: deputies.localhost' http://<TRAEFIK_EXTERNAL_IP>/health
```

For browser access without Portless, add concrete hostnames to `/etc/hosts`:

```txt
<TRAEFIK_EXTERNAL_IP> deputies.localhost
<TRAEFIK_EXTERNAL_IP> s-3000-<session-id>.deputies.localhost
```

`/etc/hosts` does not support wildcards, so dynamic exposed service hosts need either concrete entries, a wildcard-capable local DNS resolver, or Portless.

## Portless Access

Portless is useful when you want trusted local HTTPS and wildcard `.localhost` routing.

Portless aliases local ports, not arbitrary LoadBalancer IPs. Put a local forward in front of Traefik, then alias that local port:

```sh
socat TCP-LISTEN:15173,bind=127.0.0.1,reuseaddr,fork TCP:<TRAEFIK_EXTERNAL_IP>:80
pnpm dlx portless proxy start --wildcard
pnpm dlx portless alias deputies 15173 --force
```

If you do not want `socat`, use `kubectl port-forward`:

```sh
kubectl port-forward -n deputies service/traefik 15173:80
pnpm dlx portless proxy start --wildcard
pnpm dlx portless alias deputies 15173 --force
```

For Portless plus Traefik, configure Traefik to trust forwarded headers and configure the web Caddy proxy to route service hosts from `X-Forwarded-Host`:

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
  --set web.trustForwardedServiceHosts=true \
  --wait
```

Why both are needed:

- Portless forwards wildcard requests with `X-Forwarded-Host: s-<port>-<session>.deputies.localhost` and an upstream `Host` like `127.0.0.1:15173`.
- Traefik must not discard the forwarded host metadata.
- The web Caddyfile must route service hosts from `X-Forwarded-Host`, matching the Docker Compose local Caddy behavior.

Open the app:

```txt
https://deputies.localhost
```

Exposed service links use hosts like:

```txt
https://s-3000-<session-id>.deputies.localhost
```

## Smoke Test

Run the Kubernetes smoke test against an empty kind cluster:

```sh
pnpm smoke:kubernetes
```

The smoke test installs both charts into `deputies-smoke`, runs the existing full-stack Playwright smoke, and validates artifact creation/download through SeaweedFS-backed storage.

Access modes:

- `K8S_SMOKE_ACCESS_MODE=cloud-provider-kind`: uses Traefik's LoadBalancer/Ingress IP. This is the default and expects `cloud-provider-kind` to be running.
- `K8S_SMOKE_ACCESS_MODE=portless`: starts Portless and port-forwards Traefik to a local port for `https://deputies.localhost`.
- `K8S_SMOKE_ACCESS_MODE=port-forward`: skips Portless and uses `http://127.0.0.1:15173`.

Keep resources for debugging:

```sh
K8S_SMOKE_KEEP=true pnpm smoke:kubernetes
```

The fake-runner smoke validates artifacts. Exposed sandbox service creation/access requires a real sandbox provider with preview URL support, such as Daytona, so it is not part of the default fake-runner smoke path.

## Future Split Topology

The split control-plane deployment should be a configuration mode in the `deputies` chart, not a separate chart. It is the same application and should share image, secret, migration, web, and ingress configuration with the ALL topology.
