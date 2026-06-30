module "alb_sg" {
  source  = "terraform-aws-modules/security-group/aws"
  version = "6.0.0"

  name            = "${var.name}-alb"
  use_name_prefix = false
  description     = "Public ALB ingress"
  vpc_id          = var.vpc_id

  ingress_rules = {
    http = {
      from_port   = 80
      to_port     = 80
      ip_protocol = "tcp"
      cidr_ipv4   = "0.0.0.0/0"
    }
    https = {
      from_port   = 443
      to_port     = 443
      ip_protocol = "tcp"
      cidr_ipv4   = "0.0.0.0/0"
    }
  }

  egress_rules = {
    all = {
      ip_protocol = "-1"
      cidr_ipv4   = "0.0.0.0/0"
    }
  }

  tags = var.tags
}

module "app_sg" {
  source  = "terraform-aws-modules/security-group/aws"
  version = "6.0.0"

  name            = "${var.name}-ecs"
  use_name_prefix = false
  description     = "Deputies ECS tasks"
  vpc_id          = var.vpc_id

  ingress_rules = {
    web = {
      from_port                    = 5173
      to_port                      = 5173
      ip_protocol                  = "tcp"
      referenced_security_group_id = module.alb_sg.id
    }
  }

  egress_rules = {
    all = {
      ip_protocol = "-1"
      cidr_ipv4   = "0.0.0.0/0"
    }
  }

  tags = var.tags
}

module "db_sg" {
  source  = "terraform-aws-modules/security-group/aws"
  version = "6.0.0"

  name            = "${var.name}-db"
  use_name_prefix = false
  description     = "Deputies RDS"
  vpc_id          = var.vpc_id

  ingress_rules = {
    postgres = {
      from_port                    = 5432
      to_port                      = 5432
      ip_protocol                  = "tcp"
      referenced_security_group_id = module.app_sg.id
    }
  }

  tags = var.tags
}
