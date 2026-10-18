import { normalizeIssue, parseAcceptanceCriteria } from "./issue-normalizer.js";
import type { NormalizedIssue } from "../schemas.js";

interface GitHubIssue {
  number: number;
  title: string;
  body: string | null;
  labels: Array<{ name?: string } | string>;
  pull_request?: unknown;
}

export async function loadGitHubIssue(repository: string, issueNumber: number, token?: string): Promise<NormalizedIssue> {
  const [owner, repo, ...extra] = repository.split("/");
  if (!owner || !repo || extra.length > 0) throw new Error("--repo must be owner/repository.");
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${issueNumber}`, {
    headers,
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`GitHub issue request failed (${response.status} ${response.statusText}). Check the repository, issue number, permissions${token ? "" : " or set GITHUB_TOKEN for private repositories/rate limits"}.`);
  }
  const issue = await response.json() as GitHubIssue;
  if (issue.pull_request) throw new Error("The requested GitHub item is a pull request, not an issue.");
  if (typeof issue.body !== "string" || issue.body.trim() === "") throw new Error("GitHub issue body is empty; include the user story and acceptance criteria.");
  const targetUrl = issue.body.match(/^\s*(?:\*\*)?Target URL(?:\*\*)?\s*:\s*(https?:\/\/\S+)/im)?.[1];
  return normalizeIssue({
    issueNumber: issue.number,
    title: issue.title,
    status: issue.labels.some((label) => (typeof label === "string" ? label : label.name ?? "").toLowerCase() === "rfqa") ? "RFQA" : "OTHER",
    targetUrl: targetUrl ?? process.env.TARGET_URL ?? "https://demo.playwright.dev/todomvc/",
    description: issue.body,
    acceptanceCriteria: parseAcceptanceCriteria(issue.body),
  });
}
