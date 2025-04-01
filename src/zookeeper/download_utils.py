import asyncio as aio
import time
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import aiofiles
import httpx
from rich.progress import (
    BarColumn,
    DownloadColumn,
    Progress,
    TextColumn,
    TimeRemainingColumn,
    TransferSpeedColumn,
)


def infer_filename(url: str, headers: Mapping[str, Any]) -> str:
    """Infer filename from headers."""
    default = url.split("/")[-1]
    if content_disposition := headers.get("Content-Disposition"):
        filename = content_disposition.split("filename=")[-1]
        return filename.strip('"')
    return default


@dataclass(frozen=True)
class DownloadJob:
    url: str
    dest: Path
    start: int = 0
    end: int = 0
    user_headers: dict[str, Any] = field(default_factory=dict)
    params: dict[str, str] = field(default_factory=dict)

    @property
    def headers(self) -> dict[str, Any]:
        if self.start or self.end:
            return {"Range": f"bytes={self.start}-{self.end}"} | self.user_headers
        return self.user_headers


@dataclass(frozen=True)
class DownloadBuffer:
    job: DownloadJob
    buffer: bytes

    @property
    def size(self) -> int:
        return len(self.buffer)


async def asegmented_download(
    url: str,
    params: dict[str, str] | None = None,
    headers: dict[str, Any] | None = None,
    dest: str | Path | None = None,
    connections: int = 10,
    progress_bar: Progress | None = None,
) -> None:
    """Main function to download a file using segmented downloading."""

    async def progress_worker(
        progress_q: aio.Queue[int | None],
        total_size: int,
    ) -> None:
        """Display download progress."""
        time_started = time.time()
        with progress_bar or Progress(
            TextColumn("[progress.description]{task.description}"),
            BarColumn(),
            DownloadColumn(),
            TransferSpeedColumn(),
            TimeRemainingColumn(),
            TextColumn("[bold cyan]"),
            refresh_per_second=1,
        ) as pbar:
            task = pbar.add_task(url, total=total_size)
            while advance := await progress_q.get():
                pbar.update(task, advance=advance)

        print(f"Download completed in {time.time() - time_started:.2f} seconds.")

    async with httpx.AsyncClient() as client:

        async def fetch_file_info(
            client: httpx.AsyncClient,
        ) -> tuple[str, int]:
            """Fetch file info from the server."""
            response = await client.head(url, params=params or {}, headers=headers or {})
            response.raise_for_status()
            filename = infer_filename(url, response.headers)
            content_length = int(response.headers.get("Content-Length", "0"))
            return filename, content_length

        filename, content_length = await fetch_file_info(client)
        dest = Path(dest or filename)
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.touch(exist_ok=True)

        job_q = aio.Queue[DownloadJob | None](10)
        progress_q = aio.Queue[int | None]()

        progress_task = aio.create_task(progress_worker(progress_q, content_length))

        async with aio.TaskGroup() as tg:

            async def prepare_jobs():
                segment_size = content_length // connections
                for i in range(connections):
                    start = i * segment_size
                    end = min((i + 1) * segment_size - 1, content_length - 1)
                    job = DownloadJob(
                        url, dest, start, end, params=params or {}, user_headers=headers or {}
                    )
                    await job_q.put(job)
                await job_q.put(None)

            tg.create_task(prepare_jobs())

            while job := await job_q.get():
                buf_q = aio.Queue[DownloadBuffer | None]()

                async def download_segment(
                    job: DownloadJob,
                    buf_q: aio.Queue[DownloadBuffer | None],
                ) -> None:
                    async with client.stream(
                        "GET", job.url, params=job.params, headers=job.headers
                    ) as response:
                        response.raise_for_status()
                        async for chunk in response.aiter_bytes(1024 * 1024):
                            await progress_q.put(len(chunk))
                            await buf_q.put(DownloadBuffer(job, chunk))
                        await buf_q.put(None)

                tg.create_task(download_segment(job, buf_q))

                async def write_buffer(
                    job: DownloadJob,
                    buf_q: aio.Queue[DownloadBuffer | None],
                ) -> None:
                    async with aiofiles.open(job.dest, "r+b") as file:
                        offset = job.start
                        while buffer := await buf_q.get():
                            await file.seek(offset)
                            await file.write(buffer.buffer)
                            offset += len(buffer.buffer)

                tg.create_task(write_buffer(job, buf_q))

        await progress_q.put(None)
        await progress_task


def segmented_download(
    url: str,
    params: dict[str, str] | None = None,
    headers: dict[str, Any] | None = None,
    dest: str | Path | None = None,
    connections: int = 10,
    progress_bar: Progress | None = None,
) -> None:
    aio.run(asegmented_download(url, params, headers, dest, connections, progress_bar))
