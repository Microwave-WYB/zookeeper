import * as $argv from "../argv/argv.mjs";
import * as $int from "../gleam_stdlib/gleam/int.mjs";
import * as $io from "../gleam_stdlib/gleam/io.mjs";
import * as $option from "../gleam_stdlib/gleam/option.mjs";
import { None, Some } from "../gleam_stdlib/gleam/option.mjs";
import * as $glint from "../glint/glint.mjs";
import * as $simplifile from "../simplifile/simplifile.mjs";
import { Ok, toList, Empty as $Empty } from "./gleam.mjs";
import * as $config from "./zoo/config.mjs";
import * as $db from "./zoo/db.mjs";
import * as $query from "./zoo/query.mjs";
import { QueryOpts } from "./zoo/query.mjs";

function status_command() {
  return $glint.command_help(
    "Show database stats and sync status",
    () => {
      return $glint.unnamed_args(
        new $glint.EqArgs(0),
        () => {
          return $glint.command(
            (_, _1, _2) => {
              let home = $config.get_zoo_home();
              $io.println_error("ZOO_HOME: " + home);
              $io.println_error("Database: " + $config.db_path());
              $io.println_error("Store:    " + $config.store_dir());
              let db_file = $config.db_path();
              let $ = $simplifile.is_file(db_file);
              if ($ instanceof Ok) {
                let $1 = $[0];
                if ($1) {
                  let conn = $db.open_readonly(db_file);
                  let apk_count = $db.query_count(
                    conn,
                    "SELECT COUNT(*) as count FROM apks",
                    toList([]),
                  );
                  $io.println_error(
                    ("APKs:     " + $int.to_string(apk_count)) + " rows",
                  );
                  let meta_count = $db.query_count(
                    conn,
                    "SELECT COUNT(*) as count FROM gp_metadata",
                    toList([]),
                  );
                  $io.println_error(
                    ("Metadata: " + $int.to_string(meta_count)) + " rows",
                  );
                  $db.close(conn)
                } else {
                  $io.println_error("Database: (not found — run zoo sync)")
                }
              } else {
                $io.println_error("Database: (not found — run zoo sync)")
              }
              let $1 = $config.read_sync_state("csv_synced_at");
              if ($1 instanceof Ok) {
                let t = $1[0];
                $io.println_error("CSV sync:  " + t)
              } else {
                undefined
              }
              let $2 = $config.read_sync_state("metadata_synced_at");
              if ($2 instanceof Ok) {
                let t = $2[0];
                return $io.println_error("Meta sync: " + t);
              } else {
                return undefined;
              }
            },
          );
        },
      );
    },
  );
}

function config_set_command() {
  return $glint.command_help(
    "Set a config value",
    () => {
      return $glint.unnamed_args(
        new $glint.MinArgs(2),
        () => {
          return $glint.command(
            (_, args, _1) => {
              if (args instanceof $Empty) {
                return $io.println_error("Usage: zoo config set <key> <value>");
              } else {
                let $ = args.tail;
                if ($ instanceof $Empty) {
                  return $io.println_error(
                    "Usage: zoo config set <key> <value>",
                  );
                } else {
                  let key = args.head;
                  let value = $.head;
                  let $1 = $config.set_config_value(key, value);
                  if ($1 instanceof Ok) {
                    return $io.println_error("Set " + key);
                  } else {
                    let e = $1[0];
                    return $io.println_error("Error: " + e);
                  }
                }
              }
            },
          );
        },
      );
    },
  );
}

function config_get_command() {
  return $glint.command_help(
    "Get a config value",
    () => {
      return $glint.unnamed_args(
        new $glint.MinArgs(1),
        () => {
          return $glint.command(
            (_, args, _1) => {
              if (args instanceof $Empty) {
                return $io.println_error("Usage: zoo config get <key>");
              } else {
                let key = args.head;
                if (key === "api-key") {
                  let $ = $config.get_api_key();
                  if ($ instanceof Ok) {
                    let v = $[0];
                    return $io.println(v);
                  } else {
                    let e = $[0];
                    return $io.println_error("Error: " + e);
                  }
                } else {
                  let $ = $config.read_config_key(key);
                  if ($ instanceof Ok) {
                    let v = $[0];
                    return $io.println(v);
                  } else {
                    let e = $[0];
                    return $io.println_error("Error: " + e);
                  }
                }
              }
            },
          );
        },
      );
    },
  );
}

function result_to_option(result) {
  if (result instanceof Ok) {
    let v = result[0];
    return new Some(v);
  } else {
    return new None();
  }
}

function query_command() {
  return $glint.command_help(
    "Query database (JSONL to stdout)",
    () => {
      return $glint.unnamed_args(
        new $glint.EqArgs(0),
        () => {
          return $glint.flag(
            (() => {
              let _pipe = $glint.string_flag("pkg");
              return $glint.flag_help(
                _pipe,
                "Package name (supports * wildcards)",
              );
            })(),
            (pkg) => {
              return $glint.flag(
                (() => {
                  let _pipe = $glint.string_flag("sha256");
                  return $glint.flag_help(_pipe, "Exact SHA-256 hash");
                })(),
                (sha256) => {
                  return $glint.flag(
                    (() => {
                      let _pipe = $glint.string_flag("market");
                      return $glint.flag_help(_pipe, "Market (substring match)");
                    })(),
                    (market) => {
                      return $glint.flag(
                        (() => {
                          let _pipe = $glint.string_flag("after");
                          return $glint.flag_help(
                            _pipe,
                            "DEX date after (ISO 8601)",
                          );
                        })(),
                        (after) => {
                          return $glint.flag(
                            (() => {
                              let _pipe = $glint.string_flag("before");
                              return $glint.flag_help(
                                _pipe,
                                "DEX date before (ISO 8601)",
                              );
                            })(),
                            (before) => {
                              return $glint.flag(
                                (() => {
                                  let _pipe = $glint.string_flag("min-vt");
                                  return $glint.flag_help(
                                    _pipe,
                                    "Min VirusTotal detections",
                                  );
                                })(),
                                (min_vt) => {
                                  return $glint.flag(
                                    (() => {
                                      let _pipe = $glint.string_flag("max-vt");
                                      return $glint.flag_help(
                                        _pipe,
                                        "Max VirusTotal detections",
                                      );
                                    })(),
                                    (max_vt) => {
                                      return $glint.flag(
                                        (() => {
                                          let _pipe = $glint.string_flag(
                                            "min-size",
                                          );
                                          return $glint.flag_help(
                                            _pipe,
                                            "Min APK size (bytes)",
                                          );
                                        })(),
                                        (min_size) => {
                                          return $glint.flag(
                                            (() => {
                                              let _pipe = $glint.string_flag(
                                                "max-size",
                                              );
                                              return $glint.flag_help(
                                                _pipe,
                                                "Max APK size (bytes)",
                                              );
                                            })(),
                                            (max_size) => {
                                              return $glint.flag(
                                                (() => {
                                                  let _pipe = $glint.string_flag(
                                                    "permission",
                                                  );
                                                  return $glint.flag_help(
                                                    _pipe,
                                                    "Android permission (requires metadata)",
                                                  );
                                                })(),
                                                (permission) => {
                                                  return $glint.flag(
                                                    (() => {
                                                      let _pipe = $glint.string_flag(
                                                        "limit",
                                                      );
                                                      return $glint.flag_help(
                                                        _pipe,
                                                        "Max results",
                                                      );
                                                    })(),
                                                    (limit) => {
                                                      return $glint.command(
                                                        (_, _1, flags) => {
                                                          let opts = new QueryOpts(
                                                            result_to_option(
                                                              pkg(flags),
                                                            ),
                                                            result_to_option(
                                                              sha256(flags),
                                                            ),
                                                            result_to_option(
                                                              market(flags),
                                                            ),
                                                            result_to_option(
                                                              after(flags),
                                                            ),
                                                            result_to_option(
                                                              before(flags),
                                                            ),
                                                            result_to_option(
                                                              min_vt(flags),
                                                            ),
                                                            result_to_option(
                                                              max_vt(flags),
                                                            ),
                                                            result_to_option(
                                                              min_size(flags),
                                                            ),
                                                            result_to_option(
                                                              max_size(flags),
                                                            ),
                                                            result_to_option(
                                                              permission(flags),
                                                            ),
                                                            result_to_option(
                                                              limit(flags),
                                                            ),
                                                          );
                                                          return $query.run_query(
                                                            opts,
                                                          );
                                                        },
                                                      );
                                                    },
                                                  );
                                                },
                                              );
                                            },
                                          );
                                        },
                                      );
                                    },
                                  );
                                },
                              );
                            },
                          );
                        },
                      );
                    },
                  );
                },
              );
            },
          );
        },
      );
    },
  );
}

export function main() {
  let _pipe = $glint.new$();
  let _pipe$1 = $glint.with_name(_pipe, "zoo");
  let _pipe$2 = $glint.pretty_help(_pipe$1, $glint.default_pretty_help());
  let _pipe$3 = $glint.add(_pipe$2, toList(["status"]), status_command());
  let _pipe$4 = $glint.add(_pipe$3, toList(["query"]), query_command());
  let _pipe$5 = $glint.add(
    _pipe$4,
    toList(["config", "set"]),
    config_set_command(),
  );
  let _pipe$6 = $glint.add(
    _pipe$5,
    toList(["config", "get"]),
    config_get_command(),
  );
  return $glint.run(_pipe$6, $argv.load().arguments);
}
