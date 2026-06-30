variable "name" {
  description = "Name prefix for app resources."
  type        = string
}

variable "aws_region" {
  description = "AWS region."
  type        = string
}

variable "vpc_id" {
  description = "VPC ID."
  type        = string
}

variable "public_subnets" {
  description = "Public subnet IDs for the ALB."
  type        = list(string)
}

variable "private_subnets" {
  description = "Private subnet IDs for ECS and RDS."
  type        = list(string)
}

variable "app_hostname" {
  description = "Public application hostname."
  type        = string
}

variable "service_base_domain" {
  description = "Base domain for sandbox service preview hosts. Empty defaults to app_hostname."
  type        = string
  default     = ""
}

variable "alb_certificate_arn" {
  description = "Optional ACM certificate ARN for HTTPS. Empty creates an HTTP-only ALB listener."
  type        = string
  default     = ""
}

variable "control_plane_image" {
  description = "Control-plane image repository, or full image reference when image_tag is empty."
  type        = string
}

variable "web_image" {
  description = "Web image repository, or full image reference when image_tag is empty."
  type        = string
}

variable "image_tag" {
  description = "Image tag. Set empty when image variables are full references such as digest-pinned refs."
  type        = string
}

variable "run_mode" {
  description = "Deputies run mode for the control-plane container."
  type        = string
}

variable "desired_count" {
  description = "Desired ECS task count."
  type        = number
}

variable "task_cpu" {
  description = "Fargate task CPU units."
  type        = number
}

variable "task_memory" {
  description = "Fargate task memory MiB."
  type        = number
}

variable "cpu_architecture" {
  description = "Fargate CPU architecture."
  type        = string
  default     = "ARM64"

  validation {
    condition     = contains(["X86_64", "ARM64"], var.cpu_architecture)
    error_message = "Allowed values for cpu_architecture are X86_64 or ARM64."
  }
}

variable "api_auth_mode" {
  description = "API auth mode."
  type        = string
}

variable "auth_provider" {
  description = "Session auth provider."
  type        = string
}

variable "auth_static_username" {
  description = "Static auth username."
  type        = string
}

variable "runner" {
  description = "Runner kind."
  type        = string
}

variable "runner_model_default" {
  description = "Default runner model."
  type        = string
}

variable "sandbox_provider" {
  description = "Sandbox provider."
  type        = string
}

variable "lambda_microvm_image_identifier" {
  description = "Lambda MicroVM image ARN consumed by Deputies."
  type        = string
}

variable "lambda_microvm_image_version" {
  description = "Optional Lambda MicroVM image version."
  type        = string
  default     = ""
}

variable "lambda_microvm_execution_role_arn" {
  description = "Optional runtime role ARN passed to run-microvm."
  type        = string
  default     = ""
}

variable "lambda_microvm_ingress_network_connectors" {
  description = "Ingress connector ARNs passed to run-microvm."
  type        = list(string)
  default     = []
}

variable "lambda_microvm_egress_network_connectors" {
  description = "Egress connector ARNs passed to run-microvm."
  type        = list(string)
  default     = []
}

variable "lambda_microvm_maximum_duration_seconds" {
  description = "Maximum Lambda MicroVM lifetime in seconds."
  type        = number
}

variable "lambda_microvm_auth_token_ttl_minutes" {
  description = "Lambda MicroVM endpoint auth token TTL in minutes."
  type        = number
}

variable "lambda_microvm_log_group" {
  description = "CloudWatch log group for MicroVM runtime logging."
  type        = string
  default     = ""
}

variable "db_name" {
  description = "Postgres database name."
  type        = string
}

variable "db_username" {
  description = "Postgres username."
  type        = string
}

variable "db_instance_class" {
  description = "RDS instance class."
  type        = string
}

variable "db_allocated_storage" {
  description = "RDS allocated storage GiB."
  type        = number
}

variable "db_engine_version" {
  description = "RDS Postgres engine version."
  type        = string
}

variable "db_multi_az" {
  description = "Whether RDS is Multi-AZ."
  type        = bool
}

variable "db_backup_retention_days" {
  description = "RDS backup retention days."
  type        = number
}

variable "db_deletion_protection" {
  description = "Whether RDS deletion protection is enabled."
  type        = bool
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

variable "app_secret_values" {
  description = "Additional/overriding secret environment values stored in Secrets Manager."
  type        = map(string)
  default     = {}
  sensitive   = true
}

variable "extra_environment" {
  description = "Additional non-secret control-plane environment values."
  type        = map(string)
  default     = {}
}

variable "tags" {
  description = "Tags to apply to resources."
  type        = map(string)
  default     = {}
}
