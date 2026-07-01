variable "aws_region" {
  description = "AWS region for the reference deployment."
  type        = string
  default     = "us-east-2"
}

variable "environment" {
  description = "Deployment environment label."
  type        = string
  default     = "prod"
}

variable "name_prefix" {
  description = "Prefix used for named AWS resources."
  type        = string
  default     = "deputies"
}

variable "app_hostname" {
  description = "Public application hostname. Create the Cloudflare DNS record manually against the ALB DNS output."
  type        = string
}

variable "service_base_domain" {
  description = "Base domain for sandbox service preview hosts. Empty defaults to app_hostname."
  type        = string
  default     = ""
}

variable "vpc_cidr" {
  description = "CIDR block for the VPC."
  type        = string
  default     = "10.42.0.0/16"
}

variable "az_count" {
  description = "Number of AZs to use for public/private subnets."
  type        = number
  default     = 2
}

variable "nat_mode" {
  description = "NAT mode for private subnet egress."
  type        = string
  default     = "fck_nat"

  validation {
    condition     = contains(["fck_nat", "single_nat_gateway", "one_nat_gateway_per_az"], var.nat_mode)
    error_message = "Allowed values for nat_mode are fck_nat, single_nat_gateway, or one_nat_gateway_per_az."
  }
}

variable "fck_nat_instance_type" {
  description = "Instance type for fck-nat gateways."
  type        = string
  default     = "t4g.nano"
}

variable "alb_certificate_arn" {
  description = "Optional existing ACM certificate ARN for an HTTPS ALB listener. Overrides the Terraform-managed ACM certificate."
  type        = string
  default     = ""
}

variable "create_managed_acm_certificate" {
  description = "Whether to request a Terraform-managed ACM certificate for app_hostname and the wildcard service base domain when alb_certificate_arn is empty."
  type        = bool
  default     = true
}

variable "managed_acm_https_enabled" {
  description = "Whether to attach the Terraform-managed ACM certificate to the ALB. Enable after creating the Cloudflare DNS validation records and ACM has issued the certificate."
  type        = bool
  default     = false
}

variable "control_plane_image" {
  description = "Control-plane container image repository, or full image reference when image_tag is empty."
  type        = string
  default     = "ghcr.io/sidpalas/deputies-control-plane"
}

variable "web_image" {
  description = "Web container image repository, or full image reference when image_tag is empty."
  type        = string
  default     = "ghcr.io/sidpalas/deputies-web"
}

variable "image_tag" {
  description = "Container image tag for Deputies images. Set empty when control_plane_image/web_image are full references such as digest-pinned refs."
  type        = string
  default     = "latest"
}

variable "run_mode" {
  description = "Control-plane run mode for combined topology. Split topology uses api and worker run modes automatically."
  type        = string
  default     = "combined"

  validation {
    condition     = contains(["combined", "all"], var.run_mode)
    error_message = "Allowed values for run_mode are combined or all."
  }
}

variable "topology_mode" {
  description = "Control-plane topology mode. combined creates one ECS service with web and control-plane containers. split creates separate API and worker ECS services."
  type        = string
  default     = "combined"

  validation {
    condition     = contains(["combined", "split"], var.topology_mode)
    error_message = "Allowed values for topology_mode are combined or split."
  }
}

variable "desired_count" {
  description = "Desired ECS service task count for combined topology."
  type        = number
  default     = 1
}

variable "api_desired_count" {
  description = "Desired ECS task count for the API service when topology_mode is split."
  type        = number
  default     = 1
}

variable "worker_desired_count" {
  description = "Desired ECS task count for the worker service when topology_mode is split."
  type        = number
  default     = 1
}

variable "task_cpu" {
  description = "Fargate task CPU units for combined topology and the default for split topology."
  type        = number
  default     = 512
}

variable "task_memory" {
  description = "Fargate task memory MiB for combined topology and the default for split topology."
  type        = number
  default     = 1024
}

variable "api_task_cpu" {
  description = "Optional Fargate task CPU units for the split API service. Defaults to task_cpu."
  type        = number
  default     = null
}

variable "api_task_memory" {
  description = "Optional Fargate task memory MiB for the split API service. Defaults to task_memory."
  type        = number
  default     = null
}

variable "worker_task_cpu" {
  description = "Optional Fargate task CPU units for the split worker service. Defaults to task_cpu."
  type        = number
  default     = null
}

variable "worker_task_memory" {
  description = "Optional Fargate task memory MiB for the split worker service. Defaults to task_memory."
  type        = number
  default     = null
}

variable "cpu_architecture" {
  description = "Fargate CPU architecture for the app task."
  type        = string
  default     = "ARM64"

  validation {
    condition     = contains(["X86_64", "ARM64"], var.cpu_architecture)
    error_message = "Allowed values for cpu_architecture are X86_64 or ARM64."
  }
}

variable "api_auth_mode" {
  description = "Deputies API auth mode."
  type        = string
  default     = "session"
}

variable "auth_provider" {
  description = "Session auth provider."
  type        = string
  default     = "static"
}

variable "auth_static_username" {
  description = "Static auth username for the initial reference deployment."
  type        = string
  default     = "admin"
}

variable "runner" {
  description = "Deputies runner kind."
  type        = string
  default     = "pi"
}

variable "runner_model_default" {
  description = "Default runner model."
  type        = string
  default     = "amazon-bedrock/us.anthropic.claude-haiku-4-5-20251001-v1:0"
}

variable "sandbox_provider" {
  description = "Sandbox provider used by the ECS deployment."
  type        = string
  default     = "lambda-microvm"
}

variable "lambda_microvm_image_identifier" {
  description = "Existing Lambda MicroVM image ARN to run for sandboxes. Empty uses the ARN derived from lambda_microvm_image_name. Build/manage it with deploy/sandboxes/lambda-microvm."
  type        = string
  default     = ""
}

variable "lambda_microvm_image_name" {
  description = "Stable Lambda MicroVM image name used by the image management workflow when lambda_microvm_image_identifier is empty."
  type        = string
  default     = ""
}

variable "lambda_microvm_base_image_arn" {
  description = "Lambda-managed base MicroVM image ARN. Empty uses the regional AL2023 base image ARN."
  type        = string
  default     = ""
}

variable "lambda_microvm_image_version" {
  description = "Optional Lambda MicroVM image version. Empty uses latest active version."
  type        = string
  default     = ""
}

variable "lambda_microvm_ingress_network_connectors" {
  description = "Ingress connector ARNs for run-microvm. Empty uses the AWS-managed ALL_INGRESS connector for the region."
  type        = list(string)
  default     = []
}

variable "lambda_microvm_egress_network_connectors" {
  description = "Egress connector ARNs for run-microvm. Empty uses the AWS-managed INTERNET_EGRESS connector for the region."
  type        = list(string)
  default     = []
}

variable "lambda_microvm_maximum_duration_seconds" {
  description = "Maximum Lambda MicroVM lifetime in seconds. Maximum is 28800."
  type        = number
  default     = 28800
}

variable "lambda_microvm_auth_token_ttl_minutes" {
  description = "Lambda MicroVM endpoint auth token TTL in minutes. Maximum is 60."
  type        = number
  default     = 30
}

variable "db_name" {
  description = "RDS database name."
  type        = string
  default     = "deputies"
}

variable "db_username" {
  description = "RDS master username."
  type        = string
  default     = "deputies"
}

variable "db_instance_class" {
  description = "RDS instance class."
  type        = string
  default     = "db.t4g.micro"
}

variable "db_allocated_storage" {
  description = "RDS allocated storage in GiB."
  type        = number
  default     = 20
}

variable "db_engine_version" {
  description = "Postgres engine version."
  type        = string
  default     = "17"
}

variable "db_multi_az" {
  description = "Whether RDS should be Multi-AZ."
  type        = bool
  default     = false
}

variable "db_backup_retention_days" {
  description = "RDS backup retention in days."
  type        = number
  default     = 1
}

variable "db_deletion_protection" {
  description = "Whether RDS deletion protection is enabled."
  type        = bool
  default     = true
}

variable "db_skip_final_snapshot" {
  description = "Whether to skip the final RDS snapshot on destroy. Keep false for durable deployments; set true with deletion protection disabled for disposable stacks."
  type        = bool
  default     = false
}

variable "db_iam_database_authentication_enabled" {
  description = "Whether RDS IAM database authentication is enabled. The app still uses DATABASE_URL password auth until runtime support is added."
  type        = bool
  default     = false
}

variable "artifact_bucket_force_destroy" {
  description = "Whether to force-destroy the app artifact bucket."
  type        = bool
  default     = false
}

variable "app_secret_recovery_window_days" {
  description = "Number of days Secrets Manager waits before deleting the app secret. Set 0 for disposable stacks that must recreate the same name immediately."
  type        = number
  default     = 30
}

variable "microvm_artifact_bucket_force_destroy" {
  description = "Whether to force-destroy the Lambda MicroVM image artifact bucket."
  type        = bool
  default     = false
}

variable "app_secret_values" {
  description = "Additional or overriding app secrets stored in Secrets Manager. Values are written to Terraform state; use external secret versioning if that is unacceptable."
  type        = map(string)
  default     = {}
  sensitive   = true
}

variable "extra_environment" {
  description = "Additional non-secret environment variables for the control-plane container."
  type        = map(string)
  default     = {}
}

variable "tags" {
  description = "Additional AWS tags."
  type        = map(string)
  default     = {}
}
