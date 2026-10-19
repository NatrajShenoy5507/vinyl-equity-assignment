import { getPermittedTools, type DiscoveredTool } from "../browser/tool-policy.js";

// Keep the full discovered constraints in the prompt and in host validation,
// while removing prose annotations that would otherwise dominate the prompt.
export function compactToolSchema(value: unknown, propertyMap = false): unknown {
  if (Array.isArray(value)) return value.map((child) => compactToolSchema(child));
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => propertyMap || !["description", "title", "examples", "default", "$schema"].includes(key))
    .map(([key, child]) => [key, !propertyMap && ["enum", "const"].includes(key)
      ? child : compactToolSchema(child, !propertyMap && ["properties", "$defs", "definitions"].includes(key))]));
}

type JsonSchema = Record<string, unknown>;

function schemaObject(value: unknown): JsonSchema {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as JsonSchema : {};
}

// The provider gets a conservative shared shape, not a union of entire MCP
// contracts. Keep only constraints that apply to every occurrence of a field;
// exact types, required fields and allowed values remain enforced by the host.
function mergeArgumentSchemas(values: unknown[]): JsonSchema {
  const schemas = values.map(schemaObject);
  const declaredTypes = schemas.map(({ type }) => type);
  const type = declaredTypes[0];
  if (typeof type !== "string" || !declaredTypes.every((candidate) => candidate === type)
    || !["object", "array", "string", "number", "integer", "boolean", "null"].includes(type)) return {};
  const merged: JsonSchema = { type };
  if (type === "object") {
    const fields = new Map<string, unknown[]>();
    for (const schema of schemas) {
      for (const [name, child] of Object.entries(schemaObject(schema.properties))) {
        const occurrences = fields.get(name) ?? [];
        occurrences.push(child);
        fields.set(name, occurrences);
      }
    }
    merged.properties = Object.fromEntries([...fields].map(([name, occurrences]) => [name, mergeArgumentSchemas(occurrences)]));
    merged.additionalProperties = false;
  } else if (type === "array") {
    // Unknown item contracts must remain unconstrained rather than excluding a
    // dynamically discovered valid tool shape.
    merged.items = mergeArgumentSchemas(schemas.map(({ items }) => items));
  } else if (["string", "number", "integer"].includes(type) && schemas.every((schema) => Array.isArray(schema.enum))) {
    const enums = schemas.flatMap((schema) => schema.enum as unknown[]);
    if (enums.length > 0 && enums.every((value) => value === null ? type === "null"
      : type === "integer" ? typeof value === "number" && Number.isInteger(value)
        : typeof value === type)) {
      merged.enum = [...new Map(enums.map((value) => [JSON.stringify(value), value])).values()];
    }
  }
  return merged;
}

export function executorDecisionJsonSchema(tools: DiscoveredTool[], onlyToolName?: string): JsonSchema {
  const availableTools = getPermittedTools(tools).filter((tool) => onlyToolName === undefined || tool.name === onlyToolName);
  const properties: JsonSchema = {
    kind: { type: "string", enum: availableTools.length ? ["action", "finish"] : ["finish"] },
    rationale: { type: "string" },
  };
  if (availableTools.length) {
    properties.toolName = { type: "string", enum: availableTools.map(({ name }) => name) };
    properties.arguments = mergeArgumentSchemas(availableTools.map(({ inputSchema }) => inputSchema));
  }
  properties.assessments = {
    type: "array",
    minItems: 1,
    items: {
      type: "object",
      properties: {
        acceptanceCriteriaId: { type: "string" },
        meets: { type: "boolean" },
        observedEvidence: { type: "string" },
        explanation: { type: "string" },
      },
      required: ["acceptanceCriteriaId", "meets", "observedEvidence", "explanation"],
      additionalProperties: false,
    },
  };
  // A single explicit object avoids depending on root/nested union behavior in
  // structured generation. Zod enforces the action/finish conditional fields;
  // the selected discovered MCP contract is validated before any browser call.
  return {
    type: "object",
    properties,
    required: ["kind", "rationale"],
    additionalProperties: false,
  };
}
