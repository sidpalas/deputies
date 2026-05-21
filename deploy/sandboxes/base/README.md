# Sandbox Base Image

This directory defines the provider-neutral base toolchain for Deputies-compatible sandboxes.

It includes:

- Ubuntu 24.04
- Node.js 24 and Corepack/pnpm
- Git, Git LFS, SSH, jq, rsync, zsh, vim, and sudo
- `code-server`, `ttyd`, and `hunkdiff` for browser-accessible workspace tools
- Deputies sandbox bridge build output at `/opt/deputies/sandbox-bridge`

Build locally:

```sh
docker build -f deploy/sandboxes/base/Dockerfile -t deputies-sandbox-base:local .
```

Provider-specific images still need to add their provider contract. The Docker provider starts the Deputies sandbox bridge as its command. Daytona uses a long-running command and usually the no-nested-virtualization helper scripts. The example provider images also add Postgres and Playwright Chromium on top of the default base because this repo's full checks need database and browser-test support. Most users should derive from `deploy/sandboxes/docker/` or `deploy/sandboxes/daytona/` images rather than using this base directly as a sandbox image.
