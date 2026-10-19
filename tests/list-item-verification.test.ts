import { describe, expect, it } from "vitest";
import { verifyScenarioChecks } from "../src/agents/executor.js";
import type { NormalizedIssue, PlannedScenario } from "../src/schemas.js";

const taskPlaceholder = "{{uniqueTaskText}}";
const issue: NormalizedIssue = {
  issueNumber: 1,
  title: "Todo lifecycle",
  status: "RFQA",
  targetUrl: "https://demo.playwright.dev/todomvc/",
  description: "Verify a Todo using independently observed browser state.",
  acceptanceCriteria: [{ id: "AC-01", description: "The Todo satisfies the requested final state." }],
};

type Check = PlannedScenario["verificationChecks"][number];
type Observation = Parameters<typeof verifyScenarioChecks>[3][number];

function check(kind: Check["kind"], expectedVisible = [taskPlaceholder], expectedAbsent: string[] = []): Check {
  return { acceptanceCriterionId: "AC-01", kind, expectedVisible, expectedAbsent };
}

function verify(verificationCheck: Check, subject: string, snapshots: Observation[]) {
  const scenario: PlannedScenario = {
    id: "SC-01",
    title: "Verify the observed Todo state",
    acceptanceCriteriaIds: ["AC-01"],
    preconditions: [],
    steps: [{ intent: "Perform the planned interaction", expectedObservation: "The intended Todo state is observed" }],
    verificationStrategy: "Check semantic list-item content in the final accessibility tree.",
    verificationChecks: [verificationCheck],
    relevantApplicationContext: ["The application exposes a semantic Todo list."],
    unknownControlsToDiscover: [],
    expectedResult: "The final Todo state matches the acceptance criterion.",
  };
  return verifyScenarioChecks(scenario, issue, subject, snapshots)[0]!;
}

function final(text: string): Observation[] {
  return [{ stage: "post_action", text }];
}

// Mirrors the observed TodoMVC accessibility tree, including its generic wrappers.
// The task text is supplied by each test rather than baked into the verifier.
function todoSnapshot(items: Array<{ text: string; state?: "checked" | "unchecked" }>, activeSelected = false): string {
  const itemLines = items.flatMap(({ text, state }, index) => {
    const ref = index === 0 ? 19 : 40 + (index - 1) * 4;
    return [
      `        - listitem [ref=e${ref}]:`,
      `          - generic [ref=e${ref + 1}]:`,
      `            - checkbox "Toggle Todo" [ref=e${ref + 2}]${state ? ` [${state}]` : ""}`,
      `            - generic [ref=e${ref + 3}]: ${text}`,
      "            - text: ×",
    ];
  });
  return [
    "### Page",
    "- Page URL: https://demo.playwright.dev/todomvc/#/",
    "- Page Title: React • TodoMVC",
    "### Snapshot",
    "```yaml",
    "- generic [ref=e1]:",
    "  - generic [ref=e5]:",
    "    - generic [ref=e6]:",
    '      - heading "todos" [level=1] [ref=e7]',
    '      - textbox "What needs to be done?" [active] [ref=e8]',
    "    - generic [ref=e15]:",
    '      - checkbox "❯Mark all as complete" [ref=e16]',
    "      - generic [ref=e17]: ❯Mark all as complete",
    "      - list [ref=e18]:",
    ...itemLines,
    "    - generic [ref=e23]:",
    "      - list [ref=e26]:",
    "        - listitem [ref=e29]:",
    `          - link "Active" [ref=e30]${activeSelected ? " [current]" : ""}:`,
    '            - /url: "#/active"',
    "  - contentinfo [ref=e9]:",
    "    - paragraph [ref=e10]: Double-click to edit a todo",
    "```",
  ].join("\n");
}

describe("semantic list-item host verification", () => {
  it.each(["Prepare release notes", "Groceries & errands", "QA-run-unique-task"])(
    "recognizes task descendants through the real TodoMVC generic wrappers: %s",
    (subject) => {
      const result = verify(check("visible"), subject, final(todoSnapshot([{ text: subject }])));
      expect(result.status, result.reason).toBe("PASS");
    },
  );

  it("continues past an earlier occurrence outside the list to a valid nested task occurrence", () => {
    const subject = "Repeated observed task";
    const snapshot = todoSnapshot([{ text: subject }]).replace(
      '      - heading "todos" [level=1] [ref=e7]',
      `      - heading "${subject}" [level=1] [ref=e7]`,
    );
    const result = verify(check("visible"), subject, final(snapshot));
    expect(result.status, result.reason).toBe("PASS");
  });

  it("accepts deeper generic descendants rather than only direct children of a listitem", () => {
    const subject = "Deeply wrapped task";
    const snapshot = todoSnapshot([{ text: subject }]).replace(
      `            - generic [ref=e22]: ${subject}`,
      `            - generic [ref=e22]:\n              - generic [ref=e40]:\n                - generic [ref=e41]: ${subject}`,
    );
    expect(verify(check("visible"), subject, final(snapshot)).status).toBe("PASS");
  });

  it.each([
    ["a heading before an unrelated listitem", (subject: string) => todoSnapshot([{ text: "Different task" }]).replace('heading "todos"', `heading "${subject}"`)],
    ["a textbox outside the list", (subject: string) => todoSnapshot([{ text: "Different task" }]).replace('textbox "What needs to be done?"', `textbox "${subject}"`)],
    ["content after the closed listitem branch", (subject: string) => todoSnapshot([{ text: "Different task" }]).replace("paragraph [ref=e10]: Double-click to edit a todo", `paragraph [ref=e10]: ${subject}`)],
    ["a sibling of the listitem", (subject: string) => todoSnapshot([{ text: "Different task" }]).replace("    - generic [ref=e23]:", `        - generic [ref=e40]: ${subject}\n    - generic [ref=e23]:`)],
    ["an unrelated sibling branch between listitems", (subject: string) => todoSnapshot([{ text: "First task" }, { text: "Second task" }]).replace("        - listitem [ref=e40]:", `        - generic [ref=e50]:\n          - generic [ref=e51]: ${subject}\n        - listitem [ref=e40]:`)],
    ["plain text with the word listitem", (subject: string) => `- generic: listitem ${subject}`],
    ["a generic label containing the word listitem", (subject: string) => `- generic "listitem":\n  - generic: ${subject}`],
    ["a listitem-like role name", (subject: string) => `- listitem-extra:\n  - generic: ${subject}`],
    ["a separate block after the snapshot's closing fence", (subject: string) => [
      "```yaml", "- listitem:", "  - generic: Different item", "```", `  - generic: ${subject}`,
    ].join("\n")],
  ])("blocks when the subject appears only in %s", (_name, snapshotForSubject) => {
    const subject = "Task only outside semantic items";
    const result = verify(check("visible"), subject, final(snapshotForSubject(subject)));
    expect(result.status).toBe("BLOCKED");
    expect(result.reason).toContain(`missing: ${subject}`);
  });

  it("blocks when every occurrence of the subject is outside listitems", () => {
    const subject = "Repeated non-item text";
    const snapshot = todoSnapshot([{ text: "Unrelated item" }])
      .replace('heading "todos"', `heading "${subject}"`)
      .replace("paragraph [ref=e10]: Double-click to edit a todo", `paragraph [ref=e10]: ${subject}`);
    expect(verify(check("visible"), subject, final(snapshot)).status).toBe("BLOCKED");
  });

  it("still blocks without a post-action observation", () => {
    const subject = "Initial-state task";
    const result = verify(check("visible"), subject, [{ stage: "initial", text: todoSnapshot([{ text: subject }]) }]);
    expect(result.status).toBe("BLOCKED");
    expect(result.reason).toContain("No post-action accessibility snapshot");
  });

  it.each([
    ["checked", "PASS"],
    ["unchecked", "FAIL"],
    [undefined, "BLOCKED"],
  ] as const)("preserves completion semantics for a nested task with checkbox state %s", (state, expectedStatus) => {
    const subject = "Completion state task";
    const result = verify(check("checked"), subject, final(todoSnapshot([{ text: subject, ...(state ? { state } : {}) }])));
    expect(result.status, result.reason).toBe(expectedStatus);
  });

  it("does not use a checked checkbox to pass a subject outside a semantic item", () => {
    const subject = "Outside completion label";
    const snapshot = todoSnapshot([{ text: "Unrelated task", state: "checked" }]).replace(
      '      - heading "todos" [level=1] [ref=e7]',
      `      - heading "${subject}" [level=1] [ref=e7]`,
    );
    expect(verify(check("checked"), subject, final(snapshot)).status).toBe("BLOCKED");
  });

  it.each([
    ["unchecked", "FAIL"],
    [undefined, "BLOCKED"],
  ] as const)("does not borrow a neighboring checked item's state for a %s subject", (state, expectedStatus) => {
    const subject = "Independent completion subject";
    const snapshot = todoSnapshot([{ text: subject, ...(state ? { state } : {}) }, { text: "Unrelated checked task", state: "checked" }]);
    expect(verify(check("checked"), subject, final(snapshot)).status).toBe(expectedStatus);
  });

  it("blocks ambiguous duplicate identities with conflicting checkbox states", () => {
    const subject = "Duplicate subject";
    const snapshot = todoSnapshot([{ text: subject, state: "checked" }, { text: subject, state: "unchecked" }]);
    expect(verify(check("checked"), subject, final(snapshot)).status).toBe("BLOCKED");
  });

  it("does not treat checked-state text inside a checkbox name as an observed state", () => {
    const subject = "Checkbox label subject";
    const snapshot = todoSnapshot([{ text: subject }]).replace('checkbox "Toggle Todo"', 'checkbox "A label containing [checked]"');
    expect(verify(check("checked"), subject, final(snapshot)).status).toBe("BLOCKED");
  });

  it("passes an Active filter only after both nested test items were observed and the excluded item disappears", () => {
    const subject = "Filter task";
    const result = verify(check("filter", [`${taskPlaceholder}-ACTIVE`], [`${taskPlaceholder}-COMPLETED`]), subject, [
      { stage: "initial", text: todoSnapshot([]) },
      { stage: "post_action", text: todoSnapshot([{ text: `${subject}-ACTIVE`, state: "unchecked" }, { text: `${subject}-COMPLETED`, state: "checked" }]) },
      { stage: "post_action", text: todoSnapshot([{ text: `${subject}-ACTIVE` }], true) },
    ]);
    expect(result.status, result.reason).toBe("PASS");
  });

  it.each([
    ["keeps the completed item visible", [{ text: "Filter task-ACTIVE" }, { text: "Filter task-COMPLETED", state: "checked" as const }]],
    ["loses the active item", []],
  ])("fails a selected Active filter that %s", (_name, items) => {
    const subject = "Filter task";
    const result = verify(check("filter", [`${taskPlaceholder}-ACTIVE`], [`${taskPlaceholder}-COMPLETED`]), subject, [
      { stage: "initial", text: todoSnapshot([]) },
      { stage: "post_action", text: todoSnapshot([{ text: `${subject}-ACTIVE`, state: "unchecked" }, { text: `${subject}-COMPLETED`, state: "checked" }]) },
      { stage: "post_action", text: todoSnapshot(items, true) },
    ]);
    expect(result.status).toBe("FAIL");
  });

  it("blocks filtering when the excluded task was observed only outside a listitem", () => {
    const subject = "Filter task";
    const before = todoSnapshot([{ text: `${subject}-ACTIVE` }]).replace(
      'heading "todos"', `heading "${subject}-COMPLETED"`,
    );
    const result = verify(check("filter", [`${taskPlaceholder}-ACTIVE`], [`${taskPlaceholder}-COMPLETED`]), subject, [
      { stage: "initial", text: before },
      { stage: "post_action", text: todoSnapshot([{ text: `${subject}-ACTIVE` }], true) },
    ]);
    expect(result.status).toBe("BLOCKED");
    expect(result.reason).toContain("observed before the final filter result");
  });

  it("blocks filtering without independent evidence that Active is selected", () => {
    const subject = "Filter task";
    const result = verify(check("filter", [`${taskPlaceholder}-ACTIVE`], [`${taskPlaceholder}-COMPLETED`]), subject, [
      { stage: "initial", text: todoSnapshot([]) },
      { stage: "post_action", text: todoSnapshot([{ text: `${subject}-ACTIVE`, state: "unchecked" }, { text: `${subject}-COMPLETED`, state: "checked" }]) },
      { stage: "post_action", text: todoSnapshot([{ text: `${subject}-ACTIVE` }]) },
    ]);
    expect(result.status).toBe("BLOCKED");
    expect(result.reason).toContain("Active filter is selected");
  });

  it.each(["unchecked", undefined] as const)("blocks filter setup whose excluded item's own state is %s despite a nearby checked task", (state) => {
    const subject = "Filter state subject";
    const before = todoSnapshot([
      { text: `${subject}-ACTIVE`, state: "unchecked" },
      { text: `${subject}-COMPLETED`, ...(state ? { state } : {}) },
      { text: "Unrelated completed task", state: "checked" },
    ]);
    const result = verify(check("filter", [`${taskPlaceholder}-ACTIVE`], [`${taskPlaceholder}-COMPLETED`]), subject, [
      { stage: "initial", text: todoSnapshot([]) },
      { stage: "post_action", text: before },
      { stage: "post_action", text: todoSnapshot([{ text: `${subject}-ACTIVE` }], true) },
    ]);
    expect(result.status).toBe("BLOCKED");
    expect(result.reason).toMatch(/excluded item.*checked checkbox/);
  });

  it("does not accept recovery-only observations as filter setup evidence", () => {
    const subject = "Recovery filter subject";
    const result = verify(check("filter", [`${taskPlaceholder}-ACTIVE`], [`${taskPlaceholder}-COMPLETED`]), subject, [
      { stage: "initial", text: todoSnapshot([]) },
      { stage: "recovery", text: todoSnapshot([{ text: `${subject}-ACTIVE`, state: "unchecked" }, { text: `${subject}-COMPLETED`, state: "checked" }]) },
      { stage: "post_action", text: todoSnapshot([{ text: `${subject}-ACTIVE` }], true) },
    ]);
    expect(result.status).toBe("BLOCKED");
  });

  it("does not accept the Active URL without an observed filter control", () => {
    const subject = "URL-only subject";
    const after = todoSnapshot([{ text: `${subject}-ACTIVE` }]).replace("todomvc/#/", "todomvc/#/active")
      .replace('link "Active"', 'generic "Active"');
    const result = verify(check("filter", [`${taskPlaceholder}-ACTIVE`], [`${taskPlaceholder}-COMPLETED`]), subject, [
      { stage: "initial", text: todoSnapshot([]) },
      { stage: "post_action", text: todoSnapshot([{ text: `${subject}-ACTIVE`, state: "unchecked" }, { text: `${subject}-COMPLETED`, state: "checked" }]) },
      { stage: "post_action", text: after },
    ]);
    expect(result.status).toBe("BLOCKED");
    expect(result.reason).toContain("Active filter is selected");
  });

  it.each([
    ["a false current attribute", 'link "Active" [current=false]'],
    ["role-like page text", 'generic: link "Active" [current]'],
  ])("does not accept %s as a selected filter", (_description, fakeControl) => {
    const subject = "Selected filter subject";
    const after = todoSnapshot([{ text: `${subject}-ACTIVE` }]).replace('link "Active"', fakeControl);
    const result = verify(check("filter", [`${taskPlaceholder}-ACTIVE`], [`${taskPlaceholder}-COMPLETED`]), subject, [
      { stage: "initial", text: todoSnapshot([]) },
      { stage: "post_action", text: todoSnapshot([{ text: `${subject}-ACTIVE`, state: "unchecked" }, { text: `${subject}-COMPLETED`, state: "checked" }]) },
      { stage: "post_action", text: after },
    ]);
    expect(result.status).toBe("BLOCKED");
    expect(result.reason).toContain("Active filter is selected");
  });

  it("passes deletion after a nested item was seen even if its text remains outside the list", () => {
    const subject = "Removed task";
    const after = todoSnapshot([]).replace('heading "todos"', `heading "${subject}"`);
    const result = verify(check("absent_after_seen", [taskPlaceholder], [taskPlaceholder]), subject, [
      { stage: "initial", text: todoSnapshot([]) },
      { stage: "post_action", text: todoSnapshot([{ text: subject }]).replace("            - text: ×", '            - button "Delete" [ref=e80]') },
      { stage: "post_action", text: after, action: { toolName: "browser_click", arguments: { target: "e80" } } },
    ]);
    expect(result.status, result.reason).toBe("PASS");
  });

  it("fails deletion when the task remains nested in a semantic listitem", () => {
    const subject = "Remaining task";
    const result = verify(check("absent_after_seen", [taskPlaceholder], [taskPlaceholder]), subject, [
      { stage: "initial", text: todoSnapshot([]) },
      { stage: "post_action", text: todoSnapshot([{ text: subject }]).replace("            - text: ×", '            - button "Delete" [ref=e80]') },
      { stage: "post_action", text: todoSnapshot([{ text: subject }]), action: { toolName: "browser_click", arguments: { target: "e80" } } },
    ]);
    expect(result.status).toBe("FAIL");
    expect(result.reason).toContain("still visible");
  });

  it("blocks deletion if the subject was previously seen only outside a listitem", () => {
    const subject = "Never an observed task";
    const before = todoSnapshot([{ text: "Unrelated task" }]).replace('heading "todos"', `heading "${subject}"`);
    const result = verify(check("absent_after_seen", [taskPlaceholder], [taskPlaceholder]), subject, [
      { stage: "initial", text: before },
      { stage: "post_action", text: todoSnapshot([]) },
    ]);
    expect(result.status).toBe("BLOCKED");
    expect(result.reason).toContain("was never observed");
  });
});
