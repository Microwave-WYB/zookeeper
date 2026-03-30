import { sync } from "./sync";
import { query, type QueryOpts } from "./query";
import { download, readStdinJsonl } from "./download";
import { list } from "./list";
import { verify } from "./verify";
import { getConfigValue, setConfigValue, getApiKey, getZooHome, dbPath, storePath } from "./config";
import { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";

function stderr(msg: string) {
  process.stderr.write(msg + "\n");
}

function error(msg: string): never {
  stderr(JSON.stringify({ error: msg }));
  process.exit(1);
}

function usage() {
  stderr(`Usage: zoo <command> [options]

Commands:
  sync                        Download and import CSV (and optionally GP metadata)
    --with-added-date         Use CSV with added date column
    --with-metadata           Also download + import GP metadata (~7.9GB)

  status                      Show database stats

  config set <key> <value>    Set config value
  config get <key>            Get config value

  query [options]             Query database (JSONL to stdout)
    --pkg <name>              Package name (supports * wildcards)
    --sha256 <hash>           Exact SHA-256 hash
    --market <name>           Market (substring match)
    --after <date>            DEX date after (ISO 8601)
    --before <date>           DEX date before (ISO 8601)
    --min-vt <n>              Min VirusTotal detections
    --max-vt <n>              Max VirusTotal detections
    --min-size <bytes>        Min APK size
    --max-size <bytes>        Max APK size
    --permission <perm>       Android permission (requires metadata)
    --limit <n>               Max results

  download [options]          Download APKs
    (reads JSONL from stdin, or use query flags as shortcut)
    --sha256 <hash>           Download single APK
    --jobs <n>                Concurrent downloads (default 4, max 20)
    --force                   Re-download even if exists

  list                        List downloaded APKs (JSONL)
  verify                      Verify downloaded APKs on disk`);
}

function parseArgs(args: string[]) {
  const command = args[0];
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];

  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      if (i + 1 < args.length && !args[i + 1].startsWith("--")) {
        flags[key] = args[i + 1];
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(arg);
    }
  }

  return { command, flags, positional };
}

function flagStr(flags: Record<string, string | boolean>, key: string): string | undefined {
  const v = flags[key];
  return typeof v === "string" ? v : undefined;
}

function flagInt(flags: Record<string, string | boolean>, key: string): number | undefined {
  const v = flagStr(flags, key);
  return v !== undefined ? parseInt(v, 10) : undefined;
}

function buildQueryOpts(flags: Record<string, string | boolean>): QueryOpts {
  return {
    pkg: flagStr(flags, "pkg"),
    sha256: flagStr(flags, "sha256"),
    market: flagStr(flags, "market"),
    after: flagStr(flags, "after"),
    before: flagStr(flags, "before"),
    minVt: flagInt(flags, "min-vt"),
    maxVt: flagInt(flags, "max-vt"),
    minSize: flagInt(flags, "min-size"),
    maxSize: flagInt(flags, "max-size"),
    permission: flagStr(flags, "permission"),
    limit: flagInt(flags, "limit"),
  };
}

async function cmdSync(flags: Record<string, string | boolean>) {
  await sync({
    withAddedDate: !!flags["with-added-date"],
    withMetadata: !!flags["with-metadata"],
  });
}

function cmdStatus() {
  const home = getZooHome();
  const db = dbPath();
  const store = storePath();

  stderr(`ZOO_HOME: ${home}`);
  stderr(`Database: ${db}`);
  stderr(`Store:    ${store}`);

  if (existsSync(db)) {
    const conn = new Database(db, { readonly: true });
    try {
      const apkCount = conn.query("SELECT COUNT(*) as count FROM apks").get() as any;
      stderr(`APKs:     ${apkCount?.count ?? 0} rows`);
    } catch {
      stderr("APKs:     (table not found)");
    }
    try {
      const metaCount = conn.query("SELECT COUNT(*) as count FROM gp_metadata").get() as any;
      stderr(`Metadata: ${metaCount?.count ?? 0} rows`);
    } catch {
      stderr("Metadata: (table not found)");
    }
    conn.close();
  } else {
    stderr("Database: (not found — run zoo sync)");
  }

  // Show sync state
  const syncStatePath = `${home}/sync_state.json`;
  if (existsSync(syncStatePath)) {
    try {
      const state = JSON.parse(readFileSync(syncStatePath, "utf-8"));
      if (state.csv_synced_at) stderr(`CSV sync:  ${state.csv_synced_at}`);
      if (state.metadata_synced_at) stderr(`Meta sync: ${state.metadata_synced_at}`);
    } catch {}
  }
}

function cmdQuery(flags: Record<string, string | boolean>) {
  const opts = buildQueryOpts(flags);
  query(opts);
}

async function cmdDownload(flags: Record<string, string | boolean>) {
  const jobs = Math.min(flagInt(flags, "jobs") ?? 4, 20);
  const force = !!flags["force"];

  // Single sha256 shortcut
  const sha256 = flagStr(flags, "sha256");
  if (sha256) {
    await download({
      jobs: 1,
      force,
      items: [{ sha256 }],
    });
    return;
  }

  // Check if any query flags are present — use as shortcut
  const queryFlags = ["pkg", "market", "after", "before", "min-vt", "max-vt", "min-size", "max-size", "permission"];
  const hasQueryFlags = queryFlags.some((k) => flags[k] !== undefined);

  if (hasQueryFlags) {
    // Query and feed results to downloader
    const opts = buildQueryOpts(flags);
    const db = new Database(dbPath(), { readonly: true });
    const results = queryRows(db, opts);
    await download({ jobs, force, items: results });
    db.close();
    return;
  }

  // Read from stdin
  if (process.stdin.isTTY) {
    error("No input. Pipe JSONL to stdin or use query flags (--pkg, --sha256, etc.)");
  }
  await download({ jobs, force, items: readStdinJsonl() });
}

/** Internal: query returning iterable rows (for piping into download) */
function* queryRows(db: Database, opts: QueryOpts): Iterable<{ sha256: string }> {
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (opts.sha256) {
    conditions.push("a.sha256 = ?");
    params.push(opts.sha256.toUpperCase());
  }
  if (opts.pkg) {
    if (opts.pkg.includes("%") || opts.pkg.includes("*")) {
      conditions.push("a.pkg_name LIKE ?");
      params.push(opts.pkg.replace(/\*/g, "%"));
    } else {
      conditions.push("a.pkg_name = ?");
      params.push(opts.pkg);
    }
  }
  if (opts.market) {
    conditions.push("a.markets LIKE ?");
    params.push(`%${opts.market}%`);
  }
  if (opts.after) {
    conditions.push("a.dex_date >= ?");
    params.push(opts.after);
  }
  if (opts.before) {
    conditions.push("a.dex_date <= ?");
    params.push(opts.before);
  }
  if (opts.minVt !== undefined) {
    conditions.push("a.vt_detection >= ?");
    params.push(opts.minVt);
  }
  if (opts.maxVt !== undefined) {
    conditions.push("a.vt_detection <= ?");
    params.push(opts.maxVt);
  }
  if (opts.minSize !== undefined) {
    conditions.push("a.apk_size >= ?");
    params.push(opts.minSize);
  }
  if (opts.maxSize !== undefined) {
    conditions.push("a.apk_size <= ?");
    params.push(opts.maxSize);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = opts.limit ? `LIMIT ${opts.limit}` : "";
  const sql = `SELECT a.sha256 FROM apks a ${where} ${limit}`;

  for (const row of db.prepare(sql).all(...params) as { sha256: string }[]) {
    yield row;
  }
}

function cmdConfigSet(positional: string[]) {
  if (positional.length < 2) error("Usage: zoo config set <key> <value>");
  const [key, value] = positional;
  setConfigValue(key, value);
  stderr(`Set ${key}`);
}

function cmdConfigGet(positional: string[]) {
  if (positional.length < 1) error("Usage: zoo config get <key>");
  const key = positional[0];
  if (key === "api-key") {
    try {
      console.log(getApiKey());
    } catch (e: any) {
      error(e.message);
    }
  } else {
    const val = getConfigValue(key);
    if (val !== undefined) {
      console.log(val);
    } else {
      error(`Config key '${key}' not found`);
    }
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    usage();
    process.exit(args.length === 0 ? 1 : 0);
  }

  const { command, flags, positional } = parseArgs(args);

  switch (command) {
    case "sync":
      await cmdSync(flags);
      break;
    case "status":
      cmdStatus();
      break;
    case "query":
      cmdQuery(flags);
      break;
    case "download":
      await cmdDownload(flags);
      break;
    case "list":
      list();
      break;
    case "verify":
      await verify();
      break;
    case "config":
      if (positional[0] === "set") {
        cmdConfigSet(positional.slice(1));
      } else if (positional[0] === "get") {
        cmdConfigGet(positional.slice(1));
      } else {
        error("Usage: zoo config <set|get> ...");
      }
      break;
    default:
      error(`Unknown command: ${command}`);
  }
}

main().catch((e) => {
  error(e.message);
});
