# networking

Reusable Terraform module for the AWS network baseline used by the Deputies reference deployment.

## Owns

- VPC with DNS support enabled.
- Public and private subnets across `az_count` availability zones.
- Public/private route tables.
- Optional S3 gateway endpoint for private subnet S3 access.
- Private subnet NAT egress through either AWS NAT Gateway or `fck_nat`.

## Does Not Own

- Application security groups, ALB, ECS, RDS, or buckets.
- DNS zones or records.
- VPC peering, transit gateway, VPN, private hosted zones, or corporate network integration.
- Fine-grained egress filtering beyond the selected NAT mode and route tables.

## NAT Modes

- `fck_nat`: lower-cost EC2 NAT instances, one per AZ. Good for reference and cost-sensitive stacks, but it is not the same operational profile as managed NAT Gateway.
- `single_nat_gateway`: one managed AWS NAT Gateway. Simpler, but cross-AZ egress can add cost and blast radius.
- `one_nat_gateway_per_az`: managed NAT Gateway per AZ. Higher cost, better AZ isolation.

Choose NAT based on availability, throughput, operational ownership, and cost requirements.

## Subnet Layout

The module derives subnet CIDRs from `vpc_cidr` using `cidrsubnet(var.vpc_cidr, 8, index)` for private subnets and offset public subnets. Review the resulting CIDRs before adopting this module in an existing network plan.

## Key Outputs

- `vpc_id` and `vpc_cidr_block`.
- `private_subnets` and `public_subnets`.
- `private_route_table_ids` and `public_route_table_ids`.
