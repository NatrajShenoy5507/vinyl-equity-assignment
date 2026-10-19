import { describe, expect, it } from "vitest";
import { compactToolSchema, executorDecisionJsonSchema } from "../src/agents/executor-contract.js";
import type { DiscoveredTool } from "../src/browser/tool-policy.js";

const tools: DiscoveredTool[] = [
  { name: "browser_navigate", inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } },
  { name: "browser_snapshot", inputSchema: { type: "object" } },
  {
    name: "browser_type",
    inputSchema: {
      type: "object",
      properties: { ref: { type: "string" }, text: { type: "string" }, submit: { type: "boolean" } },
      required: ["ref", "text"],
    },
  },
  { name: "browser_click", inputSchema: { type: "object", properties: { ref: { type: "string" }, button: { type: "string", enum: ["left", "right"] } }, required: ["ref"] } },
  { name: "browser_hover", inputSchema: { type: "object", properties: { ref: { type: "string" }, button: { type: "string", enum: ["left"] } }, required: ["ref"] } },
];

function properties(schema: Record<string, unknown>): Record<string, Record<string, unknown>> {
  return schema.properties as Record<string, Record<string, unknown>>;
}

function assertNoCombinators(schema: unknown): void {
  if (Array.isArray(schema)) {
    schema.forEach(assertNoCombinators);
  } else if (schema !== null && typeof schema === "object") {
    for (const [key, value] of Object.entries(schema)) {
      expect(["anyOf", "oneOf", "allOf", "$ref", "if", "then", "else"]).not.toContain(key);
      assertNoCombinators(value);
    }
  }
}

describe("executor provider response contract", () => {
  it("requires an explicit discriminator in one plain object without union branches", () => {
    const schema = executorDecisionJsonSchema(tools);
    expect(schema.type).toBe("object");
    expect(schema.required).toEqual(["kind", "rationale"]);
    expect(schema.additionalProperties).toBe(false);
    expect(properties(schema).kind).toEqual({ type: "string", enum: ["action", "finish"] });
    expect(properties(schema).rationale).toEqual({ type: "string" });
    expect(properties(schema).assessments?.type).toBe("array");
    expect(properties(schema).assessments?.minItems).toBe(1);
    assertNoCombinators(schema);
  });

  it("derives tools and a typed shared argument object from permitted MCP discovery", () => {
    const schema = executorDecisionJsonSchema([
      ...tools,
      { name: "browser_run_code", inputSchema: { type: "object", properties: { code: { type: "string" } } } },
    ]);
    expect(properties(schema).toolName).toEqual({ type: "string", enum: tools.map(({ name }) => name) });
    const argumentsSchema = properties(schema).arguments!;
    expect(argumentsSchema).toEqual({
      type: "object",
      properties: {
        url: { type: "string" },
        ref: { type: "string" },
        text: { type: "string" },
        submit: { type: "boolean" },
        button: { type: "string", enum: ["left", "right"] },
      },
      additionalProperties: false,
    });
    // Requiring a union of every tool's required fields would exclude valid
    // calls. Conditional requirements are checked against the chosen MCP tool.
    expect(argumentsSchema.required).toBeUndefined();
  });

  it("limits a recovery schema to the selected discovered tool", () => {
    const schema = executorDecisionJsonSchema(tools, "browser_type");
    expect(properties(schema).toolName?.enum).toEqual(["browser_type"]);
    expect(properties(properties(schema).arguments!)).toEqual({
      ref: { type: "string" }, text: { type: "string" }, submit: { type: "boolean" },
    });
  });

  it("permits only finish when no permitted tools remain", () => {
    const schema = executorDecisionJsonSchema(tools, "browser_run_code");
    expect(properties(schema).kind?.enum).toEqual(["finish"]);
    expect(properties(schema).toolName).toBeUndefined();
    expect(properties(schema).arguments).toBeUndefined();
  });

  it("preserves discovered field names that resemble schema annotations", () => {
    const schema = executorDecisionJsonSchema([{
      name: "browser_type",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string", title: "Schema title" },
          description: { type: "string", description: "Schema documentation" },
          examples: { type: "array", items: { type: "string" } },
          default: { type: "boolean", default: true },
        },
      },
    }]);
    expect(properties(properties(schema).arguments!)).toEqual({
      title: { type: "string" },
      description: { type: "string" },
      examples: { type: "array", items: { type: "string" } },
      default: { type: "boolean" },
    });
  });

  it("retains known conflicting fields without adding provider union constraints", () => {
    const schema = executorDecisionJsonSchema([
      { name: "browser_click", inputSchema: { type: "object", properties: { mode: { type: "string" } } } },
      {
        name: "browser_hover",
        inputSchema: {
          type: "object",
          properties: {
            mode: { type: "boolean" },
            metadata: { type: "object", properties: { nested: { anyOf: [{ type: "string" }, { type: "number" }] } } },
          },
        },
      },
    ]);
    expect(properties(properties(schema).arguments!).mode).toEqual({});
    expect(properties(properties(properties(schema).arguments!).metadata!).nested).toEqual({});
    assertNoCombinators(schema);
  });

  it("does not copy an enum restriction that only applies to one selected tool", () => {
    const schema = executorDecisionJsonSchema([
      { name: "browser_click", inputSchema: { type: "object", properties: { mode: { type: "string", enum: ["left"] } } } },
      { name: "browser_hover", inputSchema: { type: "object", properties: { mode: { type: "string" } } } },
    ]);
    expect(properties(properties(schema).arguments!).mode).toEqual({ type: "string" });
  });

  it("omits provider enum constraints on boolean/null fields while retaining exact prompt contracts", () => {
    const inputSchema: DiscoveredTool["inputSchema"] = {
      type: "object",
      properties: { submit: { type: "boolean", enum: [true] }, optional: { type: "null", enum: [null] } },
    };
    const schema = executorDecisionJsonSchema([{ name: "browser_type", inputSchema }]);
    expect(properties(properties(schema).arguments!)).toEqual({ submit: { type: "boolean" }, optional: { type: "null" } });
    expect(compactToolSchema(inputSchema)).toEqual(inputSchema);
  });

  it("compacts annotation text while preserving exact discovered constraints and field names", () => {
    const schema = {
      type: "object",
      description: "Long tool documentation",
      properties: {
        title: { type: "string", description: "Long field documentation" },
        description: { type: "string", enum: ["description", "title"] },
      },
      required: ["title", "description"],
      additionalProperties: false,
    };
    expect(compactToolSchema(schema)).toEqual({
      type: "object",
      properties: {
        title: { type: "string" },
        description: { type: "string", enum: ["description", "title"] },
      },
      required: ["title", "description"],
      additionalProperties: false,
    });
  });
});
