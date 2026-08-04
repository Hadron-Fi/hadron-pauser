variable "name" {
  description = "Deployment name; prefixes every resource (ECR repo, cluster, service, SG, roles, log group). Convention: hadron-pauser-<fleet>."
  type        = string
  default     = "hadron-pauser"
}

variable "region" {
  description = "AWS region. NOTE: use eu-central-1 (or any non-US region) if any pool uses a `binance` reference source — binance.com returns HTTP 451 to US IPs."
  type        = string
  default     = "us-east-1"
}

variable "image" {
  description = "Container image URI (ECR repo URL + tag)."
  type        = string
}

variable "cpu" {
  type    = string
  default = "256"
}

variable "memory" {
  type    = string
  default = "512"
}

variable "vpc_id" {
  description = "VPC for the service security group. Empty = use the account's default VPC."
  type        = string
  default     = ""
}

variable "subnet_ids" {
  description = "Subnets for the task ENI (public subnets with assign_public_ip, or private with NAT). Empty = all subnets of the chosen VPC."
  type        = list(string)
  default     = []
}

variable "assign_public_ip" {
  type    = bool
  default = true
}

variable "config_json" {
  description = "The full config.json document as a string. Secrets inside MUST be env:NAME references, never literal values (they would land in tfvars/state)."
  type        = string
}

variable "pauser_secret_arn" {
  description = "Secrets Manager ARN holding the pauser keypair (bs58 or JSON array)."
  type        = string
}

variable "grpc_token_secret_arn" {
  type    = string
  default = ""
}

variable "grpc_endpoint_secret_arn" {
  description = "Secrets Manager ARN for the gRPC endpoint URL. Use when the URL itself embeds a key; otherwise inline it in config_json."
  type        = string
  default     = ""
}

variable "rpc_url_primary_secret_arn" {
  type    = string
  default = ""
}

variable "rpc_url_fallback_secret_arn" {
  type    = string
  default = ""
}

variable "log_retention_days" {
  type    = number
  default = 30
}
