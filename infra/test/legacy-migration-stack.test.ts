import assert from "node:assert/strict";
import test from "node:test";
import * as cdk from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { LegacyMigrationStack } from "../lib/legacy-migration-stack";

let defaultTemplate: Template | undefined;
let enabledTemplate: Template | undefined;

function synthesize(bedrockEnabled = false): Template {
  const cached = bedrockEnabled ? enabledTemplate : defaultTemplate;
  if (cached) {
    return cached;
  }
  const app = new cdk.App();
  const stack = new LegacyMigrationStack(app, "TestMigrationStack", {
    bedrockEnabled,
    bedrockModelId: "amazon.nova-lite-v1:0",
    githubTokenSecretName: "legacy-migration-agent/github-token",
  });
  const template = Template.fromStack(stack);
  if (bedrockEnabled) {
    enabledTemplate = template;
  } else {
    defaultTemplate = template;
  }
  return template;
}

function getStateMachineAsl(template: Template): Record<string, any> {
  const stateMachine = Object.values(
    template.findResources("AWS::StepFunctions::StateMachine"),
  )[0];
  const definition = stateMachine?.Properties?.DefinitionString;
  const isInsideString = (value: string): boolean => {
    let quoted = false;
    let escaped = false;
    for (const character of value) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === "\"") {
        quoted = !quoted;
      }
    }
    return quoted;
  };
  const flatten = (value: unknown, prefix = ""): string => {
    if (typeof value === "string") {
      return value;
    }
    if (
      typeof value === "object" &&
      value !== null &&
      "Fn::Join" in value
    ) {
      const join = (value as { "Fn::Join": [string, unknown[]] })["Fn::Join"];
      let result = prefix;
      join[1].forEach((part, index) => {
        if (index > 0) {
          result += join[0];
        }
        result += flatten(part, result);
      });
      return result.slice(prefix.length);
    }
    return isInsideString(prefix) ? "INTRINSIC" : JSON.stringify("INTRINSIC");
  };
  return JSON.parse(flatten(definition)) as Record<string, any>;
}

test("synthesizes required AWS services without NAT or public runner networking", () => {
  const template = synthesize();
  template.resourceCountIs("AWS::Lambda::Function", 12);
  template.resourceCountIs("AWS::StepFunctions::StateMachine", 1);
  template.resourceCountIs("AWS::ECS::Cluster", 1);
  template.resourceCountIs("AWS::ECS::TaskDefinition", 1);
  template.resourceCountIs("AWS::EC2::NatGateway", 0);
  template.resourceCountIs("AWS::EC2::InternetGateway", 0);
  template.resourceCountIs("AWS::S3::Bucket", 1);
  template.resourceCountIs("AWS::DynamoDB::Table", 1);
  template.resourceCountIs("AWS::CloudWatch::Dashboard", 1);
  template.resourceCountIs("AWS::CloudWatch::Alarm", 1);
  template.resourceCountIs("AWS::EC2::VPCEndpoint", 4);

  template.hasResourceProperties("AWS::S3::Bucket", {
    PublicAccessBlockConfiguration: {
      BlockPublicAcls: true,
      BlockPublicPolicy: true,
      IgnorePublicAcls: true,
      RestrictPublicBuckets: true,
    },
    BucketEncryption: {
      ServerSideEncryptionConfiguration: [
        { ServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" } },
      ],
    },
  });
  template.hasResourceProperties("AWS::DynamoDB::Table", {
    BillingMode: "PAY_PER_REQUEST",
    TimeToLiveSpecification: {
      AttributeName: "expiresAt",
      Enabled: true,
    },
    GlobalSecondaryIndexes: Match.arrayWith([
      Match.objectLike({ IndexName: "gsi1" }),
    ]),
  });
  template.hasResourceProperties("AWS::ECS::TaskDefinition", {
    RequiresCompatibilities: ["FARGATE"],
    NetworkMode: "awsvpc",
    Cpu: "1024",
    Memory: "2048",
  });
});

test("synthesizes sequential per-file migration with verification, review, and rollback branches", () => {
  const template = synthesize();
  const asl = getStateMachineAsl(template);
  const stateMachineDefinition = JSON.stringify(asl);
  for (const stateName of [
    "PrepareIncrementalMigration",
    "MigrateFilesSequentially",
    "MigrateOneProjectFile",
    "PrepareCurrentFileVerification",
    "BuildAndTestCurrentFileInFargate",
    "VerifyCurrentFileBuildAndTests",
    "WaitForCurrentFileHumanReview",
    "CurrentFileHumanReviewApproved",
    "AcceptVerifiedFileSnapshot",
    "CommitVerifiedFile",
    "ReturnRolledBackFile",
    "RollbackCurrentFile",
    "FinalizeAcceptedFileResults",
    "CommitVerifiedMigrationPullRequest",
    "RollbackMigration",
  ]) {
    assert.ok(
      stateMachineDefinition.includes(stateName),
      `state machine should contain ${stateName}`,
    );
  }
  const fileMap = asl.States.MigrateFilesSequentially;
  assert.equal(fileMap.MaxConcurrency, 1);
  assert.equal(fileMap.Catch[0].Next, "RollbackMigration");
  const states = fileMap.ItemProcessor.States;
  assert.equal(
    states.MigrateOneProjectFile.Catch[0].Next,
    "RollbackCurrentFile",
  );
  assert.ok(
    states.DeterministicFileMigrationSucceeded.Choices.some(
      (choice: Record<string, unknown>) =>
        choice.Next === "RollbackCurrentFile",
    ),
  );
  assert.ok(
    states.CurrentFileVerificationPassed.Choices.some(
      (choice: Record<string, unknown>) =>
        choice.Next === "RollbackCurrentFile",
    ),
  );
  assert.equal(
    states.CurrentFileVerificationPassed.Default,
    "CurrentFileNeedsHumanReview",
  );
  assert.ok(
    states.CurrentFileNeedsHumanReview.Choices.some(
      (choice: Record<string, unknown>) =>
        choice.Next === "WaitForCurrentFileHumanReview",
    ),
  );
  assert.equal(
    states.CurrentFileNeedsHumanReview.Default,
    "AcceptVerifiedFileSnapshot",
  );
  assert.ok(
    states.CurrentFileHumanReviewApproved.Choices.some(
      (choice: Record<string, unknown>) =>
        choice.Next === "ApplyApprovedCurrentFileSuggestion",
    ),
  );
  assert.equal(
    states.CurrentFileHumanReviewApproved.Default,
    "RollbackCurrentFile",
  );
  assert.ok(
    states.ReviewedFileVerificationPassed.Choices.some(
      (choice: Record<string, unknown>) =>
        choice.Next === "AcceptVerifiedFileSnapshot",
    ),
  );
  assert.equal(
    states.ReviewedFileVerificationPassed.Default,
    "RollbackCurrentFile",
  );
  assert.equal(states.RollbackCurrentFile.Next, "ReturnRolledBackFile");
  assert.equal(states.ReturnRolledBackFile.End, true);
  assert.equal(states.AcceptVerifiedFileSnapshot.Next, "CommitVerifiedFile");
  assert.equal(states.CommitVerifiedFile.End, true);
  assert.equal(
    states.CommitVerifiedFile.Catch[0].Next,
    "RollbackCurrentFile",
  );
  assert.equal(
    states.CurrentFileVerificationPassed.Choices[0].Next,
    "RollbackCurrentFile",
    "failed verification must stop before the per-file commit state",
  );
  assert.equal(
    states.ReviewedFileVerificationPassed.Default,
    "RollbackCurrentFile",
    "failed post-review verification must stop before the per-file commit state",
  );
  assert.equal(asl.States.AnyFilesCommitted.Type, "Choice");
  assert.equal(
    asl.States.AnyFilesCommitted.Default,
    "NoFilesCommitted",
    "failed-only runs must not create a pull request",
  );
  assert.equal(
    asl.States.RollbackMigration.Type,
    "Task",
    "Map-level failures should record terminal status and metrics",
  );
  assert.ok(
    stateMachineDefinition.includes("waitForTaskToken"),
    "per-file review must use a Step Functions task-token callback",
  );
  assert.ok(
    stateMachineDefinition.includes("ecs:runTask.sync"),
    "per-file validation must wait for Fargate completion",
  );
  assert.ok(stateMachineDefinition.includes("MigrationFailed"));
});

test("Bedrock invocation permission is absent by default and opt-in when enabled", () => {
  const disabled = synthesize(false);
  const enabled = synthesize(true);
  const disabledPolicies = JSON.stringify(
    disabled.findResources("AWS::IAM::Policy"),
  );
  const enabledPolicies = JSON.stringify(
    enabled.findResources("AWS::IAM::Policy"),
  );
  assert.equal(disabledPolicies.includes("bedrock:InvokeModel"), false);
  assert.equal(enabledPolicies.includes("bedrock:InvokeModel"), true);
  assert.ok(enabledPolicies.includes("amazon.nova-lite-v1:0"));
});

test("does not display empty migration periods as a 100 percent success rate", () => {
  const dashboard = Object.values(
    synthesize().findResources("AWS::CloudWatch::Dashboard"),
  )[0];
  const dashboardBody = JSON.stringify(dashboard?.Properties?.DashboardBody);
  assert.ok(dashboardBody.includes("IF(total > 0, 100 * successful / total, 0)"));
  assert.equal(
    dashboardBody.includes("IF(total > 0, 100 * successful / total, 100)"),
    false,
  );
});
