data "aws_iam_policy_document" "lambda_assume_role" {
  statement {
    actions = ["sts:AssumeRole", "sts:TagSession"]

    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

data "aws_caller_identity" "current" {}

moved {
  from = aws_s3_bucket.artifact
  to   = module.artifact.aws_s3_bucket.this[0]
}

moved {
  from = aws_s3_bucket_public_access_block.artifact
  to   = module.artifact.aws_s3_bucket_public_access_block.this[0]
}

moved {
  from = aws_s3_bucket_server_side_encryption_configuration.artifact
  to   = module.artifact.aws_s3_bucket_server_side_encryption_configuration.this[0]
}

moved {
  from = aws_s3_bucket_versioning.artifact
  to   = module.artifact.aws_s3_bucket_versioning.this[0]
}

moved {
  from = aws_s3_bucket_policy.artifact
  to   = module.artifact.aws_s3_bucket_policy.this[0]
}

resource "random_id" "artifact_bucket" {
  byte_length = 4
}

locals {
  artifact_bucket_name = substr(lower("${var.name}-microvm-artifacts-${random_id.artifact_bucket.hex}"), 0, 63)
  log_group_name       = "/aws/lambda/microvms/${var.image_name}"
  base_image_arn       = var.base_image_arn != "" ? var.base_image_arn : "arn:aws:lambda:${var.aws_region}:aws:microvm-image:al2023-1"
  image_arn            = "arn:aws:lambda:${var.aws_region}:${data.aws_caller_identity.current.account_id}:microvm-image:${var.image_name}"

  all_ingress_connector     = "arn:aws:lambda:${var.aws_region}:aws:network-connector:aws-network-connector:ALL_INGRESS"
  internet_egress_connector = "arn:aws:lambda:${var.aws_region}:aws:network-connector:aws-network-connector:INTERNET_EGRESS"
}

module "artifact" {
  source  = "terraform-aws-modules/s3-bucket/aws"
  version = "5.14.1"

  bucket        = local.artifact_bucket_name
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

resource "aws_cloudwatch_log_group" "microvm" {
  name              = local.log_group_name
  retention_in_days = var.log_retention_days
}

resource "aws_iam_role" "build" {
  name               = "${var.name}-microvm-build"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume_role.json
}

data "aws_iam_policy_document" "build" {
  statement {
    sid       = "ReadMicrovmArtifact"
    actions   = ["s3:GetObject"]
    resources = ["${module.artifact.s3_bucket_arn}/*"]
  }

  statement {
    sid = "WriteBuildLogs"
    actions = [
      "logs:CreateLogGroup",
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    resources = ["*"]
  }

  dynamic "statement" {
    for_each = var.allow_private_ecr_pull ? [1] : []
    content {
      sid = "PullPrivateEcrImages"
      actions = [
        "ecr:GetAuthorizationToken",
        "ecr:BatchCheckLayerAvailability",
        "ecr:GetDownloadUrlForLayer",
        "ecr:BatchGetImage",
      ]
      resources = ["*"]
    }
  }
}

resource "aws_iam_role_policy" "build" {
  name   = "${var.name}-microvm-build"
  role   = aws_iam_role.build.id
  policy = data.aws_iam_policy_document.build.json
}

resource "aws_iam_role" "runtime" {
  name               = "${var.name}-microvm-runtime"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume_role.json
}
