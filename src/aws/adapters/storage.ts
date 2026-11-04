import {
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import {
  DynamoDBClient,
} from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { MigratedFile, PendingReview } from "../contracts";
import { decideCandidateRollback } from "../workflow-decisions";

export const s3 = new S3Client({});
export const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable ${name}.`);
  }
  return value;
}

export function migrationTableName(): string {
  return requiredEnvironment("MIGRATION_TABLE_NAME");
}

export async function getObject(bucket: string, key: string): Promise<Buffer> {
  const response = await s3.send(
    new GetObjectCommand({ Bucket: bucket, Key: key }),
  );
  if (!response.Body) {
    throw new Error(`S3 object ${key} has no body.`);
  }
  return Buffer.from(await response.Body.transformToByteArray());
}

export async function putObject(
  bucket: string,
  key: string,
  body: Buffer | string,
  contentType = "application/octet-stream",
): Promise<void> {
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
      ServerSideEncryption: "AES256",
    }),
  );
}

export async function listObjects(
  bucket: string,
  prefix: string,
): Promise<string[]> {
  const keys: string[] = [];
  let continuationToken: string | undefined;
  do {
    const response = await s3.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      }),
    );
    keys.push(
      ...(response.Contents ?? [])
        .map(object => object.Key)
        .filter((key): key is string => key !== undefined),
    );
    continuationToken = response.NextContinuationToken;
  } while (continuationToken);
  return keys;
}

export function artifactKey(runId: string, suffix: string): string {
  return `runs/${runId}/${suffix.replace(/^\/+/, "")}`;
}

export async function presignGet(
  bucket: string,
  key: string,
  expiresIn = 900,
): Promise<string> {
  return getSignedUrl(
    s3,
    new GetObjectCommand({ Bucket: bucket, Key: key }),
    { expiresIn },
  );
}

export async function presignPut(
  bucket: string,
  key: string,
  expiresIn = 900,
): Promise<string> {
  return getSignedUrl(
    s3,
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      ContentType: "application/json",
    }),
    { expiresIn },
  );
}

export async function putRunRecord(
  runId: string,
  status: string,
  fields: Record<string, unknown> = {},
): Promise<void> {
  const now = new Date().toISOString();
  const attributes: Record<string, unknown> = {
    status,
    updatedAt: now,
    gsi1pk: "WORKSPACE#default",
    gsi1sk: `${now}#${runId}`,
    expiresAt: Math.floor(Date.now() / 1000) + 90 * 24 * 60 * 60,
    ...fields,
  };
  const names: Record<string, string> = {};
  const values: Record<string, unknown> = {};
  const assignments = Object.entries(attributes)
    .filter(([, value]) => value !== undefined)
    .map(([name, value], index) => {
      names[`#field${index}`] = name;
      values[`:value${index}`] = value;
      return `#field${index} = :value${index}`;
    });
  await dynamo.send(
    new UpdateCommand({
      TableName: migrationTableName(),
      Key: { pk: `RUN#${runId}`, sk: "META" },
      UpdateExpression: `SET ${assignments.join(", ")}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    }),
  );
}

export async function getRunRecord(
  runId: string,
): Promise<Record<string, unknown> | undefined> {
  const response = await dynamo.send(
    new GetCommand({
      TableName: migrationTableName(),
      Key: { pk: `RUN#${runId}`, sk: "META" },
      ConsistentRead: true,
    }),
  );
  return response.Item;
}

export async function getFileRecord(
  runId: string,
  filePath: string,
): Promise<Record<string, unknown> | undefined> {
  const response = await dynamo.send(
    new GetCommand({
      TableName: migrationTableName(),
      Key: { pk: `RUN#${runId}`, sk: `FILE#${filePath}` },
      ConsistentRead: true,
    }),
  );
  return response.Item;
}

export async function listFileRecords(
  runId: string,
): Promise<Array<Record<string, unknown>>> {
  const items: Array<Record<string, unknown>> = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const response = await dynamo.send(
      new QueryCommand({
        TableName: migrationTableName(),
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :file)",
        ExpressionAttributeValues: {
          ":pk": `RUN#${runId}`,
          ":file": "FILE#",
        },
        ConsistentRead: true,
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );
    items.push(
      ...(response.Items ?? []) as Array<Record<string, unknown>>,
    );
    exclusiveStartKey = response.LastEvaluatedKey;
  } while (exclusiveStartKey);
  return items;
}

export async function acceptCandidateArchive(
  runId: string,
  previousCandidateKey: string,
  candidateKey: string,
): Promise<void> {
  await dynamo.send(
    new UpdateCommand({
      TableName: migrationTableName(),
      Key: { pk: `RUN#${runId}`, sk: "META" },
      UpdateExpression:
        "SET currentCandidateKey = :candidate, updatedAt = :updatedAt",
      ConditionExpression: "currentCandidateKey = :previous",
      ExpressionAttributeValues: {
        ":previous": previousCandidateKey,
        ":candidate": candidateKey,
        ":updatedAt": new Date().toISOString(),
      },
    }),
  );
}

export async function restoreCandidateArchive(
  runId: string,
  previousCandidateKey: string | undefined,
  candidateKey: string | undefined,
): Promise<void> {
  if (!previousCandidateKey || !candidateKey) {
    return;
  }
  const current = await getRunRecord(runId);
  const decision = decideCandidateRollback(
    current?.currentCandidateKey,
    previousCandidateKey,
    candidateKey,
  );
  if (decision === "already_restored") {
    return;
  }
  if (decision === "conflict") {
    throw new Error(
      `Cannot restore migration ${runId}: accepted archive pointer changed unexpectedly.`,
    );
  }
  await dynamo.send(
    new UpdateCommand({
      TableName: migrationTableName(),
      Key: { pk: `RUN#${runId}`, sk: "META" },
      UpdateExpression:
        "SET currentCandidateKey = :previous, updatedAt = :updatedAt",
      ConditionExpression: "currentCandidateKey = :candidate",
      ExpressionAttributeValues: {
        ":previous": previousCandidateKey,
        ":candidate": candidateKey,
        ":updatedAt": new Date().toISOString(),
      },
    }),
  );
}

export async function resetCandidateArchive(
  runId: string,
  originalCandidateKey: string,
): Promise<void> {
  await dynamo.send(
    new UpdateCommand({
      TableName: migrationTableName(),
      Key: { pk: `RUN#${runId}`, sk: "META" },
      UpdateExpression:
        "SET currentCandidateKey = :original, updatedAt = :updatedAt",
      ExpressionAttributeValues: {
        ":original": originalCandidateKey,
        ":updatedAt": new Date().toISOString(),
      },
    }),
  );
}

export async function putFileRecord(
  runId: string,
  file: MigratedFile,
  send: (command: PutCommand) => Promise<unknown> = command =>
    dynamo.send(command),
): Promise<void> {
  await send(
    new PutCommand({
      TableName: migrationTableName(),
      Item: {
        pk: `RUN#${runId}`,
        sk: `FILE#${file.path}`,
        runId,
        filePath: file.path,
        outputPath: file.outputPath,
        status: file.status,
        transformations: file.transformations,
        errors: file.errors,
        warnings: file.warnings,
        commitSha: file.commitSha,
        commitBranch: file.commitBranch,
        updatedAt: new Date().toISOString(),
        expiresAt: Math.floor(Date.now() / 1000) + 90 * 24 * 60 * 60,
      },
    }),
  );
}

export async function putPendingReview(
  runId: string,
  file: MigratedFile,
  taskToken: string,
): Promise<void> {
  const now = new Date().toISOString();
  await dynamo.send(
    new PutCommand({
      TableName: migrationTableName(),
      Item: {
        pk: `RUN#${runId}`,
        sk: `REVIEW#${file.path}`,
        gsi1pk: "REVIEW#PENDING",
        gsi1sk: `${now}#${runId}#${file.path}`,
        runId,
        filePath: file.path,
        status: "pending",
        warnings: file.warnings,
        explanation: file.explanation,
        taskToken,
        createdAt: now,
        expiresAt: Math.floor(Date.now() / 1000) + 90 * 24 * 60 * 60,
      },
    }),
  );
}

export async function getReview(
  runId: string,
  filePath: string,
): Promise<Record<string, unknown> | undefined> {
  const response = await dynamo.send(
    new GetCommand({
      TableName: migrationTableName(),
      Key: { pk: `RUN#${runId}`, sk: `REVIEW#${filePath}` },
      ConsistentRead: true,
    }),
  );
  return response.Item;
}

export async function listPendingReviews(): Promise<PendingReview[]> {
  const response = await dynamo.send(
    new QueryCommand({
      TableName: migrationTableName(),
      IndexName: "gsi1",
      KeyConditionExpression: "gsi1pk = :pk",
      ExpressionAttributeValues: { ":pk": "REVIEW#PENDING" },
      ScanIndexForward: false,
      Limit: 100,
    }),
  );
  return (response.Items ?? []).map(item => ({
    runId: String(item.runId),
    path: String(item.filePath),
    status: "pending",
    warnings: (item.warnings as string[] | undefined) ?? [],
    explanation:
      typeof item.explanation === "string" ? item.explanation : undefined,
    createdAt: String(item.createdAt),
  }));
}

export async function setReviewDecision(
  runId: string,
  filePath: string,
  decision: "approved" | "rejected",
): Promise<void> {
  await dynamo.send(
    new UpdateCommand({
      TableName: migrationTableName(),
      Key: { pk: `RUN#${runId}`, sk: `REVIEW#${filePath}` },
      UpdateExpression:
        "SET #status = :status, decidedAt = :decidedAt REMOVE gsi1pk, gsi1sk, taskToken",
      ConditionExpression: "#status = :pending",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        ":status": decision,
        ":pending": "pending",
        ":decidedAt": new Date().toISOString(),
      },
    }),
  );
  await dynamo.send(
    new UpdateCommand({
      TableName: migrationTableName(),
      Key: { pk: `RUN#${runId}`, sk: `FILE#${filePath}` },
      UpdateExpression:
        "SET reviewDecision = :decision, reviewedAt = :reviewedAt",
      ExpressionAttributeValues: {
        ":decision": decision,
        ":reviewedAt": new Date().toISOString(),
      },
    }),
  );
}
