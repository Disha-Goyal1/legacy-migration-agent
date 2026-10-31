import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { migrateFile, type MigrationReport } from "./migrate";

const MAX_REQUEST_BYTES = 1_000_000;

interface DashboardSummary {
  totalFiles: number;
  successful: number;
  failures: number;
  review: number;
  files: string[];
}

interface DashboardMigrationResult {
  output: string | null;
  report: MigrationReport;
}

function sendJson(
  response: ServerResponse,
  statusCode: number,
  value: unknown,
): void {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(value));
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let byteLength = 0;
    let tooLarge = false;

    request.on("data", (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      byteLength += buffer.length;
      if (byteLength > MAX_REQUEST_BYTES) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      if (!tooLarge) {
        chunks.push(buffer);
      }
    });

    request.on("end", () => {
      if (tooLarge) {
        reject(new Error("Request body exceeds the 1 MB limit."));
        return;
      }
      resolve(Buffer.concat(chunks).toString("utf8"));
    });

    request.on("error", reject);
  });
}

async function loadSummary(rootDirectory: string): Promise<DashboardSummary> {
  const legacyDirectory = path.join(rootDirectory, "fixtures", "legacy");
  const reportPath = path.join(
    rootDirectory,
    "fixtures",
    "migrated",
    "migration-report.json",
  );
  const files = (await fs.readdir(legacyDirectory))
    .filter(file => file.endsWith(".js"))
    .sort();
  let reports: MigrationReport[] = [];

  try {
    const reportCollection = JSON.parse(await fs.readFile(reportPath, "utf8")) as {
      fixtures?: MigrationReport[];
    };
    reports = reportCollection.fixtures ?? [];
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      error.code !== "ENOENT"
    ) {
      throw error;
    }
  }

  const reportBySource = new Map(
    reports.map(report => [path.basename(report.sourceFile), report]),
  );
  const currentReports = files
    .map(file => reportBySource.get(file))
    .filter((report): report is MigrationReport => report !== undefined);

  return {
    totalFiles: files.length,
    successful: currentReports.filter(report => report.status === "completed").length,
    failures: currentReports.filter(report => report.status === "failed").length,
    review: currentReports.filter(report => report.status === "review_required").length,
    files,
  };
}

async function migrateUploadedSource(
  rootDirectory: string,
  body: string,
): Promise<DashboardMigrationResult> {
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    throw new TypeError("Request body must be valid JSON.");
  }

  if (
    typeof payload !== "object" ||
    payload === null ||
    !("filename" in payload) ||
    !("source" in payload) ||
    typeof payload.filename !== "string" ||
    typeof payload.source !== "string"
  ) {
    throw new TypeError("Provide a JavaScript filename and source text.");
  }

  const requestedName = path.basename(payload.filename);
  if (!requestedName.toLowerCase().endsWith(".js")) {
    throw new TypeError("Only .js source files can be migrated.");
  }

  const filename = requestedName.replace(/[^A-Za-z0-9._-]/g, "_");
  const temporaryDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), "legacy-migration-dashboard-"),
  );
  const inputFile = path.join(temporaryDirectory, "input.js");
  const outputFile = path.join(temporaryDirectory, "output.ts");
  const reportFile = path.join(temporaryDirectory, "report.json");

  try {
    await fs.writeFile(inputFile, payload.source, {
      encoding: "utf8",
      flag: "wx",
    });

    const report = await migrateFile({
      inputFile,
      outputFile,
      projectRoot: temporaryDirectory,
      reportFile,
    });
    const output =
      report.status === "failed"
        ? null
        : await fs.readFile(outputFile, "utf8");
    const outputName = `${path.basename(filename, ".js")}.ts`;

    return {
      output,
      report: {
        ...report,
        sourceFile: filename,
        outputFile: outputName,
      },
    };
  } finally {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
}

export function createMigrationServer(
  rootDirectory = path.resolve(__dirname, ".."),
): Server {
  return createServer((request, response) => {
    void (async () => {
      const requestUrl = new URL(
        request.url ?? "/",
        "http://127.0.0.1",
      );

      if (request.method === "GET" && requestUrl.pathname === "/api/summary") {
        sendJson(response, 200, await loadSummary(rootDirectory));
        return;
      }

      if (request.method === "GET" && requestUrl.pathname === "/api/source") {
        const requestedName = requestUrl.searchParams.get("name");
        if (!requestedName || path.basename(requestedName) !== requestedName) {
          sendJson(response, 400, { error: "Select a valid JavaScript fixture." });
          return;
        }

        const legacyDirectory = path.join(rootDirectory, "fixtures", "legacy");
        const availableFiles = await fs.readdir(legacyDirectory);
        if (!availableFiles.includes(requestedName) || !requestedName.endsWith(".js")) {
          sendJson(response, 404, { error: "The requested fixture was not found." });
          return;
        }

        sendJson(response, 200, {
          filename: requestedName,
          source: await fs.readFile(path.join(legacyDirectory, requestedName), "utf8"),
        });
        return;
      }

      if (request.method === "POST" && requestUrl.pathname === "/api/migrate") {
        const result = await migrateUploadedSource(
          rootDirectory,
          await readRequestBody(request),
        );
        sendJson(response, 200, result);
        return;
      }

      sendJson(response, 404, { error: "API route not found." });
    })().catch(error => {
      const statusCode =
        error instanceof TypeError
          ? 400
          : error instanceof Error &&
              error.message === "Request body exceeds the 1 MB limit."
            ? 413
            : 500;
      sendJson(response, statusCode, {
        error: error instanceof Error ? error.message : "Unexpected local server error.",
      });
    });
  });
}

export function startMigrationServer(
  port = Number(process.env.PORT ?? 4179),
  host = "127.0.0.1",
  workspaceRoot = path.resolve(__dirname, ".."),
): Server {
  const server = createMigrationServer(workspaceRoot);
  server.listen(port, host, () => {
    console.log(`Legacy migration API listening at http://${host}:${port}`);
  });
  return server;
}
