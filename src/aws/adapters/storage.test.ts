import assert from "node:assert/strict";
import test from "node:test";
import { putFileRecord } from "./storage";

test("persists outputPath with each DynamoDB file record", async () => {
  const previousTableName = process.env.MIGRATION_TABLE_NAME;
  process.env.MIGRATION_TABLE_NAME = "migration-test-table";
  let recordedItem: Record<string, unknown> | undefined;

  try {
    await putFileRecord(
      "run-storage-test",
      {
        path: "src/legacy.js",
        outputPath: "src/legacy.ts",
        status: "accepted",
        transformations: [],
        warnings: [],
        errors: [],
      },
      async command => {
        recordedItem = command.input.Item;
      },
    );
  } finally {
    if (previousTableName === undefined) {
      delete process.env.MIGRATION_TABLE_NAME;
    } else {
      process.env.MIGRATION_TABLE_NAME = previousTableName;
    }
  }

  assert.equal(recordedItem?.filePath, "src/legacy.js");
  assert.equal(recordedItem?.outputPath, "src/legacy.ts");
  assert.equal(recordedItem?.status, "accepted");
});
