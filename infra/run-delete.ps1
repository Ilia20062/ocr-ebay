$Outputs = (Get-Content infra/cdk/outputs.json -Raw | ConvertFrom-Json).OcrCrmStack
$Cluster      = $Outputs.ClusterName
$TaskDefArn   = $Outputs.TaskDefArn
$ContainerNm  = $Outputs.ContainerName
$SubnetIds    = $Outputs.TaskSubnetIds
$TaskSg       = $Outputs.TaskSecurityGroupId

$netCfg = "awsvpcConfiguration={subnets=[$SubnetIds],securityGroups=[$TaskSg],assignPublicIp=ENABLED}"

$nodeCmd = @"
const { Client } = require('pg');
const ssl = process.env.PGSSL === 'disable' ? false : { rejectUnauthorized: false };
const client = process.env.DATABASE_URL
  ? new Client({ connectionString: process.env.DATABASE_URL, ssl })
  : new Client({
      host: process.env.PGHOST,
      port: process.env.PGPORT ? parseInt(process.env.PGPORT, 10) : 5432,
      user: process.env.PGUSER,
      password: process.env.PGPASSWORD,
      database: process.env.PGDATABASE,
      ssl
    });

client.connect()
  .then(() => client.query("DELETE FROM listings WHERE sku IN ('162570', '625754')"))
  .then(() => { console.log('Deleted successfully'); client.end(); })
  .catch(e => { console.error('Error:', e); process.exit(1); });
"@

$b64 = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($nodeCmd))
$evalCmd = "eval(Buffer.from('$b64', 'base64').toString('utf8'))"

$overridesJson = '{"containerOverrides":[{"name":"' + $ContainerNm + '","command":["node", "-e", "' + $evalCmd + '"]}]}'
$overridesFile = Join-Path $env:TEMP "ocr-delete-overrides.json"
[System.IO.File]::WriteAllText($overridesFile, $overridesJson)

$taskArn = (aws ecs run-task --cluster $Cluster --task-definition $TaskDefArn --launch-type FARGATE --network-configuration $netCfg --overrides "file://$overridesFile" --query 'tasks[0].taskArn' --output text)
Write-Host "Task ARN: $taskArn"
aws ecs wait tasks-stopped --cluster $Cluster --tasks $taskArn
$exitCode = (aws ecs describe-tasks --cluster $Cluster --tasks $taskArn --query 'tasks[0].containers[0].exitCode' --output text)
Write-Host "Finished with exit code: $exitCode"
