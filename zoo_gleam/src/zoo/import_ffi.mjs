import { Database } from "bun:sqlite";
import { createReadStream } from "node:fs";
import { createGunzip } from "node:zlib";
import { statSync } from "node:fs";
import { Ok, Error } from "../gleam.mjs";

function formatNum(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "k";
  return String(n);
}

function parseCsvLine(line, expectedCols) {
  if (line.includes(",snaggamea")) return null;
  const fields = [];
  let i = 0, field = "", inQuote = false;
  while (i < line.length) {
    const ch = line[i];
    if (inQuote) {
      if (ch === '"' && line[i + 1] === '"') { field += '"'; i += 2; }
      else if (ch === '"') { inQuote = false; i++; }
      else { field += ch; i++; }
    } else if (ch === '"') { inQuote = true; i++; }
    else if (ch === ',') { fields.push(field); field = ""; i++; }
    else { field += ch; i++; }
  }
  fields.push(field);
  if (fields.length < expectedCols) return null;
  return fields.slice(0, expectedCols);
}

// Returns Promise(Result(#(rows, skipped), String))
export async function import_csv(dbPath, gzPath, withAddedDate) {
  try {
    const db = new Database(dbPath);
    const fileSize = statSync(gzPath).size;

    db.run("PRAGMA journal_mode = WAL");
    db.run("PRAGMA synchronous = OFF");
    db.run("PRAGMA cache_size = -64000");
    db.run("PRAGMA mmap_size = 268435456");

    db.run("DROP TABLE IF EXISTS apks");
    db.run(`CREATE TABLE apks (
      sha256 TEXT PRIMARY KEY, sha1 TEXT, md5 TEXT, apk_size INTEGER,
      dex_size INTEGER, dex_date TEXT, pkg_name TEXT, vercode INTEGER,
      vt_detection INTEGER, vt_scan_date TEXT, markets TEXT, added TEXT
    )`);

    const BATCH_SIZE = 5000;
    const numCols = withAddedDate ? 12 : 11;
    const ph = Array(numCols).fill("?").join(",");
    const batchPh = Array(BATCH_SIZE).fill(`(${ph})`).join(",");
    const cols = "sha256,sha1,md5,dex_date,apk_size,pkg_name,vercode,vt_detection,vt_scan_date,dex_size,markets" + (withAddedDate ? ",added" : "");
    const batchStmt = db.prepare(`INSERT OR IGNORE INTO apks (${cols}) VALUES ${batchPh}`);

    let rows = 0, skipped = 0, batch = [], headerSkipped = false, compressedRead = 0;
    const startTime = Date.now();
    let lastReport = 0;

    const flush = (b) => {
      if (b.length === 0) return;
      if (b.length === BATCH_SIZE) batchStmt.run(...b.flat());
      else db.prepare(`INSERT OR IGNORE INTO apks (${cols}) VALUES ${Array(b.length).fill(`(${ph})`).join(",")}`).run(...b.flat());
    };

    db.run("BEGIN TRANSACTION");

    await new Promise((resolve, reject) => {
      const input = createReadStream(gzPath);
      const gunzip = createGunzip();
      input.on("data", (chunk) => { compressedRead += chunk.length; });
      let leftover = "";
      gunzip.on("data", (chunk) => {
        const text = leftover + chunk.toString("utf-8");
        const lines = text.split("\n");
        leftover = lines.pop() || "";
        for (const line of lines) {
          if (!headerSkipped) { headerSkipped = true; continue; }
          if (line.trim() === "") continue;
          const parsed = parseCsvLine(line, numCols);
          if (!parsed) { skipped++; continue; }
          const row = [...parsed];
          row[4] = parseInt(parsed[4], 10) || 0;
          row[6] = parseInt(parsed[6], 10) || 0;
          row[7] = parseInt(parsed[7], 10) || 0;
          row[9] = parseInt(parsed[9], 10) || 0;
          batch.push(row);
          rows++;
          if (batch.length >= BATCH_SIZE) { flush(batch); batch = []; }
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
      gunzip.on("end", () => { flush(batch); resolve(); });
      gunzip.on("error", reject);
      input.on("error", reject);
      input.pipe(gunzip);
    });

    db.run("COMMIT");
    const elapsed = (Date.now() - startTime) / 1000;
    process.stderr.write(`\rImporting CSV... ${formatNum(rows)} rows (100%) ${formatNum(Math.round(rows / elapsed))} rows/s\n`);

    const indexes = [
      "CREATE INDEX IF NOT EXISTS idx_pkg_name ON apks(pkg_name)",
      "CREATE INDEX IF NOT EXISTS idx_markets ON apks(markets)",
      "CREATE INDEX IF NOT EXISTS idx_vt_detection ON apks(vt_detection)",
      "CREATE INDEX IF NOT EXISTS idx_dex_date ON apks(dex_date)",
      "CREATE INDEX IF NOT EXISTS idx_apk_size ON apks(apk_size)",
    ];
    for (let i = 0; i < indexes.length; i++) {
      process.stderr.write(`\rCreating indexes... ${i + 1}/${indexes.length}`);
      db.run(indexes[i]);
    }
    process.stderr.write(`\rCreating indexes... ${indexes.length}/${indexes.length}\n`);

    db.run("PRAGMA synchronous = NORMAL");
    db.close();
    return new Ok([rows, skipped]);
  } catch (e) {
    return new Error(e.message);
  }
}

// Returns Promise(Result(#(rows, skipped), String))
export async function import_metadata(dbPath, gzPath) {
  try {
    const db = new Database(dbPath);
    const fileSize = statSync(gzPath).size;

    db.run("PRAGMA journal_mode = WAL");
    db.run("PRAGMA synchronous = OFF");
    db.run("PRAGMA cache_size = -64000");
    db.run("PRAGMA mmap_size = 268435456");

    db.run("DROP TABLE IF EXISTS gp_metadata");
    db.run(`CREATE TABLE gp_metadata (
      pkg_name TEXT, version_code INTEGER, title TEXT, creator TEXT,
      description TEXT, permissions TEXT, num_downloads TEXT, star_rating REAL,
      upload_date TEXT, install_size INTEGER, metadata_date TEXT, raw TEXT
    )`);

    const BATCH_SIZE = 10000;
    const COLS = 12;
    const ph = Array(COLS).fill("?").join(",");
    const batchPh = Array(BATCH_SIZE).fill(`(${ph})`).join(",");
    const insertSql = `INSERT INTO gp_metadata (pkg_name,version_code,title,creator,description,permissions,num_downloads,star_rating,upload_date,install_size,metadata_date,raw) VALUES`;
    const batchStmt = db.prepare(`${insertSql} ${batchPh}`);

    let rows = 0, skipped = 0, batch = [], compressedRead = 0;
    const startTime = Date.now();
    let lastReport = 0;

    const flush = (b) => {
      if (b.length === 0) return;
      if (b.length === BATCH_SIZE) batchStmt.run(...b.flat());
      else db.prepare(`${insertSql} ${Array(b.length).fill(`(${ph})`).join(",")}`).run(...b.flat());
    };

    db.run("BEGIN TRANSACTION");

    await new Promise((resolve, reject) => {
      const input = createReadStream(gzPath);
      const gunzip = createGunzip();
      input.on("data", (chunk) => { compressedRead += chunk.length; });
      let leftover = "";
      gunzip.on("data", (chunk) => {
        const text = leftover + chunk.toString("utf-8");
        const lines = text.split("\n");
        leftover = lines.pop() || "";
        for (const line of lines) {
          if (line.trim() === "") continue;
          try {
            const obj = JSON.parse(line);
            const pkgName = obj.docid || obj.packageName || obj.backendDocid;
            if (!pkgName) { skipped++; continue; }
            const ad = obj.details?.appDetails || {};
            let desc = obj.descriptionHtml || obj.descriptionShort || null;
            if (desc) desc = desc.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
            batch.push([
              pkgName, ad.versionCode || 0, obj.title || null, obj.creator || null,
              desc, JSON.stringify(ad.permission ?? []), ad.numDownloads || null,
              obj.aggregateRating?.starRating || null, ad.uploadDate || null,
              parseInt(ad.installationSize, 10) || 0, obj.az_metadata_date || null, line,
            ]);
            rows++;
          } catch { skipped++; }
          if (batch.length >= BATCH_SIZE) { flush(batch); batch = []; }
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
      gunzip.on("end", () => { flush(batch); resolve(); });
      gunzip.on("error", reject);
      input.on("error", reject);
      input.pipe(gunzip);
    });

    db.run("COMMIT");
    const elapsed = (Date.now() - startTime) / 1000;
    process.stderr.write(`\rImporting metadata... ${formatNum(rows)} rows (100%) ${formatNum(Math.round(rows / elapsed))} rows/s\n`);

    const indexes = [
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_gp_pk ON gp_metadata(pkg_name,version_code,metadata_date)",
      "CREATE INDEX IF NOT EXISTS idx_gp_pkg_name ON gp_metadata(pkg_name)",
      "CREATE INDEX IF NOT EXISTS idx_gp_version_code ON gp_metadata(version_code)",
      "CREATE INDEX IF NOT EXISTS idx_gp_metadata_date ON gp_metadata(metadata_date)",
    ];
    for (let i = 0; i < indexes.length; i++) {
      process.stderr.write(`\rCreating metadata indexes... ${i + 1}/${indexes.length}`);
      db.run(indexes[i]);
    }
    process.stderr.write(`\rCreating metadata indexes... ${indexes.length}/${indexes.length}\n`);

    db.run("PRAGMA synchronous = NORMAL");
    db.close();
    return new Ok([rows, skipped]);
  } catch (e) {
    return new Error(e.message);
  }
}
