import gleam/dict
import gleam/dynamic/decode
import gleam/json
import gleam/result
import simplifile

@external(javascript, "./config_ffi.mjs", "get_env")
pub fn get_env(name: String) -> Result(String, Nil)

pub fn get_zoo_home() -> String {
  case get_env("ZOO_HOME") {
    Ok(home) if home != "" -> home
    _ -> {
      let assert Ok(home) = get_env("HOME")
      home <> "/.local/share/zoo"
    }
  }
}

pub fn db_path() -> String {
  get_zoo_home() <> "/zoo.db"
}

pub fn store_dir() -> String {
  get_zoo_home() <> "/store"
}

pub fn ensure_dirs() -> Result(Nil, simplifile.FileError) {
  use _ <- result.try(simplifile.create_directory_all(get_zoo_home()))
  simplifile.create_directory_all(store_dir())
}

pub fn get_api_key() -> Result(String, String) {
  case get_env("ZOO_API_KEY") {
    Ok(key) if key != "" -> Ok(key)
    _ ->
      case read_config_key("api-key") {
        Ok(key) -> Ok(key)
        Error(_) ->
          Error(
            "No API key. Set ZOO_API_KEY or run: zoo config set api-key <KEY>",
          )
      }
  }
}

// --- Config file (JSON dict) ---

fn config_path() -> String {
  get_zoo_home() <> "/config.json"
}

fn read_json_dict(path: String) -> dict.Dict(String, String) {
  case simplifile.read(path) {
    Ok(content) ->
      case json.parse(content, decode.dict(decode.string, decode.string)) {
        Ok(d) -> d
        Error(_) -> dict.new()
      }
    Error(_) -> dict.new()
  }
}

fn write_json_dict(path: String, d: dict.Dict(String, String)) -> Nil {
  let content = json.to_string(json.dict(d, fn(k) { k }, json.string))
  let assert Ok(_) = simplifile.write(path, content <> "\n")
  Nil
}

pub fn read_config_key(key: String) -> Result(String, String) {
  case dict.get(read_json_dict(config_path()), key) {
    Ok(v) if v != "" -> Ok(v)
    _ -> Error("Config key '" <> key <> "' not found")
  }
}

pub fn set_config_value(key: String, value: String) -> Result(Nil, String) {
  let d = read_json_dict(config_path()) |> dict.insert(key, value)
  write_json_dict(config_path(), d)
  Ok(Nil)
}

// --- Sync state ---

fn sync_state_path() -> String {
  get_zoo_home() <> "/sync_state.json"
}

pub fn read_sync_state(key: String) -> Result(String, Nil) {
  case dict.get(read_json_dict(sync_state_path()), key) {
    Ok(v) if v != "" -> Ok(v)
    _ -> Error(Nil)
  }
}

pub fn write_sync_state(key: String, value: String) -> Nil {
  let d = read_json_dict(sync_state_path()) |> dict.insert(key, value)
  write_json_dict(sync_state_path(), d)
}
