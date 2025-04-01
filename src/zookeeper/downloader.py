import threading
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from hashlib import sha256
from pathlib import Path
from queue import Queue, ShutDown
from typing import Final, TypeVar

import httpx
import rich
from rich.progress import (
    BarColumn,
    DownloadColumn,
    Progress,
    TaskID,
    TextColumn,
    TimeRemainingColumn,
    TransferSpeedColumn,
)

ANDROZOO_DOWNLOAD_ENDPOINT: Final[str] = "https://androzoo.uni.lu/api/download"
MAX_THREADS: Final[int] = 40

T = TypeVar("T")


def consume(queue: Queue[T], on_shutdown: Callable[[], None] | None = None) -> Iterator[T]:
    """Python please let us iterate over a queue. Something like this should be built-in."""
    try:
        while True:
            yield queue.get()
    except ShutDown:
        if on_shutdown:
            on_shutdown()


@dataclass
class DownloadJob:
    hash: str
    output_file: Path
    size: int
    fail_count: int = 0


class APKDownloader:
    def __init__(
        self,
        api_key: str,
        *,
        download_dir: Path | str = Path("downloads"),
        max_connections: int = 40,
        max_retries: int = 3,
        on_failure: Callable[[DownloadJob], None] | None = None,
        on_success: Callable[[DownloadJob], None] | None = None,
    ) -> None:
        self.api_key = api_key
        self.download_dir = Path(download_dir)
        self.download_dir.mkdir(parents=True, exist_ok=True)
        self.max_retries = max_retries
        self.on_failure = on_failure or (
            lambda job: rich.print("[red]Download failed after max retries:[/red]", job.hash)
        )
        self.on_success = on_success or (
            lambda job: rich.print("[green]Download completed:[/green]", job.hash)
        )
        self.httpxclient = httpx.Client(params=dict(apikey=api_key), timeout=30)
        self.max_connections = max_connections
        if max_connections > MAX_THREADS:
            rich.print(
                f"[yellow]Max connections limited to {MAX_THREADS}.[/yellow] "
                f"Set max_connections to {MAX_THREADS}."
            )
            self.max_connections = MAX_THREADS

        self.progress_queue = Queue[tuple[DownloadJob, int]]()
        self.job_queue = Queue[DownloadJob](self.max_connections)
        self.worker_threads: list[threading.Thread] = []
        for _ in range(self.max_connections):
            worker = threading.Thread(target=self._download_worker, daemon=True)
            self.worker_threads.append(worker)
        self.monitor_thread = threading.Thread(target=self._monitor_worker, daemon=True)
        self.progress_bar = Progress(
            TextColumn("[progress.description]{task.description}"),
            BarColumn(),
            DownloadColumn(),
            TransferSpeedColumn(),
            TimeRemainingColumn(),
            refresh_per_second=1,
        )

    def _download_worker(self) -> None:
        def handle_failure(job: DownloadJob) -> None:
            job.fail_count += 1
            if job.fail_count >= self.max_retries:
                self.on_failure(job)
                return
            self.job_queue.put(job)

        for job in consume(self.job_queue):
            with self.httpxclient.stream(
                "GET", ANDROZOO_DOWNLOAD_ENDPOINT, params=dict(apikey=self.api_key, sha256=job.hash)
            ) as response:
                if response.is_error:
                    handle_failure(job)
                    continue
                temp_file = job.output_file.with_suffix(".apk.download")
                with open(temp_file, "ab") as f:
                    downloaded = 0
                    for chunk in response.iter_bytes(chunk_size=1024 * 1024):
                        f.write(chunk)
                        downloaded += len(chunk)
                        self.progress_queue.put((job, downloaded))
                temp_file.rename(job.output_file)
                self.on_success(job)

    def _monitor_worker(self) -> None:
        tasks: dict[str, TaskID] = {}

        with self.progress_bar as pbar:
            for job, size in consume(
                self.progress_queue, lambda: rich.print("[green]All downloads completed.[/green]")
            ):
                task_id = tasks.get(job.hash)
                if task_id is None:
                    task_id = pbar.add_task(f"{job.hash[:10]}...", total=job.size)
                    tasks[job.hash] = task_id
                pbar.update(task_id, completed=size)
                if size >= job.size:
                    pbar.remove_task(task_id)
                    tasks.pop(job.hash)

    def _verify(self, hash: str, file: Path | str) -> bool:
        """Verify the hash of a file"""
        file = Path(file)
        if not file.exists():
            return False
        return hash == sha256(file.read_bytes()).hexdigest().upper()

    def _start(self) -> None:
        """Start the download and monitoring threads"""
        for worker in self.worker_threads:
            worker.start()
        self.monitor_thread.start()

    def _wait(self) -> None:
        """Wait for all downloads to complete"""
        self.job_queue.shutdown()
        for worker in self.worker_threads:
            worker.join()
        self.progress_queue.shutdown()
        self.monitor_thread.join()

    def __enter__(self) -> "APKDownloader":
        self._start()
        return self

    def __exit__(self, exc_type, exc_val, exc_tb) -> None:
        self._wait()
        self.httpxclient.close()

    def enqueue(self, hash: str) -> None:
        """Download a file from AndroZoo. Blocks if the queue is full."""

        output_file = self.download_dir / f"{hash}.apk"
        if output_file.exists() and self._verify(hash, output_file):
            rich.print("[green]Already downloaded:[/green]", hash)
            return
        head_response = self.httpxclient.head(
            ANDROZOO_DOWNLOAD_ENDPOINT, params=dict(apikey=self.api_key, sha256=hash)
        )
        head_response.raise_for_status()
        content_length = int(head_response.headers.get("Content-Length", 0))
        job = DownloadJob(hash=hash, output_file=output_file, size=content_length)
        self.job_queue.put(job)
