# zoo

A CLI tool to automate [AndroZoo](https://androzoo.uni.lu/api_doc) APK dataset management. Query, download, and manage 26M+ Android APKs.

Built in TypeScript, running on [Bun](https://bun.sh). Compiles to a single binary with no runtime dependencies.

## Install

```bash
make install   # builds and installs to ~/.local/bin/zoo
```

Requires [Bun](https://bun.sh) to build.

## Setup

```bash
zoo config set api-key <YOUR_ANDROZOO_API_KEY>
zoo sync                    # download + import CSV catalog (~7GB)
zoo sync --with-metadata    # also import Google Play metadata
```

## Usage

```bash
# Search APKs
zoo query --pkg "com.whatsapp"
zoo query --market play.google.com --after 2022-01-01 --limit 100
zoo query --min-vt 5 --max-vt 50 --limit 100
zoo query --permission "android.permission.BLUETOOTH_SCAN"

# Download APKs
zoo download ABC123... DEF456...
zoo query --pkg "com.whatsapp" --limit 5 | jq -r '.sha256' | zoo download --jobs 10

# List downloaded APKs
zoo list

# Verify downloads
zoo verify
```

All output is JSONL to stdout, progress to stderr. Pipe to `jq` for filtering.

## Commands

| Command | Description |
|---------|-------------|
| `zoo sync` | Download and import CSV catalog into SQLite |
| `zoo status` | Show database stats and last sync time |
| `zoo query` | Search APKs with filters, output JSONL |
| `zoo download` | Download APKs by SHA-256 hash |
| `zoo list` | List downloaded APKs as JSONL |
| `zoo verify` | Verify downloaded APKs against SHA-256 |
| `zoo config` | Manage API key and settings |

## License

MIT
