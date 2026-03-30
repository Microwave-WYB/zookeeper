import { sync } from "./sync";
import { getConfigValue, setConfigValue, getApiKey, getZooHome, dbPath, storePath } from "./config";
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";

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
  sync                  Download and import CSV (and optionally GP metadata)
    --with-added-date   Use CSV with added date column
    --with-metadata     Also download + import GP metadata (~7.1GB)

  status                Show database stats

  config set <key> <value>   Set config value
  config get <key>           Get config value

  query [options]       Query database (JSONL output) — coming soon
  download [options]    Download APKs — coming soon`);
}

function parseArgs(args: string[]) {
  const command = args[0];
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];

  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      // Check if next arg is a value (not a flag)
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
