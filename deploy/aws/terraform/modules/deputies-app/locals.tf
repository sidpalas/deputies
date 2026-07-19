locals {
  app_url                  = "https://${var.app_hostname}"
  service_base_domain      = var.service_base_domain != "" ? var.service_base_domain : var.app_hostname
  artifact_bucket          = substr(lower("${var.name}-artifacts-${random_id.artifact_bucket.hex}"), 0, 63)
  db_major_engine_version  = split(".", var.db_engine_version)[0]
  db_max_allocated_storage = max(var.db_allocated_storage + 1, ceil(var.db_allocated_storage * 1.1))
  database_url             = "postgres://${var.db_username}:${random_password.db.result}@${module.postgres.db_instance_address}:5432/${var.db_name}?sslmode=require&uselibpqcompat=true"
  control_plane_image      = var.image_tag != "" ? "${var.control_plane_image}:${var.image_tag}" : var.control_plane_image
  web_image                = var.image_tag != "" ? "${var.web_image}:${var.image_tag}" : var.web_image
  api_task_cpu             = coalesce(var.api_task_cpu, var.task_cpu)
  api_task_memory          = coalesce(var.api_task_memory, var.task_memory)
  worker_task_cpu          = coalesce(var.worker_task_cpu, var.task_cpu)
  worker_task_memory       = coalesce(var.worker_task_memory, var.task_memory)
  control_plane_log_options = {
    awslogs-group         = aws_cloudwatch_log_group.app.name
    awslogs-region        = var.aws_region
    awslogs-stream-prefix = "control-plane"
  }
  api_log_options = merge(local.control_plane_log_options, {
    awslogs-stream-prefix = "api"
  })
  worker_log_options = merge(local.control_plane_log_options, {
    awslogs-stream-prefix = "worker"
  })
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

  control_plane_common_environment = {
    PORT                                    = "3583"
    AWS_DEFAULT_REGION                      = var.aws_region
    AWS_REGION                              = var.aws_region
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
    TITLE_GENERATION_ENABLED                = tostring(var.title_generation_enabled)
    REPOSITORY_SETUP_SCRIPT_ENABLED         = "true"
    REPOSITORY_SETUP_SCRIPT_TIMEOUT_SECONDS = "600"
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
    TITLE_GENERATION_MODEL                    = var.title_generation_model
    LAMBDA_MICROVM_IMAGE_VERSION              = var.lambda_microvm_image_version
    LAMBDA_MICROVM_EXECUTION_ROLE_ARN         = var.lambda_microvm_execution_role_arn
    LAMBDA_MICROVM_INGRESS_NETWORK_CONNECTORS = join(",", var.lambda_microvm_ingress_network_connectors)
    LAMBDA_MICROVM_EGRESS_NETWORK_CONNECTORS  = join(",", var.lambda_microvm_egress_network_connectors)
    LAMBDA_MICROVM_LOG_GROUP                  = var.lambda_microvm_log_group
  }

  control_plane_run_modes = distinct([var.run_mode, "api", "worker"])
  control_plane_environment_by_run_mode = {
    for run_mode in local.control_plane_run_modes : run_mode => merge(
      local.control_plane_common_environment,
      { RUN_MODE = run_mode },
      { for key, value in local.control_plane_optional_environment : key => value if value != "" },
      var.extra_environment,
    )
  }

  control_plane_environment_lists = {
    for run_mode, environment in local.control_plane_environment_by_run_mode : run_mode => [for key, value in environment : {
      name  = key
      value = value
    }]
  }

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

  migrate_container_definitions = {
    for run_mode in local.control_plane_run_modes : run_mode => {
      image                     = local.control_plane_image
      essential                 = false
      command                   = ["node", "apps/control-plane/dist/db/migrate.js"]
      environment               = local.control_plane_environment_lists[run_mode]
      secrets                   = local.control_plane_secret_list
      readonlyRootFilesystem    = false
      enable_cloudwatch_logging = false
      logConfiguration = {
        logDriver = "awslogs"
        options   = local.migrate_log_options
      }
    }
  }

  control_plane_container_specs = {
    "control-plane" = {
      run_mode    = var.run_mode
      log_options = local.control_plane_log_options
    }
    api = {
      run_mode    = "api"
      log_options = local.api_log_options
    }
    worker = {
      run_mode    = "worker"
      log_options = local.worker_log_options
    }
  }

  control_plane_container_definitions = {
    for name, spec in local.control_plane_container_specs : name => {
      image                  = local.control_plane_image
      essential              = true
      environment            = local.control_plane_environment_lists[spec.run_mode]
      secrets                = local.control_plane_secret_list
      readonlyRootFilesystem = false
      dependsOn = [{
        containerName = "migrate"
        condition     = "SUCCESS"
      }]
      portMappings = [{
        name          = name
        containerPort = 3583
        hostPort      = 3583
        protocol      = "tcp"
      }]
      enable_cloudwatch_logging = false
      logConfiguration = {
        logDriver = "awslogs"
        options   = spec.log_options
      }
    }
  }

  web_container_definitions = {
    for upstream_container_name in ["control-plane", "api"] : upstream_container_name => {
      image                  = local.web_image
      essential              = true
      environment            = local.web_environment
      readonlyRootFilesystem = false
      dependsOn = [{
        containerName = upstream_container_name
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

  container_definitions_by_service = {
    app = {
      migrate         = local.migrate_container_definitions[var.run_mode]
      "control-plane" = local.control_plane_container_definitions["control-plane"]
      web             = local.web_container_definitions["control-plane"]
    }
    api = {
      migrate = local.migrate_container_definitions["api"]
      api     = local.control_plane_container_definitions["api"]
      web     = local.web_container_definitions["api"]
    }
    worker = {
      migrate = local.migrate_container_definitions["worker"]
      worker  = local.control_plane_container_definitions["worker"]
    }
  }

  ecs_service_common = {
    launch_type        = "FARGATE"
    network_mode       = "awsvpc"
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

    task_exec_secret_arns          = [module.app_secret.secret_arn]
    tasks_iam_role_statements      = local.task_iam_statements
    create_cloudwatch_log_group    = false
    ignore_task_definition_changes = false
  }

  ecs_service_specs = {
    app = {
      enabled                 = var.topology_mode == "combined"
      name                    = var.name
      family                  = var.name
      cpu                     = var.task_cpu
      memory                  = var.task_memory
      desired_count           = var.desired_count
      task_exec_iam_role_name = "${var.name}-ecs-execution"
      tasks_iam_role_name     = "${var.name}-ecs-task"
      attach_to_load_balancer = true
    }
    api = {
      enabled                 = var.topology_mode == "split"
      name                    = "${var.name}-api"
      family                  = "${var.name}-api"
      cpu                     = local.api_task_cpu
      memory                  = local.api_task_memory
      desired_count           = var.api_desired_count
      task_exec_iam_role_name = "${var.name}-api-ecs-execution"
      tasks_iam_role_name     = "${var.name}-api-ecs-task"
      attach_to_load_balancer = true
    }
    worker = {
      enabled                 = var.topology_mode == "split"
      name                    = "${var.name}-worker"
      family                  = "${var.name}-worker"
      cpu                     = local.worker_task_cpu
      memory                  = local.worker_task_memory
      desired_count           = var.worker_desired_count
      task_exec_iam_role_name = "${var.name}-worker-ecs-execution"
      tasks_iam_role_name     = "${var.name}-worker-ecs-task"
      attach_to_load_balancer = false
    }
  }

  ecs_services = {
    for key, spec in local.ecs_service_specs : key => merge(local.ecs_service_common, {
      name          = spec.name
      family        = spec.family
      cpu           = spec.cpu
      memory        = spec.memory
      desired_count = spec.desired_count
      load_balancer = spec.attach_to_load_balancer ? {
        web = {
          target_group_arn = module.alb.target_groups["web"].arn
          container_name   = "web"
          container_port   = 5173
        }
      } : {}
      task_exec_iam_role_name            = spec.task_exec_iam_role_name
      task_exec_iam_role_use_name_prefix = false
      tasks_iam_role_name                = spec.tasks_iam_role_name
      tasks_iam_role_use_name_prefix     = false
      container_definitions              = local.container_definitions_by_service[key]
    }) if spec.enabled
  }

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
