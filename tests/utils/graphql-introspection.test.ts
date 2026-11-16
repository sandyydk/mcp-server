import { describe, it, expect } from "vitest";
import {
  INTROSPECTION_QUERY,
  IntrospectionError,
  MAX_DESCRIPTION_CHARS,
  MAX_VIEW_ITEMS,
  getSchemaItem,
  listQueries,
  parseIntrospection,
  typeRefToString,
  type TypeView,
} from "../../src/utils/graphql-introspection.js";

const named = (name: string) => ({ kind: "OBJECT", name });
const scalar = (name: string) => ({ kind: "SCALAR", name });
const nonNull = (t: unknown) => ({ kind: "NON_NULL", name: null, ofType: t });
const list = (t: unknown) => ({ kind: "LIST", name: null, ofType: t });
const input = (n: string) => ({ kind: "INPUT_OBJECT", name: n });

function fixture(extra: unknown[] = [], queryFields?: unknown[]) {
  return {
    data: {
      __schema: {
        queryType: { name: "Query" },
        types: [
          {
            kind: "OBJECT",
            name: "Query",
            fields: queryFields ?? [
              {
                name: "perspectiveGrid",
                description: "Cost grid for a perspective. Use groupBy to pivot.\nSecond line.",
                args: [
                  { name: "filters", description: "Filters.", type: list(input("QLCEViewFilterWrapperInput")) },
                  { name: "groupBy", type: list(input("QLCEViewGroupByInput")) },
                  { name: "limit", type: nonNull(scalar("Int")) },
                  { name: "offset", defaultValue: "0", type: nonNull(scalar("Int")) },
                ],
                type: nonNull(named("PerspectiveData")),
              },
              {
                name: "changeRecommendationState",
                description: "Writes.",
                args: [],
                type: scalar("Boolean"),
              },
            ],
          },
          {
            kind: "OBJECT",
            name: "PerspectiveData",
            fields: [
              { name: "data", args: [], type: list(named("GridRow")) },
              { name: "total", args: [], isDeprecated: true, type: scalar("Int") },
            ],
          },
          { kind: "INPUT_OBJECT", name: "QLCEViewFilterWrapperInput", inputFields: [{ name: "idFilter", type: scalar("String") }] },
          { kind: "OBJECT", name: "GridRow", fields: [{ name: "id", args: [], type: scalar("String") }] },
          {
            kind: "INPUT_OBJECT",
            name: "QLCEViewGroupByInput",
            description: "Group by.",
            inputFields: [
              { name: "fieldId", type: nonNull(scalar("String")) },
              { name: "identifier", description: "Which source.", type: nonNull({ kind: "ENUM", name: "Source" }) },
              { name: "label", type: scalar("String") },
            ],
          },
          {
            kind: "ENUM",
            name: "Source",
            enumValues: [{ name: "AWS", description: "Amazon." }, { name: "GCP" }],
          },
          { kind: "OBJECT", name: "__Schema", fields: [] },
          ...extra,
        ],
      },
    },
  };
}

describe("INTROSPECTION_QUERY", () => {
  it("is a read-only query that stays small", () => {
    expect(INTROSPECTION_QUERY.trimStart().startsWith("query")).toBe(true);
    expect(INTROSPECTION_QUERY).not.toMatch(/mutation|subscription/);
    // Backend complexity cap is 1000; every field counts once. Keep a wide margin.
    const fieldish = INTROSPECTION_QUERY.match(/\b[a-zA-Z_]+\b(?=\s*[{(\n}])/g) ?? [];
    expect(fieldish.length).toBeLessThan(200);
  });
});

describe("typeRefToString", () => {
  it("renders lists and non-null wrappers", () => {
    expect(typeRefToString(nonNull(list(nonNull(scalar("Int")))))).toBe("[Int!]!");
    expect(typeRefToString(list(input("X")))).toBe("[X]");
    expect(typeRefToString(undefined)).toBe("Unknown");
  });
});

describe("parseIntrospection", () => {
  it("normalises types, skips introspection types, and marks required args", () => {
    const model = parseIntrospection(fixture());
    expect(model.queryType).toBe("Query");
    expect(model.types.has("__Schema")).toBe(false);
    const grid = model.types.get("Query")!.fields[0]!;
    const byName = Object.fromEntries(grid.args.map((a) => [a.name, a]));
    expect(byName.limit!.required).toBe(true);
    expect(byName.offset!.required).toBe(false); // has a default
    expect(byName.offset!.defaultValue).toBe("0");
    expect(byName.filters!.required).toBe(false);
    expect(grid.type).toBe("PerspectiveData!");
  });

  it("accepts the bare __schema object", () => {
    const model = parseIntrospection({ __schema: fixture().data.__schema });
    expect(model.types.has("Query")).toBe(true);
  });

  it("throws a readable error for GraphQL errors and bad shapes", () => {
    expect(() => parseIntrospection({ errors: [{ message: "denied" }] })).toThrow(IntrospectionError);
    expect(() => parseIntrospection({ errors: [{ message: "denied" }] })).toThrow(/denied/);
    expect(() => parseIntrospection({ data: {} })).toThrow(/__schema/);
    expect(() => parseIntrospection(null)).toThrow(IntrospectionError);
  });
});

describe("listQueries", () => {
  const model = parseIntrospection(fixture());

  it("lists queries with first-sentence descriptions and required markers", () => {
    const view = listQueries(model);
    expect(view.total).toBe(2);
    const grid = view.queries.find((q) => q.name === "perspectiveGrid")!;
    expect(grid.description).toBe("Cost grid for a perspective.");
    expect(grid.args).toEqual(["filters", "groupBy", "limit!", "offset"]);
    expect(grid.returns).toBe("PerspectiveData!");
  });

  it("lists what is not in GraphQL with the resource that serves it", () => {
    const view = listQueries(model);
    expect(view.not_in_graphql.map((r) => r.resource)).toEqual(
      expect.arrayContaining(["cost_commitment", "cost_anomaly", "cost_category", "ai_budget"]),
    );
    expect(view.hint).toContain("WRITE:");
  });

  it("truncates beyond the cap and says so", () => {
    const many = Array.from({ length: MAX_VIEW_ITEMS + 5 }, (_, i) => ({
      name: `q${i}`,
      args: [],
      type: scalar("Int"),
    }));
    const view = listQueries(parseIntrospection(fixture([], many)));
    expect(view.queries).toHaveLength(MAX_VIEW_ITEMS);
    expect(view.total).toBe(MAX_VIEW_ITEMS + 5);
    expect(view.truncated).toBe(true);
  });
});

describe("getSchemaItem", () => {
  const model = parseIntrospection(fixture());

  it("describes a root query with args, return fields, and what to expand next", () => {
    const view = getSchemaItem(model, "perspectiveGrid") as TypeView;
    expect(view.kind).toBe("query");
    expect(view.args!.map((a) => a.name)).toEqual(["filters", "groupBy", "limit", "offset"]);
    expect(view.fields!.map((f) => f.name)).toEqual(["data", "total"]);
    expect(view.fields![1]!.deprecated).toBe(true);
    expect(view.next).toEqual(expect.arrayContaining(["QLCEViewFilterWrapperInput", "QLCEViewGroupByInput", "GridRow"]));
    expect(view.next).not.toContain("Int");
  });

  it("describes an input type with required flags", () => {
    const view = getSchemaItem(model, "QLCEViewGroupByInput") as TypeView;
    expect(view.typeKind).toBe("INPUT_OBJECT");
    const req = Object.fromEntries(view.fields!.map((f) => [f.name, f.required ?? false]));
    expect(req).toEqual({ fieldId: true, identifier: true, label: false });
    expect(view.next).toEqual(["Source"]);
  });

  it("lists enum values with descriptions", () => {
    const view = getSchemaItem(model, "Source") as TypeView;
    expect(view.values).toEqual([{ name: "AWS", description: "Amazon." }, { name: "GCP" }]);
  });

  it("clips very long descriptions", () => {
    const long = "x".repeat(MAX_DESCRIPTION_CHARS + 50);
    const m = parseIntrospection(fixture([{ kind: "ENUM", name: "Big", description: long, enumValues: [] }]));
    const view = getSchemaItem(m, "Big") as TypeView;
    expect(view.description!.length).toBe(MAX_DESCRIPTION_CHARS + 1);
    expect(view.description!.endsWith("…")).toBe(true);
  });

  it("reports truncation for types with many fields", () => {
    const fields = Array.from({ length: MAX_VIEW_ITEMS + 3 }, (_, i) => ({ name: `f${i}`, args: [], type: scalar("Int") }));
    const m = parseIntrospection(fixture([{ kind: "OBJECT", name: "Wide", fields }]));
    const view = getSchemaItem(m, "Wide") as TypeView;
    expect(view.fields).toHaveLength(MAX_VIEW_ITEMS);
    expect(view.truncated).toBe(true);
  });

  it("returns an error with a redirect for things not in GraphQL", () => {
    const miss = getSchemaItem(model, "commitmentCoverage") as { error: string; hint: string };
    expect(miss.error).toContain("commitmentCoverage");
    expect(miss.hint).toContain("cost_commitment");
    const plain = getSchemaItem(model, "nope") as { error: string; hint: string };
    expect(plain.hint).toContain("harness_schema");
    expect(plain.hint).toContain("cost_graphql");
  });
});
