pub type Connection

pub type Row

@external(javascript, "./db_ffi.mjs", "open")
fn raw_open(path: String) -> Connection

@external(javascript, "./db_ffi.mjs", "open_readonly")
pub fn open_readonly(path: String) -> Connection

@external(javascript, "./db_ffi.mjs", "close")
pub fn close(conn: Connection) -> Nil

@external(javascript, "./db_ffi.mjs", "run")
pub fn run(conn: Connection, sql: String) -> Nil

@external(javascript, "./db_ffi.mjs", "get")
pub fn get(conn: Connection, sql: String, params: List(String)) -> Row

@external(javascript, "./db_ffi.mjs", "iter_jsonl")
pub fn iter_jsonl(conn: Connection, sql: String, params: List(String)) -> Nil

@external(javascript, "./db_ffi.mjs", "get_field_int")
pub fn get_field_int(row: Row, field: String) -> Int

pub fn open(path: String) -> Connection {
  let conn = raw_open(path)
  run(conn, "PRAGMA journal_mode = WAL")
  run(conn, "PRAGMA synchronous = NORMAL")
  conn
}

pub fn count(conn: Connection, sql: String, params: List(String)) -> Int {
  let row = get(conn, sql, params)
  get_field_int(row, "count")
}
