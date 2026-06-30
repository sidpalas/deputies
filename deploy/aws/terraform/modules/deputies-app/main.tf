resource "random_id" "artifact_bucket" {
  byte_length = 4
}

resource "random_password" "db" {
  length  = 32
  special = false
}

resource "random_password" "auth_session" {
  length  = 64
  special = false
}

resource "random_password" "auth_static" {
  length  = 32
  special = false
}

resource "random_password" "sandbox_secret" {
  length  = 64
  special = false
}

locals {
  app_url                       = "https://${var.app_hostname}"
  service_base_domain           = var.service_base_domain != "" ? var.service_base_domain : var.app_hostname
  artifact_bucket               = substr(lower("${var.name}-artifacts-${random_id.artifact_bucket.hex}"), 0, 63)
  db_major_engine_version       = split(".", var.db_engine_version)[0]
  db_max_allocated_storage      = max(var.db_allocated_storage + 1, ceil(var.db_allocated_storage * 1.1))
  database_url                  = "postgres://${var.db_username}:${random_password.db.result}@${module.postgres.db_instance_address}:5432/${var.db_name}?sslmode=require&uselibpqcompat=true"
  control_plane_image           = var.image_tag != "" ? "${var.control_plane_image}:${var.image_tag}" : var.control_plane_image
  web_image                     = var.image_tag != "" ? "${var.web_image}:${var.image_tag}" : var.web_image
  control_plane_log_options     = {
    awslogs-group         = aws_cloudwatch_log_group.app.name
    awslogs-region        = var.aws_region
    awslogs-stream-prefix = "control-plane"
  }
  migrate_log_options = merge(local.control_plane_log_options, {
    awslogs-stream-prefix = "migrate"
  })
  web_log_options = {
    awslogs-group         = aws_cloudwatch_log_group.app.name
    awslogs-region        = var.aws_region
    awslogs-stream-prefix = "web"
  }

  default_secret_values = {
    DATABASE_URL                  = local.database_url
    AUTH_SESSION_SECRET           = random_password.auth_session.result
    AUTH_STATIC_PASSWORD          = random_password.auth_static.result
    SANDBOX_SECRET_ENCRYPTION_KEY = random_password.sandbox_secret.result
  }
  app_secret_values = merge(local.default_secret_values, var.app_secret_values)
  secret_names      = sort(distinct(concat(keys(local.default_secret_values), nonsensitive(keys(var.app_secret_values)))))

  control_plane_base_environment = {
    PORT                                    = "3583"
    AWS_DEFAULT_REGION                      = var.aws_region
    AWS_REGION                              = var.aws_region
    RUN_MODE                                = var.run_mode
    API_AUTH_MODE                           = var.api_auth_mode
    APP_DATA_STORE                          = "postgres"
    RUNNER_STATE_STORE                      = "postgres"
    AUTH_PROVIDER                           = var.auth_provider
    AUTH_STATIC_USERNAME                    = var.auth_static_username
    AUTH_COOKIE_SECURE                      = "true"
    AUTH_COOKIE_SAME_SITE                   = "lax"
    WEB_BASE_URL                            = local.app_url
    SERVICE_BASE_DOMAIN                     = local.service_base_domain
    SERVICE_TRUST_FORWARDED_HOSTS           = "false"
    RUNNER                                  = var.runner
    RUNNER_MODEL_DEFAULT                    = var.runner_model_default
    SANDBOX_PROVIDER                        = var.sandbox_provider
    SANDBOX_WORKSPACE_PATH                  = "/workspace"
    ARTIFACT_STORAGE_PROVIDER               = "s3"
    ARTIFACT_STORAGE_S3_BUCKET              = module.artifacts.s3_bucket_id
    ARTIFACT_STORAGE_S3_REGION              = var.aws_region
    ARTIFACT_STORAGE_S3_FORCE_PATH_STYLE    = "false"
    ARTIFACT_STORAGE_S3_CREATE_BUCKET       = "false"
    LAMBDA_MICROVM_REGION                   = var.aws_region
    LAMBDA_MICROVM_IMAGE_IDENTIFIER         = var.lambda_microvm_image_identifier
    LAMBDA_MICROVM_MAXIMUM_DURATION_SECONDS = tostring(var.lambda_microvm_maximum_duration_seconds)
    LAMBDA_MICROVM_AUTH_TOKEN_TTL_MINUTES   = tostring(var.lambda_microvm_auth_token_ttl_minutes)
  }

  control_plane_optional_environment = {
    LAMBDA_MICROVM_IMAGE_VERSION              = var.lambda_microvm_image_version
    LAMBDA_MICROVM_EXECUTION_ROLE_ARN         = var.lambda_microvm_execution_role_arn
    LAMBDA_MICROVM_INGRESS_NETWORK_CONNECTORS = join(",", var.lambda_microvm_ingress_network_connectors)
    LAMBDA_MICROVM_EGRESS_NETWORK_CONNECTORS  = join(",", var.lambda_microvm_egress_network_connectors)
    LAMBDA_MICROVM_LOG_GROUP                  = var.lambda_microvm_log_group
  }

  control_plane_environment = merge(
    local.control_plane_base_environment,
    { for key, value in local.control_plane_optional_environment : key => value if value != "" },
    var.extra_environment,
  )

  control_plane_environment_list = [for key, value in local.control_plane_environment : {
    name  = key
    value = value
  }]

  control_plane_secret_list = [for name in local.secret_names : {
    name      = name
    valueFrom = "${module.app_secret.secret_arn}:${name}::"
  }]

  web_environment = [
    {
      name  = "PORT"
      value = "5173"
    },
    {
      name  = "API_UPSTREAM"
      value = "http://127.0.0.1:3583"
    },
  ]

  task_iam_statements = concat(
    [
      {
        sid = "ArtifactBucket"
        actions = [
          "s3:ListBucket",
          "s3:GetBucketLocation",
        ]
        resources = [module.artifacts.s3_bucket_arn]
      },
      {
        sid = "ArtifactObjects"
        actions = [
          "s3:GetObject",
          "s3:PutObject",
          "s3:DeleteObject",
        ]
        resources = ["${module.artifacts.s3_bucket_arn}/*"]
      },
      {
        sid = "BedrockRuntime"
        actions = [
          "bedrock:InvokeModel",
          "bedrock:InvokeModelWithResponseStream",
        ]
        resources = ["*"]
      },
      {
        sid = "LambdaMicrovmLifecycle"
        actions = [
          "lambda:RunMicrovm",
          "lambda:GetMicrovm",
          "lambda:GetMicrovmImage",
          "lambda:GetMicrovmImageVersion",
          "lambda:CreateMicrovmAuthToken",
          "lambda:SuspendMicrovm",
          "lambda:ResumeMicrovm",
          "lambda:TerminateMicrovm",
          "lambda:ListMicrovms",
        ]
        # Lambda MicroVM IAM currently evaluates these new actions against "*".
        # Scoping to the documented microvm-image ARN caused RunMicrovm denies.
        resources = ["*"]
      },
    ],
    length(concat(var.lambda_microvm_ingress_network_connectors, var.lambda_microvm_egress_network_connectors)) > 0 ? [
      {
        sid       = "PassLambdaMicrovmNetworkConnectors"
        actions   = ["lambda:PassNetworkConnector"]
        resources = ["*"]
      },
    ] : [],
    var.lambda_microvm_execution_role_arn != "" ? [
      {
        sid       = "PassLambdaMicrovmExecutionRole"
        actions   = ["iam:PassRole"]
        resources = [var.lambda_microvm_execution_role_arn]
      },
    ] : [],
  )

  alb_listeners = jsondecode(var.alb_certificate_arn == "" ? jsonencode({
    http = {
      port     = 80
      protocol = "HTTP"
      forward = {
        target_group_key = "web"
      }
    }
    }) : jsonencode({
    http = {
      port     = 80
      protocol = "HTTP"
      redirect = {
        port        = "443"
        protocol    = "HTTPS"
        status_code = "HTTP_301"
      }
    }
    https = {
      port            = 443
      protocol        = "HTTPS"
      certificate_arn = var.alb_certificate_arn
      ssl_policy      = "ELBSecurityPolicy-TLS13-1-2-2021-06"
      forward = {
        target_group_key = "web"
      }
    }
  }))
}

module "artifacts" {
  source  = "terraform-aws-modules/s3-bucket/aws"
  version = "5.14.1"

  bucket        = local.artifact_bucket
  force_destroy = var.artifact_bucket_force_destroy

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true

  attach_deny_insecure_transport_policy = true

  server_side_encryption_configuration = {
    rule = {
      apply_server_side_encryption_by_default = {
        sse_algorithm = "AES256"
      }
    }
  }

  versioning = {
    enabled = true
  }

  tags = var.tags
}

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

module "postgres" {
  source  = "terraform-aws-modules/rds/aws"
  version = "7.2.0"

  identifier = "${var.name}-postgres"

  engine                   = "postgres"
  engine_version           = var.db_engine_version
  engine_lifecycle_support = "open-source-rds-extended-support-disabled"
  family                   = "postgres${local.db_major_engine_version}"
  major_engine_version     = local.db_major_engine_version
  instance_class           = var.db_instance_class

  allocated_storage     = var.db_allocated_storage
  max_allocated_storage = local.db_max_allocated_storage
  storage_encrypted     = true

  db_name                     = var.db_name
  username                    = var.db_username
  manage_master_user_password = false
  password_wo                 = random_password.db.result
  password_wo_version         = 1
  port                        = 5432

  create_db_subnet_group          = true
  db_subnet_group_name            = "${var.name}-postgres"
  db_subnet_group_use_name_prefix = false
  subnet_ids                      = var.private_subnets
  vpc_security_group_ids          = [module.db_sg.id]
  publicly_accessible             = false
  multi_az                        = var.db_multi_az

  create_db_option_group    = false
  create_db_parameter_group = true

  backup_retention_period = var.db_backup_retention_days
  copy_tags_to_snapshot   = true
  deletion_protection     = var.db_deletion_protection
  skip_final_snapshot     = var.db_skip_final_snapshot

  final_snapshot_identifier_prefix     = "${var.name}-postgres-final"
  iam_database_authentication_enabled  = var.db_iam_database_authentication_enabled
  enabled_cloudwatch_logs_exports      = ["postgresql", "upgrade"]
  create_cloudwatch_log_group          = true
  cloudwatch_log_group_retention_in_days = 14

  tags = var.tags
}

module "app_secret" {
  source  = "terraform-aws-modules/secrets-manager/aws"
  version = "2.1.0"

  name                    = "${var.name}/app"
  recovery_window_in_days = var.app_secret_recovery_window_days
  secret_string           = jsonencode(local.app_secret_values)

  tags = var.tags
}

resource "aws_cloudwatch_log_group" "app" {
  name              = "/ecs/${var.name}"
  retention_in_days = 14
}

module "alb" {
  source  = "terraform-aws-modules/alb/aws"
  version = "10.5.0"

  name               = var.name
  load_balancer_type = "application"
  internal           = false
  vpc_id             = var.vpc_id
  subnets            = var.public_subnets

  create_security_group     = false
  security_groups           = [module.alb_sg.id]
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

module "ecs" {
  source  = "terraform-aws-modules/ecs/aws"
  version = "7.5.0"

  cluster_name                = var.name
  create_cloudwatch_log_group = false

  services = {
    app = {
      name            = var.name
      family          = var.name
      cpu             = var.task_cpu
      memory          = var.task_memory
      launch_type     = "FARGATE"
      network_mode    = "awsvpc"
      desired_count   = var.desired_count
      enable_autoscaling = false

      runtime_platform = {
        operating_system_family = "LINUX"
        cpu_architecture        = var.cpu_architecture
      }

      subnet_ids            = var.private_subnets
      security_group_ids    = [module.app_sg.id]
      create_security_group = false
      assign_public_ip      = false

      deployment_circuit_breaker = {
        enable   = true
        rollback = true
      }

      load_balancer = {
        web = {
          target_group_arn = module.alb.target_groups["web"].arn
          container_name   = "web"
          container_port   = 5173
        }
      }

      task_exec_iam_role_name            = "${var.name}-ecs-execution"
      task_exec_iam_role_use_name_prefix = false
      task_exec_secret_arns              = [module.app_secret.secret_arn]

      tasks_iam_role_name            = "${var.name}-ecs-task"
      tasks_iam_role_use_name_prefix = false
      tasks_iam_role_statements      = local.task_iam_statements

      container_definitions = {
        migrate = {
          image                  = local.control_plane_image
          essential              = false
          command                = ["node", "apps/control-plane/dist/db/migrate.js"]
          environment            = local.control_plane_environment_list
          secrets                = local.control_plane_secret_list
          readonlyRootFilesystem = false
          enable_cloudwatch_logging = false
          logConfiguration = {
            logDriver = "awslogs"
            options   = local.migrate_log_options
          }
        }

        "control-plane" = {
          image                  = local.control_plane_image
          essential              = true
          environment            = local.control_plane_environment_list
          secrets                = local.control_plane_secret_list
          readonlyRootFilesystem = false
          dependsOn = [{
            containerName = "migrate"
            condition     = "SUCCESS"
          }]
          portMappings = [{
            name          = "control-plane"
            containerPort = 3583
            hostPort      = 3583
            protocol      = "tcp"
          }]
          enable_cloudwatch_logging = false
          logConfiguration = {
            logDriver = "awslogs"
            options   = local.control_plane_log_options
          }
        }

        web = {
          image                  = local.web_image
          essential              = true
          environment            = local.web_environment
          readonlyRootFilesystem = false
          dependsOn = [{
            containerName = "control-plane"
            condition     = "START"
          }]
          portMappings = [{
            name          = "web"
            containerPort = 5173
            hostPort      = 5173
            protocol      = "tcp"
          }]
          enable_cloudwatch_logging = false
          logConfiguration = {
            logDriver = "awslogs"
            options   = local.web_log_options
          }
        }
      }
    }
  }

  depends_on = [
    module.alb,
    module.app_secret,
  ]

  tags = var.tags
}
