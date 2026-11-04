import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertSafeArchivePath,
  enforceArchiveEntryLimit,
} from "./archive-security.mjs";
import { runTests, verificationCommands } from "./test-runner.mjs";

async function withTargetProject(scripts, callback) {
  const workspace = await fs.mkdtemp(
    path.join(os.tmpdir(), "migration-target-project-"),
  );
  try {
    await fs.mkdir(path.join(workspace, ".npm"));
    await fs.writeFile(
      path.join(workspace, "package.json"),
      JSON.stringify({ name: "migration-test-target", version: "1.0.0", scripts }),
    );
    await fs.writeFile(
      path.join(workspace, "package-lock.json"),
      JSON.stringify({
        name: "migration-test-target",
        version: "1.0.0",
        lockfileVersion: 3,
        requires: true,
        packages: {
          "": { name: "migration-test-target", version: "1.0.0" },
        },
      }),
    );
    return await callback(workspace);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
}

test("accepts contained archive paths", () => {
  const root = path.join(os.tmpdir(), "migration-runner");
  assert.equal(
    assertSafeArchivePath(root, "src/index.js"),
    path.join(root, "src", "index.js"),
  );
});

test("rejects absolute and traversing archive paths", () => {
  const root = path.join(os.tmpdir(), "migration-runner");
  for (const unsafePath of [
    "../outside.js",
    "src/../../outside.js",
    "/absolute/file.js",
    "C:\\outside.js",
  ]) {
    assert.throws(() => assertSafeArchivePath(root, unsafePath));
  }
});

test("enforces archive expansion limits and rejects links", () => {
  const state = { entries: 0, expandedBytes: 0 };
  enforceArchiveEntryLimit(state, { size: 12, type: "File" }, {
    maxEntries: 1,
    maxExpandedBytes: 12,
  });
  assert.equal(state.entries, 1);
  assert.equal(state.expandedBytes, 12);
  assert.throws(
    () =>
      enforceArchiveEntryLimit(state, { size: 1, type: "File" }, {
        maxEntries: 1,
      }),
    /extraction limits/,
  );
  assert.throws(
    () =>
      enforceArchiveEntryLimit(
        { entries: 0, expandedBytes: 0 },
        { size: 0, type: "SymbolicLink" },
      ),
    /may not contain links/,
  );
});

test("isolated verification runs the target build before its test suite", () => {
  assert.deepEqual(
    verificationCommands({
      scripts: { build: "tsc -p .", test: "node --test" },
    }),
    [
      ["npm", ["run", "build"]],
      ["npm", ["test"]],
    ],
  );
});

test("isolated verification rejects repositories without build or test scripts", () => {
  assert.throws(
    () => verificationCommands({ scripts: { test: "node --test" } }),
    /both build and test scripts/,
  );
});

test("reports a target build failure before running its tests", async () => {
  await withTargetProject(
    {
      build: "node -e \"process.exit(7)\"",
      test: "node -e \"process.exit(0)\"",
    },
    async workspace => {
      const result = await runTests(workspace);
      assert.equal(result.passed, false);
      assert.equal(result.stage, "build");
      assert.notEqual(result.exitCode, 0);
    },
  );
});

test("reports a target test failure after a successful build", async () => {
  await withTargetProject(
    {
      build: "node -e \"process.exit(0)\"",
      test: "node -e \"process.exit(9)\"",
    },
    async workspace => {
      const result = await runTests(workspace);
      assert.equal(result.passed, false);
      assert.equal(result.stage, "test");
      assert.notEqual(result.exitCode, 0);
      assert.match(result.output, /build/);
    },
  );
});

test("reports a transferred archive without its prepared cache as an install failure", async () => {
  await withTargetProject(
    {
      build: "node -e \"process.exit(0)\"",
      test: "node -e \"process.exit(0)\"",
    },
    async workspace => {
      await fs.rm(path.join(workspace, ".npm"), { recursive: true });
      const result = await runTests(workspace);
      assert.equal(result.passed, false);
      assert.equal(result.stage, "install");
      assert.equal(result.command, "npm ci --offline");
      assert.match(result.output, /missing package-lock\.json or the \.npm cache/);
    },
  );
});

test("reports malformed lockfile metadata as an install failure", async () => {
  await withTargetProject(
    {
      build: "node -e \"process.exit(0)\"",
      test: "node -e \"process.exit(0)\"",
    },
    async workspace => {
      await fs.writeFile(path.join(workspace, "package-lock.json"), "{bad json");
      const result = await runTests(workspace);
      assert.equal(result.passed, false);
      assert.equal(result.stage, "install");
      assert.match(result.output, /malformed JSON/);
    },
  );
});

test("reports a dependency missing from the lockfile as an install failure", async () => {
  await withTargetProject(
    {
      build: "node -e \"process.exit(0)\"",
      test: "node -e \"process.exit(0)\"",
    },
    async workspace => {
      const packagePath = path.join(workspace, "package.json");
      const packageJson = JSON.parse(await fs.readFile(packagePath, "utf8"));
      packageJson.dependencies = { "missing-package": "1.0.0" };
      await fs.writeFile(packagePath, JSON.stringify(packageJson));
      const result = await runTests(workspace);
      assert.equal(result.passed, false);
      assert.equal(result.stage, "install");
      assert.notEqual(result.exitCode, 0);
      assert.equal(result.command, "npm ci --offline");
    },
  );
});
