import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { migrateFile, type MigrationReport } from "./migrate";
import { createMigrationServer } from "./server";

const projectRoot = path.resolve(__dirname, "..");
const legacyDirectory = path.join(projectRoot, "fixtures", "legacy");
const originalCalculator = `
function add(a, b) {
  return a + b;
}

function greet(name) {
  return "Hello, " + name;
}

module.exports = { add, greet };
`;

async function withTemporaryOutput<T>(
  callback: (directory: string) => Promise<T>,
): Promise<T> {
  const directory = await fs.mkdtemp(
    path.join(projectRoot, ".migration-test-"),
  );

  try {
    return await callback(directory);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

test("migrates functions and executes their TypeScript output", async () => {
  await withTemporaryOutput(async directory => {
    const outputFile = path.join(directory, "calculator.ts");
    const report = await migrateFile({
      inputFile: path.join(legacyDirectory, "calculator.js"),
      outputFile,
      projectRoot,
    });

    assert.notEqual(report.status, "failed");
    const generated = await fs.readFile(outputFile, "utf8");
    const persistedReport = JSON.parse(
      await fs.readFile(path.join(directory, "migration-report.json"), "utf8"),
    );
    assert.match(generated, /function add\(a: any, b: any\)/);
    assert.match(generated, /export \{ add, greet \};/);
    assert.equal(persistedReport.sourceFile, "fixtures/legacy/calculator.js");
    assert.equal(
      persistedReport.outputFile,
      path.relative(projectRoot, outputFile).split(path.sep).join("/"),
    );
    assert.ok(!persistedReport.sourceFile.includes(projectRoot));
    assert.ok(!persistedReport.outputFile.includes(projectRoot));
    assert.ok(Array.isArray(persistedReport.transformations));
    assert.ok(Array.isArray(persistedReport.warnings));
    assert.deepEqual(persistedReport.errors, []);
    assert.equal(persistedReport.status, "review_required");
    assert.equal(persistedReport.warnings.length, 6);
    assert.ok(
      persistedReport.warnings.some((warning: string) =>
        warning.includes('Parameter "a" has no reliable type evidence'),
      ),
    );
    assert.ok(
      persistedReport.warnings.some((warning: string) =>
        warning.includes('Function "add" has an uncertain any return type'),
      ),
    );
    assert.ok(
      persistedReport.warnings.some((warning: string) =>
        warning.includes("Converting CommonJS to ES module exports"),
      ),
    );
    assert.ok(
      persistedReport.warnings.some((warning: string) =>
        warning.includes("numeric addition or string concatenation"),
      ),
    );

    const calculator = await import(pathToFileURL(outputFile).href);
    assert.equal(calculator.add(2, 3), 5);
    assert.equal(calculator.greet("Disha"), "Hello, Disha");
  });
});

test("infers types from consistent literal arguments at all visible local calls", async () => {
  await withTemporaryOutput(async directory => {
    const inputFile = path.join(directory, "local-calls.js");
    const outputFile = path.join(directory, "local-calls.ts");
    await fs.writeFile(
      inputFile,
      `function calculateTotal(first, second) {
  return first + second;
}

const total = calculateTotal(2, 3);
`,
      "utf8",
    );

    const report = await migrateFile({ inputFile, outputFile, projectRoot });
    const generated = await fs.readFile(outputFile, "utf8");

    assert.equal(report.status, "completed");
    assert.match(
      generated,
      /function calculateTotal\(first: number, second: number\): number/,
    );
    assert.ok(
      report.transformations.some(item =>
        item.includes('parameter "first" as number'),
      ),
    );
    assert.deepEqual(report.warnings, []);
  });
});

test("infers object and array values and transforms generic CommonJS exports", async () => {
  await withTemporaryOutput(async directory => {
    const outputFile = path.join(directory, "data.ts");
    const report = await migrateFile({
      inputFile: path.join(legacyDirectory, "data.js"),
      outputFile,
      projectRoot,
    });
    const generated = await fs.readFile(outputFile, "utf8");

    assert.equal(report.status, "review_required");
    assert.match(generated, /const profile = \{ name: "Disha", active: true \}/);
    assert.match(generated, /const scores = \[2, 3, 5\]/);
    assert.match(generated, /export \{ profile, scores, summarize \};/);
    assert.ok(
      report.transformations.some(item =>
        item.includes("Converted a top-level module.exports"),
      ),
    );
    assert.ok(
      report.warnings.some(item => item.includes("interoperability")),
    );
  });
});

test("flags ambiguous parameter and addition types for human review", async () => {
  await withTemporaryOutput(async directory => {
    const outputFile = path.join(directory, "ambiguous.ts");
    const report = await migrateFile({
      inputFile: path.join(legacyDirectory, "ambiguous.js"),
      outputFile,
      projectRoot,
    });
    const generated = await fs.readFile(outputFile, "utf8");

    assert.equal(report.status, "review_required");
    assert.match(generated, /function combine\(left: any, right: any\)/);
    assert.ok(
      report.warnings.some(item => item.includes("no reliable type evidence")),
    );
    assert.ok(
      report.warnings.some(item => item.includes("numeric addition or string concatenation")),
    );
  });
});

test("reports invalid source and preserves an existing output", async () => {
  await withTemporaryOutput(async directory => {
    const outputFile = path.join(directory, "invalid.ts");
    const reportFile = path.join(directory, "report.json");
    const existingOutput = "keep this output unchanged\n";
    await fs.writeFile(outputFile, existingOutput, "utf8");

    const report = await migrateFile({
      inputFile: path.join(legacyDirectory, "invalid.js"),
      outputFile,
      projectRoot,
      reportFile,
    });

    assert.equal(report.status, "failed");
    assert.ok(report.errors.length > 0);
    assert.equal(await fs.readFile(outputFile, "utf8"), existingOutput);
    const persistedReport = JSON.parse(await fs.readFile(reportFile, "utf8"));
    assert.equal(persistedReport.status, "failed");
    assert.ok(persistedReport.errors.length > 0);
  });
});

test("persisted migration report covers every fixture with complete results", async () => {
  const reportPath = path.join(
    projectRoot,
    "fixtures",
    "migrated",
    "migration-report.json",
  );
  const collection = JSON.parse(await fs.readFile(reportPath, "utf8"));
  const reports = collection.fixtures as Array<{
    sourceFile: string;
    outputFile: string;
    transformations: string[];
    warnings: string[];
    errors: string[];
    status: string;
  }>;
  const reportsBySource = new Map(
    reports.map(report => [path.basename(report.sourceFile), report]),
  );

  assert.deepEqual(
    [...reportsBySource.keys()].sort(),
    ["ambiguous.js", "calculator.js", "data.js", "invalid.js"],
  );

  for (const fixture of ["calculator.js", "data.js", "ambiguous.js"]) {
    const report = reportsBySource.get(fixture);
    assert.ok(report, `missing report for ${fixture}`);
    assert.equal(report.status, "review_required");
    assert.ok(report.outputFile.endsWith(`${path.basename(fixture, ".js")}.ts`));
    assert.ok(report.transformations.length > 0);
    assert.ok(report.warnings.length > 0);
    assert.deepEqual(report.errors, []);
    assert.ok(
      await fs.stat(
        path.join(
          projectRoot,
          "fixtures",
          "migrated",
          `${path.basename(fixture, ".js")}.ts`,
        ),
      ),
    );
  }

  const invalidReport = reportsBySource.get("invalid.js");
  assert.ok(invalidReport, "missing report for invalid.js");
  assert.equal(invalidReport.status, "failed");
  assert.ok(invalidReport.errors.length > 0);
  assert.deepEqual(invalidReport.warnings, []);
  await assert.rejects(
    fs.stat(path.join(projectRoot, "fixtures", "migrated", "invalid.ts")),
    { code: "ENOENT" },
  );
});

test("flags every valid fixture for review where evidence is incomplete", async () => {
  await withTemporaryOutput(async directory => {
    for (const fixture of ["calculator.js", "data.js", "ambiguous.js"]) {
      const inputFile = path.join(legacyDirectory, fixture);
      const originalSource = await fs.readFile(inputFile, "utf8");
      const report = await migrateFile({
        inputFile,
        outputFile: path.join(directory, `${fixture}.ts`),
        projectRoot,
      });

      assert.notEqual(report.status, "failed", fixture);
      assert.ok(await fs.stat(path.join(directory, `${fixture}.ts`)));
      assert.equal(await fs.readFile(inputFile, "utf8"), originalSource);
      assert.ok(
        report.warnings.length > 0,
        `${fixture} should explain why review is required`,
      );
      assert.equal(report.status, "review_required");
    }

    const invalidOutput = path.join(directory, "invalid.js.ts");
    const invalidInput = path.join(legacyDirectory, "invalid.js");
    const originalInvalidSource = await fs.readFile(invalidInput, "utf8");
    const invalidReport = await migrateFile({
      inputFile: invalidInput,
      outputFile: invalidOutput,
      projectRoot,
    });

    assert.equal(invalidReport.status, "failed");
    assert.ok(invalidReport.errors.length > 0);
    assert.equal(await fs.readFile(invalidInput, "utf8"), originalInvalidSource);
    await assert.rejects(fs.stat(invalidOutput), { code: "ENOENT" });
  });
});

test("keeps report paths project-relative when invoked from another working directory", async () => {
  await withTemporaryOutput(async directory => {
    const outputFile = path.join(directory, "calculator.ts");
    const originalWorkingDirectory = process.cwd();

    try {
      process.chdir(os.tmpdir());
      const report = await migrateFile({
        inputFile: path.join(legacyDirectory, "calculator.js"),
        outputFile,
        projectRoot,
      });

      assert.equal(report.sourceFile, "fixtures/legacy/calculator.js");
      assert.equal(
        report.outputFile,
        path.relative(projectRoot, outputFile).split(path.sep).join("/"),
      );
      assert.ok(!report.sourceFile.startsWith("../"));
      assert.ok(!report.outputFile.startsWith("../"));
    } finally {
      process.chdir(originalWorkingDirectory);
    }
  });
});

test("rejects migration paths outside the configured project root", async () => {
  const outsideDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), "legacy-migration-outside-"),
  );
  const outsideInput = path.join(outsideDirectory, "input.js");
  const outsideOutput = path.join(outsideDirectory, "output.ts");
  const outsideReport = path.join(outsideDirectory, "report.json");

  try {
    await fs.writeFile(outsideInput, "const value = 1;\n", "utf8");
    await assert.rejects(
      migrateFile({
        inputFile: path.join(legacyDirectory, "calculator.js"),
        outputFile: outsideOutput,
        projectRoot,
      }),
      /must be inside project root/,
    );
    await assert.rejects(fs.stat(outsideOutput), { code: "ENOENT" });

    await withTemporaryOutput(async directory => {
      const outputFile = path.join(directory, "output.ts");
      await assert.rejects(
        migrateFile({
          inputFile: outsideInput,
          outputFile,
          projectRoot,
        }),
        /must be inside project root/,
      );
      await assert.rejects(
        migrateFile({
          inputFile: path.join(legacyDirectory, "calculator.js"),
          outputFile,
          projectRoot,
          reportFile: outsideReport,
        }),
        /must be inside project root/,
      );
      await assert.rejects(fs.stat(outputFile), { code: "ENOENT" });
      await assert.rejects(fs.stat(outsideReport), { code: "ENOENT" });
    });
  } finally {
    await fs.rm(outsideDirectory, { recursive: true, force: true });
  }
});

test("keeps the original calculator fixture unchanged", async () => {
  const source = await fs.readFile(
    path.join(legacyDirectory, "calculator.js"),
    "utf8",
  );
  assert.equal(source.replace(/\r\n/g, "\n"), originalCalculator);
});

test("local dashboard API runs the migration engine without executing source", async () => {
  const server = createMigrationServer(projectRoot);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const summaryResponse = await fetch(`${baseUrl}/api/summary`);
    assert.equal(summaryResponse.status, 200);
    const summary = await summaryResponse.json() as {
      totalFiles: number;
      files: string[];
    };
    assert.equal(summary.totalFiles, 4);
    assert.ok(summary.files.includes("calculator.js"));

    const sourceResponse = await fetch(
      `${baseUrl}/api/source?name=calculator.js`,
    );
    assert.equal(sourceResponse.status, 200);
    const fixture = await sourceResponse.json() as {
      filename: string;
      source: string;
    };
    assert.equal(fixture.filename, "calculator.js");
    assert.equal(fixture.source.replace(/\r\n/g, "\n"), originalCalculator);

    const migrationResponse = await fetch(`${baseUrl}/api/migrate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        filename: "uploaded.js",
        source: `function unsafe() {
  throw new Error("source was executed");
}
`,
      }),
    });
    assert.equal(migrationResponse.status, 200);
    const migration = await migrationResponse.json() as {
      output: string | null;
      report: MigrationReport;
    };
    assert.equal(migration.report.status, "completed");
    assert.equal(migration.report.sourceFile, "uploaded.js");
    assert.equal(migration.report.outputFile, "uploaded.ts");
    assert.ok(migration.output?.includes('throw new Error("source was executed")'));
    assert.ok(!JSON.stringify(migration).includes("legacy-migration-dashboard-"));

    const invalidNameResponse = await fetch(`${baseUrl}/api/migrate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ filename: "source.ts", source: "const x = 1;" }),
    });
    assert.equal(invalidNameResponse.status, 400);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
    });
  }
});
