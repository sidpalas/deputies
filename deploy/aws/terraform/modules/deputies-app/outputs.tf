output "alb_dns_name" {
  description = "ALB DNS name to use for Cloudflare DNS records."
  value       = module.alb.dns_name
}

output "alb_zone_id" {
  description = "ALB hosted zone ID."
  value       = module.alb.zone_id
}

output "app_url" {
  description = "Configured application URL."
  value       = local.app_url
}

output "service_base_domain" {
  description = "Configured service preview base domain."
  value       = local.service_base_domain
}

output "ecs_cluster_name" {
  description = "ECS cluster name."
  value       = module.ecs.cluster_name
}

output "ecs_service_name" {
  description = "Primary ECS service name. Combined topology returns the app service; split topology returns the API service."
  value       = var.topology_mode == "combined" ? module.ecs.services["app"].name : module.ecs.services["api"].name
}

output "ecs_service_names" {
  description = "ECS service names by topology service key."
  value       = { for key, service in module.ecs.services : key => service.name }
}

output "task_role_arn" {
  description = "Primary ECS task role ARN. Combined topology returns the app role; split topology returns the API role."
  value       = var.topology_mode == "combined" ? module.ecs.services["app"].tasks_iam_role_arn : module.ecs.services["api"].tasks_iam_role_arn
}

output "task_role_arns" {
  description = "ECS task role ARNs by topology service key."
  value       = { for key, service in module.ecs.services : key => service.tasks_iam_role_arn }
}

output "artifact_bucket_name" {
  description = "S3 bucket used for Deputies artifact storage."
  value       = module.artifacts.s3_bucket_id
}

output "app_secret_arn" {
  description = "Secrets Manager secret ARN containing app secret environment values."
  value       = module.app_secret.secret_arn
}

output "rds_endpoint" {
  description = "RDS endpoint."
  value       = module.postgres.db_instance_endpoint
}
