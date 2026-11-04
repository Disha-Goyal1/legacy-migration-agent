import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import {
  artifactKey,
  getObject,
} from "./storage";
import type {
  MigratedFile,
  MigrationStageOutput,
  MigrationWorkflowInput,
} from "../contracts";

const secrets = new SecretsManagerClient({});

interface GitHubFile {
  path: string;
  mode: "100644";
  type: "blob";
  sha: string;
}

interface GitHubTreeResponse {
  sha: string;
}

interface GitHubRefResponse {
  object: { sha: string };
}

interface GitHubPullRequestResponse {
  html_url: string;
  number: number;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable ${name}.`);
  }
  return value;
}

async function getGitHubToken(): Promise<string> {
  const response = await secrets.send(
    new GetSecretValueCommand({
      SecretId: requiredEnvironment("GITHUB_TOKEN_SECRET_ARN"),
    }),
  );
  const value = response.SecretString;
  if (!value) {
    throw new Error("GitHub token secret is empty.");
  }
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as Record<string, unknown>).token === "string"
    ) {
      return (parsed as { token: string }).token;
    }
  } catch {
    return value;
  }
  return value;
}

async function githubRequest<T>(
  token: string,
  url: string,
  options: RequestInit = {},
): Promise<T> {
  const response = await fetch(url, {
    ...options,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "content-type": "application/json",
      ...options.headers,
    },
  });
  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(
      `GitHub API request failed (${response.status}): ${errorBody.slice(0, 1000)}`,
    );
  }
  return (await response.json()) as T;
}

function repositoryApi(input: MigrationWorkflowInput): string {
  return `https://api.github.com/repos/${encodeURIComponent(input.repository.owner)}/${encodeURIComponent(input.repository.name)}`;
}

function safeRepositoryPath(value: string): string {
  const normalized = value.replace(/\\/g, "/");
  if (
    normalized.startsWith("/") ||
    normalized.split("/").some(part => part === ".." || part === "")
  ) {
    throw new Error(`Unsafe path from migration output: ${value}`);
  }
  return normalized;
}

type GitHubRequest = <T>(
  token: string,
  url: string,
  options?: RequestInit,
) => Promise<T>;

export interface GitHubCommitDependencies {
  getToken: () => Promise<string>;
  request: GitHubRequest;
  getObject: typeof getObject;
}

const defaultCommitDependencies: GitHubCommitDependencies = {
  getToken: getGitHubToken,
  request: githubRequest,
  getObject,
};

function isGitHubStatus(error: unknown, status: number): boolean {
  return error instanceof Error && error.message.includes(`(${status})`);
}

export async function createMigrationFileCommit(
  input: MigrationStageOutput,
  file: MigratedFile,
  dependencies: GitHubCommitDependencies = defaultCommitDependencies,
): Promise<{ commitSha: string; branch: string }> {
  if (file.status !== "accepted") {
    throw new Error(`Cannot commit unaccepted migration file ${file.path}.`);
  }
  const token = await dependencies.getToken();
  const api = repositoryApi(input);
  const branch = `migration/${input.runId}`;
  const fileEntries: GitHubFile[] = [];
  for (const [key, filePath] of [
    [
      artifactKey(input.runId, `snapshots/after/files/${file.outputPath}`),
      safeRepositoryPath(file.outputPath),
    ],
    [
      artifactKey(input.runId, `reports/${file.path}.json`),
      `.migration-reports/${safeRepositoryPath(`${file.path}.json`)}`,
    ],
  ] as const) {
    const content = await dependencies.getObject(input.bucket, key);
    const blob = await dependencies.request<{ sha: string }>(
      token,
      `${api}/git/blobs`,
      {
        method: "POST",
        body: JSON.stringify({
          content: content.toString("base64"),
          encoding: "base64",
        }),
      },
    );
    fileEntries.push({ path: filePath, mode: "100644", type: "blob", sha: blob.sha });
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    let parentSha: string;
    let branchExists = true;
    try {
      const branchRef = await dependencies.request<GitHubRefResponse>(
        token,
        `${api}/git/ref/${encodeURI(`heads/${branch}`)}`,
      );
      parentSha = branchRef.object.sha;
    } catch (error) {
      if (!isGitHubStatus(error, 404)) {
        throw error;
      }
      const baseRef = await dependencies.request<GitHubRefResponse>(
        token,
        `${api}/git/ref/${encodeURI(`heads/${input.repository.baseBranch}`)}`,
      );
      parentSha = baseRef.object.sha;
      branchExists = false;
    }

    const parentCommit = await dependencies.request<{ tree: { sha: string } }>(
      token,
      `${api}/git/commits/${parentSha}`,
    );
    const tree = await dependencies.request<GitHubTreeResponse>(
      token,
      `${api}/git/trees`,
      {
        method: "POST",
        body: JSON.stringify({
          base_tree: parentCommit.tree.sha,
          tree: fileEntries,
        }),
      },
    );
    const commit = await dependencies.request<{ sha: string }>(
      token,
      `${api}/git/commits`,
      {
        method: "POST",
        body: JSON.stringify({
          message: `Migrate ${file.path} (${input.runId})`,
          tree: tree.sha,
          parents: [parentSha],
        }),
      },
    );

    try {
      if (branchExists) {
        await dependencies.request(
          token,
          `${api}/git/refs/${encodeURI(`heads/${branch}`)}`,
          {
            method: "PATCH",
            body: JSON.stringify({ sha: commit.sha, force: false }),
          },
        );
      } else {
        await dependencies.request(token, `${api}/git/refs`, {
          method: "POST",
          body: JSON.stringify({
            ref: `refs/heads/${branch}`,
            sha: commit.sha,
          }),
        });
      }
      return { commitSha: commit.sha, branch };
    } catch (error) {
      if (!isGitHubStatus(error, 422) || attempt === 2) {
        throw error;
      }
    }
  }
  throw new Error(`Could not safely advance migration branch ${branch}.`);
}

export async function createMigrationPullRequest(
  input: MigrationWorkflowInput,
): Promise<{ number: number; url: string; branch: string }> {
  const token = await getGitHubToken();
  const api = repositoryApi(input);
  const branch = `migration/${input.runId}`;
  await githubRequest<GitHubRefResponse>(
    token,
    `${api}/git/ref/${encodeURI(`heads/${branch}`)}`,
  );
  const existingPullRequests = await githubRequest<GitHubPullRequestResponse[]>(
    token,
    `${api}/pulls?${new URLSearchParams({
      head: `${input.repository.owner}:${branch}`,
      base: input.repository.baseBranch,
      state: "open",
    })}`,
  );
  const existingPullRequest = existingPullRequests[0];
  if (existingPullRequest) {
    return {
      number: existingPullRequest.number,
      url: existingPullRequest.html_url,
      branch,
    };
  }
  const pullRequest = await githubRequest<GitHubPullRequestResponse>(
    token,
    `${api}/pulls`,
    {
      method: "POST",
      body: JSON.stringify({
        title: `Legacy migration ${input.runId}`,
        head: branch,
        base: input.repository.baseBranch,
        body:
          "Automated migration pull request. Review generated files and migration reports before merging.",
      }),
    },
  );
  return { number: pullRequest.number, url: pullRequest.html_url, branch };
}

export async function closeMigrationPullRequest(input: {
  owner: string;
  name: string;
  branch: string;
  pullRequestNumber?: number;
}): Promise<void> {
  const token = await getGitHubToken();
  const api = `https://api.github.com/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.name)}`;
  const pullRequests = input.pullRequestNumber
    ? [{ number: input.pullRequestNumber }]
    : await githubRequest<Array<{ number: number }>>(
        token,
        `${api}/pulls?${new URLSearchParams({
          head: `${input.owner}:${input.branch}`,
          state: "open",
        })}`,
      );
  for (const pullRequest of pullRequests) {
    await githubRequest(
      token,
      `${api}/pulls/${pullRequest.number}`,
      { method: "PATCH", body: JSON.stringify({ state: "closed" }) },
    );
  }
  const response = await fetch(
    `${api}/git/refs/${encodeURI(`heads/${input.branch}`)}`,
    {
      method: "DELETE",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    },
  );
  if (!response.ok && response.status !== 404) {
    const body = await response.text();
    throw new Error(
      `Could not delete migration branch (${response.status}): ${body.slice(0, 1000)}`,
    );
  }
}
