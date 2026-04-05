import { defineCommand, runMain } from "citty";
import { sync } from "./sync";
import { query, type QueryOpts } from "./query";
import { download, readStdinLines } from "./download";
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

function buildQueryOpts(
  args: Record<string, string | number | boolean | string[] | undefined>,
): QueryOpts {
  const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
  return {
    pkg: str(args.pkg),
    sha256: str(args.sha256),
    market: str(args.market),
    after: str(args.after),
    before: str(args.before),
    minVt:
      str(args["min-vt"]) !== undefined ? parseInt(str(args["min-vt"]) as string, 10) : undefined,
    maxVt:
      str(args["max-vt"]) !== undefined ? parseInt(str(args["max-vt"]) as string, 10) : undefined,
    minSize:
      str(args["min-size"]) !== undefined
        ? parseInt(str(args["min-size"]) as string, 10)
        : undefined,
    maxSize:
      str(args["max-size"]) !== undefined
        ? parseInt(str(args["max-size"]) as string, 10)
        : undefined,
    permission: str(args.permission),
    limit: str(args.limit) !== undefined ? parseInt(str(args.limit) as string, 10) : undefined,
  };
}

const syncCommand = defineCommand({
  meta: { description: "Download and import CSV (and optionally GP metadata) into SQLite" },
  args: {
    "with-added-date": { type: "boolean", description: "Use CSV with added date column" },
    "with-metadata": {
      type: "boolean",
      description: "Also download and import GP metadata (~7.9GB)",
    },
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
        const r = conn.query("SELECT COUNT(*) as count FROM apks").get() as {
          count: number;
        } | null;
        process.stderr.write(`APKs:     ${r?.count ?? 0} rows\n`);
      } catch {
        process.stderr.write("APKs:     (table not found)\n");
      }
      try {
        const r = conn.query("SELECT COUNT(*) as count FROM gp_metadata").get() as {
          count: number;
        } | null;
        process.stderr.write(`Metadata: ${r?.count ?? 0} rows\n`);
      } catch {
        process.stderr.write("Metadata: (table not found)\n");
      }
      conn.close();
    } else {
      process.stderr.write("Database: (not found — run zoo sync)\n");
    }

    const syncStatePath = `${home}/sync_state.json`;
    if (existsSync(syncStatePath)) {
      try {
        const state = JSON.parse(readFileSync(syncStatePath, "utf-8")) as {
          csv_synced_at?: string;
          metadata_synced_at?: string;
        };
        if (state.csv_synced_at) process.stderr.write(`CSV sync:  ${state.csv_synced_at}\n`);
        if (state.metadata_synced_at)
          process.stderr.write(`Meta sync: ${state.metadata_synced_at}\n`);
      } catch {
        // ignore malformed sync state
      }
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
  meta: { description: "Download APKs by SHA-256 hash (args or stdin)" },
  args: {
    hashes: { type: "positional", description: "SHA-256 hashes to download", required: false },
    jobs: { type: "string", description: "Concurrent downloads (default 4, max 20)", default: "4" },
    force: { type: "boolean", description: "Re-download even if exists" },
  },
  async run({ args }) {
    const jobs = Math.min(parseInt(args.jobs || "4", 10), 20);
    const force = !!args.force;

    // Positional args: one or more hashes
    const rawArgs = process.argv.slice(3).filter((a) => !a.startsWith("--"));
    if (rawArgs.length > 0) {
      const items = rawArgs.map((h) => ({ sha256: h.trim() }));
      await download({ jobs, force, items });
      return;
    }

    // Stdin
    if (process.stdin.isTTY) {
      process.stderr.write(
        "No input. Pass SHA-256 hashes as arguments or pipe to stdin.\n" +
          "Examples:\n" +
          "  zoo download ABC123... DEF456...\n" +
          "  zoo query --pkg=com.whatsapp --limit=5 | jq -r '.sha256' | zoo download\n",
      );
      process.exit(1);
    }
    await download({ jobs, force, items: readStdinLines() });
  },
});

const listCommand = defineCommand({
  meta: { description: "List downloaded APKs (JSONL to stdout)" },
  run() {
    list();
  },
});

const verifyCommand = defineCommand({
  meta: { description: "Verify downloaded APKs match their SHA-256 filenames" },
  run() {
    verify();
  },
});

const configSetCommand = defineCommand({
  meta: { description: "Set a config value" },
  args: {
    key: {
      type: "positional",
      description: "Config key (e.g. api-key, store-dir)",
      required: true,
    },
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
    key: {
      type: "positional",
      description: "Config key (e.g. api-key, store-dir)",
      required: true,
    },
  },
  run({ args }) {
    if (args.key === "api-key") {
      console.log(getApiKey());
    } else {
      const val = getConfigValue(args.key);
      if (val !== undefined) {
        console.log(val);
      } else {
        process.stderr.write(`Config key '${args.key}' not found\n`);
        process.exit(1);
      }
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

void runMain(main);
