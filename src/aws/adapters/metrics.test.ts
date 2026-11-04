import assert from "node:assert/strict";
import test from "node:test";
import type { PutMetricDataCommand } from "@aws-sdk/client-cloudwatch";
import {
  publishRunMetrics,
  publishVerificationMetrics,
} from "./metrics";
import type { TestResult } from "../contracts";

function result(
  stage: TestResult["stage"],
  passed: boolean,
): TestResult {
  return {
    passed,
    exitCode: passed ? 0 : 1,
    command: "npm run build && npm test",
    stage,
    durationMs: 20,
    output: passed ? "passed" : "failed",
  };
}

test("publishes distinct per-file build failure and test failure metrics", async () => {
  const published: PutMetricDataCommand[] = [];
  const send = async (command: PutMetricDataCommand): Promise<void> => {
    published.push(command);
  };

  await publishVerificationMetrics(
    {
      runId: "run-build-failure",
      filePath: "src/first.js",
      result: result("build", false),
    },
    send,
  );
  await publishVerificationMetrics(
    {
      runId: "run-test-failure",
      filePath: "src/second.js",
      result: result("test", false),
    },
    send,
  );

  assert.deepEqual(
    published.map(command =>
      command.input.MetricData?.map(metric => metric.MetricName),
    ),
    [["BuildFailures"], ["BuildPasses", "TestFailures"]],
  );
});

test("publishes passing build and test metrics after complete verification", async () => {
  let recorded: PutMetricDataCommand | undefined;
  await publishVerificationMetrics(
    {
      runId: "run-passed",
      filePath: "src/verified.js",
      result: result("complete", true),
    },
    async command => {
      recorded = command;
    },
  );

  assert.deepEqual(
    recorded?.input.MetricData?.map(metric => metric.MetricName),
    ["BuildPasses", "TestPasses"],
  );
});

test("publishes failure totals for a rolled-back workflow", async () => {
  let recorded: PutMetricDataCommand | undefined;
  await publishRunMetrics(
    {
      totalFiles: 4,
      successfulFiles: 0,
      failedFiles: 4,
      reviewFiles: 1,
      durationMs: 300,
    },
    async command => {
      recorded = command;
    },
  );

  const values = new Map(
    recorded?.input.MetricData?.map(metric => [
      metric.MetricName,
      metric.Value,
    ]),
  );
  assert.equal(values.get("FilesMigrated"), 4);
  assert.equal(values.get("FilesSuccessful"), 0);
  assert.equal(values.get("FilesFailed"), 4);
});
