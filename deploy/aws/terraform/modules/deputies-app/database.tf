resource "random_password" "db" {
  length  = 32
  special = false
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

  final_snapshot_identifier_prefix       = "${var.name}-postgres-final"
  iam_database_authentication_enabled    = var.db_iam_database_authentication_enabled
  enabled_cloudwatch_logs_exports        = ["postgresql", "upgrade"]
  create_cloudwatch_log_group            = true
  cloudwatch_log_group_retention_in_days = 14

  tags = var.tags
}
