export type MigrationFileStatus =
  | "completed"
  | "review_required"
  | "failed"
  | "pending"
  | "migrating"
  | "testing"
  | "verified"
  | "accepted"
  | "review_pending"
  | "rolled_back";

export interface RepositoryInput {
  owner: string;
  name: string;
  baseBranch: string;
}

export interface MigrationWorkflowInput {
  runId: string;
  bucket: string;
  sourceKey: string;
  repository: RepositoryInput;
}

export interface MigrationPreparationOutput extends MigrationWorkflowInput {
  files: string[];
  initialCandidateKey: string;
}

export interface MigratedFile {
  path: string;
  outputPath: string;
  status: MigrationFileStatus;
  transformations: string[];
  errors: string[];
  warnings: string[];
  explanation?: string;
  commitSha?: string;
  commitBranch?: string;
}

export interface MigrationStageOutput extends MigrationWorkflowInput {
  candidateKey: string;
  previousCandidateKey?: string;
  migrationReportKey: string;
  files: MigratedFile[];
  requiresReview: boolean;
  committedFiles?: number;
}

export interface TestPlan extends MigrationStageOutput {
  resultKey: string;
  archiveUrl: string;
  resultUrl: string;
}

export interface TestResult {
  passed: boolean;
  exitCode: number;
  command: string;
  stage: "install" | "build" | "test" | "prepare" | "complete";
  durationMs: number;
  output: string;
}

export interface PendingReview {
  runId: string;
  path: string;
  status: "pending" | "approved" | "rejected";
  warnings: string[];
  explanation?: string;
  createdAt: string;
}

export interface QualitySnapshot {
  timestamp: string;
  totalFiles: number;
  successfulFiles: number;
  failedFiles: number;
  successRate: number;
}

export function isMigrationWorkflowInput(
  value: unknown,
): value is MigrationWorkflowInput {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  const repository = record.repository;
  return (
    typeof record.runId === "string" &&
    typeof record.bucket === "string" &&
    typeof record.sourceKey === "string" &&
    typeof repository === "object" &&
    repository !== null &&
    typeof (repository as Record<string, unknown>).owner === "string" &&
    typeof (repository as Record<string, unknown>).name === "string" &&
    typeof (repository as Record<string, unknown>).baseBranch === "string"
  );
}
