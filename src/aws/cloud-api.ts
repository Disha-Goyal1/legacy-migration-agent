import { randomUUID } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  SFNClient,
  StartExecutionCommand,
  type StartExecutionCommandOutput,
} from "@aws-sdk/client-sfn";
import { resolveReview } from "./handlers";
import {
  getMigrationHistory,
} from "./adapters/metrics";
import {
  putObject,
  listPendingReviews,
} from "./adapters/storage";
import type { RepositoryInput } from "./contracts";

const stepFunctions = new SFNClient({});
const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));

export interface CloudRunSummary {
  runId: string;
  status: string;
  updatedAt: string;
  totalFiles?: number;
  successfulFiles?: number;
  failedFiles?: number;
  successRate?: number;
  pullRequestUrl?: string;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable ${name}.`);
  }
  return value;
}

export function cloudWorkflowConfigured(): boolean {
  return Boolean(
    process.env.MIGRATION_BUCKET &&
      process.env.MIGRATION_STATE_MACHINE_ARN &&
      process.env.MIGRATION_TABLE_NAME,
  );
}

function tableName(): string {
  return requiredEnvironment("MIGRATION_TABLE_NAME");
}

function validateRepository(value: unknown): RepositoryInput {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("GitHub repository configuration is required.");
  }
  const repository = value as Record<string, unknown>;
  if (
    typeof repository.owner !== "string" ||
    !/^[A-Za-z0-9-]{1,39}$/.test(repository.owner) ||
    typeof repository.name !== "string" ||
    !/^[A-Za-z0-9_.-]{1,100}$/.test(repository.name) ||
    typeof repository.baseBranch !== "string" ||
    !/^[A-Za-z0-9._/-]{1,100}$/.test(repository.baseBranch) ||
    repository.baseBranch.includes("..")
  ) {
    throw new TypeError("GitHub repository owner, name, or base branch is invalid.");
  }
  return {
    owner: repository.owner,
    name: repository.name,
    baseBranch: repository.baseBranch,
  };
}

export async function startCloudRun(input: {
  archiveBase64: string;
  repository: unknown;
}): Promise<{ runId: string; executionArn: string }> {
  const repository = validateRepository(input.repository);
  if (typeof input.archiveBase64 !== "string") {
    throw new TypeError("A base64-encoded .tar.gz project archive is required.");
  }
  const archive = Buffer.from(input.archiveBase64, "base64");
  if (
    archive.length < 2 ||
    archive.length > 35 * 1024 * 1024 ||
    archive[0] !== 0x1f ||
    archive[1] !== 0x8b
  ) {
    throw new TypeError("Project archive must be a gzip tar file under 35 MB.");
  }

  const runId = randomUUID();
  const bucket = requiredEnvironment("MIGRATION_BUCKET");
  const sourceKey = `runs/${runId}/source/project.tar.gz`;
  await putObject(bucket, sourceKey, archive, "application/gzip");
  const startedAt = new Date().toISOString();
  await dynamo.send(
    new PutCommand({
      TableName: tableName(),
      Item: {
        pk: `RUN#${runId}`,
        sk: "META",
        gsi1pk: "WORKSPACE#default",
        gsi1sk: `${startedAt}#${runId}`,
        runId,
        status: "queued",
        repository,
        sourceKey,
        createdAt: startedAt,
        updatedAt: startedAt,
        expiresAt: Math.floor(Date.now() / 1000) + 90 * 24 * 60 * 60,
      },
    }),
  );
  let result: StartExecutionCommandOutput;
  try {
    result = await stepFunctions.send(
      new StartExecutionCommand({
        stateMachineArn: requiredEnvironment("MIGRATION_STATE_MACHINE_ARN"),
        name: `migration-${runId}`,
        input: JSON.stringify({
          runId,
          bucket,
          sourceKey,
          repository,
        }),
      }),
    );
  } catch (error) {
    try {
      await dynamo.send(
        new UpdateCommand({
          TableName: tableName(),
          Key: { pk: `RUN#${runId}`, sk: "META" },
          UpdateExpression:
            "SET #status = :status, #updatedAt = :updatedAt, startError = :startError",
          ExpressionAttributeNames: {
            "#status": "status",
            "#updatedAt": "updatedAt",
          },
          ExpressionAttributeValues: {
            ":status": "start_error",
            ":updatedAt": new Date().toISOString(),
            ":startError":
              error instanceof Error
                ? error.message.slice(0, 1000)
                : "Step Functions execution could not be started.",
          },
        }),
      );
    } catch (statusError) {
      const startMessage =
        error instanceof Error ? error.message : "Unknown start error.";
      const statusMessage =
        statusError instanceof Error
          ? statusError.message
          : "Unknown status update error.";
      throw new Error(
        `Step Functions start failed (${startMessage}); run status update failed (${statusMessage}).`,
      );
    }
    throw error;
  }
  if (!result.executionArn) {
    throw new Error("Step Functions did not return an execution ARN.");
  }
  await dynamo.send(
    new UpdateCommand({
      TableName: tableName(),
      Key: { pk: `RUN#${runId}`, sk: "META" },
      UpdateExpression: "SET executionArn = :executionArn",
      ExpressionAttributeValues: { ":executionArn": result.executionArn },
    }),
  );
  return { runId, executionArn: result.executionArn };
}

export async function getCloudRun(runId: string): Promise<CloudRunSummary | null> {
  const response = await dynamo.send(
    new GetCommand({
      TableName: tableName(),
      Key: { pk: `RUN#${runId}`, sk: "META" },
      ConsistentRead: true,
    }),
  );
  if (!response.Item) {
    return null;
  }
  return {
    runId: String(response.Item.runId),
    status: String(response.Item.status),
    updatedAt: String(response.Item.updatedAt),
    totalFiles:
      typeof response.Item.totalFiles === "number"
        ? response.Item.totalFiles
        : undefined,
    successfulFiles:
      typeof response.Item.successfulFiles === "number"
        ? response.Item.successfulFiles
        : undefined,
    failedFiles:
      typeof response.Item.failedFiles === "number"
        ? response.Item.failedFiles
        : undefined,
    successRate:
      typeof response.Item.successRate === "number"
        ? response.Item.successRate
        : undefined,
    pullRequestUrl:
      typeof response.Item.pullRequestUrl === "string"
        ? response.Item.pullRequestUrl
        : undefined,
  };
}

export async function listCloudRuns(limit = 30): Promise<CloudRunSummary[]> {
  const response = await dynamo.send(
    new QueryCommand({
      TableName: tableName(),
      IndexName: "gsi1",
      KeyConditionExpression: "gsi1pk = :workspace",
      ExpressionAttributeValues: { ":workspace": "WORKSPACE#default" },
      ScanIndexForward: false,
      Limit: Math.min(Math.max(limit, 1), 100),
    }),
  );
  return (response.Items ?? []).map(item => ({
    runId: String(item.runId),
    status: String(item.status),
    updatedAt: String(item.updatedAt),
    totalFiles: typeof item.totalFiles === "number" ? item.totalFiles : undefined,
    successfulFiles:
      typeof item.successfulFiles === "number"
        ? item.successfulFiles
        : undefined,
    failedFiles:
      typeof item.failedFiles === "number" ? item.failedFiles : undefined,
    successRate:
      typeof item.successRate === "number" ? item.successRate : undefined,
    pullRequestUrl:
      typeof item.pullRequestUrl === "string"
        ? item.pullRequestUrl
        : undefined,
  }));
}

export async function listCloudReviews() {
  return listPendingReviews();
}

export async function submitCloudReview(input: {
  runId: string;
  filePath: string;
  decision: "approved" | "rejected";
}): Promise<void> {
  if (!/^[0-9a-f-]{36}$/i.test(input.runId)) {
    throw new TypeError("Migration run ID is invalid.");
  }
  if (
    !input.filePath ||
    input.filePath.startsWith("/") ||
    input.filePath.split(/[\\/]/).includes("..")
  ) {
    throw new TypeError("Review file path is invalid.");
  }
  await resolveReview(input);
}

export async function migrationHistory(days = 90) {
  if (!Number.isInteger(days) || days < 1 || days > 365) {
    throw new TypeError("History range must be between 1 and 365 days.");
  }
  const endTime = new Date();
  const startTime = new Date(endTime.getTime() - days * 86_400_000);
  return getMigrationHistory(startTime, endTime);
}

export function cloudApiConfigured(): boolean {
  return cloudWorkflowConfigured();
}
