import { Database } from "bun:sqlite";
import { createReadStream } from "node:fs";
import { createGunzip } from "node:zlib";
import { statSync } from "node:fs";
import { parse } from "csv-parse";

function formatNum(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "k";
  return String(n);
}

export async function importCsv(
  dbPath: string,
  gzPath: string,
  withAddedDate: boolean,
): Promise<{ rows: number; skipped: number }> {
  const db = new Database(dbPath);
  const fileSize = statSync(gzPath).size;

  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA synchronous = OFF");
  db.run("PRAGMA cache_size = -64000");
  db.run("PRAGMA mmap_size = 268435456");

  db.run("DROP TABLE IF EXISTS apks");
  db.run(`CREATE TABLE apks (
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
  // CSV column order: sha256, sha1, md5, dex_date, apk_size, pkg_name, vercode, vt_detection, vt_scan_date, dex_size, markets [, added]
  const numCols = withAddedDate ? 12 : 11;
  const placeholders = Array(numCols).fill("?").join(",");
  const batchPlaceholders = Array(BATCH_SIZE).fill(`(${placeholders})`).join(",");
  const cols =
    "sha256, sha1, md5, dex_date, apk_size, pkg_name, vercode, vt_detection, vt_scan_date, dex_size, markets" +
    (withAddedDate ? ", added" : "");

  const batchStmt = db.prepare(`INSERT OR IGNORE INTO apks (${cols}) VALUES ${batchPlaceholders}`);

  let rows = 0;
  let skipped = 0;
  let batch: (string | number)[][] = [];
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

  db.run("BEGIN TRANSACTION");

  await new Promise<void>((resolve, reject) => {
    const input = createReadStream(gzPath);
    const gunzip = createGunzip();
    const parser = parse({
      columns: false,
      skip_empty_lines: true,
      from_line: 2, // skip header
      relax_column_count: true,
    });

    input.on("data", (chunk: Buffer) => {
      compressedRead += chunk.length;
    });

    parser.on("data", (record: string[]) => {
      if (record.length < numCols) {
        skipped++;
        return;
      }
      // Skip known malformed entry
      if (record.includes("snaggamea")) {
        skipped++;
        return;
      }

      const fields = record.slice(0, numCols);
      // Convert numeric fields (CSV order: sha256, sha1, md5, dex_date, apk_size, pkg_name, vercode, vt_detection, vt_scan_date, dex_size, markets)
      const row: (string | number)[] = [...fields];
      row[4] = parseInt(fields[4] ?? "", 10) || 0; // apk_size
      row[6] = parseInt(fields[6] ?? "", 10) || 0; // vercode
      row[7] = parseInt(fields[7] ?? "", 10) || 0; // vt_detection
      row[9] = parseInt(fields[9] ?? "", 10) || 0; // dex_size

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
        process.stderr.write(
          `\rImporting CSV... ${formatNum(rows)} rows (${pct}%) ${formatNum(rate)} rows/s`,
        );
        lastReport = now;
      }
    });

    parser.on("end", () => {
      flush(batch);
      resolve();
    });

    parser.on("error", reject);
    gunzip.on("error", reject);
    input.on("error", reject);
    input.pipe(gunzip).pipe(parser);
  });

  db.run("COMMIT");

  const elapsed = (Date.now() - startTime) / 1000;
  const rate = Math.round(rows / elapsed);
  process.stderr.write(
    `\rImporting CSV... ${formatNum(rows)} rows (100%) ${formatNum(rate)} rows/s\n`,
  );

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
    db.run(indexes[i] as string);
  }
  process.stderr.write(`\rCreating indexes... ${indexes.length}/${indexes.length}\n`);

  db.run("PRAGMA synchronous = NORMAL");
  db.close();

  return { rows, skipped };
}
