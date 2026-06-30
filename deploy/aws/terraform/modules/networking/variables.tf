variable "name" {
  description = "Name prefix for networking resources."
  type        = string
}

variable "vpc_cidr" {
  description = "CIDR block for the VPC."
  type        = string
}

variable "az_count" {
  description = "Number of AZs to use."
  type        = number
  default     = 2
}

variable "nat_mode" {
  description = "NAT mode for private subnet egress."
  type        = string
  default     = "fck_nat"

  validation {
    condition     = contains(["fck_nat", "single_nat_gateway", "one_nat_gateway_per_az"], var.nat_mode)
    error_message = "Allowed values for nat_mode are fck_nat, single_nat_gateway, or one_nat_gateway_per_az."
  }
}

variable "fck_nat_instance_type" {
  description = "Instance type for fck-nat gateways."
  type        = string
  default     = "t4g.nano"
}

variable "enable_s3_gateway_endpoint" {
  description = "Whether to add a free S3 gateway endpoint for private subnets."
  type        = bool
  default     = true
}

variable "tags" {
  description = "Tags to apply to resources."
  type        = map(string)
  default     = {}
}
