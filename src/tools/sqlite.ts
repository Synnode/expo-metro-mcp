import { z } from "zod";
import { metroClient } from "../metro-client.js";
import { assertSqliteReadStatement, assertWritesAllowed } from "../safety.js";

const SQLITE_ROOT = "globalThis.__EXPO_METRO_MCP__?.sqlite";

const BindParam = z.union([z.string(), z.number(), z.boolean(), z.null()]);

export const SqliteQuerySchema = z.object({
  sql: z.string().min(1).max(100_000),
  params: z.array(BindParam).optional().default([]),
  timeout_ms: z.coerce.number().int().min(100).max(30_000).optional().default(5_000),
});

export const SqliteExecSchema = z.object({
  sql: z.string().min(1).max(100_000),
  params: z.array(BindParam).optional().default([]),
  timeout_ms: z.coerce.number().int().min(100).max(30_000).optional().default(5_000),
});

export const SqliteTablesSchema = z.object({
  timeout_ms: z.coerce.number().int().min(100).max(30_000).optional().default(5_000),
});

export const SqliteSchemaSchema = z.object({
  table: z.string().min(1).max(200),
  timeout_ms: z.coerce.number().int().min(100).max(30_000).optional().default(5_000),
});

function escapeForJs(value: unknown): string {
  return JSON.stringify(value);
}

function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function resultOrObject(value: unknown): object | null {
  return value && typeof value === "object" ? (value as object) : null;
}

async function evaluateJson(code: string, timeoutMs: number): Promise<unknown> {
  const response = await metroClient.evaluate(code, timeoutMs);

  if (response.error) {
    throw new Error(response.error.message ?? "CDP evaluation failed.");
  }

  const result =
    response.result && typeof resultOrObject(response.result) === "object"
      ? (resultOrObject(response.result) as Record<string, unknown>)
      : undefined;

  const exceptionDetails =
    result?.exceptionDetails && typeof resultOrObject(result.exceptionDetails) === "object"
      ? (result.exceptionDetails as Record<string, unknown>)
      : undefined;
  if (exceptionDetails) {
    const text = typeof exceptionDetails.text === "string" ? exceptionDetails.text : "Runtime evaluation failed.";
    const exception =
      exceptionDetails.exception && typeof resultOrObject(exceptionDetails.exception) === "object"
        ? (exceptionDetails.exception as Record<string, unknown>)
        : undefined;
    const description =
      typeof exception?.description === "string"
        ? exception.description
        : typeof exception?.value === "string"
          ? exception.value
          : undefined;
    throw new Error(description ? `${text}\n${description}` : text);
  }

  const remoteResult =
    result?.result && typeof resultOrObject(result.result) === "object"
      ? (result.result as Record<string, unknown>)
      : undefined;

  return remoteResult?.value;
}

function sqliteBootstrapExpression(inner: string): string {
  return `(async () => {
    const sqlite = ${SQLITE_ROOT};
    if (!sqlite) {
      throw new Error("SQLite debug hook not found at globalThis.__EXPO_METRO_MCP__.sqlite");
    }
    if (typeof sqlite.query !== "function" || typeof sqlite.run !== "function") {
      throw new Error("SQLite debug hook is present but missing one or more required methods: query, run");
    }
    return (${inner})();
  })()`;
}

function assertSafeIdentifier(name: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(name)) {
    throw new Error(
      `Table name "${name}" is not a plain SQLite identifier. Quote-heavy or expression names aren't supported by sqlite_schema.`
    );
  }
}

export async function sqliteQuery(params: z.infer<typeof SqliteQuerySchema>): Promise<string> {
  assertSqliteReadStatement(params.sql);
  const value = await evaluateJson(
    sqliteBootstrapExpression(
      `async () => ({ rows: await sqlite.query(${escapeForJs(params.sql)}, ${escapeForJs(params.params)}) })`
    ),
    params.timeout_ms
  );
  const rows = value && typeof value === "object" && !Array.isArray(value) ? (value as { rows?: unknown }).rows : [];
  const list = Array.isArray(rows) ? rows : [];
  return formatJson({ rowCount: list.length, rows: list });
}

export async function sqliteExec(params: z.infer<typeof SqliteExecSchema>): Promise<string> {
  assertWritesAllowed("sqlite_exec");
  const value = await evaluateJson(
    sqliteBootstrapExpression(
      `async () => {
        const r = await sqlite.run(${escapeForJs(params.sql)}, ${escapeForJs(params.params)});
        return { changes: r?.changes ?? null, lastInsertRowId: r?.lastInsertRowId ?? null };
      }`
    ),
    params.timeout_ms
  );
  return formatJson(value);
}

export async function sqliteTables(params: z.infer<typeof SqliteTablesSchema>): Promise<string> {
  const value = await evaluateJson(
    sqliteBootstrapExpression(
      `async () => ({ tables: await sqlite.query("SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY type, name", []) })`
    ),
    params.timeout_ms
  );
  const tables = value && typeof value === "object" && !Array.isArray(value) ? (value as { tables?: unknown }).tables : [];
  const list = Array.isArray(tables) ? tables : [];
  return formatJson({ count: list.length, tables: list });
}

export async function sqliteSchema(params: z.infer<typeof SqliteSchemaSchema>): Promise<string> {
  assertSafeIdentifier(params.table);
  const value = await evaluateJson(
    sqliteBootstrapExpression(
      `async () => {
        const columns = await sqlite.query('PRAGMA table_info("${params.table}")', []);
        const created = await sqlite.query("SELECT sql FROM sqlite_master WHERE name = ?", [${escapeForJs(params.table)}]);
        const foreignKeys = await sqlite.query('PRAGMA foreign_key_list("${params.table}")', []);
        const indexes = await sqlite.query('PRAGMA index_list("${params.table}")', []);
        return {
          table: ${escapeForJs(params.table)},
          sql: (created && created[0] && created[0].sql) ?? null,
          columns,
          foreignKeys,
          indexes,
        };
      }`
    ),
    params.timeout_ms
  );
  return formatJson(value);
}
