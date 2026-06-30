# Lambda MicroVM Sandbox Image

This directory packages the Deputies sandbox bridge for AWS Lambda MicroVMs.

Lambda MicroVM images are not OCI images pushed to a registry. AWS builds them from a zip artifact containing a `Dockerfile` and application files. The workflow here packages this directory, uploads the zip to S3, then calls `aws lambda-microvms create-microvm-image` or `update-microvm-image`.

The Lambda MicroVM image intentionally builds its own ARM64-compatible sandbox runtime from public multi-arch base images. It does not inherit from `ghcr.io/sidpalas/deputies-docker-sandbox`, which is currently published as amd64-only for Daytona compatibility.

## Prerequisites

- A deploy-only AWS identity or profile with access to the artifact bucket, Lambda MicroVM image APIs, `lambda:PassNetworkConnector` for configured connectors, and `iam:PassRole` for the build role.
- An AWS CLI build/version that supports the `aws lambda-microvms` command group.
- `mise`, `pnpm`, `zip`, and `jq` for the repo tasks and AWS reference deployment helpers.

Check CLI support with:

```sh
mise run //deploy/sandboxes/lambda-microvm:cli:check
```

## Runtime Shape

`lambda-microvm-runtime.mjs` is a small lifecycle adapter, not a replacement for `@deputies/sandbox-bridge`.

- During `create-microvm-image`, AWS starts this runtime, invokes the enabled `ready` hook on port `9000`, and snapshots the initialized MicroVM.
- During `run-microvm`, AWS restores a fresh MicroVM from that snapshot and invokes the enabled `run` hook with the per-session payload from the control plane.
- The `run` hook starts the packaged Deputies sandbox bridge with the session bridge token, workspace path, and bridge port.
- Control-plane exec, filesystem, and preview requests then go through the sandbox bridge. The Lambda MicroVM endpoint requires `X-aws-proxy-auth` and `X-aws-proxy-port` headers for those bridge requests.

## Required Environment

Before running these tasks, export deploy-only AWS credentials and task variables into the shell that invokes `mise`. Do not source the app `.env.local` for production image builds; it can export unrelated application secrets into Terraform, AWS CLI, or child processes.

```sh
export AWS_PROFILE=deputies-prod
export AWS_REGION=us-east-2
export AWS_DEFAULT_REGION=us-east-2
export AWS_PAGER=
aws sts get-caller-identity
```

Then export the MicroVM image workflow values:

```sh
export MICROVM_ARTIFACT_BUCKET=<s3-bucket-for-image-artifacts>
export MICROVM_ARTIFACT_KEY=lambda-microvm/${GITHUB_SHA}/deputies-lambda-microvm.zip
export MICROVM_IMAGE_NAME=deputies-sandbox
export MICROVM_IMAGE_IDENTIFIER=arn:aws:lambda:us-east-2:<account-id>:microvm-image:deputies-sandbox
export MICROVM_IMAGE_VERSION=1.0
export MICROVM_BASE_IMAGE_ARN=arn:aws:lambda:us-east-2:aws:microvm-image:al2023-1
export MICROVM_BUILD_ROLE_ARN=<iam-role-arn-lambda-assumes-to-build-image>
```

Optional environment:

```sh
export MICROVM_BASE_IMAGE_VERSION=
export MICROVM_IMAGE_DESCRIPTION="Deputies Lambda MicroVM sandbox image"
export MICROVM_LOG_GROUP=/aws/lambda/microvms/deputies-sandbox
export MICROVM_MIN_MEMORY_MIB=512
export MICROVM_HOOKS_PORT=9000
export MICROVM_READY_HOOK=ENABLED
export MICROVM_READY_TIMEOUT_SECONDS=60
export MICROVM_VALIDATE_HOOK=DISABLED
export MICROVM_VALIDATE_TIMEOUT_SECONDS=60
export MICROVM_RUN_HOOK=ENABLED
export MICROVM_RUN_TIMEOUT_SECONDS=60
export MICROVM_RESUME_HOOK=ENABLED
export MICROVM_RESUME_TIMEOUT_SECONDS=60
export MICROVM_SUSPEND_HOOK=ENABLED
export MICROVM_SUSPEND_TIMEOUT_SECONDS=30
export MICROVM_TERMINATE_HOOK=ENABLED
export MICROVM_TERMINATE_TIMEOUT_SECONDS=30
export MICROVM_IMAGE_EGRESS_NETWORK_CONNECTORS=
export MICROVM_ADDITIONAL_OS_CAPABILITIES=
```

## Commands

First-time image creation:

```sh
mise run //deploy/sandboxes/lambda-microvm:cli:check
mise run //deploy/sandboxes/lambda-microvm:image:create
mise run //deploy/sandboxes/lambda-microvm:image:get
MICROVM_IMAGE_VERSION=1.0 mise run //deploy/sandboxes/lambda-microvm:image:builds
MICROVM_IMAGE_VERSION=1.0 MICROVM_BUILD_ID=<build-id> mise run //deploy/sandboxes/lambda-microvm:image:build:get
```

Subsequent image revisions:

```sh
mise run //deploy/sandboxes/lambda-microvm:image:update
mise run //deploy/sandboxes/lambda-microvm:image:get
mise run //deploy/sandboxes/lambda-microvm:image:versions
MICROVM_IMAGE_VERSION=2.0 mise run //deploy/sandboxes/lambda-microvm:image:builds
MICROVM_IMAGE_VERSION=2.0 MICROVM_BUILD_ID=<build-id> mise run //deploy/sandboxes/lambda-microvm:image:build:get
MICROVM_IMAGE_VERSION=2.0 mise run //deploy/sandboxes/lambda-microvm:image:version:delete
```

Discovery helpers:

```sh
mise run //deploy/sandboxes/lambda-microvm:managed:list
mise run //deploy/sandboxes/lambda-microvm:managed:versions
```

## Control-Plane Runtime Env

After the image is created, configure Deputies with:

```sh
SANDBOX_PROVIDER=lambda-microvm
LAMBDA_MICROVM_IMAGE_IDENTIFIER=<image-arn>
LAMBDA_MICROVM_IMAGE_VERSION=<optional-version>
LAMBDA_MICROVM_EXECUTION_ROLE_ARN=<optional-runtime-role-arn>
LAMBDA_MICROVM_INGRESS_NETWORK_CONNECTORS=arn:aws:lambda:us-east-2:aws:network-connector:aws-network-connector:ALL_INGRESS
LAMBDA_MICROVM_EGRESS_NETWORK_CONNECTORS=arn:aws:lambda:us-east-2:aws:network-connector:aws-network-connector:INTERNET_EGRESS
LAMBDA_MICROVM_MAXIMUM_DURATION_SECONDS=28800
LAMBDA_MICROVM_AUTH_TOKEN_TTL_MINUTES=30
LAMBDA_MICROVM_BRIDGE_PORT=3584
```

Inbound traffic to a MicroVM uses the AWS-managed MicroVM HTTPS endpoint. VPC network connectors are for MicroVM egress into the VPC or public internet; they do not replace the inbound endpoint.

The `Dockerfile` duplicates the sandbox runtime package set used by the Docker sandbox image so AWS can build it natively for Lambda MicroVM ARM64. If the Docker sandbox image becomes reliably multi-arch, this can converge back to deriving from the published image.

If `cli:check` fails, install an AWS CLI build/version with Lambda MicroVM support before running image lifecycle tasks.

## Cleanup

MicroVM images and versions are managed outside Terraform. During teardown or failed image experiments, delete unneeded image versions with `image:version:delete`, delete the image itself with the AWS CLI when all versions should go away, and then remove the Terraform-managed support resources. Active runtime MicroVM instances should be terminated before deleting their image/support roles.
