# hadron-pauser on ECS Fargate — mirrors the hadron-cli crank module
# (flat single module, terraform workspace per deployment, var.name prefixes
# everything) with two deliberate inversions:
#
#  1. deployment_minimum_healthy_percent = 100 / maximum = 200:
#     pausing is IDEMPOTENT (a concurrent duplicate pause lands as the benign
#     Custom(53) no-op), so unlike the single-writer crank we never accept a
#     watchdog-coverage gap during deploys.
#  2. Config is delivered as one CONFIG_JSON env blob with secrets referenced
#     as env:NAME — the actual secrets come from Secrets Manager ARNs.

data "aws_caller_identity" "current" {}

# Networking: use the account's default VPC unless the operator names one.
# Fargate + assign_public_ip needs no NAT gateway, so the default VPC's public
# subnets are a working (and free) starting point.
data "aws_vpc" "default" {
  count   = var.vpc_id == "" ? 1 : 0
  default = true
}

data "aws_subnets" "default" {
  count = length(var.subnet_ids) == 0 ? 1 : 0
  filter {
    name   = "vpc-id"
    values = [var.vpc_id != "" ? var.vpc_id : data.aws_vpc.default[0].id]
  }
}

locals {
  vpc_id     = var.vpc_id != "" ? var.vpc_id : data.aws_vpc.default[0].id
  subnet_ids = length(var.subnet_ids) > 0 ? var.subnet_ids : data.aws_subnets.default[0].ids

  environment = [
    { name = "CONFIG_JSON", value = var.config_json },
    { name = "HEALTH_PORT", value = "8080" },
    { name = "STATE_S3_BUCKET", value = aws_s3_bucket.state.bucket },
    { name = "STATE_S3_KEY", value = "${var.name}.json" },
  ]

  base_secrets    = [{ name = "PAUSER_SECRET", valueFrom = var.pauser_secret_arn }]
  grpc_secrets    = var.grpc_token_secret_arn != "" ? [{ name = "GRPC_API_KEY", valueFrom = var.grpc_token_secret_arn }] : []
  grpc_ep_secrets = var.grpc_endpoint_secret_arn != "" ? [{ name = "GRPC_ENDPOINT", valueFrom = var.grpc_endpoint_secret_arn }] : []
  rpc_secrets = concat(
    var.rpc_url_primary_secret_arn != "" ? [{ name = "RPC_URL_PRIMARY", valueFrom = var.rpc_url_primary_secret_arn }] : [],
    var.rpc_url_fallback_secret_arn != "" ? [{ name = "RPC_URL_FALLBACK", valueFrom = var.rpc_url_fallback_secret_arn }] : [],
  )
  secrets = concat(local.base_secrets, local.grpc_secrets, local.grpc_ep_secrets, local.rpc_secrets)

  health_cmd = "node -e 'fetch(\"http://localhost:8080/health\").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))'"
}

resource "aws_ecr_repository" "this" {
  name                 = var.name
  image_tag_mutability = "MUTABLE"
  force_delete         = true
  image_scanning_configuration { scan_on_push = true }
}

resource "aws_cloudwatch_log_group" "this" {
  name              = "/ecs/${var.name}"
  retention_in_days = var.log_retention_days
}

resource "aws_ecs_cluster" "this" {
  name = var.name
}

data "aws_iam_policy_document" "assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "execution" {
  name               = "${var.name}-exec"
  assume_role_policy = data.aws_iam_policy_document.assume.json
}

resource "aws_iam_role_policy_attachment" "execution" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

data "aws_iam_policy_document" "secrets" {
  statement {
    actions = ["secretsmanager:GetSecretValue"]
    resources = compact([
      var.pauser_secret_arn,
      var.grpc_token_secret_arn,
      var.grpc_endpoint_secret_arn,
      var.rpc_url_primary_secret_arn,
      var.rpc_url_fallback_secret_arn,
    ])
  }
}

resource "aws_iam_role_policy" "secrets" {
  name   = "${var.name}-secrets"
  role   = aws_iam_role.execution.id
  policy = data.aws_iam_policy_document.secrets.json
}

# Restart memory: a tiny JSON snapshot (drawdown windows + authority baseline)
# so deploys/crashes don't re-arm the drawdown budget or go blind to
# authority changes that land during downtime. See src/state/.
resource "aws_s3_bucket" "state" {
  bucket        = "${var.name}-state-${data.aws_caller_identity.current.account_id}"
  force_destroy = true
}

resource "aws_s3_bucket_public_access_block" "state" {
  bucket                  = aws_s3_bucket.state.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# Runtime task role (distinct from the execution role): the container itself
# only ever needs read/write on its own snapshot object.
resource "aws_iam_role" "task" {
  name               = "${var.name}-task"
  assume_role_policy = data.aws_iam_policy_document.assume.json
}

data "aws_iam_policy_document" "task_state" {
  statement {
    actions   = ["s3:GetObject", "s3:PutObject"]
    resources = ["${aws_s3_bucket.state.arn}/*"]
  }
}

resource "aws_iam_role_policy" "task_state" {
  name   = "${var.name}-task-state"
  role   = aws_iam_role.task.id
  policy = data.aws_iam_policy_document.task_state.json
}

resource "aws_security_group" "this" {
  name        = "${var.name}-sg"
  description = "${var.name} egress-only"
  vpc_id      = local.vpc_id

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_ecs_task_definition" "this" {
  family                   = var.name
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.cpu
  memory                   = var.memory
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn

  runtime_platform {
    operating_system_family = "LINUX"
    # X86_64 required: @triton-one/yellowstone-grpc ships no linux-arm64 binding.
    cpu_architecture = "X86_64"
  }

  container_definitions = jsonencode([{
    name        = var.name
    image       = var.image
    essential   = true
    environment = local.environment
    secrets     = local.secrets

    linuxParameters = { initProcessEnabled = true }
    portMappings    = [{ containerPort = 8080, protocol = "tcp" }]

    healthCheck = {
      command  = ["CMD-SHELL", local.health_cmd]
      interval = 15
      timeout  = 3
      retries  = 3
      # Must exceed boot + warmup so a cold start is never killed mid-seed.
      startPeriod = 120
    }

    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.this.name
        "awslogs-region"        = var.region
        "awslogs-stream-prefix" = "pauser"
      }
    }
  }])
}

resource "aws_ecs_service" "this" {
  name            = var.name
  cluster         = aws_ecs_cluster.this.id
  task_definition = aws_ecs_task_definition.this.arn
  desired_count   = 1
  launch_type     = "FARGATE"

  # Watchdog: keep the old task alive until the new one is healthy — a brief
  # overlap is safe (pause is idempotent), a coverage gap is not.
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200

  network_configuration {
    subnets          = local.subnet_ids
    security_groups  = [aws_security_group.this.id]
    assign_public_ip = var.assign_public_ip
  }

  depends_on = [aws_iam_role_policy.secrets]
}
