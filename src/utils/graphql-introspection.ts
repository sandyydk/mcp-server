/**
 * GraphQL schema discovery over standard introspection.
 *
 * The CCM GraphQL endpoint is code-first and serves introspection, so the schema reaches the agent as JSON — no SDL
 * parser and no extra dependency. This module holds the introspection query, a normaliser into a small model, and
 * bounded "views" (list queries / one query / one type) so the whole schema is never dumped into the context window.
 */

/**
 * Trimmed introspection query: names, descriptions, types and defaults only. TypeRef depth 4 covers `[X!]!`.
 * Fields counted toward the backend complexity limit stay far below it (~120).
 */
export const INTROSPECTION_QUERY = `query CcmSchemaIntrospection {
  __schema {
    queryType { name }
    types {
      kind
      name
      description
      fields(includeDeprecated: true) {
        name
        description
        isDeprecated
        args { name description defaultValue type { ...TypeRef } }
        type { ...TypeRef }
      }
      inputFields { name description defaultValue type { ...TypeRef } }
      enumValues(includeDeprecated: true) { name description }
    }
  }
}
fragment TypeRef on __Type {
  kind
  name
  ofType { kind name ofType { kind name ofType { kind name } } }
}`;

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

export interface SchemaArg {
  name: string;
  description?: string;
  type: string;
  required: boolean;
  defaultValue?: string;
}

export interface SchemaField {
  name: string;
  description?: string;
  type: string;
  args: SchemaArg[];
  deprecated?: boolean;
}

export interface SchemaEnumValue {
  name: string;
  description?: string;
}

export type SchemaTypeKind = "OBJECT" | "INPUT_OBJECT" | "ENUM" | "SCALAR" | "INTERFACE" | "UNION";

export interface SchemaType {
  kind: SchemaTypeKind;
  name: string;
  description?: string;
  fields: SchemaField[];
  enumValues: SchemaEnumValue[];
}

export interface SchemaModel {
  queryType: string;
  types: Map<string, SchemaType>;
}

interface RawTypeRef {
  kind?: string;
  name?: string | null;
  ofType?: RawTypeRef | null;
}

interface RawInputValue {
  name: string;
  description?: string | null;
  defaultValue?: string | null;
  type: RawTypeRef;
}

interface RawField {
  name: string;
  description?: string | null;
  isDeprecated?: boolean;
  args?: RawInputValue[] | null;
  type: RawTypeRef;
}

interface RawType {
  kind: string;
  name: string;
  description?: string | null;
  fields?: RawField[] | null;
  inputFields?: RawInputValue[] | null;
  enumValues?: Array<{ name: string; description?: string | null }> | null;
}

export class IntrospectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IntrospectionError";
  }
}

/** Render a TypeRef as SDL-style text, e.g. `[QLCEViewFilterWrapperInput]!`. */
export function typeRefToString(ref: RawTypeRef | null | undefined): string {
  if (!ref) return "Unknown";
  if (ref.kind === "NON_NULL") return `${typeRefToString(ref.ofType)}!`;
  if (ref.kind === "LIST") return `[${typeRefToString(ref.ofType)}]`;
  return ref.name ?? "Unknown";
}

function toArg(v: RawInputValue): SchemaArg {
  const type = typeRefToString(v.type);
  return {
    name: v.name,
    type,
    required: type.endsWith("!") && (v.defaultValue === null || v.defaultValue === undefined),
    ...(v.description ? { description: v.description } : {}),
    ...(v.defaultValue !== null && v.defaultValue !== undefined ? { defaultValue: v.defaultValue } : {}),
  };
}

/** Normalise a raw introspection response (`{ data: { __schema } }` or the bare `__schema`). */
export function parseIntrospection(raw: unknown): SchemaModel {
  const root = raw as { data?: { __schema?: unknown }; errors?: Array<{ message?: string }>; __schema?: unknown };
  if (root?.errors?.length && !root.data) {
    throw new IntrospectionError(`GraphQL introspection failed: ${root.errors.map((e) => e.message).join("; ")}`);
  }
  const schema = (root?.data?.__schema ?? root?.__schema) as
    | { queryType?: { name?: string }; types?: RawType[] }
    | undefined;
  if (!schema || !Array.isArray(schema.types)) {
    throw new IntrospectionError("Response did not contain a GraphQL __schema");
  }

  const types = new Map<string, SchemaType>();
  for (const t of schema.types) {
    if (!t?.name || t.name.startsWith("__")) continue;
    const fields: SchemaField[] = [];
    for (const f of t.fields ?? []) {
      fields.push({
        name: f.name,
        type: typeRefToString(f.type),
        args: (f.args ?? []).map(toArg),
        ...(f.description ? { description: f.description } : {}),
        ...(f.isDeprecated ? { deprecated: true } : {}),
      });
    }
    for (const f of t.inputFields ?? []) {
      const a = toArg(f);
      fields.push({
        name: a.name,
        type: a.type,
        args: [],
        ...(a.description ? { description: a.description } : {}),
      });
    }
    types.set(t.name, {
      kind: t.kind as SchemaTypeKind,
      name: t.name,
      fields,
      enumValues: (t.enumValues ?? []).map((e) => ({
        name: e.name,
        ...(e.description ? { description: e.description } : {}),
      })),
      ...(t.description ? { description: t.description } : {}),
    });
  }
  return { queryType: schema.queryType?.name ?? "Query", types };
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

/** Maximum items returned in one view before it is truncated with a pointer to narrow the request. */
export const MAX_VIEW_ITEMS = 60;
/** Descriptions longer than this are cut (ends with "…") so one verbose field cannot dominate a response. */
export const MAX_DESCRIPTION_CHARS = 800;

function clip(text: string | undefined): string | undefined {
  if (!text) return undefined;
  return text.length > MAX_DESCRIPTION_CHARS ? `${text.slice(0, MAX_DESCRIPTION_CHARS)}…` : text;
}

function firstSentence(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const line = text.split("\n")[0]!.trim();
  const m = /^(.+?[.!?])(\s|$)/.exec(line);
  const sentence = m ? m[1]! : line;
  return sentence.length > 200 ? `${sentence.slice(0, 200)}…` : sentence;
}

/** Strip `[`, `]`, `!` to get the named type. */
export function namedType(typeText: string): string {
  return typeText.replace(/[[\]!]/g, "");
}

/**
 * Things agents ask about that are NOT in CCM GraphQL; point at the resource that does serve them. Keys are matched
 * as lowercase substrings of the lookup name.
 */
export const REDIRECTS: ReadonlyArray<{ match: RegExp; resource: string; note: string }> = [
  { match: /commitment|savings.?plan|reserved|coverage|utili[sz]ation/i, resource: "cost_commitment", note: "Commitment coverage, utilization and savings are not in CCM GraphQL." },
  { match: /anomal/i, resource: "cost_anomaly", note: "Cost anomalies are served over REST, not GraphQL." },
  { match: /category|bucket|business.?context/i, resource: "cost_category", note: "Cost categories are served over REST, not GraphQL." },
  { match: /ai.?budget|llm|lightwing/i, resource: "ai_budget", note: "AI/LLM spend budgets are not in CCM GraphQL." },
];

function redirectFor(name: string): { resource: string; note: string } | undefined {
  const hit = REDIRECTS.find((r) => r.match.test(name));
  return hit ? { resource: hit.resource, note: hit.note } : undefined;
}

export interface ListView {
  total: number;
  queries: Array<{ name: string; description?: string; args: string[]; returns: string }>;
  truncated?: boolean;
  /** Topics that are not in CCM GraphQL, with the resource that serves them. */
  not_in_graphql: Array<{ resource: string; note: string }>;
  hint: string;
}

/** Root queries as a compact list: name, first sentence, argument names (`!` = required), return type. */
export function listQueries(model: SchemaModel): ListView {
  const all = model.types.get(model.queryType)?.fields ?? [];
  const shown = all.slice(0, MAX_VIEW_ITEMS);
  const view: ListView = {
    total: all.length,
    queries: shown.map((f) => ({
      name: f.name,
      ...(firstSentence(f.description) ? { description: firstSentence(f.description) } : {}),
      args: f.args.map((a) => (a.required ? `${a.name}!` : a.name)),
      returns: f.type,
    })),
    not_in_graphql: REDIRECTS.map((r) => ({ resource: r.resource, note: r.note })),
    hint: 'Pass path=<query name> for typed arguments and return fields, then path=<type name> to expand an argument or return type. Args marked ! are required. Queries whose description starts with "WRITE:" change data.',
  };
  if (all.length > shown.length) view.truncated = true;
  return view;
}

export interface TypeView {
  kind: "query" | "type";
  name: string;
  typeKind?: SchemaTypeKind;
  description?: string;
  returns?: string;
  args?: SchemaArg[];
  fields?: Array<{ name: string; type: string; description?: string; required?: boolean; deprecated?: boolean }>;
  values?: SchemaEnumValue[];
  truncated?: boolean;
  next: string[];
}

function fieldView(f: SchemaField, isInput: boolean): NonNullable<TypeView["fields"]>[number] {
  return {
    name: f.name,
    type: f.type,
    ...(clip(f.description) ? { description: clip(f.description) } : {}),
    ...(isInput && f.type.endsWith("!") ? { required: true } : {}),
    ...(f.deprecated ? { deprecated: true } : {}),
  };
}

function customTypeNames(model: SchemaModel, typeTexts: string[]): string[] {
  const out = new Set<string>();
  for (const t of typeTexts) {
    const n = namedType(t);
    const def = model.types.get(n);
    if (def && def.kind !== "SCALAR") out.add(n);
  }
  return [...out];
}

/**
 * Resolve a lookup name to a root query (preferred) or a named type, returning a bounded view.
 * Returns an object with `error` and a redirect/hint when nothing matches.
 */
export function getSchemaItem(model: SchemaModel, name: string): TypeView | { error: string; hint: string } {
  const root = model.types.get(model.queryType);
  const query = root?.fields.find((f) => f.name === name);
  if (query) {
    const returnType = model.types.get(namedType(query.type));
    const returnFields = (returnType?.fields ?? []).slice(0, MAX_VIEW_ITEMS);
    const view: TypeView = {
      kind: "query",
      name: query.name,
      returns: query.type,
      args: query.args.map((a) => ({ ...a, ...(clip(a.description) ? { description: clip(a.description) } : {}) })),
      fields: returnFields.map((f) => fieldView(f, false)),
      ...(clip(query.description) ? { description: clip(query.description) } : {}),
      next: customTypeNames(model, [...query.args.map((a) => a.type), ...returnFields.map((f) => f.type)]),
    };
    if ((returnType?.fields.length ?? 0) > returnFields.length) view.truncated = true;
    return view;
  }

  const type = model.types.get(name);
  if (type) {
    const isInput = type.kind === "INPUT_OBJECT";
    const fields = type.fields.slice(0, MAX_VIEW_ITEMS);
    const values = type.enumValues.slice(0, MAX_VIEW_ITEMS).map((v) => ({
      name: v.name,
      ...(clip(v.description) ? { description: clip(v.description) } : {}),
    }));
    const view: TypeView = {
      kind: "type",
      name: type.name,
      typeKind: type.kind,
      ...(clip(type.description) ? { description: clip(type.description) } : {}),
      ...(fields.length ? { fields: fields.map((f) => fieldView(f, isInput)) } : {}),
      ...(values.length ? { values } : {}),
      next: customTypeNames(model, fields.map((f) => f.type)),
    };
    if (type.fields.length > fields.length || type.enumValues.length > values.length) view.truncated = true;
    return view;
  }

  const redirect = redirectFor(name);
  return {
    error: `No GraphQL query or type named "${name}".`,
    hint: redirect
      ? `${redirect.note} Use resource_type=${redirect.resource} instead.`
      : 'Call harness_schema with resource_type="cost_graphql" and no path to list the available queries.',
  };
}
