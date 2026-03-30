# zoo

A CLI tool to automate [AndroZoo](https://androzoo.uni.lu/api_doc) APK dataset management.
Built in TypeScript, running on Bun.

## Architecture

### Language & Runtime
- **TypeScript** with Bun runtime
- No npm dependencies — all I/O uses Bun built-ins
- Compiled to single binary via `bun build --compile`

### Project Structure
```
src/
  main.ts          # Entry point + CLI routing (citty)
  config.ts        # Config management (ZOO_HOME, API key)
  sync.ts          # Download + import orchestration
  csv_import.ts    # Streaming gunzip + CSV parse + SQLite bulk insert
  metadata_import.ts # Streaming gunzip + JSONL parse + SQLite bulk insert
  http.ts          # Chunked parallel HTTP download with progress
  query.ts         # Query building + JSONL output
  download.ts      # APK download orchestration
  list.ts          # Walk store directory, emit JSONL
  verify.ts        # Verify downloaded APKs against SHA-256
```

### Dependencies
- `citty` — CLI framework (auto-generated help, subcommands)

All I/O uses Bun built-ins:
- `bun:sqlite` — SQLite driver
- `fetch` + `ReadableStream` — streaming HTTP
- `node:zlib` — gzip decompression
- `process.stderr.write` — progress output (simple text with `\r`, no progress bar library)

## CLI Design

### Environment
- `ZOO_HOME` — root directory for all data (default: `~/.local/share/zoo`)
- `ZOO_API_KEY` — API key (alternative to config file)
  ```
  $ZOO_HOME/
    zoo.db          # SQLite (CSV metadata + download tracking)
    config.json     # API key, settings
    store/          # APK storage, 2/2 hex prefix tree
      ab/cd/abcd...5678.apk
  ```

### Commands

```bash
zoo config set api-key <KEY>
zoo config set store-dir /mnt/disk    # override store location
zoo config get <key>

zoo sync                              # download latest.csv.gz -> import to SQLite
zoo sync --with-added-date            # use enhanced CSV variant
zoo sync --with-metadata              # also download + import GP metadata full (~7.1GB gz)
zoo status                            # db stats, last sync time

zoo query --pkg "com.whatsapp"        # JSONL to stdout
zoo query --market play.google.com --after 2022-01-01
zoo query --min-vt 0 --max-vt 3 --limit 100
zoo query --permission "android.permission.BLUETOOTH_SCAN"

zoo download                          # reads JSONL from stdin
zoo download --pkg "com.whatsapp"     # shortcut (same flags as query)
zoo download --sha256 ab3f...         # single APK
zoo download --jobs 10                # concurrency (max 20)
zoo download --force                  # re-download even if exists

zoo list                              # JSONL of downloaded APKs
zoo verify                            # check downloads table vs files on disk
```

### Output Conventions
- **stdout** — always JSONL (one JSON object per line), pipeable to `jq`
- **stderr** — progress bars, status messages, warnings
- No human-readable table mode

### Pipeline Example
```bash
zoo query --market play.google.com \
  | jq -r 'select(.pkg_name | test("bluetooth"; "i")) | .sha256' \
  | zoo download --jobs 15
```

## Database Schema

### `apks` table (from CSV import)
| Column       | Type    | Description              |
|-------------|---------|--------------------------|
| sha256      | TEXT PK | SHA-256 hash             |
| sha1        | TEXT    | SHA-1 hash               |
| md5         | TEXT    | MD5 hash                 |
| apk_size    | INTEGER | APK file size (bytes)    |
| dex_size    | INTEGER | DEX file size (bytes)    |
| dex_date    | TEXT    | DEX date                 |
| pkg_name    | TEXT    | Package name             |
| vercode     | INTEGER | Version code             |
| vt_detection| INTEGER | VirusTotal detection count|
| vt_scan_date| TEXT    | VirusTotal scan date     |
| markets     | TEXT    | Pipe-separated markets   |
| added       | TEXT    | Date added (enhanced CSV only) |

Indexes: `pkg_name`, `markets`, `vt_detection`, `dex_date`, `apk_size`.

### `gp_metadata` table (from full GP metadata import)
| Column         | Type    | Description                    |
|---------------|---------|--------------------------------|
| pkg_name      | TEXT    | Package name                   |
| version_code  | INTEGER | Version code                   |
| title         | TEXT    | App title                      |
| creator       | TEXT    | Developer name                 |
| description   | TEXT    | App description (text, no HTML)|
| permissions   | TEXT    | JSON array of permissions      |
| num_downloads | TEXT    | Download count string          |
| star_rating   | REAL    | Aggregate star rating          |
| upload_date   | TEXT    | Upload date                    |
| install_size  | INTEGER | Installation size bytes        |
| metadata_date | TEXT    | When metadata was acquired     |
| raw           | TEXT    | Full JSON object               |

Primary key: `(pkg_name, version_code, metadata_date)`.
Indexes: `pkg_name`.
Permissions stored as JSON array for flexible querying with `json_each()`.

### No downloads table
Download state is derived from the filesystem. To check if an APK is downloaded,
`stat` the expected path `store/ab/cd/abcdef...apk`. File mtime serves as
download timestamp. `zoo list` walks the store directory tree.

## APK Storage Layout

2-level hex prefix tree to avoid huge flat directories:
```
store/ab/cd/abcdef1234...5678.apk
```
First 2 chars of sha256 / next 2 chars / full sha256.apk.
Gives 256 x 256 = 65,536 leaf directories.

## Key Design Decisions

- **Streaming import** — gunzip stream -> line-by-line parse -> batch INSERT
  with progress reported to stderr.
- **Chunked parallel download** — large files (CSV gz, metadata gz) are downloaded
  using 20 parallel HTTP Range requests for maximum throughput.
- **Concurrent APK download** — `zoo download --jobs N` runs up to N (max 20)
  concurrent single-file downloads.
- **Deduplication** — `zoo download` checks file existence on disk before fetching.
- **Skip malformed rows** — the known "snaggamea" entry and any other CSV parse failures
  are skipped with a warning to stderr.
- **ETag caching** — `zoo sync` stores the HTTP ETag/Last-Modified from the CSV download
  to skip re-download if unchanged.
- **GP metadata permissions query** — permissions stored as JSON array, queried with
  SQLite `json_each()` for exact permission matching.

## Development

```bash
make          # compile to single binary
make dev      # run with bun directly (fast iteration)
make run      # build + run
make install  # build + install to ~/.local/bin/zoo
make uninstall # remove from ~/.local/bin/zoo
make clean    # remove build artifacts
```

Build automation is in `Makefile`. All commands go through `make`.

## Conventions
- All dates in ISO 8601 format
- All sizes in bytes
- Exit code 0 on success, 1 on error
- Errors as JSON to stderr: `{"error": "message"}`
