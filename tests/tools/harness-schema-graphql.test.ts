import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ToolResult } from "../../src/utils/response-formatter.js";
import type { HarnessClient } from "../../src/client/harness-client.js";
import { Registry } from "../../src/registry/index.js";
import type { Config } from "../../src/config.js";
import { registerSchemaTool } from "../../src/tools/harness-schema.js";
import {
  createGraphqlSchemaFetcher,
  GRAPHQL_SCHEMA_TTL_MS,
} from "../../src/tools/entity-schema/graphql.js";
import { INTROSPECTION_QUERY } from "../../src/utils/graphql-introspection.js";

const scalar = (name: string) => ({ kind: "SCALAR", name });
const nonNull = (t: unknown) => ({ kind: "NON_NULL", name: null, ofType: t });
const obj = (name: string) => ({ kind: "OBJECT", name });
const inp = (name: string) => ({ kind: "INPUT_OBJECT", name });

const INTROSPECTION_RESPONSE = {
  data: {
    __schema: {
      queryType: { name: "Query" },
      types: [
        {
          kind: "OBJECT",
          name: "Query",
          fields: [
            {
              name: "perspectiveGrid",
              description: "Cost table. Use for top N questions.",
              args: [
                { name: "groupBy", description: "Grouping.", type: inp("GroupByInput") },
                { name: "limit", type: nonNull(scalar("Int")) },
              ],
              type: obj("GridData"),
            },
            { name: "changeRecommendationState", description: "WRITE: changes data.", args: [], type: scalar("Boolean") },
          ],
        },
        { kind: "OBJECT", name: "GridData", fields: [{ name: "data", args: [], type: scalar("String") }] },
        {
          kind: "INPUT_OBJECT",
          name: "GroupByInput",
          inputFields: [{ name: "fieldId", type: nonNull(scalar("String")) }],
        },
      ],
    },
  },
};

function makeMcpServer() {
  const tools = new Map<string, { handler: (...args: unknown[]) => Promise<ToolResult> }>();
  return {
    registerTool: vi.fn((name: string, _schema: unknown, handler: (...args: unknown[]) => Promise<ToolResult>) => {
      tools.set(name, { handler });
    }),
    async call(name: string, args: Record<string, unknown>): Promise<ToolResult> {
      const tool = tools.get(name);
      if (!tool) throw new Error(`Tool "${name}" not registered`);
      const extra = { signal: new AbortController().signal, sendNotification: vi.fn(), _meta: {} };
      return tool.handler(args, extra) as Promise<ToolResult>;
    },
  } as any;
}

function parse(result: ToolResult): Record<string, any> {
  return JSON.parse(result.content[0]!.text);
}

function makeClient(request: ReturnType<typeof vi.fn>): HarnessClient {
  return { account: "acct-123", request } as unknown as HarnessClient;
}

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    HARNESS_API_KEY: "pat.test",
    HARNESS_ACCOUNT_ID: "test-account",
    HARNESS_BASE_URL: "https://app.harness.io",
    HARNESS_API_TIMEOUT_MS: 30000,
    HARNESS_MAX_RETRIES: 3,
    HARNESS_MAX_BODY_SIZE_MB: 10,
    HARNESS_RATE_LIMIT_RPS: 10,
    HARNESS_READ_ONLY: false,
    HARNESS_SKIP_ELICITATION: false,
    HARNESS_ALLOW_HTTP: false,
    HARNESS_FME_BASE_URL: "https://api.split.io",
    LOG_LEVEL: "info",
    ...overrides,
  } as Config;
}

function registeredDescription(server: ReturnType<typeof makeMcpServer>): string {
  const call = server.registerTool.mock.calls.find((c: unknown[]) => c[0] === "harness_schema");
  return (call![1] as { description: string }).description;
}

describe("harness_schema cost_graphql", () => {
  let server: ReturnType<typeof makeMcpServer>;
  let request: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    server = makeMcpServer();
    request = vi.fn().mockResolvedValue(INTROSPECTION_RESPONSE);
    registerSchemaTool(server, undefined, makeClient(request), undefined);
  });

  it("is advertised in the tool description", () => {
    expect(registeredDescription(server)).toContain("cost_graphql");
  });

  it("without path lists the root queries and what is not in GraphQL", async () => {
    const out = parse(await server.call("harness_schema", { resource_type: "cost_graphql" }));
    expect(out.resource_type).toBe("cost_graphql");
    expect(out.source).toBe("graphql-introspection");
    expect(out.available_sections).toEqual(["perspectiveGrid", "changeRecommendationState"]);
    const grid = out.queries.find((q: { name: string }) => q.name === "perspectiveGrid");
    expect(grid.args).toEqual(["groupBy", "limit!"]);
    expect(out.not_in_graphql.map((r: { resource: string }) => r.resource)).toContain("cost_commitment");
  });

  it("sends the introspection query as a POST to the CCM GraphQL endpoint", async () => {
    await server.call("harness_schema", { resource_type: "cost_graphql" });
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "POST",
        path: "/ccm/api/graphql",
        body: { query: INTROSPECTION_QUERY, operationName: "CcmSchemaIntrospection" },
      }),
    );
  });

  it("path=<query> returns typed arguments and the next types to expand", async () => {
    const out = parse(await server.call("harness_schema", { resource_type: "cost_graphql", path: "perspectiveGrid" }));
    expect(out.kind).toBe("query");
    expect(out.path).toBe("perspectiveGrid");
    expect(out.args.map((a: { name: string; required: boolean }) => [a.name, a.required])).toEqual([
      ["groupBy", false],
      ["limit", true],
    ]);
    expect(out.next).toContain("GroupByInput");
  });

  it("path=<type> expands an input type with required flags", async () => {
    const out = parse(await server.call("harness_schema", { resource_type: "cost_graphql", path: "GroupByInput" }));
    expect(out.kind).toBe("type");
    expect(out.fields).toEqual([{ name: "fieldId", type: "String!", required: true }]);
  });

  it("an unknown path is an error that names the next step", async () => {
    const result = await server.call("harness_schema", { resource_type: "cost_graphql", path: "nope" });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("harness_schema");
  });

  it("an unknown path about commitments points at the resource that serves it", async () => {
    const result = await server.call("harness_schema", { resource_type: "cost_graphql", path: "commitmentCoverage" });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("cost_commitment");
  });

  it("fetches once for repeated calls", async () => {
    await server.call("harness_schema", { resource_type: "cost_graphql" });
    await server.call("harness_schema", { resource_type: "cost_graphql", path: "perspectiveGrid" });
    await server.call("harness_schema", { resource_type: "cost_graphql", path: "GroupByInput" });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("surfaces a GraphQL error response as a tool error", async () => {
    request.mockResolvedValueOnce({ errors: [{ message: "introspection disabled" }] });
    const fresh = makeMcpServer();
    registerSchemaTool(fresh, undefined, makeClient(request), undefined);
    const result = await fresh.call("harness_schema", { resource_type: "cost_graphql" });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("introspection disabled");
  });
});

describe("cost_graphql availability", () => {
  it("is not offered without a client", () => {
    const server = makeMcpServer();
    registerSchemaTool(server, undefined, undefined, undefined);
    expect(registeredDescription(server)).not.toContain("cost_graphql");
  });

  it("is offered when the ccm toolset is enabled", () => {
    const server = makeMcpServer();
    const registry = new Registry(makeConfig({ HARNESS_TOOLSETS: "ccm" }));
    registerSchemaTool(server, registry, makeClient(vi.fn()), undefined);
    expect(registeredDescription(server)).toContain("cost_graphql");
  });

  it("is not offered when the ccm toolset is disabled", () => {
    const server = makeMcpServer();
    const registry = new Registry(makeConfig({ HARNESS_TOOLSETS: "pipelines" }));
    registerSchemaTool(server, registry, makeClient(vi.fn()), undefined);
    expect(registeredDescription(server)).not.toContain("cost_graphql");
  });
});

describe("createGraphqlSchemaFetcher cache", () => {
  it("refetches after the TTL and not before", async () => {
    let clock = 1_000;
    const request = vi.fn().mockResolvedValue(INTROSPECTION_RESPONSE);
    const fetcher = createGraphqlSchemaFetcher(makeClient(request), () => clock);

    await fetcher.summary();
    clock += GRAPHQL_SCHEMA_TTL_MS - 1;
    await fetcher.summary();
    expect(request).toHaveBeenCalledTimes(1);

    clock += 2;
    await fetcher.summary();
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("does not cache a failure", async () => {
    const request = vi
      .fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValue(INTROSPECTION_RESPONSE);
    const fetcher = createGraphqlSchemaFetcher(makeClient(request));

    await expect(fetcher.summary()).rejects.toThrow("boom");
    await expect(fetcher.summary()).resolves.toMatchObject({ resource_type: "cost_graphql" });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("shares one request between concurrent callers", async () => {
    const request = vi.fn().mockResolvedValue(INTROSPECTION_RESPONSE);
    const fetcher = createGraphqlSchemaFetcher(makeClient(request));
    await Promise.all([fetcher.summary(), fetcher.item("perspectiveGrid"), fetcher.item("GroupByInput")]);
    expect(request).toHaveBeenCalledTimes(1);
  });
});
