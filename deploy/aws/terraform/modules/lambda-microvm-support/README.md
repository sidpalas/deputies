# lambda-microvm-support

Reusable Terraform module for stable AWS resources needed by the Lambda MicroVM sandbox provider.

## Owns

- Versioned private S3 bucket for MicroVM image build artifacts.
- IAM role Lambda assumes while building MicroVM images.
- Optional runtime IAM role passed to `run-microvm`.
- CloudWatch log group for MicroVM build/runtime logs.
- Stable image name/ARN derivation and AWS-managed network connector ARNs.

## Does Not Own

- MicroVM image creation or updates. Use `deploy/sandboxes/lambda-microvm` tasks with this module's outputs.
- Individual MicroVM runtime instances. Deputies creates, resumes, suspends, and terminates them at runtime.
- ECS task permissions. Grant the app task role Lambda MicroVM permissions in the app/runtime stack.
- Application environment variables. Pass this module's outputs into the `deputies-app` module or equivalent app stack.

## Image Workflow

The `mise_environment` output is designed to feed the image lifecycle tasks:

```sh
eval "$(terraform -chdir=deploy/aws/terraform/live/prod output -json lambda_microvm_mise_environment \
  | jq -r 'to_entries[] | "export \(.key)=\(.value|@sh)"')"
```

Then use the Lambda MicroVM tasks under `deploy/sandboxes/lambda-microvm` to create or update the image.

## Network Connectors

The module outputs AWS-managed connector ARNs for:

- `ALL_INGRESS`
- `INTERNET_EGRESS`

The live reference root uses these by default, but stricter deployments should pass narrower connectors when available.

## Key Outputs

- `artifact_bucket_name` for image artifacts.
- `build_role_arn` for image creation/update calls.
- `runtime_role_arn` for `run-microvm` execution.
- `image_arn` and `image_name` for application configuration.
- `log_group_name` for runtime logs.
- `mise_environment` for local/CI image tasks.
