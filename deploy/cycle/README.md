# Cycle Experiment

This runbook records a disposable Deputies deployment on Cycle. It uses real Postgres, API, worker, and browser authentication, but fake agent execution. It is not a production reference deployment or an automated deployment template.

See the [general deployment guide](../../docs/deployment.md) for provider-independent configuration.

## Topology And Placement

Run one instance of each application container in one Cycle environment:

| Identifier | Responsibility                            | Network                                      | Persistent storage                   |
| ---------- | ----------------------------------------- | -------------------------------------------- | ------------------------------------ |
| `postgres` | Postgres                                  | Private, port 5432                           | `/var/lib/postgresql/data`           |
| `api`      | API and worker in one Node process        | Private, port 3583                           | Product and runner state in Postgres |
| `web`      | Caddy, static frontend, API reverse proxy | Public through the environment load balancer | None                                 |

Cycle also runs environment services such as discovery, scheduler, gateway, and load balancer. These are additional to the three application containers.

Inspect the hub, cluster, node health, available capacity, and workload-sharing restrictions before deploying. Start the environment services before relying on private hostnames. Constrain placement to the intended node or node tags rather than allowing placement on unrelated shared nodes.

The experiment used the `development` cluster and a Cycle-provisioned AWS `t3a.medium` node in `us-east-1a` after the existing local VM was offline. The first provisioning attempt failed in an unsupported availability zone; checking regional model availability alone was insufficient. Inspect the provisioning job and actual node health before retrying or deploying workloads. Do not provision a replacement or change an existing node's cluster membership without authorization.

## Images

The experiment imported existing CI-published GHCR images; no Docker Hub publication or source build was needed:

- `ghcr.io/sidpalas/deputies-control-plane:sha-e9abe97`
- `ghcr.io/sidpalas/deputies-web:sha-e9abe97`
- Official `postgres:17.11-alpine`

Both application tags came from source commit `e9abe97af4f8a361fabbda26d2ac90a8d14cb925`. For another deployment, select a compatible published pair from the same commit; these are historical experiment pins, not a recommendation to stay on that version indefinitely.

Cycle image sources were named `deputies-api`, `deputies-web`, and `deputies-postgres`. Create the sources, import the images, and wait for import completion before deploying the stack. Creating a source does not mean an imported image is ready. This experiment's registry import rejected a digest-form target; it used the commit tags above and retained the resulting Cycle image IDs. Do not assume those short tags provide digest-level immutability.

## Configuration And Secrets

Postgres configuration:

```dotenv
POSTGRES_USER=deputies
POSTGRES_DB=deputies
```

Mount a persistent local volume at `/var/lib/postgresql/data` (5 GB in the experiment). This preserves data across container restarts, but does not replace backups or protect against losing the node or deleting the volume. Keep Postgres private.

Configure Cycle scoped variables, marked as secrets, with the following container scopes:

| Variable               | Scope           | Value                                                        |
| ---------------------- | --------------- | ------------------------------------------------------------ |
| `POSTGRES_PASSWORD`    | `postgres` only | A generated random database password                         |
| `DATABASE_URL`         | `api` only      | `postgres://deputies:<same-password>@postgres:5432/deputies` |
| `AUTH_STATIC_PASSWORD` | `api` only      | A separate generated login password                          |
| `AUTH_SESSION_SECRET`  | `api` only      | A separate generated session-signing secret                  |

Generate the database password once and use it in both variables. URI-encode it when constructing `DATABASE_URL` if it contains reserved characters; a random hexadecimal password avoids that issue. Never bake secrets into images or the stack source. Cycle's raw secret-marked variables can still be retrieved by sufficiently privileged API credentials; do not print API responses containing their values.

The official Postgres image initializes credentials only when its data directory is empty. Changing `POSTGRES_PASSWORD` on an existing volume does not rotate the database role's password; coordinate an actual role-password change with the API connection string. Keep the session secret stable across restarts so existing logins remain valid.

API configuration for the HTTPS experiment:

```dotenv
PORT=3583
RUN_MODE=combined
APP_DATA_STORE=postgres
RUNNER_STATE_STORE=postgres
RUNNER=fake
SANDBOX_PROVIDER=fake
WORKER_CONCURRENCY=1
ARTIFACT_STORAGE_PROVIDER=disabled
WEB_SEARCH_PROVIDER=disabled
TITLE_GENERATION_ENABLED=false
OTEL_SDK_DISABLED=true
API_AUTH_MODE=session
AUTH_PROVIDER=static
AUTH_STATIC_USERNAME=deputies
AUTH_COOKIE_SECURE=true
WEB_BASE_URL=https://cycle.deputies.dev
HIDE_SETUP_PAGE=true
```

Use your own public origin for `WEB_BASE_URL`. For private plain-HTTP testing before ingress exists, use `AUTH_COOKIE_SECURE=false`; enable secure cookies once serving through HTTPS. `HIDE_SETUP_PAGE=true` skips the automatic setup-guide opening; it does not configure missing providers or remove the setup APIs.

Web configuration:

```dotenv
PORT=5173
API_UPSTREAM=http://api:3583
SERVICE_HOST_REGEX=^$
```

`SERVICE_HOST_REGEX=^$` disables sandbox service-host routing for this application-only experiment. The stock Caddy configuration proxies browser API paths (including `/auth*`, `/sessions*`, and `/health`) to the private API. There is no separate browser API hostname or build-time API URL needed for this same-origin deployment.

No Redis, Docker socket, object-storage service, model credentials, or real sandbox credentials were required for this configuration. Artifact storage and external features above are disabled, not validated. Real agent work requires a real runner, model authentication, and a supported sandbox provider with its own dependencies.

## Migrations And Process Startup

Run migrations before starting the combined API/worker process. The migration runner uses an `app_migrations` ledger and a Postgres advisory lock, so repeated runs skip applied migrations and concurrent migration runners serialize. That does not establish compatibility between arbitrary application versions.

For this single-instance experiment, migrations run as a Node preload in the same container, not as a separate Cycle job. The runtime command path is `node`, with these Cycle command arguments on one line:

```text
--import=data:text/javascript,await%20(await%20import('file%3A%2F%2F%2Fapp%2Fapps%2Fcontrol-plane%2Fdist%2Fdb%2Fmigrate.js')).runMigrations(process.env.DATABASE_URL) apps/control-plane/dist/index.js
```

This uses the image's `/app` working directory and compiled migration module. Node awaits the preload before running the application; migration failure prevents API/worker startup. Recheck these paths and exports when changing image versions.

The initial `/bin/sh` command with quoted `-ec` arguments failed with `Syntax error: Unterminated quoted string` under Cycle's command-argument handling. The shell-free preload above started successfully, and the public API subsequently returned a healthy response. Do not copy shell quoting into Cycle's command fields without checking how it is parsed.

Combined mode is one Node process with API and worker responsibilities, not two processes managed by a shell supervisor. Check instance restart policy and crash recovery separately; those were not proven by this experiment. For split deployments or production release orchestration, prefer an explicitly gated one-shot migration step using the same control-plane image, then start compatible API/worker instances after successful completion.

## Public Ingress, DNS, And TLS

Expose only `web`; leave `api` and `postgres` private:

1. Enable public networking on `web` and configure port mappings `80:5173` and `443:5173`.
2. Start the environment again to bring up its load balancer. An environment being live does not prove that its load balancer is enabled or has an instance.
3. Create a hosted Cycle DNS zone for the application subdomain, such as `cycle.deputies.dev`.
4. At the existing parent DNS provider, delegate only that subdomain with NS records:

   | Type | Name within `deputies.dev` | Target         |
   | ---- | -------------------------- | -------------- |
   | NS   | `cycle`                    | `ns1.cycle.io` |
   | NS   | `cycle`                    | `ns2.cycle.io` |
   | NS   | `cycle`                    | `ns3.cycle.io` |
   | NS   | `cycle`                    | `ns4.cycle.io` |

5. Verify the zone in Cycle, then create an apex (`@`) LINKED record targeting `web`, with TLS enabled.
6. Wait for the load-balancer addresses to resolve and the certificate to be issued. Test HTTPS without disabling certificate verification.

Do not change the parent domain's nameservers, add a hard-coded application-node A record, or require local `/etc/hosts` entries. The LINKED record follows load-balancer addresses. Public access needs explicit authorization, independently of permission to deploy private containers.

The browser connects to one HTTPS origin. Caddy forwards API requests internally, so public ingress on the API container is unnecessary. The experiment verified `https://cycle.deputies.dev/health` through that proxy and obtained a Cycle-managed TLS certificate.

## Validation And Troubleshooting

Before calling a deployment ready:

- Check job completion and actual instance health, not just job acceptance or an environment's `live` state.
- Check Postgres readiness, then inspect startup logs for migration or application errors. Buffered instance console output exposed the shell error when aggregated logs were empty.
- Request `/health` through the public web origin. Expect `status: ok`, `runMode: combined`, `apiAuthMode: session`, and `sandboxProvider: fake` for this configuration.
- Log in as the configured static user; verify authenticated requests and login persistence after reload. With `HIDE_SETUP_PAGE=true`, startup should open the session workspace instead of the setup guide.
- Create a session/message, observe worker completion, and read the result through the real API. Separately inspect database state and verify that it survives application and Postgres restarts.
- Review `/setup/status`; missing real providers are expected in this fake-provider configuration, not proof of a production-ready deployment.

Verified in Cycle during this experiment: Postgres readiness, all three application containers reporting running, public HTTPS `/health`, browser login, session restoration after reload, and skipping the setup guide. A completed fake-response session was visible in the browser. A controlled database-persistence test across a Postgres restart and a full migration-ledger audit were not completed; do not treat them as proven by the health endpoint. Fake execution does not validate model access or real sandbox execution.

If an operation is absent from Cycle MCP, consult the [Platform API](https://cycle.io/docs/api) and use the same hub and credential authorization. This experiment used API endpoints for image imports, DNS-zone creation/verification, and stack-source updates. Job details are available through `GET /v1/jobs/{jobId}` when the key has the required capability; API fallback is not a bypass for permission denials.

Changes to a deployed container's configuration do not automatically rewrite its stack source. Keep both aligned before a rebuild/redeploy, especially command arguments, ingress ports, public origin, cookie security, and `HIDE_SETUP_PAGE`.

## Cleanup Boundaries

Inventory the experiment's stack, application containers, environment services, scoped variables, image sources/imports, DNS zone/records, volumes, and any dedicated provisioned node. Check ownership and sharing before removing anything.

Agree on data export versus deletion and retention before removing Postgres volumes. Permission to restart containers is not permission to delete data. Do not remove an existing local VM, alter cluster membership, delete unrelated shared resources, or terminate a fallback cloud node without explicit authorization. Remove parent NS delegation if retiring the subdomain, and verify that dedicated cloud resources are actually terminated so billing stops.
