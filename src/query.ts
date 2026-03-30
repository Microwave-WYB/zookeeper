import { Database } from "bun:sqlite";
import { dbPath } from "./config";

export interface QueryOpts {
  pkg?: string;
  sha256?: string;
  market?: string;
  after?: string;
  before?: string;
  minVt?: number;
  maxVt?: number;
  minSize?: number;
  maxSize?: number;
  permission?: string;
  limit?: number;
}

export function query(opts: QueryOpts): void {
  const db = new Database(dbPath(), { readonly: true });

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

  // Permission query requires gp_metadata table
  let joinMeta = false;
  if (opts.permission) {
    joinMeta = true;
    conditions.push(
      "EXISTS (SELECT 1 FROM json_each(m.permissions) WHERE value = ?)",
    );
    params.push(opts.permission);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = opts.limit ? `LIMIT ${opts.limit}` : "";

  let sql: string;
  if (joinMeta) {
    sql = `SELECT a.* FROM apks a
      JOIN gp_metadata m ON a.pkg_name = m.pkg_name AND a.vercode = m.version_code
      ${where} ${limit}`;
  } else {
    sql = `SELECT a.* FROM apks a ${where} ${limit}`;
  }

  const stmt = db.prepare(sql);
  for (const row of stmt.iterate(...params)) {
    process.stdout.write(JSON.stringify(row) + "\n");
  }

  db.close();
}
