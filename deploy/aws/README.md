# AWS Reference Deployment

This is the reference AWS deployment for Deputies. The live reference stack is under `terraform/live/prod`; reusable Terraform lives under `terraform/modules`.

## Shape

- VPC, public/private subnets, route tables, S3 gateway endpoint, and configurable NAT via `terraform-aws-modules/vpc/aws` plus optional `fck_nat`.
- ECS Fargate task running the web container and a combined control-plane container.
- RDS Postgres for durable app and runner state.
- S3 bucket for Deputies artifact storage, accessed with the ECS task role credential chain.
- Lambda MicroVM support resources for sandbox images and runtime permissions.

## Lambda MicroVM Ownership

Terraform manages stable support resources only:

- MicroVM image artifact S3 bucket.
- IAM build role used by `aws lambda-microvms create-microvm-image` / `update-microvm-image`.
- Optional runtime role passed to `run-microvm`.
- CloudWatch log group.
- ECS task-role permissions to run, inspect, suspend, resume, terminate MicroVMs, create endpoint auth tokens, and pass the runtime role.

Terraform does not build MicroVM images and does not manage individual MicroVM instances. Images are managed by `deploy/sandboxes/lambda-microvm` `mise` tasks, likely from CI. Individual MicroVMs are runtime state managed by the Deputies control plane.

## Deploy

Run commands from the repository root unless a command says otherwise. Use a deploy-only AWS identity or profile; do not source the app `.env.local` for production deploys because it may export unrelated application secrets and accidental `TF_VAR_*` values into Terraform or child processes.

```sh
export AWS_PROFILE=deputies-prod
export AWS_REGION=us-east-2
export AWS_DEFAULT_REGION=us-east-2
export AWS_PAGER=
aws sts get-caller-identity
```

The AWS reference defaults the ECS task runtime platform to `ARM64` so Fargate can use cheaper Graviton capacity. The published control-plane and web images are multi-arch manifests for `linux/amd64` and `linux/arm64`, and the image publish workflow installs QEMU for ARM64 builds on GitHub-hosted x86 runners.

For local image publishing, use the active Docker Buildx builder. This can be a local QEMU/binfmt builder or a remote builder such as Namespace, Depot, Docker Build Cloud, or another Buildx-compatible endpoint:

```sh
CONTROL_PLANE_IMAGE=ghcr.io/<owner>/deputies-control-plane:<tag> \
WEB_IMAGE=ghcr.io/<owner>/deputies-web:<tag> \
DEPUTIES_APP_IMAGE_PLATFORMS=linux/amd64,linux/arm64 \
mise run images:app:push:multiarch
```

If you must run x86 Fargate, set `cpu_architecture = "X86_64"` in `terraform.tfvars`.

Copy the example variables, fill in at least `app_hostname`, and keep real secrets out of git:

```sh
cp deploy/aws/terraform/live/prod/terraform.tfvars.example deploy/aws/terraform/live/prod/terraform.tfvars
mise run //deploy/aws:init
mise run //deploy/aws:plan
mise run //deploy/aws:apply
```

With the default `create_managed_acm_certificate = true`, the first apply also requests an ACM certificate for `app_hostname` and the wildcard under `service_base_domain`. Create the Cloudflare DNS validation CNAMEs from `managed_acm_dns_validation_records` and wait for ACM to mark the certificate issued.

Then set `managed_acm_https_enabled = true` and apply again. The ALB will redirect HTTP to HTTPS and terminate TLS with the Terraform-managed ACM certificate, which supports Cloudflare Full/Strict mode.

The reference Terraform creates one ECS service, so leave `run_mode = "combined"` unless you intentionally use `all`. Split `api`/`worker` topologies need separate ECS services with separate task roles and are outside this root.

After the ALB exists, create Cloudflare DNS records against `alb_dns_name`:

```txt
deputies.example.com     CNAME  <alb_dns_name>
*.deputies.example.com   CNAME  <alb_dns_name>
```

If you provide `alb_certificate_arn`, it overrides the Terraform-managed certificate. The certificate must cover both `app_hostname` and the wildcard under `service_base_domain`. If no certificate is attached, the ALB is HTTP-only; use that only while bootstrapping validation or when Cloudflare proxies and terminates TLS for both the app host and wildcard preview host.

Cloudflare notes:

- Keep ACM validation CNAMEs DNS-only.
- App and wildcard records can be DNS-only to use the ALB ACM certificate directly.
- If Cloudflare proxies the records, Cloudflare also needs an edge certificate covering both the app host and wildcard preview host.
- Use Full/Strict after ACM issuance. Avoid Flexible/HTTP-only except for temporary bootstrap.
- Prefer `service_base_domain = "example.com"` when relying on Cloudflare Universal SSL for `*.example.com`; nested wildcard hosts may require an advanced/custom edge certificate.

## Build The Lambda MicroVM Image

If you only want to validate the MicroVM provider before applying the full app stack, create just the support resources first:

```sh
mise run //deploy/aws:microvm-support:plan
mise run //deploy/aws:microvm-support:apply
```

Then export the Terraform output values for the image workflow into the same shell that invokes the image tasks:

```sh
eval "$(terraform -chdir=deploy/aws/terraform/live/prod output -json lambda_microvm_mise_environment \
  | jq -r 'to_entries[] | "export \(.key)=\(.value|@sh)"')"
```

For a first image, create it and poll until the build is active:

```sh
mise run //deploy/sandboxes/lambda-microvm:cli:check
mise run //deploy/sandboxes/lambda-microvm:image:create
mise run //deploy/sandboxes/lambda-microvm:image:get
MICROVM_IMAGE_VERSION=1.0 mise run //deploy/sandboxes/lambda-microvm:image:builds
MICROVM_IMAGE_VERSION=1.0 MICROVM_BUILD_ID=<build-id> mise run //deploy/sandboxes/lambda-microvm:image:build:get
```

Use `image:update` only for subsequent image revisions:

```sh
mise run //deploy/sandboxes/lambda-microvm:image:update
mise run //deploy/sandboxes/lambda-microvm:image:get
```

The app receives `LAMBDA_MICROVM_IMAGE_IDENTIFIER` from Terraform. If you leave `lambda_microvm_image_identifier` empty, it defaults to the stable image ARN derived from the Lambda MicroVM support module.

The image tasks require an AWS CLI build/version that supports `aws lambda-microvms`. Run `mise run //deploy/sandboxes/lambda-microvm:cli:check` before using the image lifecycle tasks.

The CI/operator identity that runs these image tasks needs permission to:

- `s3:PutObject` to the MicroVM artifact bucket.
- `lambda:CreateMicrovmImage`, `lambda:UpdateMicrovmImage`, `lambda:GetMicrovmImage`, `lambda:ListMicrovmImageVersions`, `lambda:ListMicrovmImageBuilds`, `lambda:GetMicrovmImageBuild`, `lambda:DeleteMicrovmImageVersion`, `lambda:ListManagedMicrovmImages`, and `lambda:ListManagedMicrovmImageVersions` for the image workflow.
- `lambda:PassNetworkConnector` for configured image network connectors.
- `iam:PassRole` for the MicroVM build role, constrained with `iam:PassedToService = lambda.amazonaws.com`.

## Bedrock Models

For AWS-hosted model access, use the Pi runner with Amazon Bedrock model IDs:

```hcl
runner               = "pi"
runner_model_default = "amazon-bedrock/us.anthropic.claude-haiku-4-5-20251001-v1:0"
```

The ECS task role supplies AWS credentials. The runner uses `BEDROCK_REGION` when set, then `AWS_REGION`, then `AWS_DEFAULT_REGION`. Claude on Bedrock often requires inference-profile IDs such as `us.anthropic.claude-haiku-4-5-20251001-v1:0`; direct base model IDs can fail with on-demand throughput errors. If Bedrock ships a useful inference-profile ID before the Pi catalog includes it, temporarily supplement the catalog in `apps/control-plane/src/runner/bedrock.ts`. Ensure Bedrock model/profile access is enabled in the selected region/account before relying on the deployment.

## Secrets Pattern

The reference stack writes a single Secrets Manager JSON secret and injects selected keys as ECS task secrets.

Terraform generates defaults for:

- `DATABASE_URL`
- `AUTH_SESSION_SECRET`
- `AUTH_STATIC_PASSWORD`
- `SANDBOX_SECRET_ENCRYPTION_KEY`

Use `app_secret_values` for model keys and integration secrets, for example:

```hcl
app_secret_values = {
  ANTHROPIC_API_KEY = "..."
  GITHUB_APP_PRIVATE_KEY = "..."
  MCP_SERVERS = jsonencode([
    {
      name = "executor"
      url  = "https://<executor-host>/mcp"
      headers = {
        Authorization = "Bearer <executor-api-key>"
      }
      transport    = "streamable-http"
      allowedTools = ["execute", "skills", "resume"]
    }
  ])
}
```

Optional MCP runtime knobs can also be set as ECS environment variables or secrets: `MCP_CONNECT_TIMEOUT_MS` defaults to `10000`, `MCP_TOOL_TIMEOUT_MS` defaults to `60000`, `MCP_TOOL_RESULT_MAX_CHARS` defaults to `100000`, and `MCP_RESPONSE_MAX_BYTES` defaults to `5242880`. MCP auth headers are used only by the control-plane worker process and are not copied into sandbox environment variables. `MCP_TOOL_TIMEOUT_MS` and `MCP_TOOL_RESULT_MAX_CHARS` are enforced by the Pi/shared MCP client.

Values supplied through Terraform variables are stored in Terraform state. For stricter production secret handling, create/update the Secrets Manager secret version outside Terraform and pass only secret ARNs/keys into a hardened variant of this module.

For the generated static bootstrap password:

```sh
aws secretsmanager get-secret-value \
  --secret-id "$(terraform -chdir=deploy/aws/terraform/live/prod output -raw app_secret_arn)" \
  --query SecretString \
  --output text | jq -r .AUTH_STATIC_PASSWORD
```

## State

The reference root intentionally leaves backend configuration to the operator. Without a backend block, Terraform uses a local backend; that is only for local testing and reference-stack iteration.

For any real environment, configure an encrypted remote backend with locking before applying because Terraform state contains generated DB/auth/sandbox secrets and any values supplied through `app_secret_values`. Use the backend that fits your organization, for example an S3 backend with DynamoDB/S3 locking, Terraform Cloud, or another supported remote backend.

## Teardown

Before destroying a production-like stack, plan the cleanup explicitly:

1. Scale the ECS service down or stop traffic to prevent new sandbox creation.
2. Terminate active Lambda MicroVM instances and delete out-of-band MicroVM images/versions with the `deploy/sandboxes/lambda-microvm` tasks or AWS CLI.
3. Decide whether to disable RDS deletion protection and whether to keep a final snapshot.
4. Empty versioned S3 buckets if destroy fails because retained objects remain.
5. Account for Secrets Manager recovery windows before expecting secrets to disappear.
6. Remove or repoint Cloudflare DNS after the replacement target is ready.
7. Retain remote Terraform state long enough to audit what was destroyed.
