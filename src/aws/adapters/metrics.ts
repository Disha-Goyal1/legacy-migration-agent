import {
  CloudWatchClient,
  GetMetricDataCommand,
  PutMetricDataCommand,
  type MetricDataQuery,
} from "@aws-sdk/client-cloudwatch";
import type { TestResult } from "../contracts";

export const cloudWatch = new CloudWatchClient({});

const namespace = process.env.CLOUDWATCH_NAMESPACE ?? "LegacyMigrationAgent";

export async function publishRunMetrics(input: {
  totalFiles: number;
  successfulFiles: number;
  failedFiles: number;
  reviewFiles: number;
  durationMs: number;
}, send: (command: PutMetricDataCommand) => Promise<unknown> = command =>
  cloudWatch.send(command)): Promise<void> {
  const dimensions = [{ Name: "Application", Value: "LegacyMigrationAgent" }];
  const timestamp = new Date();
  await send(
    new PutMetricDataCommand({
      Namespace: namespace,
      MetricData: [
        {
          MetricName: "FilesMigrated",
          Value: input.totalFiles,
          Unit: "Count",
          Timestamp: timestamp,
          Dimensions: dimensions,
        },
        {
          MetricName: "FilesSuccessful",
          Value: input.successfulFiles,
          Unit: "Count",
          Timestamp: timestamp,
          Dimensions: dimensions,
        },
        {
          MetricName: "FilesFailed",
          Value: input.failedFiles,
          Unit: "Count",
          Timestamp: timestamp,
          Dimensions: dimensions,
        },
        {
          MetricName: "FilesReviewRequired",
          Value: input.reviewFiles,
          Unit: "Count",
          Timestamp: timestamp,
          Dimensions: dimensions,
        },
        {
          MetricName: "MigrationDuration",
          Value: input.durationMs,
          Unit: "Milliseconds",
          Timestamp: timestamp,
          Dimensions: dimensions,
        },
      ],
    }),
  );
}

export async function publishVerificationMetrics(
  input: {
    runId: string;
    filePath: string;
    result: TestResult;
  },
  send: (command: PutMetricDataCommand) => Promise<unknown> = command =>
    cloudWatch.send(command),
): Promise<void> {
  const dimensions = [
    { Name: "Application", Value: "LegacyMigrationAgent" },
  ];
  const metricData = [];
  if (input.result.stage === "complete") {
    metricData.push(
      { MetricName: "BuildPasses", Value: 1, Unit: "Count" as const },
      { MetricName: "TestPasses", Value: 1, Unit: "Count" as const },
    );
  } else if (input.result.stage === "build") {
    metricData.push({
      MetricName: "BuildFailures",
      Value: 1,
      Unit: "Count" as const,
    });
  } else if (input.result.stage === "test") {
    metricData.push(
      { MetricName: "BuildPasses", Value: 1, Unit: "Count" as const },
      { MetricName: "TestFailures", Value: 1, Unit: "Count" as const },
    );
  } else {
    metricData.push({
      MetricName: "VerificationPreparationFailures",
      Value: 1,
      Unit: "Count" as const,
    });
  }
  await send(
    new PutMetricDataCommand({
      Namespace: namespace,
      MetricData: metricData.map(metric => ({
        ...metric,
        Timestamp: new Date(),
        Dimensions: dimensions,
      })),
    }),
  );
}

export async function getMigrationHistory(
  startTime: Date,
  endTime = new Date(),
): Promise<Array<{ timestamp: string; successRate: number }>> {
  const queries: MetricDataQuery[] = [
    {
      Id: "success",
      MetricStat: {
        Metric: {
          Namespace: namespace,
          MetricName: "FilesSuccessful",
          Dimensions: [{ Name: "Application", Value: "LegacyMigrationAgent" }],
        },
        Period: 86400,
        Stat: "Sum",
      },
      ReturnData: false,
    },
    {
      Id: "total",
      MetricStat: {
        Metric: {
          Namespace: namespace,
          MetricName: "FilesMigrated",
          Dimensions: [{ Name: "Application", Value: "LegacyMigrationAgent" }],
        },
        Period: 86400,
        Stat: "Sum",
      },
      ReturnData: false,
    },
    {
      Id: "rate",
      Expression: "IF(total>0,100*success/total,0)",
      Label: "Migration success rate",
      ReturnData: true,
    },
  ];
  const response = await cloudWatch.send(
    new GetMetricDataCommand({
      StartTime: startTime,
      EndTime: endTime,
      MetricDataQueries: queries,
      ScanBy: "TimestampAscending",
    }),
  );
  const rate = response.MetricDataResults?.find(result => result.Id === "rate");
  return (rate?.Timestamps ?? []).map((timestamp, index) => ({
    timestamp: timestamp.toISOString(),
    successRate: rate?.Values?.[index] ?? 0,
  }));
}
