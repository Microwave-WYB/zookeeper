import csv
import gzip
import subprocess
from collections.abc import Iterable
from datetime import datetime
from itertools import batched
from pathlib import Path
from typing import Any, Final

import httpx
import rich
from pydantic import field_validator
from pydantic_core import ValidationError
from sqlmodel import Field, Session, SQLModel, col, create_engine, select

from zookeeper.download_utils import segmented_download


class APKInfo(SQLModel, table=True):
    sha256: str = Field(primary_key=True)
    sha1: str
    md5: str
    dex_date: datetime
    apk_size: int
    pkg_name: str = Field(index=True)
    vercode: int
    vt_detection: int
    dex_size: int
    markets: str

    @field_validator("vercode", "vt_detection", "apk_size", "dex_size", mode="before")
    def validate_str_to_int(cls, value: Any) -> int:
        try:
            return int(value)
        except Exception:
            return 0


class APKListsSyncLog(SQLModel, table=True):
    """Log of the last sync with AndroZoo listing database."""

    etag: str = Field(primary_key=True)
    time_synced: datetime = Field(default_factory=datetime.now)


class ListsDatabase:
    """Sync with AndroZoo listing database."""

    LIST_URL: Final[str] = "https://androzoo.uni.lu/static/lists/latest.csv.gz"

    def __init__(
        self,
        db_dsn: str | None = None,
        cache_dir: Path | str = Path("~/.cache/androzoo").expanduser(),
    ) -> None:
        self.cache_dir = Path(cache_dir)
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self.dl_path = self.cache_dir / "latest.csv.gz"
        self.csv_path = self.cache_dir / "latest.csv"
        self.db_dsn = db_dsn or "sqlite:///{self.cache_dir}/lists.db"
        self.engine = create_engine(self.db_dsn)
        SQLModel.metadata.create_all(self.engine, checkfirst=True)

    @property
    def synced(self) -> bool:
        try:
            with Session(self.engine) as session:
                local_etag = session.exec(
                    select(APKListsSyncLog).order_by(col(APKListsSyncLog.time_synced).desc())
                ).first()
            if not local_etag:
                return False
            remote_etag = httpx.head(ListsDatabase.LIST_URL).headers["etag"].strip('"')
            return local_etag.etag == remote_etag
        except Exception:
            return False

    def log_sync(self, etag: str) -> None:
        with Session(self.engine) as session:
            sync_log = APKListsSyncLog(etag=etag)
            session.add(sync_log)
            session.commit()
        rich.print(f"[green]Sync log updated:[/green] {sync_log.etag} at {sync_log.time_synced}")

    def sync_with_csv(self) -> None:
        def insert_apks(session: Session, rows: Iterable[dict[str, str]]) -> None:
            # get a list of existing hashes where sha256 is in rows
            current_hashes = {row["sha256"] for row in rows}
            existing_hashes = {
                row.sha256
                for row in session.exec(
                    select(APKInfo).where(col(APKInfo.sha256).in_(current_hashes))
                )
            }
            new_rows = [row for row in rows if row["sha256"] not in existing_hashes]
            if not new_rows:
                return
            models = []
            for row in new_rows:
                try:
                    model = APKInfo.model_validate(row)
                    models.append(model)
                except ValidationError:
                    rich.print(f"[red]Validation error for row:[/red] {row}")
                    continue
            session.add_all(models)
            session.commit()

        with open(self.csv_path, "r") as f:
            reader = csv.DictReader(f)
            total_lines = int(subprocess.check_output(["wc", "-l", self.csv_path]).split()[0]) - 1
            print(f"Total lines: {total_lines}")
            rows_inserted = 0
            with Session(self.engine) as session:
                for rows in batched(reader, 1000):
                    insert_apks(session, rows)
                    rows_inserted += len(rows)
                    print(f"{rows_inserted:,} / {total_lines:,}", flush=True, end="\r")

    def sync(self, force=False) -> None:
        """
        Sync with AndroZoo listing database.
        WARNING: This is VERY SLOW. Usually you do not need to call this method.

        Args:
            force (bool): Force sync even if already synced.
        """
        if not force and self.synced:
            rich.print("[green]Already synced.[/green]")
            return
        segmented_download(
            ListsDatabase.LIST_URL,
            dest=self.dl_path,
            connections=40,
        )

        with gzip.open(self.dl_path, "rb") as f_in, open(self.csv_path, "wb") as f_out:
            while chunk := f_in.read(1024 * 1024):
                f_out.write(chunk)

        self.sync_with_csv()
        self.log_sync(httpx.head(ListsDatabase.LIST_URL).headers["etag"].strip('"'))

    def search(self, name: str) -> list[APKInfo]:
        """Search for a package name in the database."""
        with Session(self.engine) as session:
            results = session.exec(
                select(APKInfo).where(col(APKInfo.pkg_name).ilike(f"%{name}%"))
            ).all()
        return list(results)
