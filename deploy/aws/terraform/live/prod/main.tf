locals {
  name = "${var.name_prefix}-${var.environment}"
  tags = merge(
    {
      Project     = "deputies"
      Environment = var.environment
      ManagedBy   = "terraform"
    },
    var.tags,
  )

  service_base_domain = var.service_base_domain != "" ? var.service_base_domain : var.app_hostname

  create_managed_acm_certificate        = var.create_managed_acm_certificate && var.alb_certificate_arn == ""
  managed_acm_domain_names              = sort(distinct([var.app_hostname, "*.${local.service_base_domain}"]))
  managed_acm_subject_alternative_names = [for domain_name in local.managed_acm_domain_names : domain_name if domain_name != var.app_hostname]
  app_alb_certificate_arn               = var.alb_certificate_arn != "" ? var.alb_certificate_arn : (var.managed_acm_https_enabled && local.create_managed_acm_certificate ? aws_acm_certificate.app[0].arn : "")

  lambda_microvm_image_name       = var.lambda_microvm_image_name != "" ? var.lambda_microvm_image_name : "${local.name}-sandbox"
  lambda_microvm_image_identifier = var.lambda_microvm_image_identifier != "" ? var.lambda_microvm_image_identifier : module.lambda_microvm_support.image_arn
  lambda_microvm_ingress_network_connectors = length(var.lambda_microvm_ingress_network_connectors) > 0 ? var.lambda_microvm_ingress_network_connectors : [
    module.lambda_microvm_support.all_ingress_connector_arn,
  ]
  lambda_microvm_egress_network_connectors = length(var.lambda_microvm_egress_network_connectors) > 0 ? var.lambda_microvm_egress_network_connectors : [
    module.lambda_microvm_support.internet_egress_connector_arn,
  ]
}

resource "aws_acm_certificate" "app" {
  count = local.create_managed_acm_certificate ? 1 : 0

  domain_name               = var.app_hostname
  subject_alternative_names = local.managed_acm_subject_alternative_names
  validation_method         = "DNS"

  lifecycle {
    create_before_destroy = true
  }

  tags = local.tags
}

module "networking" {
  source = "../../modules/networking"

  name                  = "${local.name}-network"
  vpc_cidr              = var.vpc_cidr
  az_count              = var.az_count
  nat_mode              = var.nat_mode
  fck_nat_instance_type = var.fck_nat_instance_type
  tags                  = local.tags
}

module "lambda_microvm_support" {
  source = "../../modules/lambda-microvm-support"

  name                          = local.name
  aws_region                    = var.aws_region
  image_name                    = local.lambda_microvm_image_name
  base_image_arn                = var.lambda_microvm_base_image_arn
  artifact_bucket_force_destroy = var.microvm_artifact_bucket_force_destroy
  tags                          = local.tags
}

module "app" {
  source = "../../modules/deputies-app"

  depends_on = [module.networking]

  name            = local.name
  aws_region      = var.aws_region
  vpc_id          = module.networking.vpc_id
  public_subnets  = module.networking.public_subnets
  private_subnets = module.networking.private_subnets

  app_hostname        = var.app_hostname
  service_base_domain = var.service_base_domain
  alb_certificate_arn = local.app_alb_certificate_arn

  control_plane_image  = var.control_plane_image
  web_image            = var.web_image
  image_tag            = var.image_tag
  topology_mode        = var.topology_mode
  run_mode             = var.run_mode
  desired_count        = var.desired_count
  api_desired_count    = var.api_desired_count
  worker_desired_count = var.worker_desired_count
  task_cpu             = var.task_cpu
  task_memory          = var.task_memory
  api_task_cpu         = var.api_task_cpu
  api_task_memory      = var.api_task_memory
  worker_task_cpu      = var.worker_task_cpu
  worker_task_memory   = var.worker_task_memory
  cpu_architecture     = var.cpu_architecture

  api_auth_mode        = var.api_auth_mode
  auth_provider        = var.auth_provider
  auth_static_username = var.auth_static_username
  runner               = var.runner
  runner_model_default = var.runner_model_default
  sandbox_provider     = var.sandbox_provider

  lambda_microvm_image_identifier           = local.lambda_microvm_image_identifier
  lambda_microvm_image_version              = var.lambda_microvm_image_version
  lambda_microvm_execution_role_arn         = module.lambda_microvm_support.runtime_role_arn
  lambda_microvm_ingress_network_connectors = local.lambda_microvm_ingress_network_connectors
  lambda_microvm_egress_network_connectors  = local.lambda_microvm_egress_network_connectors
  lambda_microvm_maximum_duration_seconds   = var.lambda_microvm_maximum_duration_seconds
  lambda_microvm_auth_token_ttl_minutes     = var.lambda_microvm_auth_token_ttl_minutes
  lambda_microvm_log_group                  = module.lambda_microvm_support.log_group_name

  db_name                                = var.db_name
  db_username                            = var.db_username
  db_instance_class                      = var.db_instance_class
  db_allocated_storage                   = var.db_allocated_storage
  db_engine_version                      = var.db_engine_version
  db_multi_az                            = var.db_multi_az
  db_backup_retention_days               = var.db_backup_retention_days
  db_deletion_protection                 = var.db_deletion_protection
  db_skip_final_snapshot                 = var.db_skip_final_snapshot
  db_iam_database_authentication_enabled = var.db_iam_database_authentication_enabled

  artifact_bucket_force_destroy   = var.artifact_bucket_force_destroy
  app_secret_recovery_window_days = var.app_secret_recovery_window_days
  app_secret_values               = var.app_secret_values
  extra_environment               = var.extra_environment
  tags                            = local.tags
}
