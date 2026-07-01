# AWS Live Prod Reference

This root is a reference implementation for running Deputies on AWS. It is intentionally concrete enough to apply, but it is not a universal production baseline.

Before applying it to your own account, copy `terraform.tfvars.example` to `terraform.tfvars` and adapt the values for your domain, account, risk tolerance, cost targets, and operational requirements.

## What This Root Wires Together

- `../../modules/networking` for VPC, subnets, routes, S3 endpoint, and NAT.
- `../../modules/lambda-microvm-support` for stable Lambda MicroVM image support resources.
- `../../modules/deputies-app` for ALB, ECS, RDS, artifact storage, app secrets, and app runtime configuration.
- Optional ACM certificate request for the app host and wildcard preview domain.

## Adapt Before Use

Review at least these settings in `terraform.tfvars.example`:

- `app_hostname` and `service_base_domain` for app and sandbox preview routing.
- `aws_region`, `environment`, `name_prefix`, and `tags` for account naming conventions.
- `vpc_cidr`, `az_count`, `nat_mode`, and `fck_nat_instance_type` for network design and cost.
- `control_plane_image`, `web_image`, and `image_tag` for the images you actually publish.
- `runner`, `runner_model_default`, and `app_secret_values` for model provider access.
- `topology_mode`, desired counts, task CPU/memory, and `cpu_architecture` for service shape.
- RDS size, backup retention, Multi-AZ, deletion protection, and final snapshot behavior.
- Lambda MicroVM image version, network connectors, max duration, and artifact bucket force-destroy settings.

## State And Secrets

This reference root does not configure a Terraform backend. Without a backend block, Terraform uses a local backend; that is only for local testing and reference-stack iteration.

Configure an encrypted remote Terraform backend with locking before using this root for anything durable. Terraform state contains generated database/auth/sandbox secrets and any values supplied through `app_secret_values`. Use the backend that fits your organization, for example S3 with DynamoDB/S3 locking, Terraform Cloud, or another supported remote backend.

Do not commit `terraform.tfvars` or state files. The example file documents the expected shape only.

## First Apply Flow

1. Publish compatible multi-arch app images.
2. Copy and adapt `terraform.tfvars.example`.
3. Run `terraform init`, `terraform plan`, and `terraform apply` from this directory or through `mise` tasks.
4. If using Terraform-managed ACM, create DNS validation records from `managed_acm_dns_validation_records`.
5. After ACM issuance, set `managed_acm_https_enabled = true` and apply again.
6. Build or update the Lambda MicroVM image using `deploy/sandboxes/lambda-microvm` tasks and set `lambda_microvm_image_version` when you want a fixed runtime version.

## Teardown

Plan teardown explicitly. Active MicroVMs and out-of-band MicroVM image versions are runtime/image-lifecycle state and are not fully managed by this Terraform root.
