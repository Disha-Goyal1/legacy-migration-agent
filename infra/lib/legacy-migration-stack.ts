import path from "node:path";
import * as cdk from "aws-cdk-lib";
import { Duration, RemovalPolicy } from "aws-cdk-lib";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecrAssets from "aws-cdk-lib/aws-ecr-assets";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as nodejs from "aws-cdk-lib/aws-lambda-nodejs";
import * as logs from "aws-cdk-lib/aws-logs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as sfn from "aws-cdk-lib/aws-stepfunctions";
import * as tasks from "aws-cdk-lib/aws-stepfunctions-tasks";
import { Construct } from "constructs";

export interface LegacyMigrationStackProps extends cdk.StackProps {
  bedrockEnabled: boolean;
  bedrockModelId: string;
  githubTokenSecretName: string;
}

export class LegacyMigrationStack extends cdk.Stack {
  constructor(
    scope: Construct,
    id: string,
    props: LegacyMigrationStackProps,
  ) {
    super(scope, id, props);

    const bucket = new s3.Bucket(this, "MigrationArtifacts", {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      versioned: true,
      removalPolicy: RemovalPolicy.RETAIN,
      lifecycleRules: [
        {
          expiration: Duration.days(90),
          noncurrentVersionExpiration: Duration.days(30),
          abortIncompleteMultipartUploadAfter: Duration.days(7),
        },
      ],
    });

    const table = new dynamodb.Table(this, "MigrationState", {
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: "expiresAt",
      removalPolicy: RemovalPolicy.RETAIN,
    });
    table.addGlobalSecondaryIndex({
      indexName: "gsi1",
      partitionKey: { name: "gsi1pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "gsi1sk", type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    const vpc = new ec2.Vpc(this, "RunnerVpc", {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [
        {
          name: "IsolatedRunner",
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
          cidrMask: 24,
        },
      ],
    });
    const runnerSecurityGroup = new ec2.SecurityGroup(
      this,
      "RunnerSecurityGroup",
      {
        vpc,
        description: "No inbound; egress is limited by isolated subnet routes.",
        allowAllOutbound: true,
      },
    );
    const endpointSecurityGroup = new ec2.SecurityGroup(
      this,
      "EndpointSecurityGroup",
      {
        vpc,
        description: "Private AWS endpoints reachable only from runner tasks.",
        allowAllOutbound: false,
      },
    );
    endpointSecurityGroup.addIngressRule(
      runnerSecurityGroup,
      ec2.Port.tcp(443),
      "Runner can reach required AWS endpoints over TLS.",
    );
    const runnerS3Endpoint = vpc.addGatewayEndpoint("RunnerS3Endpoint", {
      service: ec2.GatewayVpcEndpointAwsService.S3,
      subnets: [{ subnetType: ec2.SubnetType.PRIVATE_ISOLATED }],
    });
    const s3EndpointResource = runnerS3Endpoint.node.defaultChild;
    if (s3EndpointResource instanceof ec2.CfnVPCEndpoint) {
      s3EndpointResource.addPropertyOverride(
        "PolicyDocument",
        new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              principals: [new iam.AnyPrincipal()],
              actions: ["s3:GetObject", "s3:PutObject"],
              resources: [bucket.arnForObjects("runs/*")],
            }),
            new iam.PolicyStatement({
              principals: [new iam.AnyPrincipal()],
              actions: ["s3:GetObject"],
              resources: [
                `arn:${cdk.Aws.PARTITION}:s3:::prod-${cdk.Aws.REGION}-starport-layer-bucket/*`,
              ],
            }),
            new iam.PolicyStatement({
              principals: [new iam.AnyPrincipal()],
              actions: ["s3:ListBucket"],
              resources: [bucket.bucketArn],
              conditions: {
                StringLike: { "s3:prefix": ["runs/*"] },
              },
            }),
          ],
        }).toJSON(),
      );
    }
    for (const [id, service] of [
      ["RunnerEcrApiEndpoint", ec2.InterfaceVpcEndpointAwsService.ECR],
      [
        "RunnerEcrDockerEndpoint",
        ec2.InterfaceVpcEndpointAwsService.ECR_DOCKER,
      ],
      ["RunnerLogsEndpoint", ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS],
    ] as const) {
      vpc.addInterfaceEndpoint(id, {
        service,
        privateDnsEnabled: true,
        securityGroups: [endpointSecurityGroup],
        subnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      });
    }

    const cluster = new ecs.Cluster(this, "RunnerCluster", { vpc });
    const runnerLogGroup = new logs.LogGroup(this, "RunnerLogs", {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    const runnerImage = ecs.ContainerImage.fromAsset(
      path.resolve(__dirname, "../../runner"),
      { file: "Dockerfile", platform: ecrAssets.Platform.LINUX_AMD64 },
    );
    const runnerTask = new ecs.FargateTaskDefinition(this, "RunnerTask", {
      cpu: 1024,
      memoryLimitMiB: 2048,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.X86_64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });
    const runnerContainer = runnerTask.addContainer("IsolatedProjectTests", {
      image: runnerImage,
      logging: ecs.LogDrivers.awsLogs({
        logGroup: runnerLogGroup,
        streamPrefix: "migration-test",
      }),
      environment: {},
      readonlyRootFilesystem: true,
      user: "1000",
      memoryLimitMiB: 1536,
      cpu: 768,
      stopTimeout: Duration.seconds(30),
    });
    runnerContainer.addMountPoints({
      sourceVolume: "workspace",
      containerPath: "/tmp",
      readOnly: false,
    });
    runnerTask.addVolume({ name: "workspace" });
    const githubSecret = secretsmanager.Secret.fromSecretNameV2(
      this,
      "GitHubTokenSecret",
      props.githubTokenSecretName,
    );

    const handlerEntry = path.resolve(
      __dirname,
      "../../src/aws/handlers.ts",
    );
    const makeLambda = (
      functionId: string,
      handler: string,
      timeout: Duration,
      memorySize: number,
    ) =>
      new nodejs.NodejsFunction(this, functionId, {
        entry: handlerEntry,
        handler,
        runtime: lambda.Runtime.NODEJS_22_X,
        timeout,
        memorySize,
        logGroup: new logs.LogGroup(this, `${functionId}Logs`, {
          retention: logs.RetentionDays.ONE_MONTH,
          removalPolicy: RemovalPolicy.RETAIN,
        }),
        ephemeralStorageSize: cdk.Size.mebibytes(
          functionId.includes("Migrate") || functionId.includes("Suggestions")
            ? 2048
            : 512,
        ),
        environment: {
          MIGRATION_BUCKET: bucket.bucketName,
          MIGRATION_TABLE_NAME: table.tableName,
          CLOUDWATCH_NAMESPACE: "LegacyMigrationAgent",
          BEDROCK_ENABLED: String(props.bedrockEnabled),
          BEDROCK_MODEL_ID: props.bedrockModelId,
          GITHUB_TOKEN_SECRET_ARN: githubSecret.secretArn,
        },
        bundling: {
          minify: true,
          sourceMap: false,
          externalModules: [],
          target: "node22",
          commandHooks: {
            beforeBundling: () => [],
            beforeInstall: () => [],
            afterBundling: (_inputDir, outputDir) => [
              `node -e "require('node:fs').cpSync(process.argv[1], process.argv[2], { recursive: true })" "${path.resolve(
                __dirname,
                "../../node_modules/@types/node",
              )}" "${path.join(outputDir, "node_modules", "@types", "node")}"`,
            ],
          },
        },
      });

    const prepareMigration = makeLambda(
      "PrepareMigrationLambda",
      "prepareMigrationHandler",
      Duration.minutes(5),
      1024,
    );
    const migrate = makeLambda(
      "MigrateLambda",
      "migrateSingleFileHandler",
      Duration.minutes(5),
      2048,
    );
    const prepareTest = makeLambda(
      "PrepareTestLambda",
      "prepareTestHandler",
      Duration.seconds(30),
      512,
    );
    const verify = makeLambda(
      "VerifyLambda",
      "verifyHandler",
      Duration.seconds(30),
      512,
    );
    const humanReview = makeLambda(
      "HumanReviewLambda",
      "humanReviewHandler",
      Duration.seconds(30),
      512,
    );
    const applySuggestions = makeLambda(
      "ApplyApprovedSuggestionsLambda",
      "applyApprovedSuggestionsHandler",
      Duration.minutes(15),
      1024,
    );
    const commit = makeLambda(
      "CommitAndPullRequestLambda",
      "commitHandler",
      Duration.minutes(5),
      1024,
    );
    const commitFile = makeLambda(
      "CommitVerifiedFileLambda",
      "commitFileHandler",
      Duration.minutes(2),
      512,
    );
    const rollback = makeLambda(
      "RollbackLambda",
      "rollbackHandler",
      Duration.minutes(2),
      512,
    );
    const rollbackFile = makeLambda(
      "RollbackFileLambda",
      "rollbackFileHandler",
      Duration.seconds(30),
      512,
    );
    const acceptFileLambda = makeLambda(
      "AcceptFileLambda",
      "acceptFileHandler",
      Duration.seconds(30),
      512,
    );
    const finalizeMigration = makeLambda(
      "FinalizeMigrationLambda",
      "finalizeMigrationHandler",
      Duration.seconds(30),
      512,
    );

    bucket.grantReadWrite(prepareMigration, "runs/*");
    bucket.grantReadWrite(migrate, "runs/*");
    bucket.grantReadWrite(prepareTest, "runs/*");
    bucket.grantRead(verify, "runs/*");
    bucket.grantReadWrite(applySuggestions, "runs/*");
    bucket.grantReadWrite(commit, "runs/*");
    bucket.grantRead(commitFile, "runs/*");
    bucket.grantReadWrite(finalizeMigration, "runs/*");
    table.grantReadWriteData(prepareMigration);
    table.grantReadWriteData(migrate);
    table.grantReadWriteData(prepareTest);
    table.grantReadWriteData(verify);
    table.grantReadWriteData(humanReview);
    table.grantReadWriteData(applySuggestions);
    table.grantReadWriteData(commit);
    table.grantReadWriteData(commitFile);
    table.grantReadWriteData(rollback);
    table.grantReadWriteData(rollbackFile);
    table.grantReadWriteData(acceptFileLambda);
    table.grantReadWriteData(finalizeMigration);
    for (const metricsLambda of [commit, rollback, verify]) {
      metricsLambda.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ["cloudwatch:PutMetricData"],
          resources: ["*"],
          conditions: {
            StringEquals: { "cloudwatch:namespace": "LegacyMigrationAgent" },
          },
        }),
      );
    }

    githubSecret.grantRead(commit);
    githubSecret.grantRead(commitFile);
    githubSecret.grantRead(rollback);

    if (props.bedrockEnabled) {
      migrate.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
          resources: [
            `arn:${cdk.Aws.PARTITION}:bedrock:${cdk.Aws.REGION}::foundation-model/${props.bedrockModelId}`,
          ],
        }),
      );
    }

    const failure = new sfn.Fail(this, "MigrationFailed", {
      error: "MigrationWorkflowFailed",
      cause: "A file migration, review, build, test, or verification failed.",
    });
    const rollbackFileTask = new tasks.LambdaInvoke(this, "RollbackCurrentFile", {
      lambdaFunction: rollbackFile,
      payload: sfn.TaskInput.fromJsonPathAt("$"),
      payloadResponseOnly: true,
      resultPath: "$.rollback",
    }).next(
      new sfn.Pass(this, "ReturnRolledBackFile", {
        parameters: {
          file: sfn.JsonPath.objectAt("$.rollback.file"),
          committed: false,
        },
      }),
    );
    const rollbackMigrationTask = new tasks.LambdaInvoke(
      this,
      "RollbackMigration",
      {
        lambdaFunction: rollback,
        payload: sfn.TaskInput.fromJsonPathAt("$"),
        resultPath: "$.rollback",
      },
    ).next(failure);
    const withFileRollback = <T extends sfn.TaskStateBase>(task: T): T => {
      task.addCatch(rollbackFileTask, { resultPath: "$.error" });
      return task;
    };

    const perFileMigration = withFileRollback(
      new tasks.LambdaInvoke(this, "MigrateOneProjectFile", {
        lambdaFunction: migrate,
        payload: sfn.TaskInput.fromJsonPathAt("$"),
        payloadResponseOnly: true,
        resultPath: "$.migration",
      }),
    );
    const prepareFileTest = withFileRollback(
      new tasks.LambdaInvoke(this, "PrepareCurrentFileVerification", {
        lambdaFunction: prepareTest,
        payload: sfn.TaskInput.fromJsonPathAt("$"),
        payloadResponseOnly: true,
        resultPath: "$.testPlan",
      }),
    );
    const runFileBuildAndTests = withFileRollback(
      new tasks.EcsRunTask(this, "BuildAndTestCurrentFileInFargate", {
        integrationPattern: sfn.IntegrationPattern.RUN_JOB,
        launchTarget: new tasks.EcsFargateLaunchTarget(),
        cluster,
        taskDefinition: runnerTask,
        assignPublicIp: false,
        subnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
        securityGroups: [runnerSecurityGroup],
        containerOverrides: [
          {
            containerDefinition: runnerContainer,
            environment: [
              { name: "RUN_ID", value: sfn.JsonPath.stringAt("$.runId") },
              {
                name: "INPUT_ARCHIVE_URL",
                value: sfn.JsonPath.stringAt("$.testPlan.archiveUrl"),
              },
              {
                name: "RESULT_PUT_URL",
                value: sfn.JsonPath.stringAt("$.testPlan.resultUrl"),
              },
            ],
          },
        ],
        taskTimeout: sfn.Timeout.duration(Duration.minutes(20)),
        resultPath: "$.testTask",
      }),
    );
    const verifyFile = withFileRollback(
      new tasks.LambdaInvoke(this, "VerifyCurrentFileBuildAndTests", {
        lambdaFunction: verify,
        payload: sfn.TaskInput.fromJsonPathAt("$"),
        payloadResponseOnly: true,
        resultPath: "$.verification",
      }),
    );
    const waitForReview = withFileRollback(
      new tasks.LambdaInvoke(this, "WaitForCurrentFileHumanReview", {
        lambdaFunction: humanReview,
        integrationPattern: sfn.IntegrationPattern.WAIT_FOR_TASK_TOKEN,
        payload: sfn.TaskInput.fromObject({
          runId: sfn.JsonPath.stringAt("$.runId"),
          migration: sfn.JsonPath.objectAt("$.migration"),
          taskToken: sfn.JsonPath.taskToken,
        }),
        taskTimeout: sfn.Timeout.duration(Duration.days(7)),
        resultPath: "$.review",
      }),
    );
    const applyApprovedSuggestion = withFileRollback(
      new tasks.LambdaInvoke(this, "ApplyApprovedCurrentFileSuggestion", {
        lambdaFunction: applySuggestions,
        payload: sfn.TaskInput.fromJsonPathAt("$"),
        payloadResponseOnly: true,
        resultPath: "$.migration",
      }),
    );
    const prepareReviewedFileTest = withFileRollback(
      new tasks.LambdaInvoke(this, "PrepareReviewedFileVerification", {
        lambdaFunction: prepareTest,
        payload: sfn.TaskInput.fromJsonPathAt("$"),
        payloadResponseOnly: true,
        resultPath: "$.testPlan",
      }),
    );
    const runReviewedFileBuildAndTests = withFileRollback(
      new tasks.EcsRunTask(this, "RebuildAndRetestReviewedFileInFargate", {
        integrationPattern: sfn.IntegrationPattern.RUN_JOB,
        launchTarget: new tasks.EcsFargateLaunchTarget(),
        cluster,
        taskDefinition: runnerTask,
        assignPublicIp: false,
        subnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
        securityGroups: [runnerSecurityGroup],
        containerOverrides: [
          {
            containerDefinition: runnerContainer,
            environment: [
              { name: "RUN_ID", value: sfn.JsonPath.stringAt("$.runId") },
              {
                name: "INPUT_ARCHIVE_URL",
                value: sfn.JsonPath.stringAt("$.testPlan.archiveUrl"),
              },
              {
                name: "RESULT_PUT_URL",
                value: sfn.JsonPath.stringAt("$.testPlan.resultUrl"),
              },
            ],
          },
        ],
        taskTimeout: sfn.Timeout.duration(Duration.minutes(20)),
        resultPath: "$.testTask",
      }),
    );
    const verifyReviewedFile = withFileRollback(
      new tasks.LambdaInvoke(this, "VerifyReviewedFileBuildAndTests", {
        lambdaFunction: verify,
        payload: sfn.TaskInput.fromJsonPathAt("$"),
        payloadResponseOnly: true,
        resultPath: "$.verification",
      }),
    );
    const acceptFileTask = withFileRollback(
      new tasks.LambdaInvoke(this, "AcceptVerifiedFileSnapshot", {
        lambdaFunction: acceptFileLambda,
        payload: sfn.TaskInput.fromJsonPathAt("$"),
        payloadResponseOnly: true,
        resultPath: "$.accepted",
      }),
    );
    const commitVerifiedFileTask = withFileRollback(
      new tasks.LambdaInvoke(this, "CommitVerifiedFile", {
        lambdaFunction: commitFile,
        payload: sfn.TaskInput.fromJsonPathAt("$"),
        payloadResponseOnly: true,
        resultPath: "$",
      }),
    );
    acceptFileTask.next(commitVerifiedFileTask);
    const fileMigrationFailed = new sfn.Choice(
      this,
      "DeterministicFileMigrationSucceeded",
    )
      .when(
        sfn.Condition.stringEquals(
          "$.migration.files[0].status",
          "failed",
        ),
        rollbackFileTask,
      )
      .otherwise(
        prepareFileTest
          .next(runFileBuildAndTests)
          .next(verifyFile)
          .next(
            new sfn.Choice(this, "CurrentFileVerificationPassed")
              .when(
                sfn.Condition.booleanEquals("$.verification.passed", false),
                rollbackFileTask,
              )
              .otherwise(
                new sfn.Choice(this, "CurrentFileNeedsHumanReview")
                  .when(
                    sfn.Condition.booleanEquals(
                      "$.migration.requiresReview",
                      true,
                    ),
                    waitForReview,
                  )
                  .otherwise(acceptFileTask),
              ),
          ),
      );
    const reviewedFilePassed = new sfn.Choice(
      this,
      "ReviewedFileVerificationPassed",
    )
      .when(
        sfn.Condition.booleanEquals("$.verification.passed", true),
        acceptFileTask,
      )
      .otherwise(rollbackFileTask);
    const reviewDecision = new sfn.Choice(
      this,
      "CurrentFileHumanReviewApproved",
    )
      .when(
        sfn.Condition.booleanEquals("$.review.approved", true),
        applyApprovedSuggestion
          .next(prepareReviewedFileTest)
          .next(runReviewedFileBuildAndTests)
          .next(verifyReviewedFile)
          .next(reviewedFilePassed),
      )
      .otherwise(rollbackFileTask);
    waitForReview.next(reviewDecision);
    const fileProcessor = perFileMigration.next(fileMigrationFailed);
    const perFileWorkflow = new sfn.Map(this, "MigrateFilesSequentially", {
      itemsPath: sfn.JsonPath.stringAt("$.files"),
      itemSelector: {
        runId: sfn.JsonPath.stringAt("$.runId"),
        bucket: sfn.JsonPath.stringAt("$.bucket"),
        sourceKey: sfn.JsonPath.stringAt("$.sourceKey"),
        repository: sfn.JsonPath.objectAt("$.repository"),
        filePath: sfn.JsonPath.stringAt("$$.Map.Item.Value"),
      },
      maxConcurrency: 1,
      resultPath: "$.fileResults",
    });
    perFileWorkflow.itemProcessor(fileProcessor);
    perFileWorkflow.addCatch(rollbackMigrationTask, {
      resultPath: "$.error",
    });
    const prepareMigrationTask = new tasks.LambdaInvoke(
      this,
      "PrepareIncrementalMigration",
      {
        lambdaFunction: prepareMigration,
        payload: sfn.TaskInput.fromJsonPathAt("$"),
        payloadResponseOnly: true,
        resultPath: "$",
      },
    );
    const finalizeMigrationTask = new tasks.LambdaInvoke(
      this,
      "FinalizeAcceptedFileResults",
      {
        lambdaFunction: finalizeMigration,
        payload: sfn.TaskInput.fromJsonPathAt("$"),
        payloadResponseOnly: true,
        resultPath: "$.migration",
      },
    );
    const commitTask = new tasks.LambdaInvoke(
      this,
      "CommitVerifiedMigrationPullRequest",
      {
        lambdaFunction: commit,
        payload: sfn.TaskInput.fromJsonPathAt("$"),
        resultPath: "$.commit",
      },
    );
    finalizeMigrationTask.addCatch(rollbackMigrationTask, {
      resultPath: "$.error",
    });
    commitTask.addCatch(rollbackMigrationTask, { resultPath: "$.error" });
    const success = new sfn.Succeed(this, "MigrationPullRequestCreated");
    const noFilesCommitted = new sfn.Succeed(this, "NoFilesCommitted");
    const hasCommittedFiles = new sfn.Choice(
      this,
      "AnyFilesCommitted",
    )
      .when(
        sfn.Condition.numberGreaterThan("$.migration.committedFiles", 0),
        commitTask,
      )
      .otherwise(noFilesCommitted);
    const preparationFailed = new sfn.Fail(this, "MigrationPreparationFailed", {
      error: "MigrationPreparationFailed",
      cause: "The source project could not be prepared for incremental migration.",
    });
    prepareMigrationTask.addCatch(preparationFailed, { resultPath: "$.error" });
    const definition = prepareMigrationTask
      .next(perFileWorkflow)
      .next(finalizeMigrationTask)
      .next(hasCommittedFiles);
    commitTask.next(success);

    const stateMachine = new sfn.StateMachine(this, "MigrationStateMachine", {
      definitionBody: sfn.DefinitionBody.fromChainable(definition),
      stateMachineType: sfn.StateMachineType.STANDARD,
      timeout: Duration.days(30),
      logs: {
        destination: new logs.LogGroup(this, "StateMachineLogs", {
          retention: logs.RetentionDays.ONE_MONTH,
          removalPolicy: RemovalPolicy.RETAIN,
        }),
        level: sfn.LogLevel.ALL,
        includeExecutionData: false,
      },
    });

    const filesMigrated = new cloudwatch.Metric({
      namespace: "LegacyMigrationAgent",
      metricName: "FilesMigrated",
      statistic: "Sum",
      period: Duration.days(1),
    });
    const filesSuccessful = new cloudwatch.Metric({
      namespace: "LegacyMigrationAgent",
      metricName: "FilesSuccessful",
      statistic: "Sum",
      period: Duration.days(1),
    });
    const buildsPassed = new cloudwatch.Metric({
      namespace: "LegacyMigrationAgent",
      metricName: "BuildPasses",
      statistic: "Sum",
      period: Duration.days(1),
    });
    const buildsFailed = new cloudwatch.Metric({
      namespace: "LegacyMigrationAgent",
      metricName: "BuildFailures",
      statistic: "Sum",
      period: Duration.days(1),
    });
    const testsPassed = new cloudwatch.Metric({
      namespace: "LegacyMigrationAgent",
      metricName: "TestPasses",
      statistic: "Sum",
      period: Duration.days(1),
    });
    const testsFailed = new cloudwatch.Metric({
      namespace: "LegacyMigrationAgent",
      metricName: "TestFailures",
      statistic: "Sum",
      period: Duration.days(1),
    });
    const dailySuccessRate = new cloudwatch.MathExpression({
      expression: "IF(total > 0, 100 * successful / total, 0)",
      usingMetrics: {
        total: filesMigrated,
        successful: filesSuccessful,
      },
      label: "Daily migration success rate (%)",
      period: Duration.days(1),
    });
    const dashboard = new cloudwatch.Dashboard(
      this,
      "MigrationHistoryDashboard",
      {
        dashboardName: "LegacyMigrationAgent-History",
        periodOverride: cloudwatch.PeriodOverride.INHERIT,
      },
    );
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: "Migration success rate over time",
        left: [dailySuccessRate],
        leftYAxis: { min: 0, max: 100 },
        width: 12,
      }),
      new cloudwatch.GraphWidget({
        title: "Daily migration velocity",
        left: [filesMigrated, filesSuccessful],
        width: 12,
      }),
      new cloudwatch.GraphWidget({
        title: "Daily build and test outcomes",
        left: [buildsPassed, buildsFailed, testsPassed, testsFailed],
        width: 24,
      }),
    );
    new cloudwatch.Alarm(this, "MigrationSuccessRateAlarm", {
      alarmName: "LegacyMigrationAgent-SuccessRateBelow100Percent",
      metric: dailySuccessRate,
      threshold: 100,
      comparisonOperator:
        cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      evaluationPeriods: 1,
      datapointsToAlarm: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    new cdk.CfnOutput(this, "MigrationBucketName", {
      value: bucket.bucketName,
    });
    new cdk.CfnOutput(this, "MigrationTableName", {
      value: table.tableName,
    });
    new cdk.CfnOutput(this, "MigrationStateMachineArn", {
      value: stateMachine.stateMachineArn,
    });
    new cdk.CfnOutput(this, "RunnerVpcId", { value: vpc.vpcId });
    new cdk.CfnOutput(this, "MigrationDashboardName", {
      value: dashboard.dashboardName,
    });
  }
}
