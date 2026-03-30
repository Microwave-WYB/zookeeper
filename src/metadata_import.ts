import { Database } from "bun:sqlite";
import { createReadStream } from "node:fs";
import { createGunzip } from "node:zlib";
import { statSync } from "node:fs";

function formatNum(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "k";
  return String(n);
}

type MetadataValues = (string | number | null)[];

function parseMetadataLine(line: string): MetadataValues | null {
  try {
    const obj = JSON.parse(line);
    const pkgName = obj.docid || obj.packageName || obj.backendDocid;
    if (!pkgName) return null;

    const appDetails = obj.details?.appDetails || {};

    let description = obj.descriptionHtml || obj.descriptionShort || null;
    if (description) {
      description = description.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
    }

    return [
      pkgName,
      appDetails.versionCode || 0,
      obj.title || null,
      obj.creator || null,
      description,
      JSON.stringify(appDetails.permission || []),
      appDetails.numDownloads || null,
      obj.aggregateRating?.starRating || null,
      appDetails.uploadDate || null,
      parseInt(appDetails.installationSize, 10) || 0,
      obj.az_metadata_date || null,
      line,
    ];
  } catch {
    return null;
  }
}

export async function importMetadata(
  dbPath: string,
  gzPath: string,
): Promise<{ rows: number; skipped: number }> {
  const db = new Database(dbPath);
  const fileSize = statSync(gzPath).size;

  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = OFF");
  db.exec("PRAGMA cache_size = -64000");
  db.exec("PRAGMA mmap_size = 268435456");

  // Create table without primary key for fast bulk insert
  db.exec("DROP TABLE IF EXISTS gp_metadata");
  db.exec(`CREATE TABLE gp_metadata (
    pkg_name       TEXT,
    version_code   INTEGER,
    title          TEXT,
    creator        TEXT,
    description    TEXT,
    permissions    TEXT,
    num_downloads  TEXT,
    star_rating    REAL,
    upload_date    TEXT,
    install_size   INTEGER,
    metadata_date  TEXT,
    raw            TEXT
  )`);

  const BATCH_SIZE = 10000;
  const COLS = 12;
  const placeholders = Array(COLS).fill("?").join(",");
  const batchPlaceholders = Array(BATCH_SIZE).fill(`(${placeholders})`).join(",");
  const insertSql = `INSERT INTO gp_metadata
    (pkg_name, version_code, title, creator, description, permissions,
     num_downloads, star_rating, upload_date, install_size, metadata_date, raw)
    VALUES`;

  const batchStmt = db.prepare(`${insertSql} ${batchPlaceholders}`);

  let rows = 0;
  let skipped = 0;
  let batch: MetadataValues[] = [];
  let compressedRead = 0;
  const startTime = Date.now();
  let lastReport = 0;

  const flush = (currentBatch: MetadataValues[]) => {
    if (currentBatch.length === 0) return;
    if (currentBatch.length === BATCH_SIZE) {
      batchStmt.run(...currentBatch.flat());
    } else {
      const ph = Array(currentBatch.length).fill(`(${placeholders})`).join(",");
      db.prepare(`${insertSql} ${ph}`).run(...currentBatch.flat());
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
        if (line.trim() === "") continue;

        const parsed = parseMetadataLine(line);
        if (!parsed) { skipped++; continue; }

        batch.push(parsed);
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
          process.stderr.write(`\rImporting metadata... ${formatNum(rows)} rows (${pct}%) ${formatNum(rate)} rows/s`);
          lastReport = now;
        }
      }
    });

    gunzip.on("end", () => {
      if (leftover.trim()) {
        const parsed = parseMetadataLine(leftover);
        if (parsed) { batch.push(parsed); rows++; }
        else { skipped++; }
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
  process.stderr.write(`\rImporting metadata... ${formatNum(rows)} rows (100%) ${formatNum(rate)} rows/s\n`);

  // Create indexes after bulk insert
  process.stderr.write("Creating metadata indexes...\n");
  const indexes = [
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_gp_pk ON gp_metadata(pkg_name, version_code, metadata_date)",
    "CREATE INDEX IF NOT EXISTS idx_gp_pkg_name ON gp_metadata(pkg_name)",
    "CREATE INDEX IF NOT EXISTS idx_gp_version_code ON gp_metadata(version_code)",
    "CREATE INDEX IF NOT EXISTS idx_gp_metadata_date ON gp_metadata(metadata_date)",
  ];
  for (let i = 0; i < indexes.length; i++) {
    process.stderr.write(`\rCreating metadata indexes... ${i + 1}/${indexes.length}`);
    db.exec(indexes[i]);
  }
  process.stderr.write(`\rCreating metadata indexes... ${indexes.length}/${indexes.length}\n`);

  db.exec("PRAGMA synchronous = NORMAL");
  db.close();

  return { rows, skipped };
}
