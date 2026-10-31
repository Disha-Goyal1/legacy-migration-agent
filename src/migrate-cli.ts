import fs from "node:fs/promises";
import path from "node:path";
import {
  migrateFile,
  writeMigrationReportCollection,
  type MigrationReport,
} from "./migrate";

async function main(): Promise<void> {
  const projectRoot = path.resolve(__dirname, "..");
  const legacyDirectory = path.join(projectRoot, "fixtures", "legacy");
  const outputDirectory = path.join(projectRoot, "fixtures", "migrated");
  const reportDirectory = path.join(outputDirectory, "reports");
  const fixtures = (await fs.readdir(legacyDirectory))
    .filter(file => file.endsWith(".js"))
    .sort();
  const reports: MigrationReport[] = [];

  for (const fixture of fixtures) {
    const baseName = path.basename(fixture, ".js");
    const report = await migrateFile({
      inputFile: path.join(legacyDirectory, fixture),
      outputFile: path.join(outputDirectory, `${baseName}.ts`),
      projectRoot,
      reportFile: path.join(reportDirectory, `${baseName}.json`),
    });
    reports.push(report);

    console.log(`${fixture}: ${report.status}`);
    if (report.warnings.length > 0) {
      console.warn(`  Warnings requiring review: ${report.warnings.length}`);
    }
    if (report.errors.length > 0) {
      console.error(`  Migration errors: ${report.errors.join("; ")}`);
    }
  }

  await writeMigrationReportCollection(
    path.join(outputDirectory, "migration-report.json"),
    { fixtures: reports },
  );
  console.log(
    `Migration report: ${path.join(outputDirectory, "migration-report.json")}`,
  );
  console.log(
    `Migration batch finished: ${reports.filter(report => report.status === "failed").length} fixture(s) failed; see report for details.`,
  );
}

main().catch(error => {
  console.error("Migration command failed:", error);
  process.exitCode = 1;
});
