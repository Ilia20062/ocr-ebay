<#
.SYNOPSIS
  End-to-end AWS deployment for OCR CRM.

.DESCRIPTION
  Provisions and deploys the entire stack on AWS-native services:
    1. Ensure ECR repo exists, build + push the Docker image.
    2. cdk bootstrap (idempotent) + cdk deploy (VPC, RDS, S3, Cognito, ECS/ALB, cron).
    3. Populate the application secret (ENCRYPTION_KEY/CRON_SECRET auto-generated;
       eBay / OpenRouter taken from env vars if present).
    4. Run DB migrations as a one-off Fargate task (keeps RDS private).
    5. Force a new ECS deployment so the app picks up the populated secret.

  Requires: AWS CLI v2 (configured with admin creds), Docker, Node.js.
  Run from the repo root:  ./infra/deploy.ps1

.PARAMETER Region
  AWS region (default: us-east-1).

.PARAMETER EbayEnvironment
  'sandbox' or 'production' (default: sandbox).
#>
param(
  [string]$Region = "us-east-1",
  [string]$EbayEnvironment = "sandbox",
  [string]$EcrRepoName = "ocr-crm"
)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $RepoRoot

Write-Host "==> Region: $Region" -ForegroundColor Cyan
$env:AWS_DEFAULT_REGION = $Region
$env:CDK_DEFAULT_REGION = $Region

$AccountId = (aws sts get-caller-identity --query Account --output text)
if (-not $AccountId) { throw "Could not resolve AWS account. Are credentials configured?" }
$env:CDK_DEFAULT_ACCOUNT = $AccountId
$EcrUri = "$AccountId.dkr.ecr.$Region.amazonaws.com/$EcrRepoName"
$Tag = (Get-Date -Format "yyyyMMddHHmmss")
Write-Host "==> Account: $AccountId   ECR: $EcrUri   Tag: $Tag" -ForegroundColor Cyan

# ---- 1. ECR repo + image push ------------------------------------------------
Write-Host "`n==> [1/5] Ensuring ECR repository and pushing image" -ForegroundColor Green
try { aws ecr describe-repositories --repository-names $EcrRepoName --region $Region | Out-Null }
catch { aws ecr create-repository --repository-name $EcrRepoName --image-scanning-configuration scanOnPush=true --region $Region | Out-Null }

# Capture the token into a variable and pass it via --password. Piping
# `get-login-password | docker login --password-stdin` intermittently corrupts
# the token under Windows PowerShell (pipeline stdin encoding) -> ECR "400 Bad
# Request". Passing --password avoids the pipe entirely.
#
# docker writes an insecure-password WARNING to stderr; under this script's
# ErrorActionPreference=Stop that stderr line is promoted to a terminating
# NativeCommandError even though login succeeds (exit 0). Drop to Continue just
# around the login and gate on the real exit code instead.
$ecrPassword = (aws ecr get-login-password --region $Region)
if (-not $ecrPassword) { throw "aws ecr get-login-password returned empty - check AWS credentials/region." }
$eapPrev = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
docker login --username AWS --password $ecrPassword "$AccountId.dkr.ecr.$Region.amazonaws.com"
$loginExit = $LASTEXITCODE
$ErrorActionPreference = $eapPrev
if ($loginExit -ne 0) { throw "docker login to ECR failed (exit $loginExit)." }
docker build -t "${EcrUri}:$Tag" -t "${EcrUri}:latest" .
docker push "${EcrUri}:$Tag"
docker push "${EcrUri}:latest"

# ---- 2. CDK deploy -----------------------------------------------------------
Write-Host "`n==> [2/5] Deploying infrastructure with CDK" -ForegroundColor Green
Push-Location infra/cdk
if (-not (Test-Path node_modules)) { npm install }
npx cdk bootstrap "aws://$AccountId/$Region"
npx cdk deploy `
  -c imageTag=$Tag `
  -c ecrRepoName=$EcrRepoName `
  -c ebayEnvironment=$EbayEnvironment `
  --require-approval never `
  --outputs-file outputs.json
$Outputs = (Get-Content outputs.json -Raw | ConvertFrom-Json).OcrCrmStack
Pop-Location

$Cluster      = $Outputs.ClusterName
$ServiceName  = $Outputs.ServiceName
$TaskDefArn   = $Outputs.TaskDefArn
$ContainerNm  = $Outputs.ContainerName
$AppSecretArn = $Outputs.AppSecretArn
$SubnetIds    = $Outputs.TaskSubnetIds
$TaskSg       = $Outputs.TaskSecurityGroupId
$AppUrl       = $Outputs.AppURL

# ---- 3. Populate application secret ------------------------------------------
Write-Host "`n==> [3/5] Populating application secret" -ForegroundColor Green
function New-HexKey([int]$bytes) {
  $b = New-Object byte[] $bytes
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
  ($b | ForEach-Object { $_.ToString("x2") }) -join ""
}
$current = (aws secretsmanager get-secret-value --secret-id $AppSecretArn --query SecretString --output text | ConvertFrom-Json)
# Pull any provided values from the environment (incl. encryption/cron if you
# want to supply your own instead of auto-generating).
foreach ($k in @('ENCRYPTION_KEY','CRON_SECRET','EBAY_CLIENT_ID','EBAY_CLIENT_SECRET','EBAY_REDIRECT_URI','OPENROUTER_API_KEY','GOOGLE_VISION_API_KEY','PADDLE_OCR_URL','PADDLE_OCR_TOKEN')) {
  $v = [Environment]::GetEnvironmentVariable($k)
  if ($v) { $current.$k = $v }
}
# Auto-generate any security secrets still empty.
if (-not $current.ENCRYPTION_KEY) { $current.ENCRYPTION_KEY = (New-HexKey 32) }   # 64 hex chars
if (-not $current.CRON_SECRET)    { $current.CRON_SECRET    = (New-HexKey 24) }
$json = ($current | ConvertTo-Json -Compress)
# Write via a file:// reference. Passing the JSON inline strips the double
# quotes when PowerShell hands it to aws.exe, storing malformed JSON that ECS
# then cannot extract secret keys from (bricks the app secret). file:// is
# byte-exact.
$secretFile = Join-Path $env:TEMP "ocr-app-secret.json"
[System.IO.File]::WriteAllText($secretFile, $json)
aws secretsmanager put-secret-value --secret-id $AppSecretArn --secret-string "file://$secretFile" | Out-Null
Remove-Item $secretFile -Force -ErrorAction SilentlyContinue
Write-Host "    ENCRYPTION_KEY/CRON_SECRET set; integration keys taken from env where present."

# ---- 4. Run DB migrations (one-off Fargate task) -----------------------------
Write-Host "`n==> [4/5] Applying database schema via one-off Fargate task" -ForegroundColor Green
$netCfg = "awsvpcConfiguration={subnets=[$SubnetIds],securityGroups=[$TaskSg],assignPublicIp=ENABLED}"
# Pass containerOverrides via a file:// reference. Inline, PowerShell strips the
# JSON double quotes when handing the arg to aws.exe, yielding invalid JSON
# ({containerOverrides:[...]}) and a ParamValidation error.
$overridesJson = '{"containerOverrides":[{"name":"' + $ContainerNm + '","command":["node","scripts/migrate.cjs"]}]}'
$overridesFile = Join-Path $env:TEMP "ocr-migrate-overrides.json"
[System.IO.File]::WriteAllText($overridesFile, $overridesJson)
$taskArn = (aws ecs run-task --cluster $Cluster --task-definition $TaskDefArn --launch-type FARGATE `
  --network-configuration $netCfg --overrides "file://$overridesFile" --query 'tasks[0].taskArn' --output text)
Write-Host "    migration task: $taskArn"
aws ecs wait tasks-stopped --cluster $Cluster --tasks $taskArn
$exit = (aws ecs describe-tasks --cluster $Cluster --tasks $taskArn --query 'tasks[0].containers[0].exitCode' --output text)
if ($exit -ne "0") { throw "Migration task failed (exit code $exit). Check CloudWatch logs (/app stream)." }
Write-Host "    migration completed (exit 0)."

# ---- 5. Force new deployment so app picks up secret --------------------------
Write-Host "`n==> [5/5] Rolling the service to pick up populated secrets" -ForegroundColor Green
aws ecs update-service --cluster $Cluster --service $ServiceName --force-new-deployment | Out-Null
Write-Host "    waiting for service to stabilize..."
aws ecs wait services-stable --cluster $Cluster --services $ServiceName

Write-Host "`n=====================================================" -ForegroundColor Cyan
Write-Host " Deployment complete." -ForegroundColor Cyan
Write-Host " App URL: $AppUrl" -ForegroundColor Yellow
Write-Host "=====================================================" -ForegroundColor Cyan
