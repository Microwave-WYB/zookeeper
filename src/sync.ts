import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { Database } from "bun:sqlite";
import { ensureDirs, dbPath, getZooHome, getApiKey } from "./config";
import { downloadChunked, type DownloadResult } from "./http";
import { importCsv } from "./csv_import";
import { importMetadata } from "./metadata_import";

const CSV_URL = "https://androzoo.uni.lu/static/lists/latest.csv.gz";
const CSV_ADDED_URL = "https://androzoo.uni.lu/static/lists/latest_with-added-date.csv.gz";
const METADATA_URL = "https://androzoo.uni.lu/api/get_gp_metadata_file/full";

interface SyncState {
  csv_etag?: string | null;
  csv_synced_at?: string;
  metadata_etag?: string | null;
  metadata_synced_at?: string;
}

function syncStatePath(): string {
  return `${getZooHome()}/sync_state.json`;
}

function loadSyncState(): SyncState {
  const path = syncStatePath();
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as SyncState;
  } catch {
    return {};
  }
}

function saveSyncState(state: SyncState): void {
  writeFileSync(syncStatePath(), JSON.stringify(state, null, 2) + "\n");
}

function formatSize(bytes: number): string {
  if (bytes >= 1_073_741_824) return (bytes / 1_073_741_824).toFixed(1) + " GB";
  if (bytes >= 1_048_576) return (bytes / 1_048_576).toFixed(1) + " MB";
  return String(bytes) + " B";
}

async function prompt(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === "y" || answer.toLowerCase() === "yes");
    });
  });
}

async function checkAndDownload(
  url: string,
  destPath: string,
  label: string,
  cachedEtag?: string,
): Promise<DownloadResult> {
  // HEAD to check ETag and size
  const head = await fetch(url, { method: "HEAD" });
  if (!head.ok) throw new Error(`HEAD ${url}: ${head.status} ${head.statusText}`);

  const etag = head.headers.get("etag");
  const size = parseInt(head.headers.get("content-length") || "0", 10);

  // ETag matches — already up to date
  if (cachedEtag && etag && cachedEtag === etag) {
    process.stderr.write(`${label} Already up to date\n`);
    return { status: "skipped", etag };
  }

  // File exists but ETag changed (or no cached ETag) — prompt
  if (existsSync(destPath) && cachedEtag) {
    const sizeStr = size ? ` (${formatSize(size)})` : "";
    const yes = await prompt(`${label} Updated on server. Re-download${sizeStr}? [y/N] `);
    if (!yes) {
      process.stderr.write(`${label} Skipped\n`);
      return { status: "skipped", etag: cachedEtag };
    }
  }

  // Download (first time or user confirmed)
  return downloadChunked(url, destPath, { label, cachedEtag: undefined });
}

export async function sync(opts: { withAddedDate: boolean; withMetadata: boolean }): Promise<void> {
  ensureDirs();

  const home = getZooHome();
  const db = dbPath();
  const state = loadSyncState();

  const csvUrl = opts.withAddedDate ? CSV_ADDED_URL : CSV_URL;
  const gzPath = `${home}/latest.csv.gz`;

  // Check and download CSV
  const csvResult = await checkAndDownload(csvUrl, gzPath, "[CSV]", state.csv_etag ?? undefined);

  // Check and download metadata (after CSV, since prompts are sequential)
  let metaGzPath: string | undefined;
  let metaResult: DownloadResult | undefined;
  if (opts.withMetadata) {
    const apiKey = getApiKey();
    metaGzPath = `${home}/gp-metadata-full.jsonl.gz`;
    const metaUrl = `${METADATA_URL}?apikey=${apiKey}`;
    metaResult = await checkAndDownload(
      metaUrl,
      metaGzPath,
      "[Metadata]",
      state.metadata_etag ?? undefined,
    );
  }

  // Import CSV if downloaded (or if gz exists but db has no data)
  if (csvResult.status === "ok" || !tableExists(db, "apks")) {
    if (existsSync(gzPath)) {
      const importResult = await importCsv(db, gzPath, opts.withAddedDate);
      process.stderr.write(
        `CSV import complete: ${importResult.rows} rows, ${importResult.skipped} skipped\n`,
      );
    }
    state.csv_etag = csvResult.etag;
    state.csv_synced_at = new Date().toISOString();
  } else {
    process.stderr.write("CSV unchanged, skipping import\n");
  }

  // Import metadata if downloaded (or if gz exists but db has no data)
  if (metaResult && metaGzPath) {
    if (metaResult.status === "ok" || !tableExists(db, "gp_metadata")) {
      if (existsSync(metaGzPath)) {
        const importResult = await importMetadata(db, metaGzPath);
        process.stderr.write(
          `Metadata import complete: ${importResult.rows} rows, ${importResult.skipped} skipped\n`,
        );
      }
      state.metadata_etag = metaResult.etag;
      state.metadata_synced_at = new Date().toISOString();
    } else {
      process.stderr.write("Metadata unchanged, skipping import\n");
    }
  }

  saveSyncState(state);
  process.stderr.write("Sync complete\n");
}

function tableExists(dbFile: string, table: string): boolean {
  if (!existsSync(dbFile)) return false;
  try {
    const conn = new Database(dbFile, { readonly: true });
    const row = conn
      .query("SELECT COUNT(*) as cnt FROM sqlite_master WHERE type='table' AND name=?")
      .get(table) as { cnt: number } | null;
    conn.close();
    return (row?.cnt ?? 0) > 0;
  } catch {
    return false;
  }
}
