import { defineCommand, runMain } from "citty";
import { sync } from "./sync";
import { query, type QueryOpts } from "./query";
import { download, readStdinJsonl } from "./download";
import { list } from "./list";
import { verify } from "./verify";
import { getConfigValue, setConfigValue, getApiKey, getZooHome, dbPath, storePath } from "./config";
import { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";

const queryArgs = {
  pkg: { type: "string" as const, description: "Package name (supports * wildcards)" },
  sha256: { type: "string" as const, description: "Exact SHA-256 hash" },
  market: { type: "string" as const, description: "Market (substring match)" },
  after: { type: "string" as const, description: "DEX date after (ISO 8601)" },
  before: { type: "string" as const, description: "DEX date before (ISO 8601)" },
  "min-vt": { type: "string" as const, description: "Min VirusTotal detections" },
  "max-vt": { type: "string" as const, description: "Max VirusTotal detections" },
  "min-size": { type: "string" as const, description: "Min APK size (bytes)" },
  "max-size": { type: "string" as const, description: "Max APK size (bytes)" },
  permission: { type: "string" as const, description: "Android permission (requires metadata)" },
  limit: { type: "string" as const, description: "Max results" },
};

function buildQueryOpts(args: Record<string, any>): QueryOpts {
  return {
    pkg: args.pkg,
    sha256: args.sha256,
    market: args.market,
    after: args.after,
    before: args.before,
    minVt: args["min-vt"] !== undefined ? parseInt(args["min-vt"], 10) : undefined,
    maxVt: args["max-vt"] !== undefined ? parseInt(args["max-vt"], 10) : undefined,
    minSize: args["min-size"] !== undefined ? parseInt(args["min-size"], 10) : undefined,
    maxSize: args["max-size"] !== undefined ? parseInt(args["max-size"], 10) : undefined,
    permission: args.permission,
    limit: args.limit !== undefined ? parseInt(args.limit, 10) : undefined,
  };
}

function* queryRows(db: Database, opts: QueryOpts): Iterable<{ sha256: string }> {
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (opts.sha256) { conditions.push("a.sha256 = ?"); params.push(opts.sha256.toUpperCase()); }
  if (opts.pkg) {
    if (opts.pkg.includes("%") || opts.pkg.includes("*")) {
      conditions.push("a.pkg_name LIKE ?"); params.push(opts.pkg.replace(/\*/g, "%"));
    } else {
      conditions.push("a.pkg_name = ?"); params.push(opts.pkg);
    }
  }
  if (opts.market) { conditions.push("a.markets LIKE ?"); params.push(`%${opts.market}%`); }
  if (opts.after) { conditions.push("a.dex_date >= ?"); params.push(opts.after); }
  if (opts.before) { conditions.push("a.dex_date <= ?"); params.push(opts.before); }
  if (opts.minVt !== undefined) { conditions.push("a.vt_detection >= ?"); params.push(opts.minVt); }
  if (opts.maxVt !== undefined) { conditions.push("a.vt_detection <= ?"); params.push(opts.maxVt); }
  if (opts.minSize !== undefined) { conditions.push("a.apk_size >= ?"); params.push(opts.minSize); }
  if (opts.maxSize !== undefined) { conditions.push("a.apk_size <= ?"); params.push(opts.maxSize); }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = opts.limit ? `LIMIT ${opts.limit}` : "";
  const sql = `SELECT a.sha256 FROM apks a ${where} ${limit}`;
  for (const row of db.prepare(sql).all(...params) as { sha256: string }[]) { yield row; }
}

const syncCommand = defineCommand({
  meta: { description: "Download and import CSV (and optionally GP metadata) into SQLite" },
  args: {
    "with-added-date": { type: "boolean", description: "Use CSV with added date column" },
    "with-metadata": { type: "boolean", description: "Also download and import GP metadata (~7.9GB)" },
  },
  async run({ args }) {
    await sync({ withAddedDate: !!args["with-added-date"], withMetadata: !!args["with-metadata"] });
  },
});

const statusCommand = defineCommand({
  meta: { description: "Show database stats and sync status" },
  run() {
    const home = getZooHome();
    const db = dbPath();
    process.stderr.write(`ZOO_HOME: ${home}\nDatabase: ${db}\nStore:    ${storePath()}\n`);

    if (existsSync(db)) {
      const conn = new Database(db, { readonly: true });
      try {
        const r = conn.query("SELECT COUNT(*) as count FROM apks").get() as any;
        process.stderr.write(`APKs:     ${r?.count ?? 0} rows\n`);
      } catch { process.stderr.write("APKs:     (table not found)\n"); }
      try {
        const r = conn.query("SELECT COUNT(*) as count FROM gp_metadata").get() as any;
        process.stderr.write(`Metadata: ${r?.count ?? 0} rows\n`);
      } catch { process.stderr.write("Metadata: (table not found)\n"); }
      conn.close();
    } else {
      process.stderr.write("Database: (not found — run zoo sync)\n");
    }

    const syncStatePath = `${home}/sync_state.json`;
    if (existsSync(syncStatePath)) {
      try {
        const state = JSON.parse(readFileSync(syncStatePath, "utf-8"));
        if (state.csv_synced_at) process.stderr.write(`CSV sync:  ${state.csv_synced_at}\n`);
        if (state.metadata_synced_at) process.stderr.write(`Meta sync: ${state.metadata_synced_at}\n`);
      } catch {}
    }
  },
});

const queryCommand = defineCommand({
  meta: { description: "Query database (JSONL to stdout)" },
  args: queryArgs,
  run({ args }) {
    query(buildQueryOpts(args));
  },
});

const downloadCommand = defineCommand({
  meta: { description: "Download APKs (reads JSONL from stdin, or use query flags as shortcut)" },
  args: {
    ...queryArgs,
    jobs: { type: "string", description: "Concurrent downloads (default 4, max 20)", default: "4" },
    force: { type: "boolean", description: "Re-download even if exists" },
  },
  async run({ args }) {
    const jobs = Math.min(parseInt(args.jobs || "4", 10), 20);
    const force = !!args.force;

    if (args.sha256) {
      await download({ jobs: 1, force, items: [{ sha256: args.sha256 }] });
      return;
    }

    const queryKeys = ["pkg", "market", "after", "before", "min-vt", "max-vt", "min-size", "max-size", "permission"];
    const hasQueryFlags = queryKeys.some((k) => (args as any)[k] !== undefined);

    if (hasQueryFlags) {
      const opts = buildQueryOpts(args);
      const db = new Database(dbPath(), { readonly: true });
      const results = queryRows(db, opts);
      await download({ jobs, force, items: results });
      db.close();
      return;
    }

    if (process.stdin.isTTY) {
      process.stderr.write('No input. Pipe JSONL to stdin or use query flags (--pkg, --sha256, etc.)\n');
      process.exit(1);
    }
    await download({ jobs, force, items: readStdinJsonl() });
  },
});

const listCommand = defineCommand({
  meta: { description: "List downloaded APKs (JSONL to stdout)" },
  run() { list(); },
});

const verifyCommand = defineCommand({
  meta: { description: "Verify downloaded APKs match their SHA-256 filenames" },
  async run() { await verify(); },
});

const configSetCommand = defineCommand({
  meta: { description: "Set a config value" },
  args: {
    key: { type: "positional", description: "Config key (e.g. api-key, store-dir)", required: true },
    value: { type: "positional", description: "Config value", required: true },
  },
  run({ args }) {
    setConfigValue(args.key, args.value);
    process.stderr.write(`Set ${args.key}\n`);
  },
});

const configGetCommand = defineCommand({
  meta: { description: "Get a config value" },
  args: {
    key: { type: "positional", description: "Config key (e.g. api-key, store-dir)", required: true },
  },
  run({ args }) {
    if (args.key === "api-key") {
      console.log(getApiKey());
    } else {
      const val = getConfigValue(args.key);
      if (val !== undefined) { console.log(val); }
      else { process.stderr.write(`Config key '${args.key}' not found\n`); process.exit(1); }
    }
  },
});

const configCommand = defineCommand({
  meta: { description: "Manage configuration" },
  subCommands: { set: configSetCommand, get: configGetCommand },
});

const main = defineCommand({
  meta: { name: "zoo", version: "0.1.0", description: "AndroZoo APK dataset management" },
  subCommands: {
    sync: syncCommand,
    status: statusCommand,
    query: queryCommand,
    download: downloadCommand,
    list: listCommand,
    verify: verifyCommand,
    config: configCommand,
  },
});

runMain(main);
