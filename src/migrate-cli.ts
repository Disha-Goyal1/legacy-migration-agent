import fs from "node:fs/promises";
import path from "node:path";
import {
  migrateFile,
  writeMigrationReportCollection,
  type MigrationReport,
} from "./migrate";

const expectedNegativeFixtures = new Set(["invalid.js"]);

export function unexpectedMigrationFailures(
  reports: MigrationReport[],
): MigrationReport[] {
  return reports.filter(report => {
    const fixture = path.basename(report.sourceFile);
    if (expectedNegativeFixtures.has(fixture)) {
      return report.status !== "failed" || report.errors.length === 0;
    }
    return report.status === "failed";
  });
}

async function migrateFixtures(
  fixtures: string[],
  legacyDirectory: string,
  outputDirectory: string,
  reportDirectory: string,
  projectRoot: string,
): Promise<MigrationReport[]> {
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
  return reports;
}

async function main(): Promise<void> {
  const projectRoot = path.resolve(__dirname, "..");
  const legacyDirectory = path.join(projectRoot, "fixtures", "legacy");
  const outputDirectory = path.join(projectRoot, "fixtures", "migrated");
  const reportDirectory = path.join(outputDirectory, "reports");
  const fixtures = (await fs.readdir(legacyDirectory))
    .filter(file => file.endsWith(".js"))
    .sort();
  const normalFixtures = fixtures.filter(
    fixture => !expectedNegativeFixtures.has(fixture),
  );
  const negativeFixtures = fixtures.filter(fixture =>
    expectedNegativeFixtures.has(fixture),
  );
  console.log("Running successful migration fixtures.");
  const normalReports = await migrateFixtures(
    normalFixtures,
    legacyDirectory,
    outputDirectory,
    reportDirectory,
    projectRoot,
  );
  console.log("Running expected negative-fixture checks.");
  const negativeReports = await migrateFixtures(
    negativeFixtures,
    legacyDirectory,
    outputDirectory,
    reportDirectory,
    projectRoot,
  );
  const reports = [...normalReports, ...negativeReports];

  await writeMigrationReportCollection(
    path.join(outputDirectory, "migration-report.json"),
    { fixtures: reports },
  );
  console.log(
    `Migration report: ${path.join(outputDirectory, "migration-report.json")}`,
  );
  console.log(
    `Migration batch finished: ${normalReports.filter(report => report.status === "failed").length} unexpected normal fixture failure(s), ${negativeReports.filter(report => report.status === "failed").length} expected negative fixture failure(s).`,
  );
  const unexpectedFailures = unexpectedMigrationFailures(reports);
  if (unexpectedFailures.length > 0) {
    console.error(
      `Migration batch had ${unexpectedFailures.length} unexpected result(s): ${unexpectedFailures.map(report => path.basename(report.sourceFile)).join(", ")}.`,
    );
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error("Migration command failed:", error);
    process.exitCode = 1;
  });
}
