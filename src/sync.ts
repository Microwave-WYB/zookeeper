import { ensureDirs, dbPath, getZooHome, getApiKey } from "./config";
import { downloadChunked } from "./http";
import { importCsv } from "./csv_import";
import { importMetadata } from "./metadata_import";

const CSV_URL = "https://androzoo.uni.lu/static/lists/latest.csv.gz";
const CSV_ADDED_URL = "https://androzoo.uni.lu/static/lists/latest_with-added-date.csv.gz";
const METADATA_URL = "https://androzoo.uni.lu/api/get_gp_metadata_file/full";

export async function sync(opts: {
  withAddedDate: boolean;
  withMetadata: boolean;
}): Promise<void> {
  ensureDirs();

  const home = getZooHome();
  const db = dbPath();

  // Download CSV
  const csvUrl = opts.withAddedDate ? CSV_ADDED_URL : CSV_URL;
  const gzPath = `${home}/latest.csv.gz`;

  process.stderr.write("Downloading CSV...\n");
  await downloadChunked(csvUrl, gzPath);

  // Import CSV
  process.stderr.write("Importing CSV into database...\n");
  const csvResult = await importCsv(db, gzPath, opts.withAddedDate);
  process.stderr.write(`CSV import complete: ${csvResult.rows} rows, ${csvResult.skipped} skipped\n`);

  // Optionally download + import GP metadata
  if (opts.withMetadata) {
    const apiKey = getApiKey();
    const metaGzPath = `${home}/gp-metadata-full.jsonl.gz`;
    const metaUrl = `${METADATA_URL}?apikey=${apiKey}`;

    process.stderr.write("Downloading GP metadata...\n");
    await downloadChunked(metaUrl, metaGzPath);

    process.stderr.write("Importing GP metadata into database...\n");
    const metaResult = await importMetadata(db, metaGzPath);
    process.stderr.write(`Metadata import complete: ${metaResult.rows} rows, ${metaResult.skipped} skipped\n`);
  }

  process.stderr.write("Sync complete\n");
}
