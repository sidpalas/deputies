# deputies-app

Reusable Terraform module for the Deputies application runtime on ECS Fargate.

## Owns

- Application ALB, listeners, target group, and security groups.
- ECS cluster, task definitions, services, task roles, and execution roles.
- RDS Postgres instance and subnet/security group wiring.
- S3 bucket for Deputies artifact storage.
- Secrets Manager JSON secret consumed by the ECS task.
- Control-plane environment variables for runner, sandbox, auth, storage, and Lambda MicroVM runtime settings.

## Does Not Own

- VPC/subnets. Pass these from the `networking` module or your own network stack.
- DNS records. Use the ALB outputs to create DNS records in Cloudflare/Route53/etc.
- ACM certificate validation. Pass a ready certificate ARN, or use the live root's managed ACM wrapper.
- Lambda MicroVM image builds. This module only passes image/runtime settings to the app.
- Individual sandbox instances. Deputies creates and cleans them up at runtime.

## Topology

`topology_mode = "combined"` creates one ECS service with `web`, `control-plane`, and `migrate` containers.

`topology_mode = "split"` creates separate API and worker ECS services. The API task runs `web`, `api`, and `migrate`; the worker task runs `worker` and `migrate`.

In both modes, the main control-plane container depends on the `migrate` container completing successfully before it starts.

## Image Inputs

Prefer keeping repository and tag separate:

```hcl
control_plane_image = "ghcr.io/sidpalas/deputies-control-plane"
web_image           = "ghcr.io/sidpalas/deputies-web"
image_tag           = "<tag>"
```

For digest-pinned deployments, set `image_tag = ""` and pass full image references in `control_plane_image` and `web_image`.

## Secrets

Terraform generates database/auth bootstrap secrets and merges `app_secret_values` into one Secrets Manager JSON secret.

Values in `app_secret_values` are stored in Terraform state. For hardened production deployments, manage secret versions outside Terraform and adapt this module to reference pre-created secrets.

## Key Outputs

- `app_url`, `alb_dns_name`, `alb_zone_id` for routing.
- `ecs_cluster_name`, `ecs_service_name`, and `ecs_service_names` for operations.
- `task_role_arn` and `task_role_arns` for IAM extension.
- `artifact_bucket_name` and `app_secret_arn` for storage/secrets operations.
