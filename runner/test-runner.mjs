import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import * as tar from "tar";
import {
  assertSafeArchivePath,
  enforceArchiveEntryLimit,
} from "./archive-security.mjs";

const archiveUrl = process.env.INPUT_ARCHIVE_URL;
const resultUrl = process.env.RESULT_PUT_URL;
const runId = process.env.RUN_ID;
const maxArchiveBytes = 50 * 1024 * 1024;
const maxExpandedBytes = 1024 * 1024 * 1024;
const maxEntries = 20_000;

async function downloadArchive(destination) {
  const response = await fetch(archiveUrl, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) {
    throw new Error(`Could not download migration snapshot (${response.status}).`);
  }
  const data = Buffer.from(await response.arrayBuffer());
  if (data.length > maxArchiveBytes) {
    throw new Error("Migration snapshot exceeds the compressed-size limit.");
  }
  await fs.writeFile(destination, data, { flag: "wx" });
}

async function extractArchive(archivePath, workspace) {
  const limits = { expandedBytes: 0, entries: 0 };
  await tar.x({
    file: archivePath,
    cwd: workspace,
    strict: true,
    filter: (entryPath, entry) => {
      assertSafeArchivePath(workspace, entryPath);
      enforceArchiveEntryLimit(limits, entry, {
        maxEntries,
        maxExpandedBytes,
      });
      return true;
    },
  });
}

function runCommand(workspace, command, args, extraEnvironment = {}) {
  return new Promise(resolve => {
    const startedAt = Date.now();
    const child = spawn(command, args, {
      cwd: workspace,
      shell: process.platform === "win32",
      env: {
        ...process.env,
        npm_config_offline: "true",
        npm_config_audit: "false",
        npm_config_fund: "false",
        ...extraEnvironment,
        CI: "true",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const output = [];
    let bytes = 0;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, 10 * 60 * 1000);
    const append = chunk => {
      const value = chunk.toString("utf8");
      output.push(value);
      bytes += Buffer.byteLength(value);
      while (bytes > 50_000 && output.length > 1) {
        bytes -= Buffer.byteLength(output.shift());
      }
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.once("error", error => {
      clearTimeout(timer);
      resolve({
        passed: false,
        exitCode: 1,
        output: `${output.join("")}\n${error.message}`.slice(-50_000),
        durationMs: Date.now() - startedAt,
      });
    });
    child.once("close", code => {
      clearTimeout(timer);
      resolve({
        passed: code === 0 && !timedOut,
        exitCode: timedOut ? 124 : (code ?? 1),
        output: output.join("").slice(-50_000),
        durationMs: Date.now() - startedAt,
      });
    });
  });
}

export async function runTests(workspace) {
  const packageLock = path.join(workspace, "package-lock.json");
  const packagePath = path.join(workspace, "package.json");
  const npmCache = path.join(workspace, ".npm");
  let installPreparationError;
  try {
    const lock = JSON.parse(await fs.readFile(packageLock, "utf8"));
    if (
      typeof lock !== "object" ||
      lock === null ||
      Array.isArray(lock) ||
      !Number.isInteger(lock.lockfileVersion) ||
      lock.lockfileVersion < 1 ||
      lock.lockfileVersion > 3 ||
      (typeof lock.packages !== "object" &&
        typeof lock.dependencies !== "object")
    ) {
      throw new Error("package-lock.json has invalid or unsupported metadata.");
    }
    const cacheInfo = await fs.stat(npmCache);
    if (!cacheInfo.isDirectory()) {
      throw new Error("Prepared .npm cache is not a directory.");
    }
  } catch (error) {
    installPreparationError =
      error instanceof SyntaxError
        ? "package-lock.json is malformed JSON."
        : error instanceof Error && error.code === "ENOENT"
          ? "Prepared archive is missing package-lock.json or the .npm cache."
          : error instanceof Error
            ? error.message
            : "Could not validate the prepared npm cache and lockfile.";
  }
  if (installPreparationError) {
    return {
      passed: false,
      exitCode: 1,
      command: "npm ci --offline",
      stage: "install",
      durationMs: 0,
      output: installPreparationError,
    };
  }

  try {
    const install = await runCommand(
      workspace,
      "npm",
      ["ci", "--offline"],
      { npm_config_cache: npmCache },
    );
    if (install.exitCode !== 0) {
      return {
        ...install,
        passed: false,
        command: "npm ci --offline",
        stage: "install",
      };
    }
  } catch (error) {
    return {
      passed: false,
      exitCode: 1,
      command: "npm ci --offline",
      stage: "install",
      durationMs: 0,
      output: error instanceof Error ? error.message : "Offline npm installation failed.",
    };
  }

  let commands;
  try {
    const packageJson = JSON.parse(await fs.readFile(packagePath, "utf8"));
    commands = verificationCommands(packageJson);
  } catch (error) {
    return {
      passed: false,
      exitCode: 1,
      command: "validate-project-metadata",
      stage: "prepare",
      durationMs: 0,
      output: error instanceof Error ? error.message : "Could not validate project metadata.",
    };
  }
  const output = [];
  let totalDurationMs = 0;
  for (const [command, args] of commands) {
    const stage = args[1] === "build" ? "build" : "test";
    const result = await runCommand(workspace, command, args, {
      npm_config_cache: npmCache,
    });
    output.push(`$ ${command} ${args.join(" ")}\n${result.output}`);
    totalDurationMs += result.durationMs ?? 0;
    if (!result.passed) {
      return {
        ...result,
        output: output.join("\n").slice(-50_000),
        durationMs: totalDurationMs,
        command: commands.map(([name, values]) => `${name} ${values.join(" ")}`).join(" && "),
        stage,
      };
    }
  }
  return {
    passed: true,
    exitCode: 0,
    stage: "complete",
    output: output.join("\n").slice(-50_000),
    durationMs: totalDurationMs,
    command: commands.map(([name, values]) => `${name} ${values.join(" ")}`).join(" && "),
  };
}

export function verificationCommands(packageJson) {
  const scripts = packageJson?.scripts;
  if (typeof scripts?.build !== "string" || typeof scripts?.test !== "string") {
    throw new Error(
      "Target repository must define both build and test scripts for isolated verification.",
    );
  }
  return [
    ["npm", ["run", "build"]],
    ["npm", ["test"]],
  ];
}

async function uploadResult(result) {
  const response = await fetch(resultUrl, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(result),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(`Could not upload test result (${response.status}).`);
  }
}

async function main() {
  if (!archiveUrl || !resultUrl || !runId) {
    throw new Error("Missing required isolated-runner configuration.");
  }
  const temporaryDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), `migration-test-${runId}-`),
  );
  const workspace = path.join(temporaryDirectory, "workspace");
  const archivePath = path.join(temporaryDirectory, "project.tar.gz");
  const startedAt = Date.now();
  let result;
  try {
    await fs.mkdir(workspace);
    await downloadArchive(archivePath);
    await extractArchive(archivePath, workspace);
    const test = await runTests(workspace);
    result = {
      ...test,
      durationMs: Date.now() - startedAt,
      runId,
    };
  } catch (error) {
    result = {
      passed: false,
      exitCode: 1,
      command: "prepare-and-run-tests",
      stage: "prepare",
      durationMs: Date.now() - startedAt,
      output: error instanceof Error ? error.message : "Unknown test-runner error.",
      runId,
    };
  }

  try {
    await uploadResult(result);
  } finally {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
  if (!result.passed) {
    process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  main().catch(error => {
    console.error(
      "Isolated migration test runner failed:",
      error instanceof Error ? error.message : "Unknown error.",
    );
    process.exitCode = 1;
  });
}
