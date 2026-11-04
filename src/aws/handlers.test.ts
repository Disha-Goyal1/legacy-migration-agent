import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  commitFileHandler,
  markFileRecordsRolledBack,
  recordWorkflowFailure,
  rollbackFileHandler,
  validateArchiveEntry,
  validateTestResult,
  verificationPassed,
} from "./handlers";
import { isMigrationWorkflowInput } from "./contracts";
import { decideCandidateRollback } from "./workflow-decisions";

test("validates migration workflow input shape", () => {
  assert.equal(
    isMigrationWorkflowInput({
      runId: "run-1",
      bucket: "migration-bucket",
      sourceKey: "runs/run-1/source/project.tar.gz",
      repository: {
        owner: "octocat",
        name: "legacy-project",
        baseBranch: "main",
      },
    }),
    true,
  );
  assert.equal(isMigrationWorkflowInput({ runId: "missing-fields" }), false);
});

test("rejects archive traversal before extracting project files", () => {
  const root = path.join(os.tmpdir(), "migration-handler-test");
  assert.equal(
    validateArchiveEntry(root, "src/app.js"),
    path.join(root, "src", "app.js"),
  );
  for (const unsafePath of [
    "../outside.js",
    "src/../../outside.js",
    "/absolute/file.js",
    "D:\\outside.js",
  ]) {
    assert.throws(() => validateArchiveEntry(root, unsafePath));
  }
});

test("requires a complete Fargate verification result", () => {
  assert.deepEqual(
    validateTestResult({
      passed: true,
      exitCode: 0,
      command: "npm test",
      stage: "complete",
      durationMs: 42,
      output: "all tests passed",
    }),
    {
      passed: true,
      exitCode: 0,
      command: "npm test",
      stage: "complete",
      durationMs: 42,
      output: "all tests passed",
    },
  );
  assert.throws(
    () => validateTestResult({ passed: true }),
    /invalid shape/,
  );
});

test("chooses an idempotent and safe per-file snapshot rollback decision", () => {
  assert.equal(
    decideCandidateRollback("before.tar.gz", "before.tar.gz", "after.tar.gz"),
    "already_restored",
  );
  assert.equal(
    decideCandidateRollback("after.tar.gz", "before.tar.gz", "after.tar.gz"),
    "restore_previous",
  );
  assert.equal(
    decideCandidateRollback("unexpected.tar.gz", "before.tar.gz", "after.tar.gz"),
    "conflict",
  );
});

test("verification rejects failed build and test outcomes", () => {
  const file = {
    path: "src/example.js",
    outputPath: "src/example.ts",
    status: "testing" as const,
    transformations: [],
    errors: [],
    warnings: [],
  };
  assert.equal(
    verificationPassed(
      {
        passed: false,
        exitCode: 1,
        command: "npm run build && npm test",
        stage: "build",
        durationMs: 10,
        output: "build failed",
      },
      [file],
    ),
    false,
  );
  assert.equal(
    verificationPassed(
      {
        passed: false,
        exitCode: 1,
        command: "npm run build && npm test",
        stage: "test",
        durationMs: 20,
        output: "test failed",
      },
      [file],
    ),
    false,
  );
  assert.equal(
    verificationPassed(
      {
        passed: true,
        exitCode: 0,
        command: "npm run build && npm test",
        stage: "complete",
        durationMs: 30,
        output: "success",
      },
      [file],
    ),
    true,
  );
});

test("full rollback updates per-file status and handles legacy records without outputPath", async () => {
  const saved: Array<{ runId: string; file: { path: string; outputPath: string; status: string } }> = [];
  const summary = await markFileRecordsRolledBack(
    "run-1",
    "Verification failed.",
    {
      list: async () => [
        {
          filePath: "src/legacy.js",
          status: "accepted",
          transformations: [],
          errors: [],
          warnings: [],
        },
      ],
      save: async (runId, file) => {
        saved.push({ runId, file });
      },
    },
  );
  assert.deepEqual(summary, {
    totalFiles: 1,
    successfulFiles: 0,
    failedFiles: 1,
    reviewFiles: 0,
  });
  assert.deepEqual(saved, [
    {
      runId: "run-1",
      file: {
        path: "src/legacy.js",
        outputPath: "src/legacy.ts",
        status: "rolled_back",
        transformations: [],
        errors: ["Verification failed."],
        warnings: [],
        explanation: undefined,
      },
    },
  ]);
});

test("run rollback preserves records for files with successful Git commits", async () => {
  const savedPaths: string[] = [];
  const summary = await markFileRecordsRolledBack(
    "run-keep-history",
    "A later file failed.",
    {
      list: async () => [
        {
          filePath: "src/first.js",
          outputPath: "src/first.ts",
          status: "accepted",
          commitSha: "commit-first",
          transformations: [],
          errors: [],
          warnings: [],
        },
        {
          filePath: "src/second.js",
          outputPath: "src/second.ts",
          status: "testing",
          transformations: [],
          errors: [],
          warnings: [],
        },
      ],
      save: async (_runId, file) => {
        savedPaths.push(file.path);
      },
    },
  );
  assert.deepEqual(summary, {
    totalFiles: 2,
    successfulFiles: 1,
    failedFiles: 1,
    reviewFiles: 0,
  });
  assert.deepEqual(savedPaths, ["src/second.js"]);
});

test("per-file rollback restores and records only the failed file", async () => {
  const events: string[] = [];
  const migration = {
    runId: "run-one-file-fails",
    bucket: "migration-bucket",
    sourceKey: "source.tar.gz",
    repository: { owner: "owner", name: "repo", baseBranch: "main" },
    candidateKey: "candidate-two.tar.gz",
    previousCandidateKey: "candidate-one.tar.gz",
    migrationReportKey: "report.json",
    files: [
      {
        path: "src/second.js",
        outputPath: "src/second.ts",
        status: "failed" as const,
        transformations: [],
        errors: ["verification failed"],
        warnings: [],
      },
    ],
    requiresReview: false,
  };
  const result = await rollbackFileHandler(
    { runId: migration.runId, migration },
    {
      restoreCandidateArchive: async (runId, previous, candidate) => {
        events.push(`restore:${runId}:${previous}:${candidate}`);
      },
      getFileRecord: async () => undefined,
      putFileRecord: async (runId, file) => {
        events.push(`file:${runId}:${file.path}:${file.status}`);
      },
      putRunRecord: async (_runId, status) => {
        events.push(`run:${status}`);
      },
    },
  );
  assert.equal(result.filePath, "src/second.js");
  assert.equal(result.file.status, "rolled_back");
  assert.deepEqual(events, [
    "restore:run-one-file-fails:candidate-one.tar.gz:candidate-two.tar.gz",
    "file:run-one-file-fails:src/second.js:rolled_back",
    "run:file_rolled_back",
  ]);
});

test("per-file commit handler commits only an accepted verified file", async () => {
  const events: string[] = [];
  const migration = {
    runId: "run-commit",
    bucket: "migration-bucket",
    sourceKey: "input.tar.gz",
    repository: { owner: "owner", name: "repo", baseBranch: "main" },
    candidateKey: "candidate.tar.gz",
    migrationReportKey: "report.json",
    files: [],
    requiresReview: false,
  };
  const acceptedFile = {
    path: "src/file.js",
    outputPath: "src/file.ts",
    status: "accepted" as const,
    transformations: [],
    errors: [],
    warnings: [],
  };
  const result = await commitFileHandler(
    {
      migration,
      accepted: { file: acceptedFile },
      verification: { passed: true },
    },
    {
      createCommit: async (_migration, file) => {
        assert.equal(file.status, "accepted");
        events.push("commit");
        return { commitSha: "sha-1", branch: "migration/run-commit" };
      },
      getCommittedFile: async () => undefined,
      saveFile: async (_runId, file) => {
        events.push(`save:${file.commitSha}`);
      },
      recordRun: async (_runId, status) => {
        events.push(`run:${status}`);
      },
    },
  );
  assert.deepEqual(events, ["commit", "save:sha-1", "run:file_committed"]);
  assert.equal(result.file.commitSha, "sha-1");

  await assert.rejects(
    commitFileHandler(
      {
        migration,
        verification: { passed: false },
        accepted: {
          file: { ...acceptedFile, status: "verified" },
        },
      },
      {
        createCommit: async () => {
          throw new Error("Unverified file reached GitHub commit.");
        },
        getCommittedFile: async () => undefined,
        saveFile: async () => undefined,
        recordRun: async () => undefined,
      },
    ),
    /cannot be committed before successful verification and acceptance/,
  );
});

test("failed workflow records terminal status and emits failure metrics", async () => {
  const events: string[] = [];
  await recordWorkflowFailure(
    {
      runId: "run-2",
      rollbackReason: "Fargate test failed.",
      totalFiles: 3,
      successfulFiles: 1,
      failedFiles: 2,
      reviewFiles: 1,
      durationMs: 250,
    },
    {
      putRunRecord: async (runId, status, fields) => {
        events.push(`status:${runId}:${status}:${String(fields?.failedFiles ?? "")}`);
      },
      publishRunMetrics: async input => {
        events.push(`metrics:${input.totalFiles}:${input.failedFiles}`);
      },
    },
  );
  assert.deepEqual(events, ["status:run-2:rolled_back:2", "metrics:3:2"]);
});

test("failed workflow retains terminal status if CloudWatch publication fails", async () => {
  const persistedStatuses: string[] = [];
  await assert.rejects(
    recordWorkflowFailure(
      {
        runId: "run-3",
        rollbackReason: "Fargate failed.",
        totalFiles: 1,
        successfulFiles: 0,
        failedFiles: 1,
        reviewFiles: 0,
        durationMs: 50,
      },
      {
        putRunRecord: async (_runId, status, fields) => {
          persistedStatuses.push(
            `${status}:${String(fields?.metricsError ?? "")}`,
          );
        },
        publishRunMetrics: async () => {
          throw new Error("CloudWatch unavailable.");
        },
      },
    ),
    /CloudWatch unavailable/,
  );
  assert.deepEqual(persistedStatuses, [
    "rolled_back:",
    "rolled_back:CloudWatch unavailable.",
  ]);
});
