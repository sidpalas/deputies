output "artifact_bucket_name" {
  description = "S3 bucket for Lambda MicroVM image artifacts."
  value       = module.artifact.s3_bucket_id
}

output "build_role_arn" {
  description = "IAM role ARN Lambda assumes while building MicroVM images."
  value       = aws_iam_role.build.arn
}

output "runtime_role_arn" {
  description = "IAM role ARN optionally passed to run-microvm as the MicroVM execution role."
  value       = aws_iam_role.runtime.arn
}

output "image_name" {
  description = "Stable MicroVM image name for create/update commands and app config."
  value       = var.image_name
}

output "image_arn" {
  description = "Stable MicroVM image ARN for app config and update/run commands."
  value       = local.image_arn
}

output "base_image_arn" {
  description = "Lambda-managed base image ARN to use for image builds."
  value       = local.base_image_arn
}

output "log_group_name" {
  description = "CloudWatch log group for MicroVM build/runtime logs."
  value       = aws_cloudwatch_log_group.microvm.name
}

output "all_ingress_connector_arn" {
  description = "AWS-managed ALL_INGRESS connector ARN."
  value       = local.all_ingress_connector
}

output "internet_egress_connector_arn" {
  description = "AWS-managed INTERNET_EGRESS connector ARN."
  value       = local.internet_egress_connector
}

output "mise_environment" {
  description = "Environment values consumed by deploy/sandboxes/lambda-microvm mise tasks."
  value = {
    MICROVM_ARTIFACT_BUCKET  = module.artifact.s3_bucket_id
    MICROVM_IMAGE_NAME       = var.image_name
    MICROVM_IMAGE_IDENTIFIER = local.image_arn
    MICROVM_BASE_IMAGE_ARN   = local.base_image_arn
    MICROVM_BUILD_ROLE_ARN   = aws_iam_role.build.arn
    MICROVM_LOG_GROUP        = aws_cloudwatch_log_group.microvm.name
  }
}
