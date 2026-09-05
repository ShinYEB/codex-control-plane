// Deliberately narrow transport profile for this product's structured outputs.
// Domain constraints (including array uniqueness) remain in execution-contracts.
const KEYWORDS = new Set([
  "type", "properties", "required", "additionalProperties", "items", "enum",
  "minItems", "maxItems", "description", "title", "anyOf", "$defs", "$ref",
]);

export function assertOutputSchema(schema, path = "$", root = true, document = schema) {
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
  const types = Array.isArray(schema.type) ? schema.type : schema.type === undefined ? [] : [schema.type];
  if (types.some((type) => !["object", "array", "string", "number", "integer", "boolean", "null"].includes(type))) reject("unsupported type");
  if (!types.length && !schema.$ref && !schema.anyOf && !schema.enum) reject("type or reference is required");
  if (schema.enum !== undefined && (!Array.isArray(schema.enum) || !schema.enum.length)) reject("enum must be non-empty");
  for (const keyword of ["minItems", "maxItems"]) {
    if (schema[keyword] !== undefined && (!Number.isInteger(schema[keyword]) || schema[keyword] < 0)) reject(`${keyword} must be a non-negative integer`);
  }
  if (schema.minItems > schema.maxItems) reject("minItems exceeds maxItems");
  if (types.includes("array") && !schema.items) reject("array items are required");
  if (schema.$ref !== undefined) {
    if (typeof schema.$ref !== "string" || !/^#(?:\/|$)/.test(schema.$ref)) reject("only local references are supported");
    let target = document;
    for (const part of schema.$ref.slice(2).split('/').filter(Boolean)) target = target?.[part.replaceAll('~1', '/').replaceAll('~0', '~')];
    if (!target || typeof target !== "object") reject("unresolved reference");
  }
  if (schema.type === "object") {
    if (schema.additionalProperties !== false) reject("additionalProperties must be false");
    const fields = Object.keys(schema.properties ?? {});
    if (!Array.isArray(schema.required) || schema.required.length !== fields.length
      || new Set(schema.required).size !== fields.length
      || fields.some((field) => !schema.required.includes(field))) reject("all properties must be required");
  }
  for (const group of ["properties", "$defs"]) {
    if (schema[group] !== undefined && (!schema[group] || typeof schema[group] !== "object" || Array.isArray(schema[group]))) reject(`${group} must be an object`);
    for (const [name, child] of Object.entries(schema[group] ?? {})) {
      assertOutputSchema(child, `${path}.${group}.${name}`, false, document);
    }
  }
  if (schema.items !== undefined) assertOutputSchema(schema.items, `${path}.items`, false, document);
  if (schema.anyOf !== undefined) {
    if (!Array.isArray(schema.anyOf) || !schema.anyOf.length || root) reject("anyOf must be non-empty and nested");
    schema.anyOf.forEach((child, index) => assertOutputSchema(child, `${path}.anyOf[${index}]`, false, document));
  }
  return schema;
}
