# Filming Guide: Deputies On Cycle

The shot sequence for the demo thread of "Why I Stopped Defaulting to Kubernetes" (filming guide: `videos/kubernetes-alternative-cycle/script.md` in `sidpalas/youtube`, commit `b23ae91`). Every step was run end to end on 2026-11-11 on real AWS and Cherry Servers nodes in disposable Cycle environments (`validate.cycle.deputies.dev`, `upgrade.validate.cycle.deputies.dev`), then torn down. All timings are measured.

The build is continuous: §1 adds an AWS node, §2 a Cherry node, §3 deploys Deputies on AWS and releases a new version with zero downtime, §4 moves everything to Cherry, §5 cuts Cherry off from Cycle. The intro teaser reuses the §4 footage.

## Files

| File                                                                                                       | Purpose                                                                                                                 |
| ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| [deputies-db-stack.json](deputies-db-stack.json)                                                           | Postgres, unversioned so every app version shares it                                                                    |
| [deputies-app-stack.json](deputies-app-stack.json)                                                         | Deputies 0.28.0: combined API/worker (Pi runner, Claude Haiku 5.5, Tensorlake sandboxes) and the Caddy web front end    |
| [deputies-app-stack-0.27.1.json](deputies-app-stack-0.27.1.json)                                           | The "before" version for the release shot (Deputies 0.27.1)                                                             |
| [pi-models.json](pi-models.json)                                                                           | Only for 0.27.1: adds Claude Haiku 5.5 to its older Pi (0.83.0)                                                         |
| [create-scoped-variables.sh](create-scoped-variables.sh)                                                   | Creates the secret scoped variables and the Pi models file; writes the login to `deputies-login.txt`                    |
| [release.sh](release.sh)                                                                                   | Pushes a stack file, builds it, deploys the build (optionally as a deployment version) and starts it                    |
| [tag.sh](tag.sh)                                                                                           | Points a deployment tag (`live`, `next`) at a version; DNS and the load balancer follow the tag                         |
| [smoke.sh](smoke.sh)                                                                                       | Logs in, runs one real agent task, prints the tool calls and the reply                                                  |
| [watch-health.sh](watch-health.sh)                                                                         | The on-camera curl loop: `/health` once a second with elapsed time, answering IP and total downtime                     |
| [netcut-stack.json](netcut-stack.json), [netcut.sh](netcut.sh)                                             | §5: a privileged container that firewalls its node from Cycle's control plane for a fixed time, then removes the rules  |
| [inplace-test-stack.json](inplace-test-stack.json)                                                         | Test only: 2-instance `traefik/whoami` plus an unchanged Postgres in one unversioned stack (see In-Place Deploy Result) |
| [flip-test.sh](flip-test.sh), [flip-probe.py](flip-probe.py), [flip-test-stack.json](flip-test-stack.json) | Test only: repro for errors at a tag flip, and the settings that remove them (see Tag Flip Result)                      |
| [tag-flip-repro.sh](tag-flip-repro.sh)                                                                     | Standalone single-file repro of the tag-flip 503s, to share with Cycle (see Tag Flip Result)                            |

The scripts read `CYCLE_API_KEY`, `CYCLE_HUB_ID` and `CYCLE_API_BASE_URL` (`https://api.cycle.io/v1`) from the environment and print no secrets. `create-scoped-variables.sh` also reads `ANTHROPIC_API_KEY`, `TENSORLAKE_API_KEY` and `DAYTONA_API_KEY`.

## Configuration

The files are set up for the filming environment, `Deputies filming` (identifier `deputies-filming`, ID `6af601d4d7d6a986d8260c3c`) in cluster `development`, serving `https://cycle.deputies.dev`. It replaced the earlier `Deputies on Cycle` environment, which was deleted with its old `Deputies` stack on 2026-11-12.

Setup on 2026-11-12, all through the API:

- Environment created in `development`. Cycle can't initialize an environment in a cluster with no servers (`unable to create discovery service: ... no servers meet deployment criteria`), so it was initialized (`POST /v1/environments/{id}/tasks` with `{"action":"initialize"}`) on a temporary `ksk-staging` t3a.medium.
- All eight scoped variables from `create-scoped-variables.sh`, run from a directory outside the repo so the login file stays out of git.
- Stacks `deputies-db` (`6af60261612fa4ab449637ef`) and `deputies-app` (`6af60262a86694d6b33ec752`), created from the files in this directory.
- Both LINKED records below, in the hub's `cycle.deputies.dev` zone.
- Load-balancer HA left **off**: see the Pre-Provision list for why and when to turn it on.
- Smoke test on the temporary node: deployed `deputies-db`, `v0.27.1` tagged `live` and `v0.28.0` tagged `next`. `https://cycle.deputies.dev` and `https://next.cycle.deputies.dev` served `/health` over HTTPS with valid certificates, and `smoke.sh` ran the fib.py task (write, then run in a separate step, correct output) in 27 s with a cold sandbox. Then reset with the checklist in Reset Between Takes, the deployment tags cleared, and the server deleted: `GET /v1/infrastructure/servers` returned no servers and the hub had no IP pools left.

- **Placement:** every container requires the server tag `deputies`. Tag the AWS node in §1 and add the tag to the Cherry node at the start of §4. This replaces the old `aws-us-east-1` constraint, so nothing in the stack needs loosening before the move.
- **Network:** only `web` is public (`80:5173`, `443:5173`). `api` is `egress-only`, because it calls Anthropic and Tensorlake. Postgres has no public network.
- **Sandboxes:** `SANDBOX_PROVIDER=tensorlake` with `TENSORLAKE_REGISTERED_IMAGE=deputies`, a registered Tensorlake image. `DAYTONA_IMAGE` and the `daytona-api-key` variable stay, so switching back to Daytona only means changing `SANDBOX_PROVIDER`. The smoke-test and agent-task timings in this runbook were measured with Daytona.
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
| `tensorlake-api-key`            | `api`      | `TENSORLAKE_API_KEY`                                  | yes    |
| `daytona-api-key`               | `api`      | `DAYTONA_API_KEY`                                     | yes    |
| `pi-models`                     | `api`      | file `/home/node/.pi/agent/models.json` (0.27.1 only) | no     |

`Deputies filming` has all nine. Running the script again would create duplicates; to rotate a value, update that variable instead.

Two LINKED DNS records in the hosted zone, both targeting a deployment tag, not a container:

| Name   | Target                                 | Purpose                                     |
| ------ | -------------------------------------- | ------------------------------------------- |
| `@`    | container `web`, deployment tag `live` | What viewers see                            |
| `next` | container `web`, deployment tag `next` | Smoke-test a release before flipping `live` |

## Pre-Provision Versus On Camera

Before rolling (off camera):

- [x] Hub integrations exist (`ksk-staging` for AWS, `cherry`); cluster `development` has no servers.
- [x] Create the environment `Deputies filming` with all the scoped variables (done 2026-11-12; see Configuration). The old `Deputies on Cycle` environment, its three stopped containers and the old `Deputies` stack are deleted.
- [x] Create stacks `deputies-db` and `deputies-app` from the files (portal: Stacks → Create → Raw; API: `POST /v1/stacks` with `source: {type: raw, details: <file contents>}`).
- [x] Point `@` at container `web`, tag `live`, and add `next` for tag `next`. Don't request either hostname before its record exists: a negative answer gets cached for up to 20 minutes (see Snags).
- [ ] Load-balancer high availability stays **off** until the Cherry node is online (start of §4, see Shot 5). With HA on and one server, starting the environment fails (`cannot start lb service: only 1 server meets deployment criteria, HA requires 2 or more`) and no load balancer runs, so §3 would break. Turning it on while running on one server is also refused. Without HA, Cycle publishes only one load-balancer IP, so it has to be on before §4 step 2.
- [ ] Decide on the load balancer type: Tag Flip Result recommends HAProxy for the §3 flip and a rehearsal on it first. `Deputies filming` is still on the default (native) load balancer.
- [ ] Before filming §3, check `dig +short @ns1.cycle.io cycle.deputies.dev` once the environment is started (see Snag 18).
- [ ] Open `./watch-health.sh https://cycle.deputies.dev` in a terminal sized for a corner, on a machine using a public resolver.
- [ ] Have the login ready (`deputies-login.txt`, or the `auth-password` scoped variable in the portal).

"Live" below means film at real speed; "speed up" means time-lapse the wait.

## Shot Sequence

### Shot 1 (§1): Provision an AWS node

- **UI:** Infrastructure → Servers → Deploy → `ksk-staging` (AWS) → `us-east-1`, zone `us-east-1a` → `t3a.medium` (about $27/month) → cluster `development` → Deploy.
- **Then:** add the tag `deputies` to the server. Keep Allow Pool and Allow Services on.
- **Then, off camera:** start `Deputies filming` (Environment → Start; API `POST /v1/environments/{id}/tasks` with `{"action":"start"}`), then reconfigure its discovery service without changes (API `POST /v1/environments/{id}/services/discovery/tasks` with `{"action":"reconfigure","contents":{"high_availability":false}}`). Check that the `Environment Discovery (DNS)` container has a running instance. After a reset, the start brings back only the load balancer; without discovery, `api` crashes with `getaddrinfo EAI_AGAIN postgres` (see Snag 17). Both steps were verified on 2026-11-12.
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

Don't film an in-place reimage: with one instance, reimaging `api` took the site down for 38 s, and rolling back took 15 s. With two instances it drops to a blip, but still not zero (see In-Place Deploy Result). Use Cycle deployments instead. Each release runs alongside the old one, and the load balancer and DNS follow a tag.

1. **"Push":** the release is Deputies 0.28.0. In the editor, show the diff between `deputies-app-stack-0.27.1.json` and `deputies-app-stack.json`: three image tags, and the Pi workaround lines removed.
2. **Deploy alongside:** `./release.sh deputies-app-stack.json v0.28.0 && ./tag.sh next v0.28.0`. Took 53 s; 0 of 76 live-site checks failed meanwhile. (The earlier 0.27.0 → 0.27.1 rehearsal took 96 s, also with 0 failures.)
3. **Smoke-test the candidate** on `https://next.cycle.deputies.dev`: log in and run a task. It answered on 0.28.0 using `claude-haiku-5-5` natively.
4. **Flip:** `./tag.sh live v0.28.0` returns in about 1 s. On the default (native) load balancer, traffic moves 0.1 to 6 s later, and most flips drop a few requests with `503 no routers for desired route`. Switch the environment's load balancer to HAProxy before filming, or flip with traffic-splitting weights instead (see Tag Flip Result); both measured 0 errors at the flip.
5. **Roll back:** `./tag.sh live v0.27.1`, then flip forward again. In the Deputies rehearsals (six flips on the native load balancer), two flips each dropped one request; the 50-flip test below shows that's typical, not bad luck.
6. **Retire the old version:** stop its two containers, then Environment → Deployments → Prune (`deployments.prune`), which removes versions without a tag. The live site kept serving after the old version stopped (0 of 30 checks failed), which proves traffic had moved.

- **Points:** blue/green is a built-in primitive (versions plus tags), not an add-on, and rollback is moving a tag, with no rebuild. Caveat: while both versions run, both workers process the same queue; that's fine for 0.27.1 → 0.28.0 (no schema changes) but needs care across migrations.

### Shot 5 (§4 and teaser): Move AWS → Cherry with the curl loop

Keep `watch-health.sh` in the corner throughout. The validated sequence:

| Step | Action (portal, or API)                                                                                                                                                                                 | Took            | Failed checks                                                                                                       |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------- |
| 1    | Add the tag `deputies` to the Cherry server, then turn on load-balancer HA (Environment → Services → Load Balancer; not verified with two servers on `Deputies filming`)                                | instant         | 0                                                                                                                   |
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

## In-Place Deploy Result

Question: can one unversioned stack with 2 app instances release in place without downtime, instead of the two-stack, versioned setup above? Tested on 2026-11-11/12 with [inplace-test-stack.json](inplace-test-stack.json): `web` is `traefik/whoami` (2 instances, its `Name:` line shows the release label) and `db` is stock `postgres:17.11-alpine` with a local volume and a seeded marker row. Two t3a.medium AWS nodes in a throwaway environment, LINKED record on `validate.cycle.deputies.dev`, then torn down. Each release pushed a new stack file, built it, and deployed the build into the same environment. A probe hit the site 4 to 8 times a second on fresh connections, `watch-health.sh` ran alongside, and the instance states were polled every second.

**Answer: near zero, not zero.** Every instance restart cost about one failed request (a 502 or a refused connection), about 0.5 to 1.5 s of errors per instance. Cycle stops each instance in place while the load balancer still sends it new connections; there's no drain and no start-new-before-stopping-old.

| Run | Change                                | Deploy `update`                       | Failed probe checks | Failed `watch-health` checks | Instance restarts                                                  |
| --- | ------------------------------------- | ------------------------------------- | ------------------- | ---------------------------- | ------------------------------------------------------------------ |
| 1   | v1 → v2 (image + env), 1 server       | none (`release.sh` as is)             | 0                   | 0                            | none: the build deployed, but nothing changed                      |
| 2   | same build                            | `web` and `db`: reimage + reconfigure | 1 of 64             | 1 of 25                      | `web` one at a time, about 1 s apart; `db` restarted               |
| 3   | v2 → v3, 1 server                     | `web`: reimage + reconfigure          | 1 of 62             | 0 of 26                      | one at a time, overlapping by about 1 s                            |
| 4   | v3 → v4, adds `update.stagger: 30s`   | `web`: reimage + reconfigure          | 3 of 186            | 2 of 39                      | each instance twice                                                |
| 5   | v4 → v5, stagger 30 s                 | `web`: reimage + reconfigure          | 6 of 268            | 1 of 59                      | 4 restarts over 48 s; v4 and v5 served side by side for about 25 s |
| 6   | image only, stagger 30 s              | `web`: reimage only                   | 2 of 254            | 1 of 53                      | both within 1 s (random draw)                                      |
| 7   | image only, stagger 30 s              | `web`: reimage only                   | 2 of 234            | 1 of about 50                | 20 s apart                                                         |
| 8   | v5 → v6, instances on **two servers** | `web`: reimage + reconfigure          | 4 of 217            | 0 of 47                      | 4 restarts over 22 s                                               |
| 9   | Postgres unchanged                    | `db`: reimage only                    | 0 of 113            | 0                            | `db` restarted (3.6 s)                                             |

What it shows:

- **A plain build deploy changes nothing.** Deploying a build into an environment that already has the containers, without `update`, completes but leaves them on the old build. An in-place release needs `contents.update.containers.<name>: {reimage, reconfigure}` on the build's `deploy` task (portal: the per-container Reimage and Reconfigure options).
- **One at a time, by default.** Without a stagger, instances restarted about 1 s apart, so one was usually serving. Reimage and reconfigure in the same deploy can restart each instance twice (runs 4, 5, 8), doubling the errors.
- **Stagger exists but doesn't help.** `config.deploy.update.stagger` gives each instance a random start delay from 0 to the duration. It spreads restarts out, but they can still land together (run 6), it takes effect only once already applied (run 4 restarted on the old setting, then again), and old and new versions serve side by side meanwhile (run 5). It doesn't drain the load balancer, so each restart still costs about one error. There's also `deploy.startup.delay` and `deploy.shutdown.graceful_timeout`; neither adds draining, so they weren't tested.
- **Two servers don't change it** (run 8): the errors come from the load balancer routing to a stopping instance, not from the host.
- **Postgres is touched only if listed.** With `db` in `update`, the unchanged Postgres restarts (about 4 s; runs 2 and 9: `pg_postmaster_start_time` moved each time). With `db` left out, it isn't touched (runs 3 to 8). The marker row survived every restart. For Deputies, a Postgres restart also kills the API (Snag 9), so a single-stack release must leave `postgres` out of `update`.

**For the §3 release shot:** keep the two-stack, deployment-tag approach. It measured 0 failed checks while deploying alongside and, with the load-balancer setting in Tag Flip Result, 0 errors at a flip, and rollback is a 1 s tag move with no rebuild. An in-place release with 2 instances gives one to six failed checks per release in this test, for a 1 s-to-start test server; Deputies' API starts slower and runs migrations at startup, so expect no better. Fair line on camera: "a rolling in-place update with two instances is a blip, not an outage; for zero, use deployments".

## Tag Flip Result

Question: why did tag flips drop requests, and which settings help? Tested on 2026-11-12 with [flip-test.sh](flip-test.sh): `traefik/whoami` deployed twice as deployment versions `v1` and `v2` (it answers with its version), one t3a.medium AWS node, a throwaway environment and LINKED records on `validate.cycle.deputies.dev`, then torn down. A probe ([flip-probe.py](flip-probe.py)) sent about 15 requests a second to the load balancer's IP, each on a fresh TLS connection, and saved the body of every failure. Both versions kept running throughout, so every failure is the switch itself.

| Run            | How it flipped                                               | Load balancer    | Flips | Flips with errors | Failed requests | When traffic moved (after the call returned)     |
| -------------- | ------------------------------------------------------------ | ---------------- | ----- | ----------------- | --------------- | ------------------------------------------------ |
| baseline       | move tag `live` (`tag.sh`, `deployments.reconfigure`)        | native (default) | 20    | 16                | 43 of 2,167     | 0.1 to 6 s                                       |
| repoint        | repoint a plain LINKED record from tag `blue` to `green`     | native           | 20    | 14                | 46 of 2,088     | 0.1 to 6 s                                       |
| split          | swap traffic-splitting weights, record's own tag unchanged   | native           | 20    | 0                 | 0 of 2,092      | 0 to 6 s, but about 11% stays on the old version |
| splitbase      | swap weights and move the record's own tag in the same PATCH | native           | 20    | 0                 | 0 of 2,096      | 0 to 6 s, then 100% new                          |
| haproxy        | move tag `live`                                              | HAProxy          | 10    | 0                 | 0 of 1,164      | 0.8 to 1.1 s                                     |
| native-control | move tag `live`, after switching back                        | native           | 10    | 7                 | 21 of 1,136     | 0.3 to 6 s                                       |

What it shows:

- **The error is the native load balancer briefly having no route.** Every failure was `503 Service Unavailable` with body `no routers for desired route` (a few `no routers exist for controller`), 1 to 4 requests in a 0.2 to 0.5 s window, while both versions were up. It isn't DNS (the probe used the IP) and it isn't the app. Repointing a record fails the same way, so it happens whenever a route's destinations are replaced, not only for tags.
- **The native load balancer applies changes on a cycle of about 6 s.** Traffic moved anywhere from 0.1 to 6 s after the job completed, drifting by about 1.2 s per flip at 7 s spacing. So `tag.sh` returning doesn't mean traffic has moved.
- **HAProxy removes both effects.** With the environment's load balancer set to HAProxy (Environment → Services → Load Balancer, or `POST /v1/environments/{id}/services/lb/tasks` with `{"action":"reconfigure","contents":{"config":{"type":"haproxy","details":null,"ipv4":true,"ipv6":true,"performance":false}}}`), 10 flips had no errors, traffic moved about 1 s after the job each time, and latency stayed flat (max 245 ms against a 226 ms median). It served TLS for the LINKED records with no other change. Switching back to native brought the errors back (control run). To switch back, send `"type":"default"`; `"type":"v1"` with `details: null` was accepted but left HAProxy running.
- **Traffic splitting avoids the 503s, with caveats.** A LINKED record can carry `routing.traffic_splitting.variants`, weighted destinations (0 to 1000) that can each be a deployment tag. With variants `blue` (v1) and `green` (v2), a full swap only changes weights, so the route never empties: 0 errors in 60 swaps across two runs. Retested on 2026-11-12 (see Traffic Splitting Retest below): it works for full cutovers but not for gradual shifts, and moving the idle color's tag briefly leaks live traffic to it.
- **`destination_retries` doesn't help.** The native default is already 3. It retries an unreachable destination, while this error means no route at all.
- **Not tested:** whether HAProxy also removes the in-place restart errors (In-Place Deploy Result), and its feature differences from the native load balancer (WAF, URL telemetry, router options). The HAProxy run is 10 flips, against 23 of 30 native tag flips with errors.

**For the §3 release shot:** keep tag flips and set the environment's load balancer to HAProxy before filming; `tag.sh` stays the on-camera action and measured 0 errors. Rehearse the full sequence on HAProxy once first (Deputies, and the §4 move), since the earlier validation ran on the native load balancer. If HAProxy causes trouble, a traffic-splitting record with `blue`/`green` tags is a fallback for full cutovers only (0 errors, but a release becomes a tag move plus a record PATCH, and the tag move briefly sends some live traffic to the new version; see the retest). Fair line on camera: "with the right load balancer setting, the flip drops nothing".

Standalone repro for Cycle: [tag-flip-repro.sh](tag-flip-repro.sh) needs only bash, curl, jq and dig, an environment on a cluster with a live server, and a Cycle-hosted zone. `setup` deploys whoami as versions v1 and v2, tags `live`, and creates the LINKED record (60 s); `flip` moves `live` 10 times while two curl loops hit the load balancer IP, and prints each failure's body; `cleanup` removes what `setup` made. Validated on 2026-11-12 on a fresh node: 50 of 839 requests failed over 15 flips, and every flip had at least one failure. 26 were `503 no routers for desired route` or `no routers exist for controller`, and 2 were connection failures from the first run, before the script recorded curl errors. In one flip, new connections also failed TLS for about 2.7 s (`tlsv1 alert internal error`, 22 requests), which suggests the native load balancer briefly drops the hostname's certificate along with its route; the earlier probe runs didn't show that.

The fuller test harness: create a stack from `flip-test-stack.json`, run `./flip-test.sh setup`, add a LINKED record for container `web` and tag `live`, start the environment, then `HOST=<record> ./flip-test.sh run 20 6`. The header of `flip-test.sh` lists the record-repoint and traffic-splitting modes.

### Traffic Splitting Retest

Retested on 2026-11-12 on a fresh node with three versions (`v1`, `v2`, `v3`) tagged `blue`, `green` and `other`, and one traffic-splitting record with variants `blue` and `green`. About 200 to 250 requests per measurement, measured after a 10 s settle.

| Record's own target       | Weights (blue / green) | Traffic                |
| ------------------------- | ---------------------- | ---------------------- |
| blue (v1)                 | 1000 / 0               | v1 100%                |
| blue (v1)                 | 0 / 1000               | v2 91%, v1 9%          |
| green (v2)                | 1000 / 0               | v1 91%, v2 9%          |
| other (v3, not a variant) | 1000 / 0               | v1 88%, v3 12%         |
| other (v3, not a variant) | 500 / 500              | v1 44%, v2 47%, v3 9%  |
| other (v3, not a variant) | 750 / 250              | v1 69%, v2 21%, v3 10% |
| blue (v1)                 | 750 / 250              | v1 22%, v2 78%         |
| blue (v1)                 | 500 / 500              | v1 18%, v2 82%         |
| blue (v1)                 | 250 / 750              | v1 12%, v2 88%         |
| green (v2)                | 750 / 250              | v1 89%, v2 11%         |
| live (another tag on v1)  | 750 / 250              | v1 25%, v2 75%         |

- **The extra share belongs to the record's own target, not to zero-weight variants.** The target gets about 10% whatever the weights are, even when it's a third version that isn't a variant. A zero-weight variant gets nothing unless it's also the target.
- **Weights are only proportional when the target is outside the variants.** When the target and a variant are the same version (even through a different tag name), that variant loses most of its weight. So a gradual canary can't be done cleanly: either a variant's share is distorted, or a third version takes about 10%.
- **Full cutovers work.** Swapping 1000/0 to 0/1000 and moving the record's target in the same PATCH sent 100% to the new version: 0 errors in 20 swaps (2,104 requests), with the native load balancer's usual 0 to 6 s delay. A control run of plain `live` tag flips on the same node still failed (7 of 10 flips, 19 of 1,133 requests, all `503 no routers for desired route`).
- **Moving the idle color's tag leaks live traffic.** With all traffic on `blue` (1000/0), moving `green` between `v2` and `v3` caused no errors, but for up to about 6.7 s after each move, 6 to 28% of requests went to the idle version (98 of 645 over six moves). A single move followed by a wait showed no lasting effect. In a release, that means some users briefly hit the new version before the PATCH that's meant to switch them.

So the weights workaround is a two-update release (move the idle tag, then PATCH weights and target together) that works for full cutovers but briefly exposes the new version at the first step and can't do clean gradual shifts. HAProxy with a plain tag move stays the recommendation.

## Reset Between Takes

Back to "nothing provisioned" (before shot 1):

- [ ] Stop `watch-health.sh`.
- [ ] In `Deputies filming`, stop the environment, then delete the app containers (every deployment version), `postgres` (this deletes the volume and the demo history), and `netcut` if used. Keep the stacks to redeploy, or delete them. Clear the deployment tags (`POST /v1/environments/{id}/tasks` with `{"action":"deployments.reconfigure","contents":{"tags":{}}}`) so the next take starts with none.
- [ ] Remove every container instance on each server, including stopped ones and a migration's retained source (kept 3 hours), then decommission the servers. If a decommission is refused for leftover instances, the server can stay in `deleting`. `DELETE /v1/infrastructure/servers/{id}` finishes it, and `{"options": {"force": true}}` handles a node that no longer responds.
- [ ] Confirm `GET /v1/infrastructure/servers` returns no servers, and that the instances are gone at AWS and Cherry.
- [ ] Keep the environment, scoped variables, zone and records. LINKED records with no target simply stop resolving.
- [ ] Next take: after §1, do its off-camera environment start and discovery reconfigure again; removing the service instances is what makes it necessary.

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
8. **Real-runner config** also needs `SANDBOX_SECRET_ENCRYPTION_KEY` (required with Postgres and a real sandbox provider) and egress on `api`.
9. **Postgres restarts kill the API.** The control plane's `pg` pools have no `error` listener, so an idle connection terminated by a Postgres restart crashes the process (instance `failed`, then 502s). The stack's restart policy covers it; a Deputies fix was suggested separately.
10. **Stack variables can't be used in image targets** (`{{api_tag}}` fails validation), so releases edit the tag in the file.
11. **`deployment.stop` returns 500** (`gob: type not registered for interface: environmentTasks.Deployment`). Stop the containers directly or prune.
12. **API details:** secret scoped variables take `"secret": {}` (an object, not `true`), and host-network containers must be `public: disable`.
13. **Negative DNS caching.** Requesting a hostname a few seconds before its record propagates got NXDOMAIN cached by some 8.8.8.8 caches (the zone's negative TTL is up to 20 minutes).
14. **Logs:** aggregated logs were empty for the API; the instance console (MCP `capture_stream`) showed its output.
15. **Validation DNS:** there was no Cloudflare access during validation, so it used a separate Cycle-hosted zone, `validate.cycle.deputies.dev`, which Cycle's nameservers serve under the existing `cycle` delegation. Filming on `cycle.deputies.dev` needs no Cloudflare change.
16. **An environment needs a server to initialize.** Creating one in a cluster with no servers leaves it in `new` with `no servers meet deployment criteria`. Add a server, then `POST /v1/environments/{id}/tasks` with `{"action":"initialize"}`. `Deputies filming` is already initialized.
17. **Service instances don't all come back.** Decommissioning needs every instance gone, including the environment's own discovery, load balancer, scheduler and VPN instances. On the next start, Cycle recreated only the load balancer; discovery stayed at zero instances until its service was reconfigured, and `api` crashed on `getaddrinfo EAI_AGAIN postgres` meanwhile. Releasing before starting the environment gave the same crash (the restart policy recovered it after the start).
18. **`@` was slow to resolve once.** After the `@` record was switched from container form to the deployment-tag form and the load balancer came up, Cycle's nameservers answered NODATA for `@` for about 4 minutes, although HTTPS through the load balancer's IP already worked. It resolved right after two other records were created in the zone; whether that triggered it is unknown. `next`, created in tag form, resolved as soon as its tag was set. Query only Cycle's nameserver (`dig @ns1.cycle.io`) until it answers, so no public resolver caches the empty answer (Snag 13).
