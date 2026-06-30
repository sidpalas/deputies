data "aws_availability_zones" "available" {
  state = "available"
}

locals {
  azs = slice(data.aws_availability_zones.available.names, 0, var.az_count)
}

module "vpc" {
  source  = "terraform-aws-modules/vpc/aws"
  version = "6.6.1"

  name = var.name
  cidr = var.vpc_cidr

  azs             = local.azs
  private_subnets = [for index, _ in local.azs : cidrsubnet(var.vpc_cidr, 8, index)]
  public_subnets  = [for index, _ in local.azs : cidrsubnet(var.vpc_cidr, 8, index + 4)]

  enable_dns_hostnames = true
  enable_dns_support   = true

  enable_nat_gateway     = var.nat_mode != "fck_nat"
  single_nat_gateway     = var.nat_mode == "single_nat_gateway"
  one_nat_gateway_per_az = var.nat_mode == "one_nat_gateway_per_az"

  public_subnet_tags = {
    Tier = "public"
  }

  private_subnet_tags = {
    Tier = "private"
  }

  tags = var.tags
}

module "s3_vpce" {
  count   = var.enable_s3_gateway_endpoint ? 1 : 0
  source  = "terraform-aws-modules/vpc/aws//modules/vpc-endpoints"
  version = "6.6.1"

  vpc_id = module.vpc.vpc_id

  endpoints = {
    s3 = {
      service         = "s3"
      service_type    = "Gateway"
      route_table_ids = module.vpc.private_route_table_ids
      tags            = { Name = "${var.name}-s3-vpce" }
    }
  }

  tags = var.tags
}

module "fck_nat" {
  count   = var.nat_mode == "fck_nat" ? var.az_count : 0
  source  = "RaJiska/fck-nat/aws"
  version = "1.6.0"

  name                = "${var.name}-nat-${count.index}"
  vpc_id              = module.vpc.vpc_id
  subnet_id           = module.vpc.public_subnets[count.index]
  instance_type       = var.fck_nat_instance_type
  ha_mode             = true
  update_route_tables = true
  route_tables_ids    = { private = module.vpc.private_route_table_ids[count.index] }
}
