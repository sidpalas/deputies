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

module "app_secret" {
  source  = "terraform-aws-modules/secrets-manager/aws"
  version = "2.1.0"

  name                    = "${var.name}/app"
  recovery_window_in_days = var.app_secret_recovery_window_days
  secret_string           = jsonencode(local.app_secret_values)

  tags = var.tags
}
