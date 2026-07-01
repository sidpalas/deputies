module "alb" {
  source  = "terraform-aws-modules/alb/aws"
  version = "10.5.0"

  name               = var.name
  load_balancer_type = "application"
  internal           = false
  vpc_id             = var.vpc_id
  subnets            = var.public_subnets

  create_security_group      = false
  security_groups            = [module.alb_sg.id]
  enable_deletion_protection = false

  listeners = local.alb_listeners

  target_groups = {
    web = {
      name              = "${var.name}-web"
      port              = 5173
      protocol          = "HTTP"
      target_type       = "ip"
      create_attachment = false

      health_check = {
        path                = "/health"
        protocol            = "HTTP"
        matcher             = "200-399"
        interval            = 30
        timeout             = 5
        healthy_threshold   = 2
        unhealthy_threshold = 3
      }
    }
  }

  tags = var.tags
}
