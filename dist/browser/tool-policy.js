import { z } from "zod";
const safeToolNames = new Set([
    "browser_navigate",
    "browser_snapshot",
    "browser_click",
    "browser_type",
    "browser_press_key",
]);
const navigationArgs = z.object({ url: z.string().url() }).passthrough();
const snapshotArgs = z.object({}).strict();
const clickArgs = z.object({ target: z.string().optional(), ref: z.string().optional(), element: z.string().optional() }).passthrough()
    .refine((args) => /^e\d+$/.test(args.target ?? args.ref ?? ""), "Click requires an exact accessibility reference from the current snapshot, not a selector.");
const typeArgs = z.object({ text: z.string().max(250), target: z.string().optional(), ref: z.string().optional(), element: z.string().optional() }).passthrough()
    .refine((args) => /^e\d+$/.test(args.target ?? args.ref ?? ""), "Typing requires an exact accessibility reference from the current snapshot, not a selector.");
const pressArgs = z.object({ key: z.enum(["Enter", "Escape", "Tab", "Space", "Backspace", "Delete", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]) }).passthrough();
const jsonSchemaShape = z.object({
    type: z.string().optional(),
    properties: z.record(z.string(), z.unknown()).optional(),
    required: z.array(z.string()).optional(),
    enum: z.array(z.unknown()).optional(),
    items: z.unknown().optional(),
    additionalProperties: z.union([z.boolean(), z.record(z.string(), z.unknown())]).optional(),
}).passthrough();
export function getPermittedTools(tools) {
    return tools.filter((tool) => safeToolNames.has(tool.name));
}
function validateDiscoveredSchema(value, schemaInput, path) {
    const parsed = jsonSchemaShape.safeParse(schemaInput);
    if (!parsed.success)
        throw new Error(`Discovered tool schema is invalid at ${path}.`);
    const schema = parsed.data;
    const validType = schema.type === undefined
        || (schema.type === "object" && typeof value === "object" && value !== null && !Array.isArray(value))
        || (schema.type === "array" && Array.isArray(value))
        || (schema.type === "string" && typeof value === "string")
        || (schema.type === "number" && typeof value === "number")
        || (schema.type === "integer" && typeof value === "number" && Number.isInteger(value))
        || (schema.type === "boolean" && typeof value === "boolean")
        || (schema.type === "null" && value === null);
    if (!validType)
        throw new Error(`Argument ${path} does not match the discovered ${schema.type ?? "unspecified"} type.`);
    if (schema.enum && !schema.enum.some((candidate) => JSON.stringify(candidate) === JSON.stringify(value))) {
        throw new Error(`Argument ${path} is not one of the values allowed by the discovered tool schema.`);
    }
    if (schema.type === "object" && typeof value === "object" && value !== null && !Array.isArray(value)) {
        const properties = schema.properties ?? {};
        const objectValue = value;
        for (const required of schema.required ?? []) {
            if (!(required in objectValue))
                throw new Error(`Argument ${path}.${required} is required by the discovered tool schema.`);
        }
        for (const [key, childValue] of Object.entries(objectValue)) {
            const childSchema = properties[key];
            if (childSchema === undefined)
                throw new Error(`Argument ${path}.${key} is not declared by the discovered tool schema.`);
            validateDiscoveredSchema(childValue, childSchema, `${path}.${key}`);
        }
    }
    if (schema.type === "array" && Array.isArray(value) && schema.items !== undefined) {
        for (const [index, item] of value.entries())
            validateDiscoveredSchema(item, schema.items, `${path}[${index}]`);
    }
}
export function validateToolArguments(args, inputSchema) {
    const parsed = z.record(z.string(), z.unknown()).safeParse(args);
    if (!parsed.success)
        throw new Error(`Tool arguments must be an object: ${parsed.error.message}`);
    validateDiscoveredSchema(parsed.data, inputSchema, "arguments");
    return parsed.data;
}
export function validateToolAction(name, args, discovered, targetUrl) {
    if (!safeToolNames.has(name))
        throw new Error(`Tool "${name}" is not permitted.`);
    const tool = discovered.find((candidate) => candidate.name === name);
    if (!tool)
        throw new Error(`Tool "${name}" was not discovered from the Playwright MCP server.`);
    const validated = validateToolArguments(args, tool.inputSchema);
    const parsed = name === "browser_navigate" ? navigationArgs.safeParse(validated)
        : name === "browser_snapshot" ? snapshotArgs.safeParse(validated)
            : name === "browser_click" ? clickArgs.safeParse(validated)
                : name === "browser_type" ? typeArgs.safeParse(validated)
                    : name === "browser_press_key" ? pressArgs.safeParse(validated)
                        : z.never().safeParse(validated);
    if (!parsed.success)
        throw new Error(`Invalid arguments for ${name}: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`);
    if (name === "browser_navigate") {
        const target = new URL(targetUrl);
        const requested = new URL(String(args.url));
        if (requested.origin !== target.origin)
            throw new Error(`Navigation outside the allowed target origin is blocked: ${requested.origin}`);
    }
    return parsed.data;
}
