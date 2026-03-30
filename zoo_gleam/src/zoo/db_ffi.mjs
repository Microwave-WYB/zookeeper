import { Database } from "bun:sqlite";

export const open = (path) => new Database(path);
export const open_readonly = (path) => new Database(path, { readonly: true });
export const close = (db) => db.close();
export const run = (db, sql) => db.run(sql);
export const get = (db, sql, params) => db.prepare(sql).get(...params.toArray());
export const iter_jsonl = (db, sql, params) => {
  for (const row of db.prepare(sql).iterate(...params.toArray())) {
    process.stdout.write(JSON.stringify(row) + "\n");
  }
};
export const get_field_int = (row, field) => row[field] ?? 0;
