# Superserve Sandbox Image

This directory defines the Deputies runtime image intended for a Superserve custom template. It includes the shared sandbox toolchain and bridge, Node.js, Git, Postgres, and Playwright Chromium.

## Image contract

Superserve custom images must be Linux/amd64 images using glibc; Alpine and distroless images are not supported. Both requirements are enforced here:

- The mise build and publish tasks default to `--platform linux/amd64`.
- The Dockerfile fails unless BuildKit reports `TARGETARCH=amd64`, Debian reports the `amd64` architecture, and `getconf GNU_LIBC_VERSION` succeeds.

## Build and publish

Use a pinned tag for repeatable deployments:

```sh
SUPERSERVE_IMAGE=ghcr.io/<owner>/deputies-superserve-sandbox:<tag> \
mise run //deploy/sandboxes/superserve:image:publish
```

The image must be publicly pullable, or Superserve must have credentials for its registry.

## Create or rebuild the Superserve template

Superserve publishes `@superserve/cli`, but its current CLI release does not include template-management commands. The repository uses the official TypeScript SDK for this workflow instead.

The idempotent task creates the template when absent, or rebuilds its existing image reference when present, then waits for readiness:

```sh
SUPERSERVE_IMAGE=ghcr.io/<owner>/deputies-superserve-sandbox:<tag> \
SUPERSERVE_TEMPLATE=deputies \
mise run //deploy/sandboxes/superserve:template:sync
```

It loads `SUPERSERVE_API_KEY` and other defaults from the repository `.env.local` when present. The default template shape is 2 vCPU, 2048 MiB memory, and 8192 MiB disk, matching Superserve's initial team limits. Override it only when first creating the template with `SUPERSERVE_TEMPLATE_VCPU`, `SUPERSERVE_TEMPLATE_MEMORY_MIB`, and `SUPERSERVE_TEMPLATE_DISK_MIB`.

`SUPERSERVE_IMAGE` is stored when the template is first created. Later syncs rebuild that stored reference; they do not replace it. Use a stable mutable tag for in-place rebuilds, or choose a new `SUPERSERVE_TEMPLATE` name when moving to a different pinned image reference.

To push the image and sync the template sequentially:

```sh
SUPERSERVE_IMAGE=ghcr.io/<owner>/deputies-superserve-sandbox:<tag> \
SUPERSERVE_TEMPLATE=deputies \
mise run //deploy/sandboxes/superserve:publish
```

The console remains an alternative: create a template using **Custom image**, enter the published image reference, and wait for its build to become ready.

Configure Deputies with that template name or ID:

```sh
SANDBOX_PROVIDER=superserve
SUPERSERVE_API_KEY=<secret>
SUPERSERVE_TEMPLATE=deputies
SANDBOX_WORKSPACE_PATH=/workspace
```

`SUPERSERVE_BASE_URL` is optional and should normally be left unset.

Run the opt-in live provider UAT with:

```sh
mise run //deploy/sandboxes/superserve:uat
```

The UAT creates one sandbox, validates exec, files, pause/resume, and the authenticated bridge preview, then deletes the sandbox.

## GHCR package

No separate Git repository is required. Pushing `ghcr.io/<owner>/deputies-superserve-sandbox:<tag>` creates or updates a distinct container package under that GitHub owner. After the first push, link the package to this repository and make it public, or configure Superserve with credentials that can pull it.

## Service endpoints

Deputies exposes Superserve's public URL for port `3584`, where the authenticated sandbox bridge runs. User application ports are reached only through the bridge's `/preview/<port>` route. The public Superserve endpoint therefore never exposes an unauthenticated application port directly.
