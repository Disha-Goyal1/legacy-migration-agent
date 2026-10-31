import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { MigrationReport } from "./migrate";

const projectRoot = path.resolve(__dirname, "..");
const validFixtures = ["ambiguous", "calculator", "data"];
const minimumSuccessRate = 100;

interface FixtureResult {
  fixture: string;
  status: MigrationReport["status"];
  successful: boolean;
}

async function main(): Promise<void> {
  const results: FixtureResult[] = [];

  for (const fixture of validFixtures) {
    const reportPath = path.join(
      projectRoot,
      "fixtures",
      "migrated",
      "reports",
      `${fixture}.json`,
    );
    const report = JSON.parse(
      await fs.readFile(reportPath, "utf8"),
    ) as MigrationReport;
    const successful =
      (report.status === "completed" ||
        report.status === "review_required") &&
      report.errors.length === 0;

    results.push({ fixture: `${fixture}.js`, status: report.status, successful });
  }

  const successCount = results.filter(result => result.successful).length;
  const successRate = (successCount / results.length) * 100;
  const qualityReport = {
    generatedAt: new Date().toISOString(),
    commit: process.env.GITHUB_SHA ?? "local",
    workflowRun: process.env.GITHUB_RUN_ID ?? "local",
    successfulMigrations: successCount,
    totalValidFixtures: results.length,
    successRate,
    minimumSuccessRate,
    results,
  };
  const reportDirectory = process.env.RUNNER_TEMP ?? os.tmpdir();
  const reportPath = path.join(
    reportDirectory,
    "legacy-migration-success-rate.json",
  );
  await fs.writeFile(
    reportPath,
    `${JSON.stringify(qualityReport, null, 2)}\n`,
    "utf8",
  );

  const summary = [
    "## Migration success-rate quality gate",
    "",
    `**Success rate:** ${successCount}/${results.length} (${successRate.toFixed(1)}%)`,
    `**Required:** ${minimumSuccessRate.toFixed(1)}%`,
    "",
    "| Fixture | Result | Status |",
    "|---|---:|---|",
    ...results.map(
      result =>
        `| ${result.fixture} | ${result.successful ? "PASS" : "FAIL"} | ${result.status} |`,
    ),
    "",
  ].join("\n");
  console.log(summary);

  if (process.env.GITHUB_STEP_SUMMARY) {
    await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, summary, "utf8");
  }
  if (process.env.GITHUB_OUTPUT) {
    await fs.appendFile(
      process.env.GITHUB_OUTPUT,
      `report_path=${reportPath}\n`,
      "utf8",
    );
  }

  if (successRate < minimumSuccessRate) {
    throw new Error(
      `Migration success rate ${successRate.toFixed(1)}% is below the required ${minimumSuccessRate.toFixed(1)}%.`,
    );
  }
}

main().catch(error => {
  console.error("Migration success-rate quality gate failed:", error);
  process.exitCode = 1;
});
