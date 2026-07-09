# Deployment Configurations

This directory contains deployment-specific configuration for running Deputies outside the pnpm development workflow.

Deployable source and shared Dockerfiles live under `apps/`:

- `apps/control-plane/`: control-plane API and worker service, including `apps/control-plane/Dockerfile`.
- `apps/web/`: static web UI build, including `apps/web/Dockerfile`.

Deployment target docs:

- `docker-compose/`: full app Docker Compose stacks for local production-style combined and split API/worker/orchestrator deployments.
- `kubernetes/`: Helm charts for Kubernetes deployments.
- `aws/`: Terraform reference deployment for ECS Fargate, RDS, S3, and Lambda MicroVM sandboxes.
- `railway/`: Railway template notes and post-deploy variable setup.

Contributor local support services:

- `local/`: Postgres and SeaweedFS services used by mise tasks such as `mise run //deploy/local:infra:up` and `mise run //deploy/local:infra:down`. This directory does not deploy the full Deputies app stack; use `docker-compose/` if you prefer to run the full stack locally with Docker Compose.

Provider-agnostic deployment guidance lives in `../docs/deployment.md`, including remote MCP/Executor variables such as `MCP_SERVERS`, `MCP_CONNECT_TIMEOUT_MS`, `MCP_TOOL_TIMEOUT_MS`, `MCP_TOOL_RESULT_MAX_CHARS`, and `MCP_RESPONSE_MAX_BYTES`. Contributor-focused local development guidance lives in `../docs/contributing-local-development.md`.

Sandbox provider deployment assets live under `sandboxes/`. These build and verify sandbox runtime images only; they do not deploy the full Deputies app stack.

- `sandboxes/docker/`: Docker sandbox image and runtime notes.
- `sandboxes/daytona/`: Daytona image and sandbox verification notes.
- `sandboxes/superserve/`: Superserve custom-template image and linux/amd64 build tasks.
- `sandboxes/lambda-microvm/`: AWS Lambda MicroVM sandbox image package and image-management tasks.

Add one subdirectory per deployment target or infrastructure provider, for example:

- `terraform/`

Keep provider-specific secrets out of this directory. Document required environment variables in the relevant subdirectory README instead.
