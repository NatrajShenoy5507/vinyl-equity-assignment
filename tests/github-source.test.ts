import { afterEach, describe, expect, it, vi } from "vitest";
import { loadGitHubIssue } from "../src/issues/github-source.js";
import { parseCli } from "../src/config.js";

afterEach(() => vi.unstubAllGlobals());

describe("GitHub issue source", () => {
  it("maps the RFQA label, target URL, and acceptance criteria", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      number: 9,
      title: "Todo issue",
      body: "As a user, I can add a task.\n\nTarget URL: https://demo.test/\n\n## Acceptance Criteria\n- AC-01: A task appears.",
      labels: [{ name: "rfqa" }],
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await loadGitHubIssue("owner/repository", 9);
    expect(result.status).toBe("RFQA");
    expect(result.acceptanceCriteria).toEqual([{ id: "AC-01", description: "A task appears." }]);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("requires repository and issue inputs for GitHub mode", () => {
    expect(() => parseCli(["--source=github"])).toThrow(/requires --repo/);
    expect(() => parseCli(["--source=github", "--repo=owner/repository"])).toThrow(/requires --repo/);
  });

  it("parses a single dynamically generated scenario selector", () => {
    expect(parseCli(["--source=mock", "--scenario=SC-01"])).toMatchObject({ source: "mock", scenario: "SC-01" });
    expect(parseCli(["--source", "mock", "--scenario", "SC-02"]).scenario).toBe("SC-02");
    expect(() => parseCli(["--scenario="])).toThrow(/requires a scenario ID/);
  });

  it("reports remote API failures without making them product failures", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("not found", { status: 404, statusText: "Not Found" })));
    await expect(loadGitHubIssue("owner/repository", 9)).rejects.toThrow(/GitHub issue request failed \(404/);
  });

  it("rejects missing ACs and malformed repository names", async () => {
    await expect(loadGitHubIssue("owner/repository/extra", 9)).rejects.toThrow(/owner\/repository/);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      number: 9, title: "Empty", body: "No criteria", labels: [],
    }), { status: 200 })));
    await expect(loadGitHubIssue("owner/repository", 9)).rejects.toThrow(/Acceptance Criteria/);
  });
});
