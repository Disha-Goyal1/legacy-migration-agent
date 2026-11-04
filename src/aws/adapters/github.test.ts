import assert from "node:assert/strict";
import test from "node:test";
import {
  createMigrationFileCommit,
  type GitHubCommitDependencies,
} from "./github";
import type {
  MigratedFile,
  MigrationStageOutput,
} from "../contracts";

test("creates one linear, non-forced commit for each verified accepted file", async () => {
  const migration: MigrationStageOutput = {
    runId: "run-linear",
    bucket: "migration-bucket",
    sourceKey: "source.tar.gz",
    repository: { owner: "owner", name: "repo", baseBranch: "main" },
    candidateKey: "candidate.tar.gz",
    migrationReportKey: "report.json",
    files: [],
    requiresReview: false,
  };
  const operations: Array<{
    method: string;
    endpoint: string;
    body?: Record<string, unknown>;
  }> = [];
  let migrationHead: string | undefined;
  const dependencies: GitHubCommitDependencies = {
    getToken: async () => "test-token",
    getObject: async (_bucket, key) => Buffer.from(key),
    request: async <T>(
      _token: string,
      endpoint: string,
      options: RequestInit = {},
    ): Promise<T> => {
      const method = options.method ?? "GET";
      const body = options.body
        ? JSON.parse(String(options.body)) as Record<string, unknown>
        : undefined;
      operations.push({ method, endpoint, body });

      let response: unknown;
      if (endpoint.endsWith("/git/ref/heads/migration/run-linear")) {
        if (!migrationHead) {
          throw new Error("GitHub API request failed (404): missing ref");
        }
        response = { object: { sha: migrationHead } };
      } else if (endpoint.endsWith("/git/ref/heads/main")) {
        response = { object: { sha: "base-sha" } };
      } else if (endpoint.endsWith("/git/commits/base-sha")) {
        response = { tree: { sha: "base-tree" } };
      } else if (endpoint.endsWith("/git/commits/commit-1")) {
        response = { tree: { sha: "tree-1" } };
      } else if (endpoint.endsWith("/git/blobs")) {
        response = { sha: `blob-${operations.length}` };
      } else if (endpoint.endsWith("/git/trees")) {
        response = { sha: `tree-${migrationHead ? 2 : 1}` };
      } else if (endpoint.endsWith("/git/commits")) {
        const index = operations.filter(
          operation => operation.endpoint.endsWith("/git/commits"),
        ).length;
        const expectedParent = index === 1 ? "base-sha" : "commit-1";
        assert.deepEqual(body?.parents, [expectedParent]);
        response = { sha: `commit-${index}` };
      } else if (endpoint.endsWith("/git/refs")) {
        migrationHead = String(body?.sha);
        response = {};
      } else if (endpoint.endsWith("/git/refs/heads/migration/run-linear")) {
        assert.equal(body?.force, false);
        migrationHead = String(body?.sha);
        response = {};
      } else {
        throw new Error(`Unexpected mock GitHub request: ${method} ${endpoint}`);
      }
      return response as T;
    },
  };
  const file = (path: string): MigratedFile => ({
    path: `src/${path}.js`,
    outputPath: `src/${path}.ts`,
    status: "accepted",
    transformations: [],
    errors: [],
    warnings: [],
  });

  const first = await createMigrationFileCommit(
    migration,
    file("first"),
    dependencies,
  );
  const second = await createMigrationFileCommit(
    migration,
    file("second"),
    dependencies,
  );

  assert.equal(first.commitSha, "commit-1");
  assert.equal(second.commitSha, "commit-2");
  assert.equal(migrationHead, "commit-2");
  const commits = operations.filter(operation =>
    operation.endpoint.endsWith("/git/commits"),
  );
  assert.equal(commits.length, 2);
  const refUpdates = operations.filter(
    operation => operation.method === "PATCH",
  );
  assert.deepEqual(
    refUpdates.map(update => update.body?.force),
    [false],
    "existing migration branch is advanced only as a fast-forward",
  );
  const trees = operations
    .filter(operation => operation.endpoint.endsWith("/git/trees"))
    .map(operation => operation.body?.tree as Array<{ path: string }>);
  assert.deepEqual(
    trees.map(tree => tree.map(entry => entry.path)),
    [
      ["src/first.ts", ".migration-reports/src/first.js.json"],
      ["src/second.ts", ".migration-reports/src/second.js.json"],
    ],
    "each commit contains only that file's output and migration report",
  );
});

test("refuses to create a commit before verification and acceptance", async () => {
  let requestCount = 0;
  const file: MigratedFile = {
    path: "src/pending.js",
    outputPath: "src/pending.ts",
    status: "verified",
    transformations: [],
    errors: [],
    warnings: [],
  };
  const migration: MigrationStageOutput = {
    runId: "run-pending",
    bucket: "migration-bucket",
    sourceKey: "source.tar.gz",
    repository: { owner: "owner", name: "repo", baseBranch: "main" },
    candidateKey: "candidate.tar.gz",
    migrationReportKey: "report.json",
    files: [file],
    requiresReview: false,
  };
  await assert.rejects(
    createMigrationFileCommit(migration, file, {
      getToken: async () => "test-token",
      getObject: async () => Buffer.from(""),
      request: async <T>() => {
        requestCount += 1;
        return {} as T;
      },
    }),
    /Cannot commit unaccepted migration file/,
  );
  assert.equal(requestCount, 0);
});
