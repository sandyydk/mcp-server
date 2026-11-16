import type { HarnessClient } from "../../client/harness-client.js";
import {
  INTROSPECTION_QUERY,
  getSchemaItem,
  listQueries,
  parseIntrospection,
  type SchemaModel,
} from "../../utils/graphql-introspection.js";

/** `harness_schema` resource_type that serves the CCM GraphQL schema. */
export const GRAPHQL_SCHEMA_RESOURCE_TYPE = "cost_graphql";

/** Toolset that owns the CCM GraphQL endpoint; the schema is only offered when it is enabled. */
export const GRAPHQL_SCHEMA_TOOLSET = "ccm";

const GRAPHQL_PATH = "/ccm/api/graphql";
const SOURCE = "graphql-introspection";

/** How long a fetched schema is reused. The schema only changes on a backend deploy. */
export const GRAPHQL_SCHEMA_TTL_MS = 10 * 60 * 1000;

export interface GraphqlSchemaFetcher {
  summary(): Promise<Record<string, unknown>>;
  /** Drill into a root query or a type by name. */
  item(path: string): Promise<{ ok: true; result: Record<string, unknown> } | { ok: false; message: string }>;
}

/**
 * Reads the CCM GraphQL schema over introspection and answers `harness_schema` lookups from it.
 * The model is cached per client (one account, one base URL); failures are not cached.
 */
export function createGraphqlSchemaFetcher(client: HarnessClient, now: () => number = Date.now): GraphqlSchemaFetcher {
  let cached: { model: SchemaModel; fetchedAt: number } | undefined;
  let inFlight: Promise<SchemaModel> | undefined;

  async function load(): Promise<SchemaModel> {
    if (cached && now() - cached.fetchedAt < GRAPHQL_SCHEMA_TTL_MS) return cached.model;
    inFlight ??= client
      .request<unknown>({
        method: "POST",
        path: GRAPHQL_PATH,
        body: { query: INTROSPECTION_QUERY, operationName: "CcmSchemaIntrospection" },
      })
      .then((raw) => {
        const model = parseIntrospection(raw);
        cached = { model, fetchedAt: now() };
        return model;
      })
      .finally(() => {
        inFlight = undefined;
      });
    return inFlight;
  }

  return {
    async summary() {
      const model = await load();
      const view = listQueries(model);
      return {
        resource_type: GRAPHQL_SCHEMA_RESOURCE_TYPE,
        source: SOURCE,
        available_sections: view.queries.map((q) => q.name),
        ...view,
      };
    },

    async item(path: string) {
      const model = await load();
      const view = getSchemaItem(model, path);
      if ("error" in view) {
        return { ok: false, message: `${view.error} ${view.hint}` };
      }
      return { ok: true, result: { resource_type: GRAPHQL_SCHEMA_RESOURCE_TYPE, path, source: SOURCE, ...view } };
    },
  };
}
