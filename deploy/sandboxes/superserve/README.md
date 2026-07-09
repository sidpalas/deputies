# Superserve Templates

Superserve sandboxes use the published Daytona image as their template source. It already contains the Deputies sandbox bridge, Node.js, Git, Postgres, and Playwright Chromium, and is built for the Linux/amd64 glibc runtime required by Superserve.

## Create or rebuild a template

Superserve publishes `@superserve/cli`, but its current CLI release does not include template-management commands. The repository uses the official TypeScript SDK instead.

The template task creates a template when it is absent, or rebuilds the template's stored image reference when it exists:

```sh
SUPERSERVE_IMAGE=ghcr.io/sidpalas/deputies-daytona-sandbox:<tag-or-digest> \
SUPERSERVE_TEMPLATE=deputies \
mise run //deploy/sandboxes/superserve:template:sync
```

When not explicitly set, `SUPERSERVE_IMAGE` inherits `DAYTONA_IMAGE` and otherwise defaults to `ghcr.io/sidpalas/deputies-daytona-sandbox:latest`. The task loads `.env.local` when available. The default template shape is 2 vCPU, 2048 MiB memory, and 8192 MiB disk; override it only when first creating a template with `SUPERSERVE_TEMPLATE_VCPU`, `SUPERSERVE_TEMPLATE_MEMORY_MIB`, and `SUPERSERVE_TEMPLATE_DISK_MIB`.

The image reference is stored when a template is first created. Subsequent syncs rebuild that stored reference. Use a stable mutable tag for in-place rebuilds, or a new template name when moving to a different pinned image reference.

When the shared Daytona image changes, publish it first and then sync the Superserve template so it receives the new bridge payload:

```sh
mise run //deploy/sandboxes/daytona:image:publish
mise run //deploy/sandboxes/superserve:template:sync
```

Configure Deputies with that template name or ID:

```sh
SANDBOX_PROVIDER=superserve
SUPERSERVE_API_KEY=<secret>
SUPERSERVE_TEMPLATE=deputies
SANDBOX_WORKSPACE_PATH=/workspace
```

`SUPERSERVE_BASE_URL` is optional and should normally be left unset.

## Live UAT

```sh
mise run //deploy/sandboxes/superserve:uat
```

The UAT creates one sandbox, validates exec, files, pause/resume, and the authenticated bridge preview, then verifies sandbox deletion.

## Service endpoints and trust boundary

Deputies exposes Superserve's public URL for bridge port `3584`; application ports are reached through `/preview/<port>`. The bridge token blocks arbitrary external callers from directly using that public endpoint.

The token is intentionally available to the bridge process inside the sandbox. It is therefore a sandbox-visible capability, not a secrecy boundary against code already executing in the same sandbox. Treat all code allowed to execute there as trusted with respect to preview access.
