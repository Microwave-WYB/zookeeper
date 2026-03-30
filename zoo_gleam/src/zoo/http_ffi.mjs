import { mkdirSync, existsSync, renameSync, unlinkSync, createReadStream } from "node:fs";
import { dirname } from "node:path";
import { Ok, Error } from "../gleam.mjs";

function formatBytes(bytes) {
  if (bytes >= 1_073_741_824) return (bytes / 1_073_741_824).toFixed(1) + " GB";
  if (bytes >= 1_048_576) return (bytes / 1_048_576).toFixed(1) + " MB";
  if (bytes >= 1024) return (bytes / 1024).toFixed(1) + " KB";
  return String(bytes) + " B";
}

function reportProgress(label, downloaded, total, startTime, final = false) {
  const elapsed = (Date.now() - startTime) / 1000;
  const speed = elapsed > 0 ? downloaded / elapsed : 0;
  const pct = total ? Math.round((downloaded / total) * 100) : 0;
  const line = `${label} ${formatBytes(downloaded)} / ${formatBytes(total)} (${pct}%) ${formatBytes(speed)}/s`;
  process.stderr.write(final ? `\r${line}\n` : `\r${line}`);
}

// Returns Promise(Result(#(status, etag), String))
export async function download_chunked(url, destPath, label, numWorkers, cachedEtag) {
  try {
    const dir = dirname(destPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    const head = await fetch(url, { method: "HEAD" });
    if (!head.ok) return new Error(`HEAD ${url}: ${head.status} ${head.statusText}`);

    const etag = head.headers.get("etag");
    const lastModified = head.headers.get("last-modified");
    if (cachedEtag && etag && cachedEtag === etag) {
      process.stderr.write(`${label} Already up to date\n`);
      return new Ok(["skipped", etag || ""]);
    }

    const contentLength = parseInt(head.headers.get("content-length") || "0", 10);
    const acceptRanges = head.headers.get("accept-ranges");
    const tmpPath = destPath + ".tmp";

    if (!contentLength || acceptRanges !== "bytes" || numWorkers <= 1) {
      await downloadSingle(url, tmpPath, contentLength, label);
    } else {
      await downloadParallel(url, tmpPath, contentLength, numWorkers, label);
    }

    if (existsSync(destPath)) unlinkSync(destPath);
    renameSync(tmpPath, destPath);

    return new Ok(["ok", etag || lastModified || ""]);
  } catch (e) {
    return new Error(e.message);
  }
}

async function downloadSingle(url, destPath, contentLength, label) {
  const resp = await fetch(url);
  if (!resp.ok) throw new window.Error(`GET ${url}: ${resp.status}`);
  if (!resp.body) throw new window.Error("No response body");

  const writer = Bun.file(destPath).writer();
  const reader = resp.body.getReader();
  let downloaded = 0;
  const startTime = Date.now();
  let lastReport = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    await writer.write(value);
    downloaded += value.byteLength;
    const now = Date.now();
    if (now - lastReport >= 500) {
      reportProgress(label, downloaded, contentLength, startTime);
      lastReport = now;
    }
  }
  await writer.end();
  reportProgress(label, downloaded, contentLength, startTime, true);
}

async function downloadParallel(url, destPath, totalSize, numWorkers, label) {
  const chunkSize = Math.ceil(totalSize / numWorkers);
  let totalDownloaded = 0;
  const startTime = Date.now();
  let lastReport = 0;

  const chunks = [];
  for (let i = 0; i < numWorkers; i++) {
    const start = i * chunkSize;
    const end = Math.min(start + chunkSize - 1, totalSize - 1);
    chunks.push({ start, end, index: i });
  }

  const chunkPaths = chunks.map((c) => `${destPath}.part${c.index}`);

  await Promise.all(
    chunks.map(async (chunk) => {
      const chunkPath = chunkPaths[chunk.index];
      const resp = await fetch(url, {
        headers: { Range: `bytes=${chunk.start}-${chunk.end}` },
      });
      if (!resp.ok && resp.status !== 206) throw new window.Error(`Range request failed: ${resp.status}`);
      if (!resp.body) throw new window.Error("No response body");

      const writer = Bun.file(chunkPath).writer();
      const reader = resp.body.getReader();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        await writer.write(value);
        totalDownloaded += value.byteLength;
        const now = Date.now();
        if (now - lastReport >= 500) {
          reportProgress(label, totalDownloaded, totalSize, startTime);
          lastReport = now;
        }
      }
      await writer.end();
    }),
  );

  reportProgress(label, totalDownloaded, totalSize, startTime, true);

  process.stderr.write("Assembling chunks...\n");
  const outWriter = Bun.file(destPath).writer();
  for (const chunkPath of chunkPaths) {
    const stream = createReadStream(chunkPath);
    for await (const buf of stream) {
      await outWriter.write(buf);
    }
    unlinkSync(chunkPath);
  }
  await outWriter.end();
}

// Simple single-file download (for APKs)
export async function download_file(url, destPath) {
  try {
    const dir = dirname(destPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const tmpPath = destPath + ".tmp";
    const resp = await fetch(url);
    if (!resp.ok) return new Error(`GET ${url}: ${resp.status}`);
    await Bun.write(tmpPath, resp);
    renameSync(tmpPath, destPath);
    return new Ok(undefined);
  } catch (e) {
    return new Error(e.message);
  }
}
