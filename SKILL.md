---
name: zoo
description: >
  Query and download from the AndroZoo APK dataset (26M+ Android apps) using the `zoo` CLI.
  Use this skill whenever the user wants to search for Android APKs, look up apps by package name,
  filter by VirusTotal detections, date ranges, markets, file size, or Android permissions.
  Also use when the user asks about AndroZoo data, APK metadata, malware samples, or wants to
  explore the Android app ecosystem. Trigger on any mention of APK datasets, Android app analysis,
  or VirusTotal scores, even if "zoo" or "AndroZoo" is not explicitly mentioned.
---

# zoo — AndroZoo APK Dataset CLI

Query, download, and manage Android APKs from the AndroZoo dataset (26M+ apps).

## Prerequisites

- `zoo` binary on PATH (run `make install` from this repo if not)
- Synced database — run `zoo status` to check, `zoo sync` to populate

## Commands

### `zoo query` — Search APKs

Outputs JSONL to stdout. All flags are optional and AND-ed together.

```
zoo query [--pkg=STR] [--sha256=STR] [--market=STR]
          [--after=DATE] [--before=DATE]
          [--min-vt=N] [--max-vt=N]
          [--min-size=N] [--max-size=N]
          [--permission=STR] [--limit=N]
```

| Flag | Description |
|------|-------------|
| `--pkg` | Package name, supports `*` wildcards (e.g. `com.google.*`) |
| `--sha256` | Exact SHA-256 hash lookup |
| `--market` | Market name, substring match (e.g. `play` for Google Play) |
| `--after` / `--before` | DEX date range (ISO 8601) |
| `--min-vt` / `--max-vt` | VirusTotal detection count range |
| `--min-size` / `--max-size` | APK file size in bytes |
| `--permission` | Android permission (requires metadata synced) |
| `--limit` | Max number of results |

Output fields per row:
```json
{
  "sha256": "ABC123...", "sha1": "...", "md5": "...",
  "apk_size": 11806415, "dex_size": 4758220,
  "dex_date": "2013-11-14 11:39:48",
  "pkg_name": "com.whatsapp", "vercode": 48346,
  "vt_detection": 0, "vt_scan_date": "2013-11-21 14:50:08",
  "markets": "appchina", "added": null
}
```

### `zoo download` — Download APKs

Pass SHA-256 hashes as arguments or pipe via stdin (one per line). Downloads to `ZOO_HOME/store/` in a hex-prefix tree.

```
zoo download [HASH...] [--jobs=N] [--force]
```

| Flag | Description |
|------|-------------|
| `--jobs=N` | Concurrent downloads (default 4, max 20) |
| `--force` | Re-download even if file exists |

Outputs JSONL status per file to stdout:
```json
{"sha256": "...", "status": "ok", "path": "/path/to/file.apk"}
{"sha256": "...", "status": "skipped", "reason": "exists"}
{"sha256": "...", "status": "error", "reason": "HTTP 404"}
```

### `zoo sync` — Populate the database

Downloads and imports the AndroZoo CSV catalog into SQLite.

```
zoo sync [--with-added-date] [--with-metadata]
```

| Flag | Description |
|------|-------------|
| `--with-added-date` | Use enhanced CSV with added-date column |
| `--with-metadata` | Also download + import Google Play metadata (~7.1 GB gz) |

Run this before querying. Uses ETag caching to skip re-downloads.

### `zoo status` — Check database state

Prints ZOO_HOME path, row counts, and last sync times to stderr.

### `zoo list` — List downloaded APKs

Walks the store directory and emits JSONL to stdout.

### `zoo config get <key>` / `zoo config set <key> <value>`

Manage config stored in `ZOO_HOME/config.json`. The `api-key` key is also checked via `ZOO_API_KEY` env var.

## Pipelines

The power of zoo is chaining commands. stdout is always JSONL, stderr is progress — safe to pipe.

```bash
# Query then download
zoo query --pkg=com.whatsapp --limit=5 | jq -r '.sha256' | zoo download

# Download specific APKs by hash
zoo download ABC123DEF456... 789ABC...

# Filter with jq, extract hashes, then download
zoo query --min-vt=5 --after=2024-01-01 --limit=100 \
  | jq -r 'select(.apk_size < 50000000) | .sha256' \
  | zoo download --jobs=15

# Extract package names of malware
zoo query --min-vt=10 --after=2024-01-01 --limit=50 \
  | jq -r '.pkg_name' | sort -u

# Count APKs per market
zoo query --pkg=com.whatsapp | jq -r '.markets' | sort | uniq -c | sort -rn

# Export to CSV
zoo query --min-vt=5 --limit=100 \
  | jq -r '[.pkg_name, .sha256, .vt_detection, .dex_date] | @csv'

# Save full query results
zoo query --pkg=com.google.* --market=play --limit=1000 > google_play.jsonl
```

## Tips for agents

- Always use `--limit` to avoid overwhelming output. Start with `--limit=10`, then increase.
- Prefer `zoo download --pkg=X` shortcut over piping through jq. When you need custom filtering, pipe `zoo query | jq -r '.sha256' | zoo download` — stdin only accepts raw SHA-256 hashes, not JSONL.
- Use `--jobs=10` or higher for bulk downloads — default is 4.
- `vt_detection` is the VirusTotal engine count — higher means more likely malicious. 0 means clean.
- The `--permission` flag requires metadata to be synced (`zoo sync --with-metadata`).
- All dates are ISO 8601. All sizes are in bytes.
- APKs are stored in `ZOO_HOME/store/ab/cd/abcdef...apk` (2-level hex prefix tree).
