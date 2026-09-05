// Deliberately narrow transport profile for this product's structured outputs.
// Domain constraints (including array uniqueness) remain in execution-contracts.
const KEYWORDS = new Set([
  "type", "properties", "required", "additionalProperties", "items", "enum",
  "minItems", "maxItems", "description", "title", "anyOf", "$defs", "$ref",
]);

export function assertOutputSchema(schema, path = "$", root = true) {
  const reject = (reason) => {
    throw Object.assign(new Error(`Invalid output schema at ${path}: ${reason}`), {
      code: "OUTPUT_SCHEMA_INVALID", retryable: false,
    });
  };
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) reject("expected a schema object");
  for (const key of Object.keys(schema)) {
    if (!KEYWORDS.has(key)) reject(`unsupported keyword ${key}`);
  }
  if (root && schema.type !== "object") reject("root must be an object");
  if (schema.type === "object") {
    if (schema.additionalProperties !== false) reject("additionalProperties must be false");
    const fields = Object.keys(schema.properties ?? {});
    if (!Array.isArray(schema.required) || schema.required.length !== fields.length
      || new Set(schema.required).size !== fields.length
      || fields.some((field) => !schema.required.includes(field))) reject("all properties must be required");
  }
  for (const group of ["properties", "$defs"]) {
    for (const [name, child] of Object.entries(schema[group] ?? {})) {
      assertOutputSchema(child, `${path}.${group}.${name}`, false);
    }
  }
  if (schema.items !== undefined) assertOutputSchema(schema.items, `${path}.items`, false);
  if (schema.anyOf !== undefined) {
    if (!Array.isArray(schema.anyOf)) reject("anyOf must be an array");
    schema.anyOf.forEach((child, index) => assertOutputSchema(child, `${path}.anyOf[${index}]`, false));
  }
  return schema;
}
