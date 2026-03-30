import { existsSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { storePath, getApiKey } from "./config";
import { downloadFile } from "./http";

const DOWNLOAD_URL = "https://androzoo.uni.lu/api/download";

function apkPath(sha256: string): string {
  const lower = sha256.toLowerCase();
  const dir = join(storePath(), lower.slice(0, 2), lower.slice(2, 4));
  return join(dir, `${lower}.apk`);
}

interface DownloadItem {
  sha256: string;
  [key: string]: unknown;
}

export async function download(opts: {
  jobs: number;
  force: boolean;
  items: AsyncIterable<DownloadItem> | Iterable<DownloadItem>;
}): Promise<void> {
  const apiKey = getApiKey();
  const maxJobs = Math.min(opts.jobs, 20);

  let total = 0;
  let downloaded = 0;
  let skipped = 0;
  let errors = 0;
  const active = new Set<Promise<void>>();

  const processItem = async (item: DownloadItem) => {
    total++;
    const dest = apkPath(item.sha256);

    if (!opts.force && existsSync(dest)) {
      skipped++;
      process.stdout.write(
        JSON.stringify({ sha256: item.sha256, status: "skipped", reason: "exists" }) + "\n",
      );
      reportStatus();
      return;
    }

    const url = `${DOWNLOAD_URL}?apikey=${apiKey}&sha256=${item.sha256}`;
    try {
      await downloadFile(url, dest);
      downloaded++;
      process.stdout.write(
        JSON.stringify({ sha256: item.sha256, status: "ok", path: dest }) + "\n",
      );
    } catch (e: unknown) {
      errors++;
      const reason = e instanceof Error ? e.message : String(e);
      process.stdout.write(JSON.stringify({ sha256: item.sha256, status: "error", reason }) + "\n");
    }
    reportStatus();
  };

  function reportStatus() {
    process.stderr.write(
      `\rDownloaded ${downloaded}/${total} (${skipped} skipped, ${errors} errors, ${active.size} active)`,
    );
  }

  for await (const item of opts.items) {
    // Wait if at max concurrency
    while (active.size >= maxJobs) {
      await Promise.race(active);
    }

    const p = processItem(item).then(() => {
      active.delete(p);
    });
    active.add(p);
  }

  // Wait for remaining
  await Promise.all(active);
  process.stderr.write(
    `\rDownloaded ${downloaded}/${total} (${skipped} skipped, ${errors} errors)        \n`,
  );
}

/**
 * Read JSONL from stdin, yielding DownloadItem objects.
 */
export async function* readStdinLines(): AsyncGenerator<DownloadItem> {
  const rl = createInterface({ input: process.stdin });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
      yield { sha256: trimmed };
    } else {
      process.stderr.write(`Warning: skipping invalid hash: ${trimmed.slice(0, 40)}\n`);
    }
  }
}
