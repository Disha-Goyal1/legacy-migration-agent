import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as tar from "tar";
import {
  assertSafeArchivePath,
  enforceArchiveEntryLimit,
} from "../runner/archive-security.mjs";

const MAX_COMPRESSED_BYTES = 35 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 1024 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 20_000;
const NPM_REGISTRY = "https://registry.npmjs.org/";
const PREPARATION_TIMEOUT_MS = 15 * 60 * 1000;

interface PackageLock {
  lockfileVersion: number;
  packages?: Record<string, unknown>;
  dependencies?: Record<string, unknown>;
}

type Installer = (workspace: string) => Promise<void>;

async function validatePackageMetadata(
  workspace: string,
  value: unknown,
): Promise<PackageLock> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    throw new TypeError("Project package.json must contain a JSON object.");
  }
  const packageJson = value as Record<string, unknown>;
  const scripts =
    typeof packageJson.scripts === "object" &&
    packageJson.scripts !== null &&
    !Array.isArray(packageJson.scripts)
      ? packageJson.scripts as Record<string, unknown>
      : {};
  if (
    typeof scripts.build !== "string" ||
    typeof scripts.test !== "string"
  ) {
    throw new TypeError(
      "Project package.json must define both build and test scripts.",
    );
  }
  if (
    typeof packageJson.name !== "string" ||
    packageJson.name.length === 0 ||
    typeof packageJson.version !== "string"
  ) {
    throw new TypeError("Project package.json needs a name and version.");
  }

  const lockPath = path.join(workspace, "package-lock.json");
  let lock: unknown;
  try {
    lock = JSON.parse(await fs.readFile(lockPath, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new TypeError("Project package-lock.json is malformed JSON.");
    }
    throw new TypeError("Project archive must contain package-lock.json.");
  }
  if (
    typeof lock !== "object" ||
    lock === null ||
    Array.isArray(lock)
  ) {
    throw new TypeError("Project package-lock.json must contain a JSON object.");
  }
  const parsed = lock as Record<string, unknown>;
  if (
    !Number.isInteger(parsed.lockfileVersion) ||
    Number(parsed.lockfileVersion) < 1 ||
    Number(parsed.lockfileVersion) > 3
  ) {
    throw new TypeError("Project package-lock.json has an unsupported lockfileVersion.");
  }
  if (
    (parsed.packages !== undefined &&
      (typeof parsed.packages !== "object" ||
        parsed.packages === null ||
        Array.isArray(parsed.packages))) ||
    (parsed.dependencies !== undefined &&
      (typeof parsed.dependencies !== "object" ||
        parsed.dependencies === null ||
        Array.isArray(parsed.dependencies)))
  ) {
    throw new TypeError("Project package-lock.json has invalid dependency metadata.");
  }
  if (parsed.packages === undefined && parsed.dependencies === undefined) {
    throw new TypeError("Project package-lock.json does not contain dependency data.");
  }
  if (
    parsed.name !== undefined &&
    parsed.name !== packageJson.name ||
    parsed.version !== undefined &&
    parsed.version !== packageJson.version
  ) {
    throw new TypeError("Project package.json and package-lock.json metadata do not match.");
  }

  validateResolvedUrls(parsed);
  validateDirectDependencies(packageJson, parsed);
  return {
    ...parsed,
    lockfileVersion: Number(parsed.lockfileVersion),
  } as PackageLock;
}

function validateDirectDependencies(
  packageJson: Record<string, unknown>,
  lock: Record<string, unknown>,
): void {
  const rootPackage =
    typeof lock.packages === "object" &&
    lock.packages !== null &&
    !Array.isArray(lock.packages)
      ? (lock.packages as Record<string, unknown>)[""]
      : undefined;
  const lockedRoot =
    typeof rootPackage === "object" &&
    rootPackage !== null &&
    !Array.isArray(rootPackage)
      ? rootPackage as Record<string, unknown>
      : {};
  const lockedLegacy =
    typeof lock.dependencies === "object" &&
    lock.dependencies !== null &&
    !Array.isArray(lock.dependencies)
      ? lock.dependencies as Record<string, unknown>
      : {};

  for (const section of [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
  ]) {
    if (
      packageJson[section] !== undefined &&
      (typeof packageJson[section] !== "object" ||
        packageJson[section] === null ||
        Array.isArray(packageJson[section]))
    ) {
      throw new TypeError(`Project package.json has invalid ${section} metadata.`);
    }
    const declared =
      typeof packageJson[section] === "object" &&
      packageJson[section] !== null &&
      !Array.isArray(packageJson[section])
        ? packageJson[section] as Record<string, unknown>
        : {};
    const locked =
      typeof lockedRoot[section] === "object" &&
      lockedRoot[section] !== null &&
      !Array.isArray(lockedRoot[section])
        ? lockedRoot[section] as Record<string, unknown>
        : {};
    for (const name of Object.keys(declared)) {
      if (typeof declared[name] !== "string") {
        throw new TypeError(
          `Project package.json has an invalid version for dependency "${name}".`,
        );
      }
      if (!(name in locked) && !(name in lockedLegacy)) {
        throw new TypeError(
          `Project package-lock.json is missing declared dependency "${name}".`,
        );
      }
    }
  }
}

function validateResolvedUrls(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) validateResolvedUrls(item);
    return;
  }
  if (typeof value !== "object" || value === null) return;

  for (const [key, item] of Object.entries(value)) {
    if (key === "resolved" && typeof item === "string") {
      let url: URL;
      try {
        url = new URL(item);
      } catch {
        throw new TypeError("Lockfile contains a non-HTTPS dependency source.");
      }
      if (
        url.protocol !== "https:" ||
        url.hostname !== "registry.npmjs.org" ||
        url.username ||
        url.password
      ) {
        throw new TypeError(
          "Lockfile dependency sources must use https://registry.npmjs.org.",
        );
      }
    }
    validateResolvedUrls(item);
  }
}

export function dependencyPreparationDockerArgs(workspace: string): string[] {
  return [
    "run",
    "--rm",
    "--network=bridge",
    "--memory=2g",
    "--cpus=2",
    "--pids-limit=256",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--read-only",
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,size=64m",
    "--user=1000:1000",
    "--mount",
    `type=bind,source=${workspace},target=/workspace`,
    "--workdir=/workspace",
    "--env=npm_config_registry=https://registry.npmjs.org/",
    "--env=npm_config_cache=/workspace/.npm",
    "--env=npm_config_ignore_scripts=true",
    "--env=npm_config_audit=false",
    "--env=npm_config_fund=false",
    "node:24.11.1-bookworm-slim",
    "npm",
    "ci",
    "--ignore-scripts",
    "--prefer-online",
    "--no-audit",
    "--no-fund",
    `--registry=${NPM_REGISTRY}`,
  ];
}

function runDockerInstaller(workspace: string): Promise<void> {
  const args = dependencyPreparationDockerArgs(workspace);
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const output: string[] = [];
    let outputBytes = 0;
    let settled = false;
    const append = (chunk: Buffer) => {
      output.push(chunk.toString("utf8"));
      outputBytes += chunk.length;
      while (outputBytes > 20_000 && output.length > 1) {
        outputBytes -= Buffer.byteLength(output.shift() ?? "");
      }
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);

    const timer = setTimeout(() => {
      child.kill();
      finish(new Error("Local npm dependency preparation timed out."));
    }, PREPARATION_TIMEOUT_MS);
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        const details = output.join("").trim();
        reject(
          new Error(
            details
              ? `Local npm dependency preparation failed: ${details}`
              : error.message,
          ),
        );
      } else {
        resolve();
      }
    };
    child.once("error", error => {
      finish(
        new Error(
          `Could not start Docker for local dependency preparation: ${error.message}`,
        ),
      );
    });
    child.once("close", code => {
      if (code === 0) {
        finish();
      } else {
        finish(
          new Error(
            `Docker npm ci exited with code ${String(code)}.`,
          ),
        );
      }
    });
  });
}

async function prepareWorkspace(
  workspace: string,
  installer: Installer,
): Promise<void> {
  const packagePath = path.join(workspace, "package.json");
  let packageJson: unknown;
  try {
    packageJson = JSON.parse(await fs.readFile(packagePath, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new TypeError("Project package.json is malformed JSON.");
    }
    throw new TypeError("Project archive must contain package.json.");
  }
  await validatePackageMetadata(workspace, packageJson);

  await cleanWorkspace(workspace);
  await fs.mkdir(path.join(workspace, ".npm"), { recursive: true });
  await fs.chmod(path.join(workspace, ".npm"), 0o777);
  await fs.chmod(workspace, 0o777);
  await installer(workspace);
  const cacheInfo = await fs.stat(path.join(workspace, ".npm"));
  if (!cacheInfo.isDirectory()) {
    throw new Error("Local dependency preparation did not produce an npm cache.");
  }
}

async function cleanWorkspace(directory: string): Promise<void> {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (
      entry.name === "node_modules" ||
      entry.name === ".git" ||
      entry.name === ".npm" ||
      entry.name === ".npmrc"
    ) {
      await fs.rm(entryPath, { recursive: true, force: true });
    } else if (entry.isDirectory()) {
      await cleanWorkspace(entryPath);
    }
  }
}

export async function prepareDependencyArchive(
  archive: Buffer,
  installer: Installer = runDockerInstaller,
): Promise<Buffer> {
  if (
    archive.length < 2 ||
    archive.length > MAX_COMPRESSED_BYTES ||
    archive[0] !== 0x1f ||
    archive[1] !== 0x8b
  ) {
    throw new TypeError("Project archive must be a gzip tar file under 35 MB.");
  }

  const temporaryDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), "legacy-dependency-preparation-"),
  );
  const archivePath = path.join(temporaryDirectory, "source.tar.gz");
  const workspace = path.join(temporaryDirectory, "workspace");
  const outputPath = path.join(temporaryDirectory, "prepared.tar.gz");
  try {
    await fs.mkdir(workspace);
    await fs.writeFile(archivePath, archive, { flag: "wx" });
    const limits = { entries: 0, expandedBytes: 0 };
    await tar.x({
      file: archivePath,
      cwd: workspace,
      strict: true,
      filter: (entryPath, entry) => {
        assertSafeArchivePath(workspace, entryPath);
        enforceArchiveEntryLimit(limits, entry, {
          maxEntries: MAX_ARCHIVE_ENTRIES,
          maxExpandedBytes: MAX_EXPANDED_BYTES,
        });
        return true;
      },
    });

    await prepareWorkspace(workspace, installer);

    const state = { entries: 0, expandedBytes: 0 };
    const files = await listArchiveFiles(workspace, workspace, state);
    await tar.create(
      {
        cwd: workspace,
        file: outputPath,
        gzip: true,
        portable: true,
        strict: true,
      },
      files,
    );
    const preparedArchive = await fs.readFile(outputPath);
    if (preparedArchive.length > MAX_COMPRESSED_BYTES) {
      throw new Error(
        "Prepared project archive exceeds the 35 MB compressed-size limit.",
      );
    }
    return preparedArchive;
  } finally {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
}

async function listArchiveFiles(
  root: string,
  directory = root,
  state = { entries: 0, expandedBytes: 0 },
): Promise<string[]> {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    const absolutePath = path.join(directory, entry.name);
    const relativePath = path.relative(root, absolutePath);
    if (entry.isDirectory()) {
      state.entries += 1;
      if (state.entries > MAX_ARCHIVE_ENTRIES) {
        throw new Error("Prepared project exceeds archive extraction limits.");
      }
      files.push(relativePath.split(path.sep).join("/"));
      files.push(...(await listArchiveFiles(root, absolutePath, state)));
    } else if (entry.isFile()) {
      const fileStats = await fs.stat(absolutePath);
      state.entries += 1;
      state.expandedBytes += fileStats.size;
      if (
        state.entries > MAX_ARCHIVE_ENTRIES ||
        state.expandedBytes > MAX_EXPANDED_BYTES
      ) {
        throw new Error("Prepared project exceeds archive extraction limits.");
      }
      files.push(relativePath.split(path.sep).join("/"));
    } else {
      throw new Error(
        `Prepared project contains an unsupported filesystem entry: ${relativePath}`,
      );
    }
  }
  return files;
}

export const dependencyPreparationLimits = {
  maxCompressedBytes: MAX_COMPRESSED_BYTES,
  maxExpandedBytes: MAX_EXPANDED_BYTES,
  maxArchiveEntries: MAX_ARCHIVE_ENTRIES,
};
