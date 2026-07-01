variable "name" {
  description = "Name prefix for Lambda MicroVM support resources."
  type        = string
}

variable "aws_region" {
  description = "AWS region."
  type        = string
}

variable "image_name" {
  description = "Stable Lambda MicroVM image name used by the image management workflow."
  type        = string
}

variable "artifact_bucket_force_destroy" {
  description = "Whether to force-destroy the MicroVM image artifact bucket."
  type        = bool
  default     = false
}

variable "base_image_arn" {
  description = "Lambda-managed base MicroVM image ARN. Empty uses the regional AL2023 base image ARN."
  type        = string
  default     = ""
}

variable "log_retention_days" {
  description = "CloudWatch log retention for MicroVM build/runtime logs."
  type        = number
  default     = 14
}

variable "allow_private_ecr_pull" {
  description = "Whether the build role should be allowed to pull from private ECR images."
  type        = bool
  default     = true
}

variable "tags" {
  description = "Tags to apply to resources."
  type        = map(string)
  default     = {}
}
