import { z } from "zod";
import { metroClient } from "../metro-client.js";
import { assertSqliteReadStatement, assertWritesAllowed } from "../safety.js";

const ROOT = "globalThis.__EXPO_METRO_MCP__";

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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

// The Metro/fusebox CDP inspector does not honor Runtime.evaluate's
// `awaitPromise`: a promise that settles on a later tick is serialized as an
// empty object and rejections are swallowed. SQLite access is genuinely async
// (native callbacks), unlike the synchronous MMKV hook, so we cannot rely on
// awaiting inside the eval. Instead we drive it with synchronous evals only:
// one eval starts the operation and stashes its outcome on a global slot, then
// we poll that slot synchronously until it settles. Promise.resolve() wrapping
// makes this transparent for both sync (getAllSync) and async (getAllAsync) hooks.

const HOOK_GUARD = `
    const root = ${ROOT};
    const sqlite = root && root.sqlite;
    if (!sqlite) {
      throw new Error("SQLite debug hook not found at globalThis.__EXPO_METRO_MCP__.sqlite");
    }
    if (typeof sqlite.query !== "function" || typeof sqlite.run !== "function") {
      throw new Error("SQLite debug hook is present but missing one or more required methods: query, run");
    }`;

function startExpression(operation: string): string {
  return `(() => {${HOOK_GUARD}
    const jobs = (root.__mcpSqliteJobs = root.__mcpSqliteJobs || {});
    const id = "sqlite_" + (root.__mcpSqliteSeq = (root.__mcpSqliteSeq || 0) + 1) + "_" + Date.now();
    jobs[id] = { done: false };
    Promise.resolve().then(${operation}).then(
      (value) => { jobs[id] = { done: true, ok: true, value: value }; },
      (err) => { jobs[id] = { done: true, ok: false, error: (err && err.message) ? String(err.message) : String(err) }; }
    );
    return { id: id };
  })()`;
}

function pollExpression(id: string): string {
  return `(() => {
    const root = ${ROOT};
    const jobs = root && root.__mcpSqliteJobs;
    const job = jobs && jobs[${escapeForJs(id)}];
    if (!job) return { missing: true };
    if (!job.done) return { done: false };
    delete jobs[${escapeForJs(id)}];
    return { done: true, ok: !!job.ok, value: job.value, error: job.error };
  })()`;
}

function cleanupExpression(id: string): string {
  return `(() => {
    const jobs = ${ROOT} && ${ROOT}.__mcpSqliteJobs;
    if (jobs) delete jobs[${escapeForJs(id)}];
    return { cleaned: true };
  })()`;
}

async function runSqliteJob(operation: string, timeoutMs: number): Promise<unknown> {
  const started = (await evaluateJson(startExpression(operation), Math.min(timeoutMs, 30_000))) as
    | { id?: string }
    | undefined;
  const id = started && typeof started.id === "string" ? started.id : undefined;
  if (!id) {
    throw new Error("Failed to start the SQLite job in the app runtime.");
  }

  const start = Date.now();
  const pollInterval = 50;

  for (;;) {
    const status = (await evaluateJson(pollExpression(id), 5_000)) as
      | { missing?: boolean; done?: boolean; ok?: boolean; value?: unknown; error?: string }
      | undefined;

    if (status?.missing) {
      throw new Error("SQLite job vanished from the app runtime before it finished. Was the app reloaded mid-query?");
    }
    if (status?.done) {
      if (status.ok) return status.value;
      throw new Error(status.error ?? "SQLite operation failed in the app runtime.");
    }
    if (Date.now() - start >= timeoutMs) {
      await evaluateJson(cleanupExpression(id), 2_000).catch(() => undefined);
      throw new Error(`SQLite operation timed out after ${timeoutMs}ms.`);
    }
    await delay(pollInterval);
  }
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
  const operation = `async () => ({ rows: await sqlite.query(${escapeForJs(params.sql)}, ${escapeForJs(params.params)}) })`;
  const value = await runSqliteJob(operation, params.timeout_ms);
  const rows = value && typeof value === "object" && !Array.isArray(value) ? (value as { rows?: unknown }).rows : [];
  const list = Array.isArray(rows) ? rows : [];
  return formatJson({ rowCount: list.length, rows: list });
}

export async function sqliteExec(params: z.infer<typeof SqliteExecSchema>): Promise<string> {
  assertWritesAllowed("sqlite_exec");
  const operation = `async () => {
        const r = await sqlite.run(${escapeForJs(params.sql)}, ${escapeForJs(params.params)});
        return { changes: (r && r.changes != null) ? r.changes : null, lastInsertRowId: (r && r.lastInsertRowId != null) ? r.lastInsertRowId : null };
      }`;
  const value = await runSqliteJob(operation, params.timeout_ms);
  return formatJson(value);
}

export async function sqliteTables(params: z.infer<typeof SqliteTablesSchema>): Promise<string> {
  const operation = `async () => ({ tables: await sqlite.query("SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY type, name", []) })`;
  const value = await runSqliteJob(operation, params.timeout_ms);
  const tables = value && typeof value === "object" && !Array.isArray(value) ? (value as { tables?: unknown }).tables : [];
  const list = Array.isArray(tables) ? tables : [];
  return formatJson({ count: list.length, tables: list });
}

export async function sqliteSchema(params: z.infer<typeof SqliteSchemaSchema>): Promise<string> {
  assertSafeIdentifier(params.table);
  const operation = `async () => {
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
      }`;
  const value = await runSqliteJob(operation, params.timeout_ms);
  return formatJson(value);
}
