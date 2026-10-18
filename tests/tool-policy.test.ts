import { describe, expect, it } from "vitest";
import { getPermittedTools, validateToolAction, type DiscoveredTool } from "../src/browser/tool-policy.js";

const tools = [
  { name: "browser_click", inputSchema: { type: "object" as const, properties: { ref: { type: "string" } } } },
  { name: "browser_hover", inputSchema: { type: "object" as const, properties: { target: { type: "string" } }, required: ["target"] } },
  { name: "browser_navigate", inputSchema: { type: "object" as const, properties: { url: { type: "string" } }, required: ["url"] } },
  { name: "browser_snapshot", inputSchema: { type: "object" as const, properties: { filename: { type: "string" } } } },
  { name: "browser_take_screenshot", inputSchema: { type: "object" as const, properties: { filename: { type: "string" } } } },
  { name: "browser_run_code_unsafe", inputSchema: { type: "object" as const } },
] as DiscoveredTool[];

describe("Playwright MCP tool policy", () => {
  it("only exposes safe discovered browser tools", () => {
    expect(getPermittedTools(tools).map((tool) => tool.name)).toEqual(["browser_click", "browser_hover", "browser_navigate", "browser_snapshot"]);
  });
  it("allows safe hover only with a semantic reference from the current snapshot", () => {
    expect(validateToolAction("browser_hover", { target: "e12" }, tools, "https://demo.test/")).toEqual({ target: "e12" });
    expect(() => validateToolAction("browser_hover", { target: "#delete" }, tools, "https://demo.test/")).toThrow(/accessibility reference/);
  });
  it("rejects unlisted, unsafe screenshot, unknown and off-origin actions", () => {
    expect(() => validateToolAction("browser_run_code_unsafe", {}, tools, "https://demo.test/")).toThrow(/not permitted/);
    expect(() => validateToolAction("browser_take_screenshot", { filename: "C:\\secrets.png" }, tools, "https://demo.test/")).toThrow(/not permitted/);
    expect(() => validateToolAction("browser_type", { text: "hello", ref: "e1" }, tools, "https://demo.test/")).toThrow(/not discovered/);
    expect(() => validateToolAction("browser_navigate", { url: "https://evil.test/" }, tools, "https://demo.test/")).toThrow(/outside the allowed/);
  });
  it("requires semantic targets and validates ordinary actions", () => {
    expect(() => validateToolAction("browser_click", {}, tools, "https://demo.test/")).toThrow(/accessibility reference/);
    expect(validateToolAction("browser_click", { ref: "e12" }, tools, "https://demo.test/")).toEqual({ ref: "e12" });
    expect(() => validateToolAction("browser_click", { ref: 12 }, tools, "https://demo.test/")).toThrow(/discovered string type/);
    expect(() => validateToolAction("browser_click", { ref: "e12", arbitrary: "value" }, tools, "https://demo.test/")).toThrow(/not declared/);
  });
  it("accepts only snapshot references in the current target-based Playwright schema", () => {
    const targetTool: DiscoveredTool = {
      name: "browser_click",
      inputSchema: { type: "object", properties: { target: { type: "string" } }, required: ["target"] },
    };
    expect(validateToolAction("browser_click", { target: "e8" }, [targetTool], "https://demo.test/")).toEqual({ target: "e8" });
    expect(validateToolAction("browser_click", { ref: "e8" }, [targetTool], "https://demo.test/")).toEqual({ target: "e8" });
    expect(validateToolAction("browser_click", { target: "e8", ref: "e8" }, [targetTool], "https://demo.test/")).toEqual({ target: "e8" });
    expect(() => validateToolAction("browser_click", {}, [targetTool], "https://demo.test/")).toThrow(/arguments\.target is required/);
    expect(() => validateToolAction("browser_click", { target: "e8", ref: "e9" }, [targetTool], "https://demo.test/")).toThrow(/Conflicting target and ref/);
    expect(() => validateToolAction("browser_click", { target: "#todo" }, [targetTool], "https://demo.test/")).toThrow(/accessibility reference/);
  });
  it("does not rewrite ref when the discovered schema requires ref instead of target", () => {
    const refTool: DiscoveredTool = {
      name: "browser_click",
      inputSchema: { type: "object", properties: { ref: { type: "string" } }, required: ["ref"] },
    };
    expect(validateToolAction("browser_click", { ref: "e8" }, [refTool], "https://demo.test/")).toEqual({ ref: "e8" });
    expect(() => validateToolAction("browser_click", { target: "e8" }, [refTool], "https://demo.test/")).toThrow(/arguments\.ref is required/);
  });
  it("does not let the model choose a snapshot output path", () => {
    expect(() => validateToolAction("browser_snapshot", { filename: "C:\\secrets.txt" }, tools, "https://demo.test/")).toThrow(/Unrecognized key/);
  });
});
