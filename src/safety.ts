const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);

function envFlag(name: string, defaultValue = false): boolean {
  const raw = process.env[name];
  if (raw == null) return defaultValue;
  return TRUE_VALUES.has(raw.trim().toLowerCase());
}

function envList(name: string): string[] {
  const raw = process.env[name];
  if (!raw) return [];
  return raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

export const safetyConfig = {
  readOnly: envFlag("EXPO_METRO_MCP_READ_ONLY"),
  enableEval: envFlag("EXPO_METRO_MCP_ENABLE_EVAL"),
  mmkvPrefixAllowlist: envList("EXPO_METRO_MCP_MMKV_PREFIX_ALLOWLIST"),
};

export function assertWritesAllowed(toolName: string): void {
  if (safetyConfig.readOnly) {
    throw new Error(`${toolName} is disabled because EXPO_METRO_MCP_READ_ONLY=1.`);
  }
}

export function assertMmkvKeyAllowed(key: string): void {
  const { mmkvPrefixAllowlist } = safetyConfig;
  if (!mmkvPrefixAllowlist.length) return;

  if (!mmkvPrefixAllowlist.some((prefix) => key.startsWith(prefix))) {
    throw new Error(
      `MMKV key \"${key}\" is not allowed by EXPO_METRO_MCP_MMKV_PREFIX_ALLOWLIST.`
    );
  }
}

export function filterAllowedMmkvKeys(keys: string[]): string[] {
  const { mmkvPrefixAllowlist } = safetyConfig;
  if (!mmkvPrefixAllowlist.length) return keys;
  return keys.filter((key) => mmkvPrefixAllowlist.some((prefix) => key.startsWith(prefix)));
}

const SQLITE_READ_KEYWORDS = new Set(["select", "with", "explain", "pragma"]);

export function assertSqliteReadStatement(sql: string): void {
  const firstWord = sql
    .trim()
    .replace(/^\(+/, "")
    .split(/[\s(;]/)[0]
    ?.toLowerCase() ?? "";

  if (!SQLITE_READ_KEYWORDS.has(firstWord)) {
    const kind = firstWord ? firstWord.toUpperCase() : "empty";
    throw new Error(
      `sqlite_query only runs read statements (SELECT/WITH/PRAGMA/EXPLAIN). Use sqlite_exec for "${kind}".`
    );
  }
}
