import assert from "node:assert/strict";
import test from "node:test";
import type { MigrationReport } from "./migrate";
import { unexpectedMigrationFailures } from "./migrate-cli";

function report(
  sourceFile: string,
  status: MigrationReport["status"],
  errors: string[] = [],
): MigrationReport {
  return {
    sourceFile: `fixtures/legacy/${sourceFile}`,
    outputFile: `fixtures/migrated/${sourceFile.replace(/\.js$/, ".ts")}`,
    transformations: [],
    warnings: [],
    errors,
    status,
  };
}

test("accepts the explicitly invalid fixture only when migration reports errors", () => {
  assert.deepEqual(
    unexpectedMigrationFailures([
      report("calculator.js", "review_required"),
      report("invalid.js", "failed", ["TS2304"]),
    ]),
    [],
  );
  assert.deepEqual(
    unexpectedMigrationFailures([report("invalid.js", "completed")]).map(
      item => item.sourceFile,
    ),
    ["fixtures/legacy/invalid.js"],
  );
});

test("keeps unexpected failures in normal fixtures fatal", () => {
  assert.deepEqual(
    unexpectedMigrationFailures([
      report("calculator.js", "failed", ["unexpected diagnostic"]),
      report("invalid.js", "failed", ["TS2304"]),
    ]).map(item => item.sourceFile),
    ["fixtures/legacy/calculator.js"],
  );
});
