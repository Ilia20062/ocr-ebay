$ErrorActionPreference = "Stop"
$Region = "us-east-1"
$EcrRepoName = "ocr-crm"
$EbayEnvironment = "production"
$AccountId = (aws sts get-caller-identity --query Account --output text)

Write-Host "==> Deploying infrastructure with CDK" -ForegroundColor Green
Push-Location infra/cdk
npx cdk deploy `
  -c imageTag="latest" `
  -c ecrRepoName=$EcrRepoName `
  -c ebayEnvironment=$EbayEnvironment `
  --require-approval never `
  --outputs-file outputs.json
$Outputs = (Get-Content outputs.json -Raw | ConvertFrom-Json).OcrCrmStack
Pop-Location

$Cluster      = $Outputs.ClusterName
$ServiceName  = $Outputs.ServiceName

Write-Host "`n==> Rolling the service" -ForegroundColor Green
aws ecs update-service --cluster $Cluster --service $ServiceName --force-new-deployment | Out-Null
aws ecs wait services-stable --cluster $Cluster --services $ServiceName
Write-Host "Done"
