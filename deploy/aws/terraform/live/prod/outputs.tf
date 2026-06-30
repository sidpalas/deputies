output "app_url" {
  description = "Configured app URL."
  value       = module.app.app_url
}

output "alb_dns_name" {
  description = "Create Cloudflare app and wildcard preview DNS records pointing to this ALB DNS name."
  value       = module.app.alb_dns_name
}

output "alb_zone_id" {
  description = "ALB zone ID. Useful if using Route53 aliases elsewhere."
  value       = module.app.alb_zone_id
}

output "service_base_domain" {
  description = "Wildcard preview DNS should cover this base domain."
  value       = module.app.service_base_domain
}

output "managed_acm_certificate_arn" {
  description = "Terraform-managed ACM certificate ARN. Add validation records in Cloudflare before enabling managed_acm_https_enabled."
  value       = try(aws_acm_certificate.app[0].arn, null)
}

output "managed_acm_dns_validation_records" {
  description = "Cloudflare DNS CNAME records required to validate the Terraform-managed ACM certificate."
  value = {
    for option in try(aws_acm_certificate.app[0].domain_validation_options, []) : option.domain_name => {
      name  = option.resource_record_name
      type  = option.resource_record_type
      value = option.resource_record_value
    }
  }
}

output "alb_certificate_arn" {
  description = "Certificate ARN currently attached to the ALB, or empty while the ALB is HTTP-only."
  value       = local.app_alb_certificate_arn
}

output "ecs_cluster_name" {
  description = "ECS cluster name."
  value       = module.app.ecs_cluster_name
}

output "ecs_service_name" {
  description = "ECS service name."
  value       = module.app.ecs_service_name
}

output "app_secret_arn" {
  description = "Secrets Manager secret for app runtime secrets."
  value       = module.app.app_secret_arn
}

output "artifact_bucket_name" {
  description = "S3 bucket used for Deputies artifact storage."
  value       = module.app.artifact_bucket_name
}

output "lambda_microvm_image_identifier" {
  description = "MicroVM image identifier passed to the app. Build/update this image with deploy/sandboxes/lambda-microvm."
  value       = local.lambda_microvm_image_identifier
}

output "lambda_microvm_runtime_role_arn" {
  description = "Runtime role passed to run-microvm."
  value       = module.lambda_microvm_support.runtime_role_arn
}

output "lambda_microvm_mise_environment" {
  description = "Environment variables for deploy/sandboxes/lambda-microvm mise image tasks."
  value       = module.lambda_microvm_support.mise_environment
}
