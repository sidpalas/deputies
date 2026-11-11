# Filming Guide: Deputies On Cycle

The shot sequence for the demo thread of "Why I Stopped Defaulting to Kubernetes" (filming guide: `videos/kubernetes-alternative-cycle/script.md` in `sidpalas/youtube`, commit `b23ae91`). Every step was run end to end on 2026-11-11 on real AWS and Cherry Servers nodes in disposable Cycle environments (`validate.cycle.deputies.dev`, `upgrade.validate.cycle.deputies.dev`), then torn down. All timings are measured.

The build is continuous: §1 adds an AWS node, §2 a Cherry node, §3 deploys Deputies on AWS and releases a new version with zero downtime, §4 moves everything to Cherry, §5 cuts Cherry off from Cycle. The intro teaser reuses the §4 footage.

## Files

| File                                                             | Purpose                                                                                                                |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| [deputies-db-stack.json](deputies-db-stack.json)                 | Postgres, unversioned so every app version shares it                                                                   |
| [deputies-app-stack.json](deputies-app-stack.json)               | Deputies 0.28.0: combined API/worker (Pi runner, Claude Haiku 5.5, Daytona sandboxes) and the Caddy web front end      |
| [deputies-app-stack-0.27.1.json](deputies-app-stack-0.27.1.json) | The "before" version for the release shot (Deputies 0.27.1)                                                            |
| [pi-models.json](pi-models.json)                                 | Only for 0.27.1: adds Claude Haiku 5.5 to its older Pi (0.83.0)                                                        |
| [create-scoped-variables.sh](create-scoped-variables.sh)         | Creates the secret scoped variables and the Pi models file; writes the login to `deputies-login.txt`                   |
| [release.sh](release.sh)                                         | Pushes a stack file, builds it, deploys the build (optionally as a deployment version) and starts it                   |
| [tag.sh](tag.sh)                                                 | Points a deployment tag (`live`, `next`) at a version; DNS and the load balancer follow the tag                        |
| [smoke.sh](smoke.sh)                                             | Logs in, runs one real agent task, prints the tool calls and the reply                                                 |
| [watch-health.sh](watch-health.sh)                               | The on-camera curl loop: `/health` once a second with elapsed time, answering IP and total downtime                    |
| [netcut-stack.json](netcut-stack.json), [netcut.sh](netcut.sh)   | §5: a privileged container that firewalls its node from Cycle's control plane for a fixed time, then removes the rules |

The scripts read `CYCLE_API_KEY`, `CYCLE_HUB_ID` and `CYCLE_API_BASE_URL` (`https://api.cycle.io/v1`) from the environment and print no secrets. `create-scoped-variables.sh` also reads `ANTHROPIC_API_KEY` and `DAYTONA_API_KEY`.

## Configuration

The files are set up for the filming environment, `Deputies on Cycle` in cluster `development`, serving `https://cycle.deputies.dev`.

- **Placement:** every container requires the server tag `deputies`. Tag the AWS node in §1 and add the tag to the Cherry node at the start of §4. This replaces the old `aws-us-east-1` constraint, so nothing in the stack needs loosening before the move.
- **Network:** only `web` is public (`80:5173`, `443:5173`). `api` is `egress-only`, because it calls Anthropic and Daytona. Postgres has no public network.
- **Restart policy:** `api` and `web` have `restart: {condition: always, delay: 5s}`. The API process exits when Postgres restarts (see Snags), and Cycle restarts it.
- **0.27.1 only:** `PI_CODING_AGENT_DIR=/home/node/.pi/agent` plus the `pi-models` file. Cycle runs the image's process as root, not as its `node` user, so without the variable Pi looks in `/root/.pi/agent`. 0.28.0 ships Pi 1.5.0, which knows Haiku 5.5, and needs neither.

Scoped variables (each scoped to one container; `create-scoped-variables.sh` creates all of them with fresh random values):

| Identifier                      | Container  | Delivered as                                          | Secret |
| ------------------------------- | ---------- | ----------------------------------------------------- | ------ |
| `postgres-password`             | `postgres` | `POSTGRES_PASSWORD`                                   | yes    |
| `database-url`                  | `api`      | `DATABASE_URL`                                        | yes    |
| `auth-password`                 | `api`      | `AUTH_STATIC_PASSWORD`                                | yes    |
| `auth-session-secret`           | `api`      | `AUTH_SESSION_SECRET`                                 | yes    |
| `sandbox-secret-encryption-key` | `api`      | `SANDBOX_SECRET_ENCRYPTION_KEY`                       | yes    |
| `anthropic-api-key`             | `api`      | `ANTHROPIC_API_KEY`                                   | yes    |
| `daytona-api-key`               | `api`      | `DAYTONA_API_KEY`                                     | yes    |
| `pi-models`                     | `api`      | file `/home/node/.pi/agent/models.json` (0.27.1 only) | no     |

`Deputies on Cycle` already has the first four. Add the rest by hand, or with the same `jq | curl` calls the script makes; running the whole script against it would create duplicates of the first four.

Two LINKED DNS records in the hosted zone, both targeting a deployment tag, not a container:

| Name   | Target                                 | Purpose                                     |
| ------ | -------------------------------------- | ------------------------------------------- |
| `@`    | container `web`, deployment tag `live` | What viewers see                            |
| `next` | container `web`, deployment tag `next` | Smoke-test a release before flipping `live` |

## Pre-Provision Versus On Camera

Before rolling (off camera):

- [ ] Hub integrations exist (`ksk-staging` for AWS, `cherry`); cluster `development` has no servers.
- [ ] In `Deputies on Cycle`, delete the three old stopped containers and the old `Deputies` stack, and add the new scoped variables.
- [ ] Create stacks `deputies-db` and `deputies-app` from the files (portal: Stacks → Create → Raw; API: `POST /v1/stacks` with `source: {type: raw, details: <file contents>}`).
- [ ] Change the `@` record to the deployment-tag form and add `next`. Don't request either hostname before its record exists: a negative answer gets cached for up to 20 minutes (see Snags).
- [ ] Turn on load-balancer high availability (Environment → Services → Load Balancer). Without it, Cycle publishes only one load-balancer IP, and the §4 move can't hand over gradually.
- [ ] Open `./watch-health.sh https://cycle.deputies.dev` in a terminal sized for a corner, on a machine using a public resolver.
- [ ] Have the login ready (`deputies-login.txt`, or the `auth-password` scoped variable in the portal).

"Live" below means film at real speed; "speed up" means time-lapse the wait.

## Shot Sequence

### Shot 1 (§1): Provision an AWS node

- **UI:** Infrastructure → Servers → Deploy → `ksk-staging` (AWS) → `us-east-1`, zone `us-east-1a` → `t3a.medium` (about $27/month) → cluster `development` → Deploy.
- **Then:** add the tag `deputies` to the server. Keep Allow Pool and Allow Services on.
- **Took:** EC2 created the instance in 18 s; the node was online and checking in 3 min 27 s after Deploy. A second run took about 4.5 min. Film the click live and speed up the wait.
- **Points:** no VPC, IAM or cluster code: pick a provider, region and size. CycleOS boots and joins; there's no AMI, node pool or bootstrap script. Fair line: Cycle does need an AWS integration with permissions in your account, and it creates the instance and an Elastic IP per load balancer there. The exact security groups and IAM weren't inspected; there was no AWS console access during validation.
- **Avoid:** the earlier runbook hit an unsupported availability zone. `us-east-1a` worked both times.

### Shot 2 (§2): Provision a Cherry Servers node

- **UI:** same dialog, provider `cherry`, `US-Chicago`, bare metal.
- **Expect stock failures.** Models in the catalogue fail at order time with "Provided server configuration is out of stock", within about 1 s. Validation hit this with the $159 EPYC 7313P and the $159 Ryzen 7700X; the $169 **AMD EPYC 7443P, 24 cores, 64 GB** (`amd-epyc-7443p:20152`) was accepted. IDs ending in `:NNNN` are individual stock listings that come and go. A failed order leaves a server record in `provisioning`: decommission it before retrying. Nothing exists at Cherry, so nothing bills.
- **Took:** Cherry finished provisioning in 4 min 14 s; CycleOS was online about 6 min after the accepted order. Film the order live (cut the failures, or keep one for honesty) and speed up the wait. If stock looks bad on the day, pre-provision the node and film only the dialog.
- **Points:** 24 dedicated cores and 64 GB for about $169/month, against $27/month for 2 shared vCPUs and 4 GB on AWS. Same dialog, same cluster, same OS. Cycle's fee comes on top either way; the calculator shot covers that.

### Shot 3 (§3): The stack and the deploy

- **Code on screen:** `deputies-db-stack.json` and `deputies-app-stack.json` next to the Helm chart. Point at the images pulled straight from GHCR and Docker Hub, the `deputies` tag constraint, the restart policy, and the absence of secrets.
- **Scoped variables:** show the environment's Scoped Variables tab: values hidden, each scoped to one container.
- **Database:** `STACK_ID=<deputies-db> ENVIRONMENT_ID=<env> ./release.sh deputies-db-stack.json`, or in the portal: stack → New Build → Deploy, then start `postgres`. Took 28 s and 43 s in two runs.
- **App:** `./release.sh deputies-app-stack-0.27.1.json v0.27.1 && ./tag.sh live v0.27.1`, starting at 0.27.1 so shot 4 has something to release. Took 54 to 85 s to running; the build step (image import) varied from 24 to about 70 s. The first time a hostname gets a certificate, it served HTTPS 26 s after the environment start that brought up the load balancer; once the certificate exists, a new tag serves within seconds.
- **Real agent task:** log in and ask: "Write fib.py that prints the first 10 Fibonacci numbers. After the file is written, run it in a separate step and report the output." It took 11 to 17 s, including creating the Daytona sandbox; a cold first sandbox took 29 s. Ask for separate steps: with "create it and run it", Haiku once issued the write and the run in parallel, and the run lost the race.
- **Film live**, trimming the build wait.
- **Points:** two short JSON files, a few scoped variables and two DNS records; TLS, ingress and DNS come built in. Caveat: the Helm chart covers configurations this stack doesn't.

### Shot 4 (§3): Push, release and roll back without downtime

Don't film an in-place reimage: with one instance, reimaging `api` took the site down for 38 s, and rolling back took 15 s. Use Cycle deployments instead. Each release runs alongside the old one, and the load balancer and DNS follow a tag.

1. **"Push":** the release is Deputies 0.28.0. In the editor, show the diff between `deputies-app-stack-0.27.1.json` and `deputies-app-stack.json`: three image tags, and the Pi workaround lines removed.
2. **Deploy alongside:** `./release.sh deputies-app-stack.json v0.28.0 && ./tag.sh next v0.28.0`. Took 53 s; 0 of 76 live-site checks failed meanwhile. (The earlier 0.27.0 → 0.27.1 rehearsal took 96 s, also with 0 failures.)
3. **Smoke-test the candidate** on `https://next.cycle.deputies.dev`: log in and run a task. It answered on 0.28.0 using `claude-haiku-5-5` natively.
4. **Flip:** `./tag.sh live v0.28.0` takes about 1 s.
5. **Roll back:** `./tag.sh live v0.27.1`, then flip forward again; about 1 s each. Across the two rehearsals (six flips), the only errors were one 503 at the first flip and one at the rollback in the second rehearsal, so expect at most a single error at the moment of switching.
6. **Retire the old version:** stop its two containers, then Environment → Deployments → Prune (`deployments.prune`), which removes versions without a tag. The live site kept serving after the old version stopped (0 of 30 checks failed), which proves traffic had moved.

- **Points:** blue/green is a built-in primitive (versions plus tags), not an add-on, and rollback is moving a tag, with no rebuild. Caveat: while both versions run, both workers process the same queue; that's fine for 0.27.1 → 0.28.0 (no schema changes) but needs care across migrations.

### Shot 5 (§4 and teaser): Move AWS → Cherry with the curl loop

Keep `watch-health.sh` in the corner throughout. The validated sequence:

| Step | Action (portal, or API)                                                                                                                                                                                 | Took            | Failed checks                                                                                                       |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------- |
| 1    | Add the tag `deputies` to the Cherry server                                                                                                                                                             | instant         | 0                                                                                                                   |
| 2    | Add one instance each of the environment's load balancer, discovery and scheduler on Cherry (container → Instances → Add, choose the server; API `POST /v1/containers/{id}/instances` with `server_id`) | 23 s to running | 0                                                                                                                   |
| 3    | With load-balancer HA on, the LINKED record now returns both load-balancer IPs                                                                                                                          | 6 s             | 0                                                                                                                   |
| 4    | Add `web` and `api` instances on Cherry the same way                                                                                                                                                    | 18 s to running | 0                                                                                                                   |
| 5    | Delete the AWS `web` and `api` instances                                                                                                                                                                | immediate       | 0                                                                                                                   |
| 6    | Migrate `postgres` to Cherry (container → Instances → Migrate, copy volumes)                                                                                                                            | job 20 s        | **about 21 s outage** (last OK 20:49:27, first OK 20:49:48), on `/health` and on an authenticated `/sessions` check |
| 7    | Wait at least one DNS TTL (600 s) after step 3                                                                                                                                                          | 10 min          | 0                                                                                                                   |
| 8    | Delete the AWS load-balancer, discovery and scheduler instances. Cycle's nameservers answered with Cherry only within 3 s                                                                               | instant         | **intermittent until resolver caches expire:** 66 of 139 checks failed over 4.5 min                                 |
| 9    | Delete the stopped AWS VPN instance and the retained Postgres source instance, then decommission the AWS server                                                                                         | about 2 min     | 0                                                                                                                   |

Session history survived: the same 3 sessions were readable through the real API on Cherry afterwards.

- **Real downtime:** about 21 s of full outage while Postgres stops, streams its volume and restarts, then a DNS tail. Resolvers that cached the two-address answer keep handing out the old AWS address for up to one TTL (600 s). That address accepted TCP but never completed TLS, so clients didn't fall back to the Cherry address; about half of new connections failed until the cache expired. Browsers retry; a curl loop shows the failures. On camera, say "about 20 seconds of downtime, plus up to ten minutes of DNS tail for clients that cached the old load balancer".
- **Film** steps 2 to 6 live (under 2 minutes). Speed up step 7, and film step 8 with the loop visible, sped up.
- **Teaser:** steps 4 to 6 sped up with the loop in the corner, then the session history after the move.
- **Points:** compute moved with zero failed requests, and the database moved with its data in about 20 s, between two unrelated providers, with no cross-cloud networking set up by hand. It's portability, not high availability: Postgres lives in one place at a time. Where Cycle is opinionated: load balancers can't be migrated or drained from DNS before deletion, the record TTL is fixed at 600 s, and HA must be on before a second load balancer is published.

### Shot 6 (§5, optional): Cut the node off from Cycle

- **How:** `netcut` runs privileged in the host's network and PID namespaces (`namespaces` without `network` and `pid`, `public: disable`). It adds an `iptables` chain that drops traffic to and from Cycle's control plane: the host's live connections plus every address of `api`, `console` and `portal.cycle.io`. It waits `CUT_SECONDS`, then removes the chain. It has to undo itself, because nothing can reach the node to do it.
- **Pre-roll:** create the scoped variable `netcut-script` (file `/netcut/netcut.sh`, mode `0755`, scoped to `netcut`) from `netcut.sh`, then deploy the `netcut` stack. It starts in `MODE=probe`, which only prints the host's connections.
- **On camera:** reconfigure `netcut` with `MODE=cut` and `CUT_SECONDS=480`. Keep the curl loop visible, run an agent task during the cut, and try a change in the portal.
- **Run it last, on a node you're about to retire** (see the result below), and keep the AWS node until after this shot if you want a fallback.

## Control-Plane Disconnect Result

The claim holds for serving, with a caveat about getting control back.

- **Deputies kept serving.** During the 8.5-minute cut (21:06:50 to the reconnect at 21:15:26), 0 of 441 `/health` checks and 0 of 439 authenticated `/sessions` checks failed, and a real agent task (Anthropic and Daytona) completed. Cycle's nameservers kept answering with the node's load-balancer IP, even after the node was marked offline. Over the following 25 minutes the app kept serving too: 0 of 1,236 checks failed from the cut onwards.
- **Operations stopped.** The node's last check-in froze at 21:06:36. Cycle flagged it `online: false` about 2.5 minutes later and `offline` after about 6 minutes. A container restart submitted during the cut was accepted and reported `completed`, but the container sat in `starting` and the real instance was never touched. Console streaming and SSH-based commands returned nothing.
- **Check-in recovered; job delivery did not.** The netcut rules lifted at about 21:14:50, and the node checked in again at 21:15:26. But for the next 18 minutes, until the node was deleted, no job reached it: a container restart, a reconfigure, starting new containers, `compute.restart` and a server restart were all accepted and reported complete, yet nothing changed on the node. Deleting its environment left the app running on the node (Cycle listed no instances while the site still answered) until the server was force-decommissioned.
- **What's verified and what isn't:** the node checked in over one path but executed nothing. Two explanations fit: Cycle's command channel didn't reconnect after its sockets were killed, or part of the test's firewall state survived its cleanup (check-in may use IPv6 while the command channel used IPv4). There was no host access to tell which. Ask Cycle before claiming "it recovers on its own". On camera, "a Cycle outage isn't a customer-facing incident" is supported; "everything resumes when Cycle is back" was not shown.

## Reset Between Takes

Back to "nothing provisioned" (before shot 1):

- [ ] Stop `watch-health.sh`.
- [ ] In `Deputies on Cycle`, delete the app containers (every deployment version), `postgres` (this deletes the volume and the demo history), and `netcut` if used. Keep the stacks to redeploy, or delete them.
- [ ] Remove every container instance on each server, including stopped ones and a migration's retained source (kept 3 hours), then decommission the servers. If a decommission is refused for leftover instances, the server can stay in `deleting`. `DELETE /v1/infrastructure/servers/{id}` finishes it, and `{"options": {"force": true}}` handles a node that no longer responds.
- [ ] Confirm `GET /v1/infrastructure/servers` returns no servers, and that the instances are gone at AWS and Cherry.
- [ ] Keep the environment, scoped variables, zone and records. LINKED records with no target simply stop resolving.

Back to "deployed on AWS" (before shot 4 or 5): keep the AWS node, deploy `v0.27.1`, tag `live`, delete other versions and seed a session. To redo only the move, add the instances back on AWS, migrate Postgres back (or use Migrate → Revert within 3 hours), and wait out the DNS TTL before rolling again.

## Snags

Marked ★: worth a line on camera when talking about Cycle's opinions.

1. ★ **Load balancers and DNS.** A second load-balancer instance isn't published in the LINKED record until load-balancer HA is on. Deleting the old instance drops its IP at once, but the TTL is 600 s and there's no drain step, hence the DNS tail.
2. ★ **Cherry stock.** Catalogue models fail at order time as out of stock, and each failure leaves a server record to decommission.
3. ★ **Control after an outage** didn't resume within 18 minutes in the §5 test (see the result above).
4. **MCP `configure_server`** with only `tags` reset the server's `allow.pool` and `allow.services` to false, so the environment couldn't start ("no servers meet deployment criteria"). Setting tags and `allow` together through `PATCH /v1/infrastructure/servers/{id}` fixed it. The portal wasn't tested for this.
5. **Starting an environment** fails until the cluster has a live server.
6. **Cycle runs the process as root**, ignoring the image's `USER node`. That's why Pi needed `PI_CODING_AGENT_DIR` on 0.27.1. Set `runtime.user` if you want the image's user.
7. **Haiku 5.5 on 0.27.x.** Pi 0.83.0 doesn't know `claude-haiku-5-5` ("Pi model is not available"). Once added, it needs `compat.forceAdaptiveThinking`, because Anthropic rejects `thinking.type.enabled` for it. Fixed natively in 0.28.0.
8. **Real-runner config** also needs `SANDBOX_SECRET_ENCRYPTION_KEY` (required with Postgres and Daytona) and egress on `api`.
9. **Postgres restarts kill the API.** The control plane's `pg` pools have no `error` listener, so an idle connection terminated by a Postgres restart crashes the process (instance `failed`, then 502s). The stack's restart policy covers it; a Deputies fix was suggested separately.
10. **Stack variables can't be used in image targets** (`{{api_tag}}` fails validation), so releases edit the tag in the file.
11. **`deployment.stop` returns 500** (`gob: type not registered for interface: environmentTasks.Deployment`). Stop the containers directly or prune.
12. **API details:** secret scoped variables take `"secret": {}` (an object, not `true`), and host-network containers must be `public: disable`.
13. **Negative DNS caching.** Requesting a hostname a few seconds before its record propagates got NXDOMAIN cached by some 8.8.8.8 caches (the zone's negative TTL is up to 20 minutes).
14. **Logs:** aggregated logs were empty for the API; the instance console (MCP `capture_stream`) showed its output.
15. **Validation DNS:** there was no Cloudflare access during validation, so it used a separate Cycle-hosted zone, `validate.cycle.deputies.dev`, which Cycle's nameservers serve under the existing `cycle` delegation. Filming on `cycle.deputies.dev` needs no Cloudflare change.
