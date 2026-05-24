#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
NAMESPACE="${K8S_SMOKE_NAMESPACE:-deputies-smoke}"
PLATFORM_RELEASE="${K8S_SMOKE_PLATFORM_RELEASE:-deputies-platform}"
APP_RELEASE="${K8S_SMOKE_APP_RELEASE:-deputies}"
ACCESS_MODE="${K8S_SMOKE_ACCESS_MODE:-cloud-provider-kind}"
INGRESS_CLASS="${K8S_SMOKE_INGRESS_CLASS:-traefik-$NAMESPACE}"
PLATFORM_CHART="$ROOT_DIR/deploy/kubernetes/charts/deputies-platform-reference"
APP_CHART="$ROOT_DIR/deploy/kubernetes/charts/deputies"
FORWARD_PID=""
SERVICE_HOST="s-3000-00000000-0000-4000-8000-000000000001.deputies-k8s.localhost"

cleanup() {
  if [[ -n "$FORWARD_PID" ]]; then
    kill "$FORWARD_PID" >/dev/null 2>&1 || true
  fi
  if [[ "${K8S_SMOKE_KEEP:-false}" != "true" ]]; then
    helm uninstall "$APP_RELEASE" -n "$NAMESPACE" >/dev/null 2>&1 || true
    helm uninstall "$PLATFORM_RELEASE" -n "$NAMESPACE" >/dev/null 2>&1 || true
    kubectl delete namespace "$NAMESPACE" --wait=false >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

wait_for_pod_selector() {
  local selector="$1"
  local timeout_seconds="$2"
  local deadline=$((SECONDS + timeout_seconds))
  while [[ $SECONDS -lt $deadline ]]; do
    if [[ -n "$(kubectl get pods --namespace "$NAMESPACE" -l "$selector" -o name 2>/dev/null)" ]]; then
      kubectl wait --namespace "$NAMESPACE" --for=condition=ready pod -l "$selector" --timeout="${timeout_seconds}s"
      return
    fi
    sleep 1
  done
  echo "Timed out waiting for pod selector: $selector" >&2
  kubectl get pods --namespace "$NAMESPACE" -o wide >&2 || true
  exit 1
}

validate_service_host_proxy() {
  local url="$1"
  local response_body
  local status
  response_body="$(mktemp)"
  status="$(curl -sS -o "$response_body" -w "%{http_code}" "$url" || true)"
  if [[ "$status" == "200" && "$(<"$response_body")" == *"Engineering agents for delegated work."* ]]; then
    echo "Service host was served by the web SPA instead of the service proxy: $url" >&2
    exit 1
  fi
  if [[ "$status" != "404" ]]; then
    echo "Expected service host proxy to return 404 for a missing preview session; got $status from $url" >&2
    exit 1
  fi
  rm -f "$response_body"
}

helm dependency update "$PLATFORM_CHART"

helm upgrade --install "$PLATFORM_RELEASE" "$PLATFORM_CHART" \
  --namespace "$NAMESPACE" \
  --create-namespace \
  --set postgresql.persistence.enabled=false \
  --set seaweedfs.persistence.enabled=false \
  --set traefik.ingressClass.name="$INGRESS_CLASS" \
  --set traefik.providers.kubernetesIngress.ingressClass="$INGRESS_CLASS" \
  --set traefik.providers.kubernetesIngress.namespaces[0]="$NAMESPACE" \
  --set traefik.ports.web.forwardedHeaders.insecure=true \
  --set traefik.ports.websecure.forwardedHeaders.insecure=true \
  --timeout=180s

kubectl wait --namespace "$NAMESPACE" --for=condition=available deployment/traefik --timeout=180s
wait_for_pod_selector app.kubernetes.io/component=postgres 180
wait_for_pod_selector app.kubernetes.io/component=seaweedfs 180

SMOKE_VALUES="$(mktemp)"
cat >"$SMOKE_VALUES" <<YAML
config:
  runner: fake
  sandboxProvider: fake
  apiAuthMode: none
  webBaseUrl: https://deputies-k8s.localhost
  serviceBaseDomain: deputies-k8s.localhost
  flueModel: fake/smoke-default
  hideSetupPage: "true"
  artifactStorageProvider: s3
  extraEnv:
    FLUE_MODEL_OPTIONS: fake/smoke-default,fake/smoke-fast
    GITHUB_ALLOWED_REPOSITORIES: acme/widget,acme/api
    FAKE_RUNNER_ARTIFACT_JSON: '{"type":"file","title":"Smoke Artifact","content":"hello artifact storage","contentType":"text/plain","fileName":"smoke-artifact.txt"}'
secrets:
  anthropicApiKey: ""
  openaiApiKey: ""
  daytonaApiKey: ""
ingress:
  className: $INGRESS_CLASS
  web:
    host: deputies-k8s.localhost
  services:
    enabled: true
    host: "*.deputies-k8s.localhost"
web:
  trustForwardedServiceHosts: true
YAML

helm upgrade --install "$APP_RELEASE" "$APP_CHART" \
  --namespace "$NAMESPACE" \
  -f "$SMOKE_VALUES" \
  --timeout=180s

kubectl wait --namespace "$NAMESPACE" --for=condition=available deployment/$APP_RELEASE-control-plane --timeout=180s
kubectl wait --namespace "$NAMESPACE" --for=condition=available deployment/$APP_RELEASE-web --timeout=180s

rm -f "$SMOKE_VALUES"

case "$ACCESS_MODE" in
  cloud-provider-kind)
    for _ in {1..120}; do
      INGRESS_IP="$(kubectl get ingress -n "$NAMESPACE" "$APP_RELEASE-web" -o jsonpath='{.status.loadBalancer.ingress[0].ip}' 2>/dev/null || true)"
      if [[ -n "$INGRESS_IP" ]]; then
        break
      fi
      sleep 1
    done
    if [[ -z "${INGRESS_IP:-}" ]]; then
      echo "Timed out waiting for Ingress external IP. Is cloud-provider-kind running?" >&2
      exit 1
    fi
    BASE_URL="http://$INGRESS_IP"
    HOST_RESOLVER_RULES=""
    ;;
  portless)
    kubectl port-forward -n "$NAMESPACE" service/traefik 15173:80 >/tmp/deputies-k8s-smoke-port-forward.log 2>&1 &
    FORWARD_PID="$!"
    pnpm dlx portless proxy start --wildcard >/dev/null
    pnpm dlx portless alias deputies-k8s 15173 --force >/dev/null
    BASE_URL="https://deputies-k8s.localhost"
    HOST_RESOLVER_RULES=""
    ;;
  port-forward)
    kubectl port-forward -n "$NAMESPACE" service/traefik 15173:80 >/tmp/deputies-k8s-smoke-port-forward.log 2>&1 &
    FORWARD_PID="$!"
    BASE_URL="http://deputies-k8s.localhost:15173"
    HOST_RESOLVER_RULES=""
    ;;
  *)
    echo "Unsupported K8S_SMOKE_ACCESS_MODE=$ACCESS_MODE; expected cloud-provider-kind, portless, or port-forward" >&2
    exit 1
    ;;
esac

for _ in {1..60}; do
  if curl -fsS "$BASE_URL/health" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

curl -fsS "$BASE_URL/health" >/dev/null

case "$ACCESS_MODE" in
  portless)
    validate_service_host_proxy "https://$SERVICE_HOST/"
    ;;
  cloud-provider-kind|port-forward)
    response_body="$(mktemp)"
    if [[ "$ACCESS_MODE" == "port-forward" ]]; then
      service_url="http://$SERVICE_HOST:15173/"
      status="$(curl -sS -o "$response_body" -w "%{http_code}" "$service_url" || true)"
    else
      status="$(curl -sS -H "Host: $SERVICE_HOST" -o "$response_body" -w "%{http_code}" "$BASE_URL/" || true)"
    fi
    if [[ "$status" == "200" && "$(<"$response_body")" == *"Engineering agents for delegated work."* ]]; then
      echo "Service host was served by the web SPA instead of the service proxy" >&2
      exit 1
    fi
    if [[ "$status" != "404" ]]; then
      echo "Expected service host proxy to return 404 for a missing preview session; got $status" >&2
      exit 1
    fi
    rm -f "$response_body"
    ;;
esac

PLAYWRIGHT_SKIP_WEB_SERVER=true \
PLAYWRIGHT_BASE_URL="$BASE_URL" \
PLAYWRIGHT_HOST_RESOLVER_RULES="$HOST_RESOLVER_RULES" \
RUN_FULL_STACK_SMOKE=true \
pnpm --dir "$ROOT_DIR/apps/web" exec playwright test e2e/full-stack-smoke.spec.ts --config playwright.config.ts --project chromium
