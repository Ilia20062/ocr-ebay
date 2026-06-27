#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib'
import { OcrStack } from '../lib/ocr-stack'

const app = new cdk.App()

// Image tag is provided by the deploy script after pushing to ECR.
const imageTag = app.node.tryGetContext('imageTag') ?? 'latest'
const ecrRepoName = app.node.tryGetContext('ecrRepoName') ?? 'ocr-crm'
const ebayEnvironment = app.node.tryGetContext('ebayEnvironment') ?? 'sandbox'

new OcrStack(app, 'OcrCrmStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
  },
  imageTag,
  ecrRepoName,
  ebayEnvironment,
  description: 'OCR CRM — AWS-native deployment (VPC, RDS, S3, Cognito, ECS/Fargate, ALB)',
})
