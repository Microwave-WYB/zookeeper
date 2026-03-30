import { Database } from "bun:sqlite";
import { createReadStream } from "node:fs";
import { createGunzip } from "node:zlib";
import { statSync } from "node:fs";

function formatNum(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "k";
  return String(n);
}

/**
 * Parse a CSV line handling quoted fields.
 * Returns array of field strings, or null if malformed.
 */
function parseCsvLine(line: string, expectedCols: number): string[] | null {
  if (line.includes(",snaggamea")) return null;

  const fields: string[] = [];
  let i = 0;
  let field = "";
  let inQuote = false;

  while (i < line.length) {
    const ch = line[i];
    if (inQuote) {
      if (ch === '"' && line[i + 1] === '"') {
        field += '"';
        i += 2;
      } else if (ch === '"') {
        inQuote = false;
        i++;
      } else {
        field += ch;
        i++;
      }
    } else if (ch === '"') {
      inQuote = true;
      i++;
    } else if (ch === ",") {
      fields.push(field);
      field = "";
      i++;
    } else {
      field += ch;
      i++;
    }
  }
  fields.push(field);

  if (fields.length < expectedCols) return null;
  return fields.slice(0, expectedCols);
}

export async function importCsv(
  dbPath: string,
  gzPath: string,
  withAddedDate: boolean,
): Promise<{ rows: number; skipped: number }> {
  const db = new Database(dbPath);
  const fileSize = statSync(gzPath).size;

  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = OFF");
  db.exec("PRAGMA cache_size = -64000");
  db.exec("PRAGMA mmap_size = 268435456");

  db.exec("DROP TABLE IF EXISTS apks");
  db.exec(`CREATE TABLE apks (
    sha256       TEXT PRIMARY KEY,
    sha1         TEXT,
    md5          TEXT,
    apk_size     INTEGER,
    dex_size     INTEGER,
    dex_date     TEXT,
    pkg_name     TEXT,
    vercode      INTEGER,
    vt_detection INTEGER,
    vt_scan_date TEXT,
    markets      TEXT,
    added        TEXT
  )`);

  const BATCH_SIZE = 5000;
  const numCols = withAddedDate ? 12 : 11;
  const placeholders = Array(numCols).fill("?").join(",");
  const batchPlaceholders = Array(BATCH_SIZE).fill(`(${placeholders})`).join(",");
  const cols = "sha256, sha1, md5, apk_size, dex_size, dex_date, pkg_name, vercode, vt_detection, vt_scan_date, markets" + (withAddedDate ? ", added" : "");

  const batchStmt = db.prepare(`INSERT OR IGNORE INTO apks (${cols}) VALUES ${batchPlaceholders}`);

  let rows = 0;
  let skipped = 0;
  let batch: (string | number)[][] = [];
  let headerSkipped = false;
  let compressedRead = 0;
  const startTime = Date.now();
  let lastReport = 0;

  const flush = (currentBatch: (string | number)[][]) => {
    if (currentBatch.length === 0) return;
    if (currentBatch.length === BATCH_SIZE) {
      batchStmt.run(...currentBatch.flat());
    } else {
      const ph = Array(currentBatch.length).fill(`(${placeholders})`).join(",");
      db.prepare(`INSERT OR IGNORE INTO apks (${cols}) VALUES ${ph}`).run(...currentBatch.flat());
    }
  };

  db.exec("BEGIN TRANSACTION");

  await new Promise<void>((resolve, reject) => {
    const input = createReadStream(gzPath);
    const gunzip = createGunzip();

    input.on("data", (chunk: Buffer) => {
      compressedRead += chunk.length;
    });

    let leftover = "";

    gunzip.on("data", (chunk: Buffer) => {
      const text = leftover + chunk.toString("utf-8");
      const lines = text.split("\n");
      leftover = lines.pop() || "";

      for (const line of lines) {
        if (!headerSkipped) { headerSkipped = true; continue; }
        if (line.trim() === "") continue;

        const parsed = parseCsvLine(line, numCols);
        if (!parsed) { skipped++; continue; }

        // Convert numeric fields
        const row: (string | number)[] = [...parsed];
        row[3] = parseInt(parsed[3], 10) || 0; // apk_size
        row[4] = parseInt(parsed[4], 10) || 0; // dex_size
        row[7] = parseInt(parsed[7], 10) || 0; // vercode
        row[8] = parseInt(parsed[8], 10) || 0; // vt_detection

        batch.push(row);
        rows++;

        if (batch.length >= BATCH_SIZE) {
          flush(batch);
          batch = [];
        }

        const now = Date.now();
        if (now - lastReport >= 1000) {
          const elapsed = (now - startTime) / 1000;
          const rate = Math.round(rows / elapsed);
          const pct = Math.round((compressedRead / fileSize) * 100);
          process.stderr.write(`\rImporting CSV... ${formatNum(rows)} rows (${pct}%) ${formatNum(rate)} rows/s`);
          lastReport = now;
        }
      }
    });

    gunzip.on("end", () => {
      if (leftover.trim()) {
        const parsed = parseCsvLine(leftover, numCols);
        if (parsed) {
          const row: (string | number)[] = [...parsed];
          row[3] = parseInt(parsed[3], 10) || 0;
          row[4] = parseInt(parsed[4], 10) || 0;
          row[7] = parseInt(parsed[7], 10) || 0;
          row[8] = parseInt(parsed[8], 10) || 0;
          batch.push(row);
          rows++;
        } else {
          skipped++;
        }
      }
      flush(batch);
      resolve();
    });

    gunzip.on("error", reject);
    input.on("error", reject);
    input.pipe(gunzip);
  });

  db.exec("COMMIT");

  const elapsed = (Date.now() - startTime) / 1000;
  const rate = Math.round(rows / elapsed);
  process.stderr.write(`\rImporting CSV... ${formatNum(rows)} rows (100%) ${formatNum(rate)} rows/s\n`);

  process.stderr.write("Creating indexes...\n");
  const indexes = [
    "CREATE INDEX IF NOT EXISTS idx_pkg_name ON apks(pkg_name)",
    "CREATE INDEX IF NOT EXISTS idx_markets ON apks(markets)",
    "CREATE INDEX IF NOT EXISTS idx_vt_detection ON apks(vt_detection)",
    "CREATE INDEX IF NOT EXISTS idx_dex_date ON apks(dex_date)",
    "CREATE INDEX IF NOT EXISTS idx_apk_size ON apks(apk_size)",
  ];
  for (let i = 0; i < indexes.length; i++) {
    process.stderr.write(`\rCreating indexes... ${i + 1}/${indexes.length}`);
    db.exec(indexes[i]);
  }
  process.stderr.write(`\rCreating indexes... ${indexes.length}/${indexes.length}\n`);

  db.exec("PRAGMA synchronous = NORMAL");
  db.close();

  return { rows, skipped };
}
