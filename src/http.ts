import { mkdirSync, existsSync, renameSync, unlinkSync, createReadStream } from "node:fs";
import { dirname } from "node:path";

function formatBytes(bytes: number): string {
  if (bytes >= 1_073_741_824) return (bytes / 1_073_741_824).toFixed(1) + " GB";
  if (bytes >= 1_048_576) return (bytes / 1_048_576).toFixed(1) + " MB";
  if (bytes >= 1024) return (bytes / 1024).toFixed(1) + " KB";
  return String(bytes) + " B";
}

function reportProgress(
  label: string,
  downloaded: number,
  total: number,
  startTime: number,
  final = false,
) {
  const elapsed = (Date.now() - startTime) / 1000;
  const speed = elapsed > 0 ? downloaded / elapsed : 0;
  const pct = total ? Math.round((downloaded / total) * 100) : 0;
  const line = `${label} ${formatBytes(downloaded)} / ${formatBytes(total)} (${pct}%) ${formatBytes(speed)}/s`;
  process.stderr.write(final ? `\r${line}\n` : `\r${line}`);
}

export interface DownloadResult {
  status: "ok" | "skipped";
  etag?: string | null;
  size?: number;
}

/**
 * Download a file with chunked parallel HTTP Range requests.
 * Each chunk streams to its own temp file, then they're concatenated.
 */
export async function downloadChunked(
  url: string,
  destPath: string,
  opts: { numWorkers?: number; cachedEtag?: string; label?: string } = {},
): Promise<DownloadResult> {
  const numWorkers = opts.numWorkers ?? 20;
  const cachedEtag = opts.cachedEtag;
  const label = opts.label ?? "Downloading...";
  const dir = dirname(destPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  // HEAD to get size, ETag, range support
  const head = await fetch(url, { method: "HEAD" });
  if (!head.ok) throw new Error(`HEAD ${url}: ${head.status} ${head.statusText}`);

  const etag = head.headers.get("etag");
  const lastModified = head.headers.get("last-modified");
  if (cachedEtag && etag && cachedEtag === etag) {
    process.stderr.write("Skipping download (ETag unchanged)\n");
    return { status: "skipped", etag };
  }

  const contentLength = parseInt(head.headers.get("content-length") || "0", 10);
  const acceptRanges = head.headers.get("accept-ranges");
  const tmpPath = destPath + ".tmp";

  if (!contentLength || acceptRanges !== "bytes" || numWorkers <= 1) {
    await downloadSingle(url, tmpPath, contentLength, label);
  } else {
    await downloadParallel(url, tmpPath, contentLength, numWorkers, label);
  }

  // Atomic rename
  if (existsSync(destPath)) unlinkSync(destPath);
  renameSync(tmpPath, destPath);

  return { status: "ok", etag: etag || lastModified, size: contentLength };
}

async function downloadSingle(url: string, destPath: string, contentLength: number, label: string) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`GET ${url}: ${resp.status}`);

  const writer = Bun.file(destPath).writer();
  if (!resp.body) throw new Error(`GET ${url}: response body is null`);
  const reader = resp.body.getReader();
  let downloaded = 0;
  const startTime = Date.now();
  let lastReport = 0;

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
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

async function downloadParallel(
  url: string,
  destPath: string,
  totalSize: number,
  numWorkers: number,
  label: string,
) {
  const chunkSize = Math.ceil(totalSize / numWorkers);
  let totalDownloaded = 0;
  const startTime = Date.now();
  let lastReport = 0;

  const chunks: { start: number; end: number; index: number }[] = [];
  for (let i = 0; i < numWorkers; i++) {
    const start = i * chunkSize;
    const end = Math.min(start + chunkSize - 1, totalSize - 1);
    chunks.push({ start, end, index: i });
  }

  // Each worker streams to its own temp file
  const chunkPaths = chunks.map((c) => `${destPath}.part${c.index}`);

  const downloadChunkToFile = async (chunk: { start: number; end: number; index: number }) => {
    const chunkPath = chunkPaths[chunk.index] as string;
    const resp = await fetch(url, {
      headers: { Range: `bytes=${chunk.start}-${chunk.end}` },
    });
    if (!resp.ok && resp.status !== 206) {
      throw new Error(`Range request failed: ${resp.status}`);
    }

    const writer = Bun.file(chunkPath).writer();
    if (!resp.body)
      throw new Error(`Range request for chunk ${chunk.index}: response body is null`);
    const reader = resp.body.getReader();

    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
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
  };

  // Download all chunks in parallel
  await Promise.all(chunks.map(downloadChunkToFile));

  reportProgress(label, totalDownloaded, totalSize, startTime, true);

  // Concatenate chunk files into final file by streaming each
  process.stderr.write("Assembling chunks...\n");
  const outWriter = Bun.file(destPath).writer();
  for (const chunkPath of chunkPaths) {
    const stream = createReadStream(chunkPath);
    for await (const buf of stream) {
      await outWriter.write(buf as Uint8Array);
    }
    unlinkSync(chunkPath);
  }
  await outWriter.end();
}

/**
 * Simple single-file download (for APKs).
 */
export async function downloadFile(url: string, destPath: string): Promise<void> {
  const dir = dirname(destPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmpPath = destPath + ".tmp";
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`GET ${url}: ${resp.status}`);
  await Bun.write(tmpPath, resp);
  renameSync(tmpPath, destPath);
}
