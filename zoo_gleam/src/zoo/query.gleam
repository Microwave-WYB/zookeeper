import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/string
import zoo/config
import zoo/db

pub type QueryOpts {
  QueryOpts(
    pkg: Option(String),
    sha256: Option(String),
    market: Option(String),
    after: Option(String),
    before: Option(String),
    min_vt: Option(String),
    max_vt: Option(String),
    min_size: Option(String),
    max_size: Option(String),
    permission: Option(String),
    limit: Option(String),
  )
}

pub fn empty_opts() -> QueryOpts {
  QueryOpts(
    pkg: None,
    sha256: None,
    market: None,
    after: None,
    before: None,
    min_vt: None,
    max_vt: None,
    min_size: None,
    max_size: None,
    permission: None,
    limit: None,
  )
}

fn add_condition(
  acc: #(List(String), List(String)),
  opt: Option(String),
  cond: String,
  param_fn: fn(String) -> String,
) -> #(List(String), List(String)) {
  case opt {
    Some(v) -> #([cond, ..acc.0], [param_fn(v), ..acc.1])
    None -> acc
  }
}

fn build_query(opts: QueryOpts, select: String) -> #(String, List(String)) {
  let acc = #([], [])

  let acc = add_condition(acc, opts.sha256, "a.sha256 = ?", string.uppercase)

  let acc = case opts.pkg {
    Some(p) ->
      case string.contains(p, "%") || string.contains(p, "*") {
        True -> #(["a.pkg_name LIKE ?", ..acc.0], [
          string.replace(p, "*", "%"),
          ..acc.1
        ])
        False -> #(["a.pkg_name = ?", ..acc.0], [p, ..acc.1])
      }
    None -> acc
  }

  let acc =
    add_condition(acc, opts.market, "a.markets LIKE ?", fn(m) {
      "%" <> m <> "%"
    })
  let acc = add_condition(acc, opts.after, "a.dex_date >= ?", fn(x) { x })
  let acc = add_condition(acc, opts.before, "a.dex_date <= ?", fn(x) { x })
  let acc = add_condition(acc, opts.min_vt, "a.vt_detection >= ?", fn(x) { x })
  let acc = add_condition(acc, opts.max_vt, "a.vt_detection <= ?", fn(x) { x })
  let acc = add_condition(acc, opts.min_size, "a.apk_size >= ?", fn(x) { x })
  let acc = add_condition(acc, opts.max_size, "a.apk_size <= ?", fn(x) { x })

  let #(join_meta, acc) = case opts.permission {
    Some(perm) -> #(
      True,
      #(
        [
          "EXISTS (SELECT 1 FROM json_each(m.permissions) WHERE value = ?)",
          ..acc.0
        ],
        [perm, ..acc.1],
      ),
    )
    None -> #(False, acc)
  }

  let conds = list.reverse(acc.0)
  let params = list.reverse(acc.1)

  let where = case conds {
    [] -> ""
    _ -> "WHERE " <> string.join(conds, " AND ")
  }

  let limit_clause = case opts.limit {
    Some(l) -> "LIMIT " <> l
    None -> ""
  }

  let from = case join_meta {
    True ->
      "FROM apks a JOIN gp_metadata m ON a.pkg_name = m.pkg_name AND a.vercode = m.version_code"
    False -> "FROM apks a"
  }

  let sql = select <> " " <> from <> " " <> where <> " " <> limit_clause
  #(sql, params)
}

pub fn run_query(opts: QueryOpts) -> Nil {
  let conn = db.open_readonly(config.db_path())
  let #(sql, params) = build_query(opts, "SELECT a.*")
  db.iter_jsonl(conn, sql, params)
  db.close(conn)
}
