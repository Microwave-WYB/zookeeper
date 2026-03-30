import { readdirSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { storePath } from "./config";

/**
 * Walk the 2-level hex prefix store and emit JSONL for each APK found.
 */
export function list(): void {
  const store = storePath();
  let count = 0;

  let level1: string[];
  try {
    level1 = readdirSync(store);
  } catch {
    return;
  }

  for (const d1 of level1) {
    const p1 = join(store, d1);
    let level2: string[];
    try {
      level2 = readdirSync(p1);
    } catch {
      continue;
    }

    for (const d2 of level2) {
      const p2 = join(p1, d2);
      let files: string[];
      try {
        files = readdirSync(p2);
      } catch {
        continue;
      }

      for (const file of files) {
        if (!file.endsWith(".apk")) continue;
        const sha256 = basename(file, ".apk");
        const filePath = join(p2, file);
        const stat = statSync(filePath);
        process.stdout.write(
          JSON.stringify({
            sha256,
            path: filePath,
            size: stat.size,
            downloaded_at: stat.mtime.toISOString(),
          }) + "\n",
        );
        count++;
      }
    }
  }

  process.stderr.write(`${count} APKs in store\n`);
}
