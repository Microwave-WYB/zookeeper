import argv
import gleam/int
import gleam/io
import gleam/option.{None, Some}
import glint
import simplifile
import zoo/config
import zoo/db
import zoo/query.{QueryOpts}

pub fn main() {
  glint.new()
  |> glint.with_name("zoo")
  |> glint.pretty_help(glint.default_pretty_help())
  |> glint.add(at: ["status"], do: status_command())
  |> glint.add(at: ["query"], do: query_command())
  |> glint.add(at: ["config", "set"], do: config_set_command())
  |> glint.add(at: ["config", "get"], do: config_get_command())
  |> glint.run(argv.load().arguments)
}

fn query_command() -> glint.Command(Nil) {
  use <- glint.command_help("Query database (JSONL to stdout)")
  use <- glint.unnamed_args(glint.EqArgs(0))
  use pkg <- glint.flag(
    glint.string_flag("pkg")
    |> glint.flag_help("Package name (supports * wildcards)"),
  )
  use sha256 <- glint.flag(
    glint.string_flag("sha256")
    |> glint.flag_help("Exact SHA-256 hash"),
  )
  use market <- glint.flag(
    glint.string_flag("market")
    |> glint.flag_help("Market (substring match)"),
  )
  use after <- glint.flag(
    glint.string_flag("after")
    |> glint.flag_help("DEX date after (ISO 8601)"),
  )
  use before <- glint.flag(
    glint.string_flag("before")
    |> glint.flag_help("DEX date before (ISO 8601)"),
  )
  use min_vt <- glint.flag(
    glint.string_flag("min-vt")
    |> glint.flag_help("Min VirusTotal detections"),
  )
  use max_vt <- glint.flag(
    glint.string_flag("max-vt")
    |> glint.flag_help("Max VirusTotal detections"),
  )
  use min_size <- glint.flag(
    glint.string_flag("min-size")
    |> glint.flag_help("Min APK size (bytes)"),
  )
  use max_size <- glint.flag(
    glint.string_flag("max-size")
    |> glint.flag_help("Max APK size (bytes)"),
  )
  use permission <- glint.flag(
    glint.string_flag("permission")
    |> glint.flag_help("Android permission (requires metadata)"),
  )
  use limit <- glint.flag(
    glint.string_flag("limit")
    |> glint.flag_help("Max results"),
  )
  use _named, _args, flags <- glint.command()

  let opts =
    QueryOpts(
      pkg: result_to_option(pkg(flags)),
      sha256: result_to_option(sha256(flags)),
      market: result_to_option(market(flags)),
      after: result_to_option(after(flags)),
      before: result_to_option(before(flags)),
      min_vt: result_to_option(min_vt(flags)),
      max_vt: result_to_option(max_vt(flags)),
      min_size: result_to_option(min_size(flags)),
      max_size: result_to_option(max_size(flags)),
      permission: result_to_option(permission(flags)),
      limit: result_to_option(limit(flags)),
    )

  query.run_query(opts)
}

fn status_command() -> glint.Command(Nil) {
  use <- glint.command_help("Show database stats and sync status")
  use <- glint.unnamed_args(glint.EqArgs(0))
  use _named, _args, _flags <- glint.command()

  let home = config.get_zoo_home()
  io.println_error("ZOO_HOME: " <> home)
  io.println_error("Database: " <> config.db_path())
  io.println_error("Store:    " <> config.store_dir())

  let db_file = config.db_path()
  case simplifile.is_file(db_file) {
    Ok(True) -> {
      let conn = db.open_readonly(db_file)
      let apk_count = db.count(conn, "SELECT COUNT(*) as count FROM apks", [])
      io.println_error("APKs:     " <> int.to_string(apk_count) <> " rows")

      let meta_count =
        db.count(conn, "SELECT COUNT(*) as count FROM gp_metadata", [])
      io.println_error("Metadata: " <> int.to_string(meta_count) <> " rows")
      db.close(conn)
    }
    _ -> io.println_error("Database: (not found — run zoo sync)")
  }

  case config.read_sync_state("csv_synced_at") {
    Ok(t) -> io.println_error("CSV sync:  " <> t)
    _ -> Nil
  }
  case config.read_sync_state("metadata_synced_at") {
    Ok(t) -> io.println_error("Meta sync: " <> t)
    _ -> Nil
  }
}

fn config_set_command() -> glint.Command(Nil) {
  use <- glint.command_help("Set a config value")
  use <- glint.unnamed_args(glint.MinArgs(2))
  use _named, args, _flags <- glint.command()

  case args {
    [key, value, ..] -> {
      case config.set_config_value(key, value) {
        Ok(_) -> io.println_error("Set " <> key)
        Error(e) -> io.println_error("Error: " <> e)
      }
    }
    _ -> io.println_error("Usage: zoo config set <key> <value>")
  }
}

fn config_get_command() -> glint.Command(Nil) {
  use <- glint.command_help("Get a config value")
  use <- glint.unnamed_args(glint.MinArgs(1))
  use _named, args, _flags <- glint.command()

  case args {
    [key, ..] ->
      case key {
        "api-key" ->
          case config.get_api_key() {
            Ok(v) -> io.println(v)
            Error(e) -> io.println_error("Error: " <> e)
          }
        _ ->
          case config.read_config_key(key) {
            Ok(v) -> io.println(v)
            Error(e) -> io.println_error("Error: " <> e)
          }
      }
    _ -> io.println_error("Usage: zoo config get <key>")
  }
}

fn result_to_option(result: Result(a, b)) -> option.Option(a) {
  case result {
    Ok(v) -> Some(v)
    Error(_) -> None
  }
}
