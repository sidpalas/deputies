resource "aws_cloudwatch_log_group" "app" {
  name              = "/ecs/${var.name}"
  retention_in_days = 14
}
