import gzip
import json
from datetime import date, datetime
from itertools import batched
from pathlib import Path
from typing import Final

import httpx
import rich
from rich.progress import BarColumn, Progress, TextColumn, TimeRemainingColumn
from sqlmodel import JSON, Field, Session, SQLModel, col, create_engine, select

from zookeeper.download_utils import segmented_download


class GPMetadata(SQLModel):
    """SQLModel for Google Play metadata."""

    package_name: str = Field(primary_key=True)
    title: str
    description_short: str
    description_html: str
    num_downloads: str
    installation_size: int
    developer_website: str
    developer_name: str
    developer_email: str
    upload_date: date
    version_code: int
    version_string: str
    az_metadata_date: datetime

    data: dict = Field(sa_type=JSON)

    @classmethod
    def from_json(cls, raw_data: str) -> "GPMetadata":
        """Create an instance from a dictionary."""
        data = json.loads(raw_data)
        app_details = data["details"]["appDetails"]
        return GPMetadata(
            package_name=app_details["packageName"],
            title=data["title"],
            description_short=data["descriptionShort"],
            description_html=data["descriptionHtml"],
            num_downloads=app_details["numDownloads"],
            installation_size=app_details["installationSize"],
            developer_website=app_details["developerWebsite"],
            developer_name=app_details["developerName"],
            developer_email=app_details["developerEmail"],
            upload_date=app_details["uploadDate"],
            version_code=app_details["versionCode"],
            version_string=app_details["versionString"],
            az_metadata_date=data["azMetadataDate"],
            data=data,
        )


class MetadataSyncLog(SQLModel, table=True):
    """Log of the last sync with Google Play metadata."""

    etag: str = Field(primary_key=True)
    time_synced: datetime = Field(default_factory=datetime.now)


def estimate_gzfile_lines(filepath: Path, sample_size_mb=100):
    # Read random chunks
    with gzip.open(filepath, "rb") as f:
        # Sample beginning of file
        f.seek(0)
        start_chunk = f.read(sample_size_mb * 1024 * 1024)
        lines_in_start = start_chunk.count(b"\n")
        decompressed_start_size = len(start_chunk)

        # Get estimated decompressed size
        f.seek(0, 2)  # End of file
        decompressed_size = f.tell()

        # Estimate based on ratio
        estimated_lines = int(lines_in_start * (decompressed_size / decompressed_start_size))

    return estimated_lines


class MetadataDatabase:
    """Sync with Google Play metadata."""

    METADATA_URL: Final[str] = "https://androzoo.uni.lu/api/get_gp_metadata_file/full"

    def __init__(
        self,
        api_key: str,
        db_dsn: str | None = None,
        cache_dir: Path | str = Path("~/.cache/androzoo").expanduser(),
    ) -> None:
        self.api_key = api_key
        self.cache_dir = Path(cache_dir)
        self.dl_path = self.cache_dir / "gp-metadata-full.jsonl.gz"
        self.jsonl_path = self.cache_dir / "gp-metadata-full.jsonl"
        self.db_dsn = db_dsn or f"sqlite:///{self.cache_dir}/metadata.db"
        self.engine = create_engine(self.db_dsn)
        SQLModel.metadata.create_all(self.engine, checkfirst=True)

    @property
    def synced(self) -> bool:
        try:
            with Session(self.engine) as session:
                local_etag = session.exec(
                    select(MetadataSyncLog).order_by(col(MetadataSyncLog.time_synced).desc())
                ).first()
            if not local_etag:
                return False
            remote_etag = (
                httpx.head(MetadataDatabase.METADATA_URL, params=dict(apikey=self.api_key))
                .headers["etag"]
                .strip('"')
            )
            return local_etag.etag == remote_etag
        except Exception:
            return False

    def log_sync(self, etag: str) -> None:
        with Session(self.engine) as session:
            sync_log = MetadataSyncLog(etag=etag)
            session.add(sync_log)
            session.commit()
        print(f"[green]Sync log updated:[/green] {sync_log.etag} at {sync_log.time_synced}")

    def sync_with_jsonl(self):
        """Sync with the JSONL file from AndroZoo."""
        with Session(self.engine) as session, gzip.open(self.dl_path, "rb") as f, Progress(
            TextColumn("[progress.description]{task.description}"),
            BarColumn(),
            TimeRemainingColumn(),
            refresh_per_second=1,
        ) as pbar:
            task = pbar.add_task("Processing JSONL file", total=estimate_gzfile_lines(self.dl_path))
            for lines in batched(f, 1000):
                metadata_objs = [GPMetadata.from_json(line.decode("utf-8")) for line in lines]
                session.add_all(metadata_objs)
                pbar.update(task, advance=len(lines))
            session.commit()

    def sync(self, force: bool = False) -> None:
        """Sync with the Google Play metadata."""
        if not force and self.synced:
            rich.print("[green]Already synced.[/green]")
            return

        segmented_download(
            MetadataDatabase.METADATA_URL,
            params=dict(apikey=self.api_key),
            dest=self.dl_path,
            connections=40,
        )
        self.sync_with_jsonl()
        self.log_sync(
            httpx.head(MetadataDatabase.METADATA_URL, params=dict(apikey=self.api_key))
            .headers["etag"]
            .strip('"')
        )

    def get(self, package_name: str) -> GPMetadata | None:
        """Get metadata for a package name."""
        with Session(self.engine) as session:
            return session.get(GPMetadata, package_name)
