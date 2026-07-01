resource "random_id" "artifact_bucket" {
  byte_length = 4
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
