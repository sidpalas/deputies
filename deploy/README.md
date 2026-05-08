# Deployment Configurations

This directory contains deployment-specific configuration for running Deputies outside local development.

Deployable source lives under `apps/`:

- `apps/api/`: API and worker service.
- `apps/web/`: static web UI build.

Local development configuration lives under `deploy/local/`. Use the root `pnpm db:up` and `pnpm db:down` scripts instead of calling Docker Compose directly.

Use one subdirectory per deployment target or infrastructure provider, for example:

- `railway/`
- `docker/`
- `k8s/`
- `terraform/`

Keep provider-specific secrets out of this directory. Document required environment variables in the relevant subdirectory README instead.
