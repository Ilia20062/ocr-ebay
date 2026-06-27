import * as cdk from 'aws-cdk-lib'
import { Construct } from 'constructs'
import * as ec2 from 'aws-cdk-lib/aws-ec2'
import * as ecs from 'aws-cdk-lib/aws-ecs'
import * as ecsp from 'aws-cdk-lib/aws-ecs-patterns'
import * as ecr from 'aws-cdk-lib/aws-ecr'
import * as rds from 'aws-cdk-lib/aws-rds'
import * as s3 from 'aws-cdk-lib/aws-s3'
import * as cognito from 'aws-cdk-lib/aws-cognito'
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager'
import * as iam from 'aws-cdk-lib/aws-iam'
import * as lambda from 'aws-cdk-lib/aws-lambda'
import * as events from 'aws-cdk-lib/aws-events'
import * as targets from 'aws-cdk-lib/aws-events-targets'
import * as logs from 'aws-cdk-lib/aws-logs'
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront'
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins'

export interface OcrStackProps extends cdk.StackProps {
  imageTag: string
  ecrRepoName: string
  ebayEnvironment: string
}

export class OcrStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: OcrStackProps) {
    super(scope, id, props)

    const CONTAINER_NAME = 'app'

    // ---------------------------------------------------------------- VPC ----
    // No NAT gateway (~$32/mo saved). Fargate tasks run in PUBLIC subnets with a
    // public IP but are reachable only through the ALB (security group locks
    // inbound to the ALB SG). Outbound to the internet — required for the eBay /
    // OpenRouter / Google Vision APIs — goes straight out via the IGW, so no NAT
    // is needed. RDS stays in isolated subnets with no internet route.
    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [
        { name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: 'app', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
        { name: 'data', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
    })

    // -------------------------------------------------------------- S3 -------
    const bucket = new s3.Bucket(this, 'ImagesBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN, // keep user images on stack delete
      cors: [
        {
          allowedMethods: [s3.HttpMethods.PUT, s3.HttpMethods.GET, s3.HttpMethods.HEAD],
          allowedOrigins: ['*'], // presigned URLs are themselves the access control
          allowedHeaders: ['*'],
          maxAge: 3000,
        },
      ],
    })

    // ----------------------------------------------------------- Cognito -----
    const userPool = new cognito.UserPool(this, 'UserPool', {
      selfSignUpEnabled: true,
      signInAliases: { email: true },
      autoVerify: { email: true },
      standardAttributes: {
        email: { required: true, mutable: true },
        fullname: { required: false, mutable: true },
      },
      passwordPolicy: {
        minLength: 8,
        requireLowercase: true,
        requireDigits: true,
        requireUppercase: false,
        requireSymbols: false,
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    })

    const userPoolClient = userPool.addClient('AppClient', {
      authFlows: { userPassword: true, userSrp: true },
      generateSecret: false,
      idTokenValidity: cdk.Duration.hours(24),
      accessTokenValidity: cdk.Duration.hours(24),
      refreshTokenValidity: cdk.Duration.days(30),
      preventUserExistenceErrors: true,
    })

    // -------------------------------------------------------------- RDS ------
    const db = new rds.DatabaseInstance(this, 'Postgres', {
      engine: rds.DatabaseInstanceEngine.postgres({
        version: rds.PostgresEngineVersion.of('16.4', '16'),
      }),
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      instanceType: ec2.InstanceType.of(
        ec2.InstanceClass.BURSTABLE4_GRAVITON,
        ec2.InstanceSize.MICRO
      ),
      credentials: rds.Credentials.fromGeneratedSecret('ocradmin'),
      databaseName: 'ocrcrm',
      allocatedStorage: 20,
      maxAllocatedStorage: 100,
      storageEncrypted: true,
      multiAz: false, // set true for production HA
      backupRetention: cdk.Duration.days(7),
      deletionProtection: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      cloudwatchLogsExports: ['postgresql'],
    })

    // ----------------------------------------------------- App secrets -------
    // Generated/placeholder values; the deploy script populates real values
    // (ENCRYPTION_KEY, CRON_SECRET, eBay, OpenRouter) via put-secret-value so
    // they never live in the CloudFormation template.
    const appSecret = new secretsmanager.Secret(this, 'AppSecret', {
      secretName: 'ocr-crm/app',
      description: 'OCR CRM application secrets (eBay, OpenRouter, encryption, cron).',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({
          ENCRYPTION_KEY: '',
          CRON_SECRET: '',
          EBAY_CLIENT_ID: '',
          EBAY_CLIENT_SECRET: '',
          EBAY_REDIRECT_URI: '',
          OPENROUTER_API_KEY: '',
          GOOGLE_VISION_API_KEY: '',
          PADDLE_OCR_URL: '',
          PADDLE_OCR_TOKEN: '',
        }),
        generateStringKey: 'init',
      },
    })

    // ----------------------------------------------------- ECS / ALB ---------
    const repo = ecr.Repository.fromRepositoryName(this, 'Repo', props.ecrRepoName)
    const image = ecs.ContainerImage.fromEcrRepository(repo, props.imageTag)

    const cluster = new ecs.Cluster(this, 'Cluster', { vpc, containerInsights: true })

    const dbSecret = db.secret!

    const service = new ecsp.ApplicationLoadBalancedFargateService(this, 'App', {
      cluster,
      cpu: 512, // 0.5 vCPU — autoscaling adds tasks under OCR load
      memoryLimitMiB: 2048, // headroom for Tesseract + sharp
      desiredCount: 1,
      // Public subnets + public IP, no NAT. Inbound is still ALB-only via the SG.
      assignPublicIp: true,
      taskSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      publicLoadBalancer: true,
      circuitBreaker: { rollback: true },
      healthCheckGracePeriod: cdk.Duration.seconds(90),
      taskImageOptions: {
        image,
        containerName: CONTAINER_NAME,
        containerPort: 3000,
        environment: {
          NODE_ENV: 'production',
          AWS_REGION: this.region,
          S3_BUCKET: bucket.bucketName,
          COGNITO_USER_POOL_ID: userPool.userPoolId,
          COGNITO_CLIENT_ID: userPoolClient.userPoolClientId,
          PGHOST: db.dbInstanceEndpointAddress,
          PGPORT: db.dbInstanceEndpointPort,
          PGDATABASE: 'ocrcrm',
          EBAY_ENVIRONMENT: props.ebayEnvironment,
          EBAY_MARKETPLACE_ID: 'EBAY_US',
          EBAY_LOCATION_KEY: 'default-warehouse',
          EBAY_LOCATION_COUNTRY: 'US',
          EBAY_LOCATION_POSTAL_CODE: '95125',
          EBAY_LOCATION_CITY: 'San Jose',
          EBAY_LOCATION_STATE: 'CA',
          EBAY_LOCATION_NAME: 'Default Warehouse',
        },
        secrets: {
          PGUSER: ecs.Secret.fromSecretsManager(dbSecret, 'username'),
          PGPASSWORD: ecs.Secret.fromSecretsManager(dbSecret, 'password'),
          ENCRYPTION_KEY: ecs.Secret.fromSecretsManager(appSecret, 'ENCRYPTION_KEY'),
          CRON_SECRET: ecs.Secret.fromSecretsManager(appSecret, 'CRON_SECRET'),
          EBAY_CLIENT_ID: ecs.Secret.fromSecretsManager(appSecret, 'EBAY_CLIENT_ID'),
          EBAY_CLIENT_SECRET: ecs.Secret.fromSecretsManager(appSecret, 'EBAY_CLIENT_SECRET'),
          EBAY_REDIRECT_URI: ecs.Secret.fromSecretsManager(appSecret, 'EBAY_REDIRECT_URI'),
          OPENROUTER_API_KEY: ecs.Secret.fromSecretsManager(appSecret, 'OPENROUTER_API_KEY'),
          GOOGLE_VISION_API_KEY: ecs.Secret.fromSecretsManager(appSecret, 'GOOGLE_VISION_API_KEY'),
          PADDLE_OCR_URL: ecs.Secret.fromSecretsManager(appSecret, 'PADDLE_OCR_URL'),
          PADDLE_OCR_TOKEN: ecs.Secret.fromSecretsManager(appSecret, 'PADDLE_OCR_TOKEN'),
        },
        logDriver: ecs.LogDrivers.awsLogs({
          streamPrefix: 'app',
          logRetention: logs.RetentionDays.ONE_MONTH,
        }),
      },
    })

    // ---------------------------------------------- CloudFront (HTTPS) -------
    // Terminates TLS at the edge (default *.cloudfront.net cert) so the app is
    // served over HTTPS without owning a domain — required for the Secure
    // session cookies. Dynamic app: caching disabled, all methods + viewer
    // headers/cookies forwarded to the ALB origin.
    const distribution = new cloudfront.Distribution(this, 'Cdn', {
      comment: 'OCR CRM HTTPS edge',
      defaultBehavior: {
        origin: new origins.LoadBalancerV2Origin(service.loadBalancer, {
          protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
          httpPort: 80,
        }),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER,
      },
    })

    // The app is reached via CloudFront (HTTPS); used for eBay OAuth redirects
    // and signed-image proxy URLs.
    service.taskDefinition.defaultContainer?.addEnvironment(
      'NEXT_PUBLIC_APP_URL',
      `https://${distribution.distributionDomainName}`
    )

    // The app's auth-session route returns 401 when logged out — treat as healthy.
    service.targetGroup.configureHealthCheck({
      path: '/api/auth/session',
      healthyHttpCodes: '200-499',
      interval: cdk.Duration.seconds(30),
      timeout: cdk.Duration.seconds(5),
    })

    // Network + IAM wiring.
    db.connections.allowDefaultPortFrom(service.service, 'ECS tasks to RDS')
    bucket.grantReadWrite(service.taskDefinition.taskRole)
    service.taskDefinition.taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: [
          'cognito-idp:InitiateAuth',
          'cognito-idp:SignUp',
          'cognito-idp:AdminConfirmSignUp',
          'cognito-idp:AdminUpdateUserAttributes',
          'cognito-idp:AdminGetUser',
        ],
        resources: [userPool.userPoolArn],
      })
    )

    // Autoscaling.
    const scaling = service.service.autoScaleTaskCount({ minCapacity: 1, maxCapacity: 4 })
    scaling.scaleOnCpuUtilization('CpuScaling', {
      targetUtilizationPercent: 65,
      scaleInCooldown: cdk.Duration.seconds(120),
      scaleOutCooldown: cdk.Duration.seconds(60),
    })

    // ------------------------------------------------ Cron (EventBridge) -----
    const cronFn = new lambda.Function(this, 'CronInvoker', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      timeout: cdk.Duration.seconds(30),
      logRetention: logs.RetentionDays.ONE_MONTH,
      environment: {
        ALB_DNS: service.loadBalancer.loadBalancerDnsName,
        APP_SECRET_ARN: appSecret.secretArn,
      },
      code: lambda.Code.fromInline(`
const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');
let cronSecret;
exports.handler = async (event) => {
  if (!cronSecret) {
    const sm = new SecretsManagerClient({});
    const r = await sm.send(new GetSecretValueCommand({ SecretId: process.env.APP_SECRET_ARN }));
    cronSecret = JSON.parse(r.SecretString).CRON_SECRET;
  }
  const url = 'http://' + process.env.ALB_DNS + event.path;
  const res = await fetch(url, { method: 'POST', headers: { Authorization: 'Bearer ' + cronSecret } });
  const body = await res.text();
  console.log('cron', event.path, res.status, body.slice(0, 300));
  if (res.status >= 500) throw new Error('cron call failed: ' + res.status);
  return { status: res.status };
};
`),
    })
    appSecret.grantRead(cronFn)

    new events.Rule(this, 'RetryQueueSchedule', {
      schedule: events.Schedule.rate(cdk.Duration.minutes(5)),
      targets: [
        new targets.LambdaFunction(cronFn, {
          event: events.RuleTargetInput.fromObject({ path: '/api/cron/retry' }),
        }),
      ],
    })
    new events.Rule(this, 'TokenRefreshSchedule', {
      schedule: events.Schedule.rate(cdk.Duration.hours(1)),
      targets: [
        new targets.LambdaFunction(cronFn, {
          event: events.RuleTargetInput.fromObject({ path: '/api/cron/refresh-tokens' }),
        }),
      ],
    })

    // ---------------------------------------------------------- Outputs ------
    const out = (k: string, v: string, desc?: string) =>
      new cdk.CfnOutput(this, k, { value: v, description: desc })

    out('AppURL', `https://${distribution.distributionDomainName}`, 'Public application URL (HTTPS via CloudFront)')
    out('AlbURL', `http://${service.loadBalancer.loadBalancerDnsName}`, 'Direct ALB URL (origin; used by cron)')
    out('S3Bucket', bucket.bucketName)
    out('CognitoUserPoolId', userPool.userPoolId)
    out('CognitoClientId', userPoolClient.userPoolClientId)
    out('DbEndpoint', db.dbInstanceEndpointAddress)
    out('DbSecretArn', dbSecret.secretArn, 'RDS master credentials secret')
    out('AppSecretArn', appSecret.secretArn, 'Application secret to populate post-deploy')
    out('EcrRepoUri', repo.repositoryUri)
    out('ClusterName', cluster.clusterName)
    out('ServiceName', service.service.serviceName)
    out('TaskDefArn', service.taskDefinition.taskDefinitionArn)
    out('ContainerName', CONTAINER_NAME)
    out('TaskSecurityGroupId', service.service.connections.securityGroups[0].securityGroupId)
    out(
      'TaskSubnetIds',
      vpc.selectSubnets({ subnetType: ec2.SubnetType.PUBLIC }).subnetIds.join(','),
      'Public subnets for the one-off migration task (run with assignPublicIp ENABLED)'
    )
  }
}
