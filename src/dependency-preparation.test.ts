import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as tar from "tar";
import test from "node:test";
import {
  dependencyPreparationDockerArgs,
  prepareDependencyArchive,
} from "./dependency-preparation";
import { createMigrationServer } from "./server";

async function createProjectArchive(
  update: (directory: string) => Promise<void> = async () => {},
): Promise<{ directory: string; archive: Buffer }> {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "dependency-preparation-test-"),
  );
  await fs.mkdir(path.join(directory, "src"));
  await fs.mkdir(path.join(directory, "node_modules", "old"), {
    recursive: true,
  });
  await fs.mkdir(path.join(directory, ".npm"), { recursive: true });
  await fs.writeFile(
    path.join(directory, "package.json"),
    JSON.stringify({
      name: "dependency-preparation-fixture",
      version: "1.0.0",
      scripts: { build: "node build.js", test: "node test.js" },
    }),
  );
  await fs.writeFile(
    path.join(directory, "package-lock.json"),
    JSON.stringify({
      name: "dependency-preparation-fixture",
      version: "1.0.0",
      lockfileVersion: 3,
      requires: true,
      packages: {
        "": {
          name: "dependency-preparation-fixture",
          version: "1.0.0",
        },
      },
    }),
  );
  await fs.writeFile(path.join(directory, "src", "index.js"), "export {};\n");
  await fs.writeFile(
    path.join(directory, "node_modules", "old", "untrusted.js"),
    "throw new Error('must not be carried over');\n",
  );
  await fs.writeFile(path.join(directory, ".npm", "old-cache-entry"), "stale");
  await fs.writeFile(path.join(directory, ".npmrc"), "//registry.npmjs.org/:_authToken=secret");
  await update(directory);

  const archivePath = path.join(directory, "input.tar.gz");
  await tar.create(
    {
      cwd: directory,
      file: archivePath,
      gzip: true,
      portable: true,
    },
    ["package.json", "package-lock.json", "src", "node_modules", ".npm", ".npmrc"],
  );
  return { directory, archive: await fs.readFile(archivePath) };
}

test("prepares a clean repository cache without running project scripts", async () => {
  const project = await createProjectArchive();
  const preparedPath = path.join(project.directory, "prepared.tar.gz");
  const outputDirectory = path.join(project.directory, "output");
  try {
    let installerCalled = false;
    const prepared = await prepareDependencyArchive(
      project.archive,
      async workspace => {
        installerCalled = true;
        await assert.rejects(fs.stat(path.join(workspace, "node_modules")));
        await assert.rejects(fs.stat(path.join(workspace, ".npmrc")));
        await assert.rejects(
          fs.stat(path.join(workspace, ".npm", "old-cache-entry")),
        );
        await fs.mkdir(path.join(workspace, ".npm", "_cacache"), {
          recursive: true,
        });
        await fs.writeFile(
          path.join(workspace, ".npm", "_cacache", "prepared-entry"),
          "generated cache",
        );
      },
    );
    assert.equal(installerCalled, true);
    await fs.writeFile(preparedPath, prepared);
    await fs.mkdir(outputDirectory);
    await tar.x({ file: preparedPath, cwd: outputDirectory, strict: true });
    assert.equal(
      await fs.readFile(
        path.join(outputDirectory, ".npm", "_cacache", "prepared-entry"),
        "utf8",
      ),
      "generated cache",
    );
    assert.equal(
      await fs.readFile(
        path.join(outputDirectory, "src", "index.js"),
        "utf8",
      ),
      "export {};\n",
    );
    await assert.rejects(fs.stat(path.join(outputDirectory, "node_modules")));
    await assert.rejects(fs.stat(path.join(outputDirectory, ".npmrc")));
  } finally {
    await fs.rm(project.directory, { recursive: true, force: true });
  }
});

test("the Linux preparation command uses npm ci without lifecycle scripts", () => {
  const args = dependencyPreparationDockerArgs("C:\\workspace");
  assert.ok(args.includes("npm"));
  assert.ok(args.includes("ci"));
  assert.ok(args.includes("--ignore-scripts"));
  assert.ok(args.includes("--network=bridge"));
  assert.ok(args.includes("--cap-drop=ALL"));
  assert.ok(!args.includes("build"));
  assert.ok(!args.includes("test"));
  const npmIndex = args.indexOf("npm");
  assert.equal(args[npmIndex + 1], "ci");
});

test("rejects malformed lockfiles before starting the installer", async () => {
  const project = await createProjectArchive(async directory => {
    await fs.writeFile(path.join(directory, "package-lock.json"), "{not json");
  });
  try {
    let installerCalled = false;
    await assert.rejects(
      prepareDependencyArchive(project.archive, async () => {
        installerCalled = true;
      }),
      /package-lock.json is malformed JSON/,
    );
    assert.equal(installerCalled, false);
  } finally {
    await fs.rm(project.directory, { recursive: true, force: true });
  }
});

test("rejects declared dependencies missing from the lockfile", async () => {
  const project = await createProjectArchive(async directory => {
    const packagePath = path.join(directory, "package.json");
    const packageJson = JSON.parse(await fs.readFile(packagePath, "utf8"));
    packageJson.dependencies = { "missing-package": "1.0.0" };
    await fs.writeFile(packagePath, JSON.stringify(packageJson));
  });
  try {
    await assert.rejects(
      prepareDependencyArchive(project.archive, async () => {}),
      /missing declared dependency "missing-package"/,
    );
  } finally {
    await fs.rm(project.directory, { recursive: true, force: true });
  }
});

test("rejects a prepared archive that exceeds the compressed upload limit", async () => {
  const project = await createProjectArchive();
  try {
    await assert.rejects(
      prepareDependencyArchive(project.archive, async workspace => {
        await fs.writeFile(
          path.join(workspace, ".npm", "oversized-cache"),
          randomBytes(35 * 1024 * 1024 + 128 * 1024),
        );
      }),
      /exceeds the 35 MB compressed-size limit/,
    );
  } finally {
    await fs.rm(project.directory, { recursive: true, force: true });
  }
});

test("does not start a cloud run when local dependency preparation fails", async () => {
  const server = createMigrationServer(undefined, {
    cloudApiConfigured: () => true,
    prepareArchive: async () => {
      throw new Error("Docker npm ci failed.");
    },
    startCloudRun: async () => {
      throw new Error("Cloud run must not start.");
    },
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/cloud/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        archiveBase64: Buffer.from("source").toString("base64"),
        repository: {},
      }),
    });
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: "Docker npm ci failed." });
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
    });
  }
});

test("uploads the prepared archive to the cloud-run adapter", async () => {
  const preparedArchive = Buffer.from("prepared tarball");
  let receivedArchive: Buffer | undefined;
  const server = createMigrationServer(undefined, {
    cloudApiConfigured: () => true,
    prepareArchive: async archive => {
      assert.equal(archive.toString("utf8"), "original tarball");
      return preparedArchive;
    },
    startCloudRun: async input => {
      receivedArchive = Buffer.from(input.archiveBase64, "base64");
      return { runId: "local-test-run", executionArn: "local-test-execution" };
    },
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/cloud/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        archiveBase64: Buffer.from("original tarball").toString("base64"),
        repository: {},
      }),
    });
    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), {
      runId: "local-test-run",
      executionArn: "local-test-execution",
    });
    assert.deepEqual(receivedArchive, preparedArchive);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
    });
  }
});
