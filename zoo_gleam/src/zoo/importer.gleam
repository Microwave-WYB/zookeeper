import gleam/javascript/promise.{type Promise}

@external(javascript, "./import_ffi.mjs", "import_csv")
pub fn import_csv(
  db_path: String,
  gz_path: String,
  with_added_date: Bool,
) -> Promise(Result(#(Int, Int), String))

@external(javascript, "./import_ffi.mjs", "import_metadata")
pub fn import_metadata(
  db_path: String,
  gz_path: String,
) -> Promise(Result(#(Int, Int), String))
