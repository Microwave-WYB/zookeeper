import { readdirSync, createReadStream } from "node:fs";
import { join, basename } from "node:path";
import { createHash } from "node:crypto";
import { storePath } from "./config";

/**
 * Walk the store and verify each APK's sha256 matches its filename.
 * Uses streaming hash to avoid loading large APKs into memory.
 */
export function verify(): void {
  const store = storePath();
  let total = 0;
  let ok = 0;
  let bad = 0;
  const pending: Promise<void>[] = [];

  let level1: string[];
  try {
    level1 = readdirSync(store);
  } catch {
    process.stderr.write("Store directory not found\n");
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
        total++;
        const expectedSha = basename(file, ".apk");
        const filePath = join(p2, file);

        // Stream hash to avoid loading entire file into memory
        const p = new Promise<void>((resolve) => {
          const hash = createHash("sha256");
          const stream = createReadStream(filePath);
          stream.on("data", (chunk: Buffer) => hash.update(chunk));
          stream.on("end", () => {
            const actual = hash.digest("hex");
            if (actual === expectedSha) {
              ok++;
            } else {
              bad++;
              process.stdout.write(
                JSON.stringify({
                  sha256: expectedSha,
                  actual_sha256: actual,
                  path: filePath,
                  status: "mismatch",
                }) + "\n",
              );
            }
            if ((ok + bad) % 100 === 0) {
              process.stderr.write(`\rVerified ${ok + bad} (${ok} ok, ${bad} bad)`);
            }
            resolve();
          });
          stream.on("error", () => {
            bad++;
            process.stdout.write(
              JSON.stringify({ sha256: expectedSha, path: filePath, status: "read_error" }) + "\n",
            );
            resolve();
          });
        });
        pending.push(p);
      }
    }
  }

  // Wait for all hashing to complete — this is sync-ish since we collected all promises
  // In practice, verify is called from a sync context, so we attach the final report
  void Promise.all(pending).then(() => {
    process.stderr.write(`\rVerified ${total} (${ok} ok, ${bad} bad)\n`);
  });
}
