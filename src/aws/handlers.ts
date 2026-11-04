import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createTwoFilesPatch } from "diff";
import * as tar from "tar";
import { Project, ScriptTarget } from "ts-morph";
import {
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  SendTaskFailureCommand,
  SendTaskSuccessCommand,
  SFNClient,
} from "@aws-sdk/client-sfn";
import { BedrockTransformer } from "./adapters/bedrock";
import {
  createMigrationFileCommit,
  createMigrationPullRequest,
} from "./adapters/github";
import {
  publishRunMetrics,
  publishVerificationMetrics,
} from "./adapters/metrics";
import {
  artifactKey,
  acceptCandidateArchive,
  dynamo,
  getFileRecord,
  getRunRecord,
  getObject,
  getReview,
  listFileRecords,
  listObjects,
  migrationTableName,
  presignGet,
  presignPut,
  putFileRecord,
  putObject,
  putPendingReview,
  putRunRecord,
  restoreCandidateArchive,
  setReviewDecision,
} from "./adapters/storage";
import type {
  MigratedFile,
  MigrationPreparationOutput,
  MigrationStageOutput,
  MigrationWorkflowInput,
  TestPlan,
  TestResult,
} from "./contracts";
import { migrateFile, type MigrationReport } from "../migrate";

const execFileAsync = promisify(execFile);
const stepFunctions = new SFNClient({});
const MAX_ARCHIVE_BYTES = 50 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 1024 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 20_000;

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable ${name}.`);
  }
  return value;
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function workflowInput(value: unknown): MigrationWorkflowInput {
  const root = record(value, "workflow input");
  const repository = record(root.repository, "repository");
  if (
    typeof root.runId !== "string" ||
    typeof root.bucket !== "string" ||
    typeof root.sourceKey !== "string" ||
    typeof repository.owner !== "string" ||
    typeof repository.name !== "string" ||
    typeof repository.baseBranch !== "string"
  ) {
    throw new TypeError("Workflow input is missing required migration fields.");
  }
  return {
    runId: root.runId,
    bucket: root.bucket,
    sourceKey: root.sourceKey,
    repository: {
      owner: repository.owner,
      name: repository.name,
      baseBranch: repository.baseBranch,
    },
  };
}

function safeArchivePath(root: string, entryPath: string): string {
  const normalized = entryPath.replace(/\\/g, "/");
  if (
    normalized.startsWith("/") ||
    /^[A-Za-z]:/.test(normalized) ||
    normalized.split("/").some(part => part === "..")
  ) {
    throw new Error(`Archive contains an unsafe path: ${entryPath}`);
  }
  const resolvedRoot = path.resolve(root);
  const resolvedPath = path.resolve(resolvedRoot, normalized);
  const relative = path.relative(resolvedRoot, resolvedPath);
  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`Archive path escapes the workspace: ${entryPath}`);
  }
  return resolvedPath;
}

async function extractProjectArchive(
  archiveFile: string,
  workspace: string,
): Promise<void> {
  let expandedBytes = 0;
  let entryCount = 0;
  await tar.x({
    file: archiveFile,
    cwd: workspace,
    strict: true,
    filter: (entryPath, entry) => {
      safeArchivePath(workspace, entryPath);
      entryCount += 1;
      expandedBytes += entry.size;
      if (entryCount > MAX_ARCHIVE_ENTRIES) {
        throw new Error("Project archive exceeds the file-count limit.");
      }
      if (expandedBytes > MAX_EXPANDED_BYTES) {
        throw new Error("Project archive exceeds the expanded-size limit.");
      }
      if (
        "type" in entry &&
        (entry.type === "SymbolicLink" || entry.type === "Link")
      ) {
        throw new Error("Project archives may not contain links.");
      }
      return true;
    },
  });
}

async function collectFiles(
  root: string,
  directory = root,
): Promise<string[]> {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (
      entry.name === ".git" ||
      entry.name === "node_modules" ||
      entry.name === ".migration-reports" ||
      entry.name === "dist" ||
      entry.name === "coverage" ||
      entry.name === "build"
    ) {
      continue;
    }
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(root, fullPath)));
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }
  return files;
}

function portableRelative(root: string, filePath: string): string {
  return path.relative(root, filePath).split(path.sep).join("/");
}

async function makeArchive(workspace: string, archiveFile: string): Promise<void> {
  const files = await collectFiles(workspace);
  await tar.create(
    {
      cwd: workspace,
      file: archiveFile,
      gzip: true,
      portable: true,
      strict: true,
    },
    files.map(file => portableRelative(workspace, file)),
  );
}

async function readOptionalObject(
  bucket: string,
  key: string,
): Promise<Buffer | undefined> {
  try {
    return await getObject(bucket, key);
  } catch (error) {
    if (
      error instanceof Error &&
      "$metadata" in error &&
      typeof error.$metadata === "object" &&
      error.$metadata !== null &&
      "httpStatusCode" in error.$metadata &&
      error.$metadata.httpStatusCode === 404
    ) {
      return undefined;
    }
    throw error;
  }
}

function encodedFilePath(filePath: string): string {
  return encodeURIComponent(filePath);
}

export async function prepareMigrationHandler(
  event: unknown,
): Promise<MigrationPreparationOutput> {
  const input = workflowInput(event);
  const temporaryDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), `migration-prepare-${input.runId}-`),
  );
  const archiveFile = path.join(temporaryDirectory, "source.tar.gz");
  const workspace = path.join(temporaryDirectory, "workspace");

  try {
    await fs.mkdir(workspace, { recursive: true });
    const archive = await getObject(input.bucket, input.sourceKey);
    if (archive.length > MAX_ARCHIVE_BYTES) {
      throw new Error("Project archive exceeds the compressed-size limit.");
    }
    await fs.writeFile(archiveFile, archive, { flag: "wx" });
    await putObject(
      input.bucket,
      artifactKey(input.runId, "snapshots/before/project.tar.gz"),
      archive,
      "application/gzip",
    );
    await extractProjectArchive(archiveFile, workspace);

    const files = (await collectFiles(workspace))
      .filter(
        file =>
          file.endsWith(".js") &&
          !portableRelative(workspace, file).split("/").includes(".npm"),
      )
      .map(file => portableRelative(workspace, file))
      .sort();
    if (files.length === 0) {
      throw new Error("The project archive contains no JavaScript files.");
    }

    for (const filePath of files) {
      const source = await fs.readFile(
        safeArchivePath(workspace, filePath),
        "utf8",
      );
      await putObject(
        input.bucket,
        artifactKey(
          input.runId,
          `snapshots/before/files/${filePath}`,
        ),
        source,
        "text/javascript",
      );
      await putFileRecord(input.runId, {
        path: filePath,
        outputPath: filePath.replace(/\.js$/i, ".ts"),
        status: "pending",
        transformations: [],
        warnings: [],
        errors: [],
      });
    }
    await putRunRecord(input.runId, "migrating", {
      repository: input.repository,
      sourceKey: input.sourceKey,
      currentCandidateKey: input.sourceKey,
      totalFiles: files.length,
      startedAt: new Date().toISOString(),
    });

    return {
      ...input,
      files,
      initialCandidateKey: input.sourceKey,
    };
  } finally {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
}

export async function migrateSingleFileHandler(
  event: unknown,
): Promise<MigrationStageOutput> {
  const root = record(event, "per-file migration input");
  const input = workflowInput(root);
  if (
    typeof root.filePath !== "string" ||
    !root.filePath.toLowerCase().endsWith(".js")
  ) {
    throw new TypeError("Per-file migration requires a JavaScript file path.");
  }
  const filePath = root.filePath.replace(/\\/g, "/");
  if (
    filePath.startsWith("/") ||
    filePath.split("/").some(part => part === ".." || part === "")
  ) {
    throw new TypeError("Per-file migration path is unsafe.");
  }
  const run = await getRunRecord(input.runId);
  const previousCandidateKey =
    typeof run?.currentCandidateKey === "string"
      ? run.currentCandidateKey
      : input.sourceKey;
  const temporaryDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), `migration-file-${input.runId}-`),
  );
  const archiveFile = path.join(temporaryDirectory, "candidate.tar.gz");
  const candidateWorkspace = path.join(temporaryDirectory, "workspace");
  const reportsDirectory = path.join(candidateWorkspace, ".migration-reports");
  const sourcePath = safeArchivePath(candidateWorkspace, filePath);
  const outputPath = safeArchivePath(
    candidateWorkspace,
    filePath.replace(/\.js$/i, ".ts"),
  );
  const reportFile = path.join(
    reportsDirectory,
    `${encodedFilePath(filePath)}.json`,
  );

  try {
    await fs.mkdir(candidateWorkspace, { recursive: true });
    await fs.writeFile(
      archiveFile,
      await getObject(input.bucket, previousCandidateKey),
      { flag: "wx" },
    );
    await extractProjectArchive(archiveFile, candidateWorkspace);
    await fs.access(sourcePath);
    await fs.mkdir(reportsDirectory, { recursive: true });
    const source = await fs.readFile(sourcePath, "utf8");
    const report = await migrateFile({
      inputFile: sourcePath,
      outputFile: outputPath,
      projectRoot: candidateWorkspace,
      reportFile,
    });
    let explanation: string | undefined;
    if (
      report.status !== "failed" &&
      report.warnings.length > 0 &&
      process.env.BEDROCK_ENABLED === "true"
    ) {
      const judgment = await new BedrockTransformer().review({
        sourcePath: filePath,
        source,
        deterministicOutput: await fs.readFile(outputPath, "utf8"),
        warnings: report.warnings,
      });
      explanation = judgment.explanation;
      await putObject(
        input.bucket,
        artifactKey(
          input.runId,
          `review-proposals/${filePath.replace(/\.js$/i, ".ts")}.json`,
        ),
        JSON.stringify(
          {
            sourcePath: filePath,
            outputPath: filePath.replace(/\.js$/i, ".ts"),
            proposedTypeScript: judgment.proposedTypeScript,
            explanation: judgment.explanation,
          },
          null,
          2,
        ),
        "application/json",
      );
    }
    const file: MigratedFile = {
      path: filePath,
      outputPath: filePath.replace(/\.js$/i, ".ts"),
      status: report.status,
      transformations: report.transformations,
      errors: report.errors,
      warnings: report.warnings,
      explanation,
    };
    const migrationReportKey = artifactKey(
      input.runId,
      `reports/${filePath}.json`,
    );
    await putObject(
      input.bucket,
      migrationReportKey,
      JSON.stringify(report, null, 2),
      "application/json",
    );
    await putFileRecord(input.runId, file);

    if (report.status === "failed") {
      return {
        ...input,
        candidateKey: previousCandidateKey,
        migrationReportKey,
        files: [file],
        requiresReview: false,
        previousCandidateKey,
      } as MigrationStageOutput;
    }

    const candidateArchive = path.join(temporaryDirectory, "next.tar.gz");
    await makeArchive(candidateWorkspace, candidateArchive);
    const candidateKey = artifactKey(
      input.runId,
      `snapshots/candidates/${encodedFilePath(filePath)}.tar.gz`,
    );
    await putObject(
      input.bucket,
      candidateKey,
      await fs.readFile(candidateArchive),
      "application/gzip",
    );
    const output = await fs.readFile(outputPath, "utf8");
    await putObject(
      input.bucket,
      artifactKey(
        input.runId,
        `snapshots/after/files/${file.outputPath}`,
      ),
      output,
      "text/typescript",
    );
    await putObject(
      input.bucket,
      artifactKey(input.runId, `diffs/${filePath}.patch`),
      createTwoFilesPatch(filePath, file.outputPath, source, output),
      "text/plain",
    );
    await putRunRecord(input.runId, "file_migrated", {
      currentFile: filePath,
      currentCandidateKey: previousCandidateKey,
    });
    return {
      ...input,
      candidateKey,
      migrationReportKey,
      files: [file],
      requiresReview: report.status === "review_required",
      previousCandidateKey,
    } as MigrationStageOutput;
  } finally {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
}

export async function migrateHandler(event: unknown): Promise<MigrationStageOutput> {
  const input = workflowInput(event);
  const temporaryDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), `migration-${input.runId}-`),
  );
  const archiveFile = path.join(temporaryDirectory, "source.tar.gz");
  const workspace = path.join(temporaryDirectory, "workspace");
  const reportsDirectory = path.join(workspace, ".migration-reports");
  const bucket = input.bucket;

  try {
    await fs.mkdir(workspace, { recursive: true });
    const archive = await getObject(bucket, input.sourceKey);
    if (archive.length > MAX_ARCHIVE_BYTES) {
      throw new Error("Project archive exceeds the compressed-size limit.");
    }
    await fs.writeFile(archiveFile, archive, { flag: "wx" });
    await putObject(
      bucket,
      artifactKey(input.runId, "snapshots/before/project.tar.gz"),
      archive,
      "application/gzip",
    );
    await extractProjectArchive(archiveFile, workspace);
    await fs.mkdir(reportsDirectory, { recursive: true });
    const projectFiles = (await collectFiles(workspace))
      .filter(
        file =>
          file.endsWith(".js") &&
          !portableRelative(workspace, file).split("/").includes(".npm"),
      )
      .sort();
    if (projectFiles.length === 0) {
      throw new Error("The project archive contains no JavaScript files.");
    }

    await putRunRecord(input.runId, "migrating", {
      repository: input.repository,
      totalFiles: projectFiles.length,
      sourceKey: input.sourceKey,
    });
    const migratedFiles: MigratedFile[] = [];
    const bedrockEnabled = process.env.BEDROCK_ENABLED === "true";
    const transformer = bedrockEnabled ? new BedrockTransformer() : undefined;

    for (const inputFile of projectFiles) {
      const sourcePath = portableRelative(workspace, inputFile);
      const outputFile = inputFile.replace(/\.js$/i, ".ts");
      const outputPath = portableRelative(workspace, outputFile);
      const reportFile = path.join(
        reportsDirectory,
        `${sourcePath.replace(/[\\/]/g, "__")}.json`,
      );
      const source = await fs.readFile(inputFile, "utf8");
      const report: MigrationReport = await migrateFile({
        inputFile,
        outputFile,
        projectRoot: workspace,
        reportFile,
      });
      let explanation: string | undefined;

      if (report.status !== "failed" && report.warnings.length > 0) {
        if (transformer) {
          const output = await fs.readFile(outputFile, "utf8");
          const judgment = await transformer.review({
            sourcePath,
            source,
            deterministicOutput: output,
            warnings: report.warnings,
          });
          explanation = judgment.explanation;
          await putObject(
            bucket,
            artifactKey(
              input.runId,
              `review-proposals/${outputPath}.json`,
            ),
            JSON.stringify(
              {
                sourcePath,
                outputPath,
                proposedTypeScript: judgment.proposedTypeScript,
                explanation: judgment.explanation,
              },
              null,
              2,
            ),
            "application/json",
          );
        }
      }

      const file: MigratedFile = {
        path: sourcePath,
        outputPath,
        status: report.status,
        transformations: report.transformations,
        errors: report.errors,
        warnings: report.warnings,
        explanation,
      };
      migratedFiles.push(file);
      await putFileRecord(input.runId, file);
      const reportKey = artifactKey(
        input.runId,
        `reports/${sourcePath}.json`,
      );
      await putObject(bucket, reportKey, JSON.stringify(file, null, 2), "application/json");

      if (report.status !== "failed") {
        const output = await fs.readFile(outputFile, "utf8");
        const outputKey = artifactKey(
          input.runId,
          `snapshots/after/files/${outputPath}`,
        );
        await putObject(bucket, outputKey, output, "text/typescript");
        await putObject(
          bucket,
          artifactKey(input.runId, `diffs/${sourcePath}.patch`),
          createTwoFilesPatch(sourcePath, outputPath, source, output),
          "text/plain",
        );
      }
    }

    const candidateArchive = path.join(temporaryDirectory, "candidate.tar.gz");
    await makeArchive(workspace, candidateArchive);
    const candidateKey = artifactKey(
      input.runId,
      "snapshots/after/project.tar.gz",
    );
    await putObject(
      bucket,
      candidateKey,
      await fs.readFile(candidateArchive),
      "application/gzip",
    );
    const summary = {
      runId: input.runId,
      generatedAt: new Date().toISOString(),
      files: migratedFiles,
    };
    const migrationReportKey = artifactKey(
      input.runId,
      "reports/migration-summary.json",
    );
    await putObject(
      bucket,
      migrationReportKey,
      JSON.stringify(summary, null, 2),
      "application/json",
    );
    const result: MigrationStageOutput = {
      ...input,
      candidateKey,
      migrationReportKey,
      files: migratedFiles,
      requiresReview: migratedFiles.some(
        file => file.status === "review_required",
      ),
    };
    const successfulFiles = migratedFiles.filter(
      file => file.status !== "failed",
    ).length;
    await putRunRecord(input.runId, "migrated", {
      repository: input.repository,
      totalFiles: migratedFiles.length,
      successfulFiles,
      failedFiles: migratedFiles.length - successfulFiles,
      candidateSuccessRate:
        Math.round((successfulFiles / migratedFiles.length) * 10000) / 100,
      requiresReview: result.requiresReview,
      candidateKey,
      migrationReportKey,
    });
    return result;
  } finally {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
}

export async function prepareTestHandler(event: unknown): Promise<TestPlan> {
  const root = record(event, "workflow state");
  const migration = record(root.migration, "migration result") as unknown as MigrationStageOutput;
  const file = migration.files[0];
  if (!file) {
    throw new Error("Per-file test preparation requires a migrated file.");
  }
  const resultKey = artifactKey(
    migration.runId,
    `test-results/${encodedFilePath(file.path)}.json`,
  );
  const plan: TestPlan = {
    ...migration,
    resultKey,
    archiveUrl: await presignGet(migration.bucket, migration.candidateKey),
    resultUrl: await presignPut(migration.bucket, resultKey),
  };
  await putRunRecord(migration.runId, "testing", {
    candidateKey: migration.candidateKey,
    migrationReportKey: migration.migrationReportKey,
    currentFile: file.path,
    totalFiles: 1,
  });
  await putFileRecord(migration.runId, { ...file, status: "testing" });
  return plan;
}

export async function verifyHandler(event: unknown): Promise<{
  passed: boolean;
  requiresReview: boolean;
  testResult: TestResult;
}> {
  const root = record(event, "workflow state");
  const migration = record(root.migration, "migration result") as unknown as MigrationStageOutput;
  const testPlan = record(root.testPlan, "test plan") as unknown as TestPlan;
  const resultBytes = await getObject(migration.bucket, testPlan.resultKey);
  const testResult = validateTestResult(
    JSON.parse(resultBytes.toString("utf8")),
  );
  const passed = verificationPassed(testResult, migration.files);
  for (const file of migration.files) {
    await publishVerificationMetrics({
      runId: migration.runId,
      filePath: file.path,
      result: testResult,
    });
  }
  for (const file of migration.files) {
    await putFileRecord(migration.runId, {
      ...file,
      status: passed ? "verified" : "failed",
      errors: passed
        ? file.errors
        : [...file.errors, "Target repository build or test verification failed."],
    });
  }
  await putRunRecord(migration.runId, passed ? "verified" : "verification_failed", {
    testResult,
    currentFile: migration.files[0]?.path,
    verifiedAt: new Date().toISOString(),
  });
  return {
    passed,
    requiresReview: migration.requiresReview,
    testResult,
  };
}

export function verificationPassed(
  testResult: TestResult,
  files: MigratedFile[],
): boolean {
  return (
    testResult.passed &&
    testResult.exitCode === 0 &&
    testResult.stage === "complete" &&
    files.every(file => file.status !== "failed")
  );
}

export async function humanReviewHandler(event: unknown): Promise<{
  reviewRequested: boolean;
}> {
  const root = record(event, "review task input");
  const migration = record(root.migration, "migration result") as unknown as MigrationStageOutput;
  if (typeof root.taskToken !== "string") {
    throw new TypeError("Step Functions task token was not provided.");
  }
  for (const file of migration.files.filter(
    item => item.status === "review_required",
  )) {
    await putPendingReview(migration.runId, file, root.taskToken);
    await putFileRecord(migration.runId, {
      ...file,
      status: "review_pending",
    });
  }
  await putRunRecord(migration.runId, "review_pending", {
    reviewCount: migration.files.filter(
      file => file.status === "review_required",
    ).length,
  });
  return { reviewRequested: true };
}

export async function applyApprovedSuggestionsHandler(event: unknown): Promise<MigrationStageOutput> {
  const root = record(event, "approved migration input");
  const migration = record(root.migration, "migration result") as unknown as MigrationStageOutput;
  const review = record(root.review, "review decision");
  const approvedFiles = Array.isArray(review.approvedFiles)
    ? new Set(
        review.approvedFiles.filter(
          (file): file is string => typeof file === "string",
        ),
      )
    : new Set<string>();
  const temporaryDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), `approved-migration-${migration.runId}-`),
  );
  const archiveFile = path.join(temporaryDirectory, "candidate.tar.gz");
  const workspace = path.join(temporaryDirectory, "workspace");
  try {
    await fs.mkdir(workspace, { recursive: true });
    await fs.writeFile(
      archiveFile,
      await getObject(migration.bucket, migration.candidateKey),
      { flag: "wx" },
    );
    await extractProjectArchive(archiveFile, workspace);

    for (const file of migration.files.filter(item =>
      approvedFiles.has(item.path),
    )) {
      const proposalBytes = await readOptionalObject(
        migration.bucket,
        artifactKey(
          migration.runId,
          `review-proposals/${file.outputPath}.json`,
        ),
      );
      if (!proposalBytes) {
        continue;
      }
      const proposal = JSON.parse(proposalBytes.toString("utf8")) as {
        proposedTypeScript?: unknown;
      };
      if (typeof proposal.proposedTypeScript !== "string") {
        throw new Error(`Bedrock proposal for ${file.path} is malformed.`);
      }
      const project = new Project({
        compilerOptions: {
          allowJs: false,
          target: ScriptTarget.ES2020,
          strict: true,
        },
      });
      const proposedFile = project.createSourceFile(
        `${randomUUID()}.ts`,
        proposal.proposedTypeScript,
      );
      if (project.getProgram().getSyntacticDiagnostics(proposedFile).length > 0) {
        throw new Error(
          `Approved Bedrock proposal for ${file.path} is invalid TypeScript syntax.`,
        );
      }
      const outputPath = safeArchivePath(workspace, file.outputPath);
      const sourcePath = safeArchivePath(workspace, file.path);
      const source = await fs.readFile(sourcePath, "utf8");
      await fs.writeFile(outputPath, proposal.proposedTypeScript, "utf8");
      await putObject(
        migration.bucket,
        artifactKey(
          migration.runId,
          `snapshots/after/files/${file.outputPath}`,
        ),
        proposal.proposedTypeScript,
        "text/typescript",
      );
      await putObject(
        migration.bucket,
        artifactKey(migration.runId, `diffs/${file.path}.patch`),
        createTwoFilesPatch(
          file.path,
          file.outputPath,
          source,
          proposal.proposedTypeScript,
        ),
        "text/plain",
      );
    }

    const updatedArchive = path.join(temporaryDirectory, "approved.tar.gz");
    await makeArchive(workspace, updatedArchive);
    await putObject(
      migration.bucket,
      migration.candidateKey,
      await fs.readFile(updatedArchive),
      "application/gzip",
    );
    return migration;
  } finally {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
}

export async function acceptFileHandler(event: unknown): Promise<{
  file: MigratedFile;
}> {
  const root = record(event, "verified per-file migration");
  const migration = record(root.migration, "migration result") as unknown as MigrationStageOutput;
  const verification = record(root.verification, "verification result");
  const review = root.review
    ? record(root.review, "human review result")
    : undefined;
  const file = migration.files[0];
  if (!file || verification.passed !== true) {
    throw new Error("A file cannot be accepted before successful verification.");
  }
  if (migration.requiresReview && review?.approved !== true) {
    throw new Error("A review-required file cannot be accepted without approval.");
  }
  if (!migration.previousCandidateKey) {
    throw new Error("The previous accepted project snapshot is missing.");
  }
  await acceptCandidateArchive(
    migration.runId,
    migration.previousCandidateKey,
    migration.candidateKey,
  );
  await putFileRecord(migration.runId, { ...file, status: "accepted" });
  await putRunRecord(migration.runId, "file_accepted", {
    currentFile: file.path,
    currentCandidateKey: migration.candidateKey,
    acceptedFiles: Number(root.acceptedFiles ?? 0) + 1,
  });
  return { file };
}

export async function rollbackFileHandler(
  event: unknown,
  dependencies: {
    restoreCandidateArchive: typeof restoreCandidateArchive;
    getFileRecord: typeof getFileRecord;
    putFileRecord: typeof putFileRecord;
    putRunRecord: typeof putRunRecord;
  } = {
    restoreCandidateArchive,
    getFileRecord,
    putFileRecord,
    putRunRecord,
  },
): Promise<{
  rolledBack: true;
  filePath: string;
  file: MigratedFile;
}> {
  const root = record(event, "per-file rollback input");
  const migration = root.migration
    ? (record(root.migration, "migration result") as unknown as MigrationStageOutput)
    : undefined;
  const filePath =
    migration?.files[0]?.path ??
    (typeof root.filePath === "string" ? root.filePath : undefined);
  if (!filePath || typeof root.runId !== "string") {
    throw new TypeError("Per-file rollback is missing the run or file path.");
  }
  await dependencies.restoreCandidateArchive(
    root.runId,
    migration?.previousCandidateKey,
    migration?.candidateKey,
  );
  const migrationFile = migration?.files[0];
  const existingFile = migrationFile
    ? undefined
    : await dependencies.getFileRecord(root.runId, filePath);
  const errorMessage =
    root.error && typeof root.error === "object" && "Cause" in root.error
      ? String(root.error.Cause).slice(0, 1000)
      : "Per-file migration or verification failed.";
  const file = migrationFile
    ? {
        ...migrationFile,
        status: "rolled_back" as const,
        errors: [...migrationFile.errors, errorMessage],
      }
    : existingFile &&
        typeof existingFile.filePath === "string" &&
        typeof existingFile.outputPath === "string"
      ? ({
          path: existingFile.filePath,
          outputPath: existingFile.outputPath,
          status: "rolled_back",
          transformations: Array.isArray(existingFile.transformations)
            ? existingFile.transformations.filter(
                (value): value is string => typeof value === "string",
              )
            : [],
          warnings: Array.isArray(existingFile.warnings)
            ? existingFile.warnings.filter(
                (value): value is string => typeof value === "string",
              )
            : [],
          errors: [
            ...(Array.isArray(existingFile.errors)
              ? existingFile.errors.filter(
                  (value): value is string => typeof value === "string",
                )
              : []),
            errorMessage,
          ],
          explanation:
            typeof existingFile.explanation === "string"
              ? existingFile.explanation
              : undefined,
        } satisfies MigratedFile)
      : undefined;
  if (!file) {
    throw new Error(`Could not load file record for rollback: ${filePath}.`);
  }
  await dependencies.putFileRecord(root.runId, file);
  await dependencies.putRunRecord(root.runId, "file_rolled_back", {
    currentFile: filePath,
    rollbackReason: errorMessage,
  });
  return { rolledBack: true, filePath, file };
}

export async function finalizeMigrationHandler(
  event: unknown,
): Promise<MigrationStageOutput> {
  const root = record(event, "migration finalization input");
  const input = workflowInput(root);
  if (!Array.isArray(root.fileResults) || root.fileResults.length === 0) {
    throw new TypeError("Successful per-file results are required to finalize.");
  }
  const files = root.fileResults.map((item, index) => {
    const result = record(item, `file result ${index + 1}`);
    const file = record(result.file, `file result ${index + 1} payload`);
    if (
      typeof file.path !== "string" ||
      typeof file.outputPath !== "string" ||
      !Array.isArray(file.transformations) ||
      !Array.isArray(file.warnings) ||
      !Array.isArray(file.errors)
    ) {
      throw new TypeError(`File result ${index + 1} is malformed.`);
    }
    return file as unknown as MigratedFile;
  });
  const run = await getRunRecord(input.runId);
  if (typeof run?.currentCandidateKey !== "string") {
    throw new Error("No accepted project snapshot is available to finalize.");
  }
  const migrationReportKey = artifactKey(
    input.runId,
    "reports/migration-summary.json",
  );
  const migration: MigrationStageOutput = {
    ...input,
    candidateKey: run.currentCandidateKey,
    migrationReportKey,
    files,
    requiresReview: files.some(file => file.status === "review_required"),
    committedFiles: files.filter(file => file.commitSha).length,
  };
  await putObject(
    input.bucket,
    migrationReportKey,
    JSON.stringify(
      { runId: input.runId, generatedAt: new Date().toISOString(), files },
      null,
      2,
    ),
    "application/json",
  );
  const successfulFiles = files.filter(file => file.commitSha).length;
  const failedFiles = files.length - successfulFiles;
  await putRunRecord(
    input.runId,
    failedFiles > 0 ? "completed_with_failures" : "verified",
    {
      totalFiles: files.length,
      successfulFiles,
      failedFiles,
      candidateKey: migration.candidateKey,
      migrationReportKey,
    },
  );
  return migration;
}

export async function commitFileHandler(
  event: unknown,
  dependencies: {
    createCommit: typeof createMigrationFileCommit;
    getCommittedFile: typeof getFileRecord;
    saveFile: typeof putFileRecord;
    recordRun: typeof putRunRecord;
  } = {
    createCommit: createMigrationFileCommit,
    getCommittedFile: getFileRecord,
    saveFile: putFileRecord,
    recordRun: putRunRecord,
  },
): Promise<{ file: MigratedFile; commitSha: string; branch: string }> {
  const root = record(event, "verified per-file commit input");
  const migration = record(
    root.migration,
    "migration result",
  ) as unknown as MigrationStageOutput;
  const accepted = record(root.accepted, "accepted file result");
  const file = record(accepted.file, "accepted file") as unknown as MigratedFile;
  const verification = record(root.verification, "file verification");
  if (verification.passed !== true || file.status !== "accepted") {
    throw new Error(
      "A file cannot be committed before successful verification and acceptance.",
    );
  }
  const existing = await dependencies.getCommittedFile(
    migration.runId,
    file.path,
  );
  if (
    typeof existing?.commitSha === "string" &&
    typeof existing.commitBranch === "string"
  ) {
    return {
      file: {
        ...file,
        commitSha: existing.commitSha,
        commitBranch: existing.commitBranch,
      },
      commitSha: existing.commitSha,
      branch: existing.commitBranch,
    };
  }
  const commit = await dependencies.createCommit(migration, file);
  const committedFile: MigratedFile = {
    ...file,
    commitSha: commit.commitSha,
    commitBranch: commit.branch,
  };
  await dependencies.saveFile(migration.runId, committedFile);
  await dependencies.recordRun(migration.runId, "file_committed", {
    currentFile: file.path,
    currentCommitSha: commit.commitSha,
    migrationBranch: commit.branch,
  });
  return { file: committedFile, ...commit };
}

export async function commitHandler(event: unknown): Promise<{
  pullRequestNumber: number;
  pullRequestUrl: string;
  branch: string;
}> {
  const root = record(event, "workflow state");
  const migration = record(root.migration, "migration result") as unknown as MigrationStageOutput;
  const pullRequest = await createMigrationPullRequest(migration);
  const startedAt = Date.parse(
    typeof root.startedAt === "string" ? root.startedAt : "",
  );
  const durationMs = Number.isFinite(startedAt)
    ? Date.now() - startedAt
    : 0;
  const successfulFiles = migration.files.filter(
    file => Boolean(file.commitSha),
  ).length;
  const failedFiles = migration.files.length - successfulFiles;
  await publishRunMetrics({
    totalFiles: migration.files.length,
    successfulFiles,
    failedFiles,
    reviewFiles: migration.files.filter(
      file => file.status === "review_required",
    ).length,
    durationMs,
  });
  await putRunRecord(
    migration.runId,
    failedFiles > 0 ? "completed_with_failures" : "committed",
    {
      pullRequestNumber: pullRequest.number,
      pullRequestUrl: pullRequest.url,
      branch: pullRequest.branch,
      completedAt: new Date().toISOString(),
      successfulFiles,
      failedFiles,
      successRate:
        migration.files.length > 0
          ? Math.round((successfulFiles / migration.files.length) * 10000) / 100
          : 0,
    },
  );
  return {
    pullRequestNumber: pullRequest.number,
    pullRequestUrl: pullRequest.url,
    branch: pullRequest.branch,
  };
}

export async function rollbackHandler(event: unknown): Promise<{
  status: "rolled_back";
}> {
  const root = record(event, "rollback input");
  const migration = root.migration
    ? (record(root.migration, "migration result") as unknown as MigrationStageOutput)
    : workflowInput(root);
  const rollbackReason =
    typeof root.error === "object" &&
    root.error !== null &&
    "Cause" in root.error &&
    typeof root.error.Cause === "string"
      ? root.error.Cause.slice(0, 1000)
      : "Migration workflow failed or was rejected.";

  const rollbackSummary = await markFileRecordsRolledBack(
    migration.runId,
    rollbackReason,
  );

  const files = "files" in migration && Array.isArray(migration.files)
    ? migration.files
    : [];
  const totalFiles = files.length || rollbackSummary.totalFiles;
  const startedAt = Date.parse(
    typeof root.startedAt === "string" ? root.startedAt : "",
  );
  await recordWorkflowFailure(
    {
      runId: migration.runId,
      rollbackReason,
      totalFiles,
      successfulFiles: rollbackSummary.successfulFiles,
      failedFiles: rollbackSummary.failedFiles,
      reviewFiles: rollbackSummary.reviewFiles,
      durationMs: Number.isFinite(startedAt) ? Date.now() - startedAt : 0,
    },
    { putRunRecord, publishRunMetrics },
  );
  return { status: "rolled_back" };
}

export async function markFileRecordsRolledBack(
  runId: string,
  rollbackReason: string,
  dependencies: {
    list: typeof listFileRecords;
    save: typeof putFileRecord;
  } = { list: listFileRecords, save: putFileRecord },
): Promise<{
  totalFiles: number;
  successfulFiles: number;
  failedFiles: number;
  reviewFiles: number;
}> {
  const items = await dependencies.list(runId);
  let reviewFiles = 0;
  let successfulFiles = 0;
  for (const item of items) {
    if (item.status === "accepted" && typeof item.commitSha === "string") {
      successfulFiles += 1;
      continue;
    }
    if (item.status === "review_required" || item.status === "review_pending") {
      reviewFiles += 1;
    }
    if (typeof item.filePath !== "string") {
      continue;
    }
    const outputPath =
      typeof item.outputPath === "string"
        ? item.outputPath
        : item.filePath.replace(/\.js$/i, ".ts");
    if (outputPath === item.filePath) {
      continue;
    }
    await dependencies.save(runId, {
      path: item.filePath,
      outputPath,
      status: "rolled_back",
      transformations: Array.isArray(item.transformations)
        ? item.transformations.filter(
            (value): value is string => typeof value === "string",
          )
        : [],
      warnings: Array.isArray(item.warnings)
        ? item.warnings.filter(
            (value): value is string => typeof value === "string",
          )
        : [],
      errors: [
        ...(Array.isArray(item.errors)
          ? item.errors.filter(
              (value): value is string => typeof value === "string",
            )
          : []),
        rollbackReason,
      ],
      explanation:
        typeof item.explanation === "string" ? item.explanation : undefined,
    });
  }
  return {
    totalFiles: items.length,
    successfulFiles,
    failedFiles: items.length - successfulFiles,
    reviewFiles,
  };
}

export async function recordWorkflowFailure(
  input: {
    runId: string;
    rollbackReason: string;
    totalFiles: number;
    successfulFiles: number;
    failedFiles: number;
    reviewFiles: number;
    durationMs: number;
  },
  dependencies: {
    putRunRecord: typeof putRunRecord;
    publishRunMetrics: typeof publishRunMetrics;
  } = { putRunRecord, publishRunMetrics },
): Promise<void> {
  const fields = {
    rollbackReason: input.rollbackReason,
    rolledBackAt: new Date().toISOString(),
    totalFiles: input.totalFiles,
    successfulFiles: input.successfulFiles,
    failedFiles: input.failedFiles,
    successRate:
      input.totalFiles > 0
        ? Math.round((input.successfulFiles / input.totalFiles) * 10000) / 100
        : 0,
  };
  await dependencies.putRunRecord(input.runId, "rolled_back", fields);
  try {
    await dependencies.publishRunMetrics({
      totalFiles: input.totalFiles,
      successfulFiles: input.successfulFiles,
      failedFiles: input.failedFiles,
      reviewFiles: input.reviewFiles,
      durationMs: input.durationMs,
    });
  } catch (error) {
    await dependencies.putRunRecord(input.runId, "rolled_back", {
      metricsError:
        error instanceof Error ? error.message.slice(0, 1000) : String(error),
    });
    throw error;
  }
}

export async function resolveReview(
  input: {
    runId: string;
    filePath: string;
    decision: "approved" | "rejected";
  },
): Promise<void> {
  const review = await getReview(input.runId, input.filePath);
  if (!review || typeof review.taskToken !== "string") {
    throw new Error("Pending review or Step Functions task token was not found.");
  }
  await setReviewDecision(input.runId, input.filePath, input.decision);

  const response = await dynamo.send(
    new QueryCommand({
      TableName: migrationTableName(),
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :review)",
      ExpressionAttributeValues: {
        ":pk": `RUN#${input.runId}`,
        ":review": "REVIEW#",
      },
      ConsistentRead: true,
    }),
  );
  const reviews = response.Items ?? [];
  const allResolved = reviews.every(
    item => item.status === "approved" || item.status === "rejected",
  );
  if (!allResolved) {
    return;
  }
  const approvedFiles = reviews
    .filter(item => item.status === "approved")
    .map(item => item.filePath)
    .filter((filePath): filePath is string => typeof filePath === "string");
  const rejected = reviews.some(item => item.status === "rejected");
  if (rejected) {
    await stepFunctions.send(
      new SendTaskFailureCommand({
        taskToken: review.taskToken,
        error: "HumanReviewRejected",
        cause: "A reviewer rejected one or more files.",
      }),
    );
  } else {
    await stepFunctions.send(
      new SendTaskSuccessCommand({
        taskToken: review.taskToken,
        output: JSON.stringify({ approved: true, approvedFiles }),
      }),
    );
  }
}

export function newRunId(): string {
  return randomUUID();
}

export function validateTestResult(value: unknown): TestResult {
  const result = record(value, "Fargate test result");
  if (
    typeof result.passed !== "boolean" ||
    typeof result.exitCode !== "number" ||
    typeof result.command !== "string" ||
    !["install", "build", "test", "prepare", "complete"].includes(
      String(result.stage),
    ) ||
    typeof result.durationMs !== "number" ||
    typeof result.output !== "string"
  ) {
    throw new TypeError("Fargate test result has an invalid shape.");
  }
  return result as unknown as TestResult;
}

export function validateArchiveEntry(root: string, archivePath: string): string {
  return safeArchivePath(root, archivePath);
}

export async function listRunArtifacts(
  bucket: string,
  runId: string,
): Promise<string[]> {
  return listObjects(bucket, `runs/${runId}/`);
}

export async function runLocalTestCommand(
  workspace: string,
): Promise<{ command: string; exitCode: number; output: string }> {
  const packagePath = path.join(workspace, "package.json");
  const packageJson = JSON.parse(await fs.readFile(packagePath, "utf8")) as {
    scripts?: Record<string, unknown>;
  };
  if (typeof packageJson.scripts?.test !== "string") {
    throw new Error("Project package.json does not define a test script.");
  }
  const command = "npm test";
  try {
    const result = await execFileAsync("npm", ["test"], {
      cwd: workspace,
      timeout: 10 * 60 * 1000,
      maxBuffer: 2 * 1024 * 1024,
      env: {
        ...process.env,
        npm_config_offline: "true",
        npm_config_audit: "false",
        npm_config_fund: "false",
      },
    });
    return {
      command,
      exitCode: 0,
      output: `${result.stdout}\n${result.stderr}`.slice(-50_000),
    };
  } catch (error) {
    const failure = error as Error & {
      code?: number;
      stdout?: string;
      stderr?: string;
    };
    return {
      command,
      exitCode: typeof failure.code === "number" ? failure.code : 1,
      output: `${failure.stdout ?? ""}\n${failure.stderr ?? ""}\n${failure.message}`.slice(-50_000),
    };
  }
}
