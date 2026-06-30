module "ecs" {
  source  = "terraform-aws-modules/ecs/aws"
  version = "7.5.0"

  cluster_name                = var.name
  create_cloudwatch_log_group = false

  services = local.ecs_services

  depends_on = [
    module.alb,
    module.app_secret,
  ]

  tags = var.tags
}
