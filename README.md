# ZooKeeper: Utility Library for AndroZoo

## Install

```bash
pip install zookeeper
```

## Usage

### Download APKs

To download APKs, you need to import the `APKDownloader` class and create an instance of it.

```python
from zookeeper import APKDownloader

with APKDownloader() as downloader:
    for hash in [
        "0000003B455A6C7AF837EF90F2EAFFD856E3B5CF49F5E27191430328DE2FA670",
        "0000014A634DB98F85038B833A8DFC50D5FB13A464E0B25994E439AEF830CD70",
        "000001A94F46A0C3DDA514E1F24E675648835BBA5EF3C3AA72D9C378534FCAD6",
        "000002B63FAD4B030787F6DE4081DC1E12325026EB7DDAD146C52F5F4FC2D525",
        "000003D3981DC548A772A30D688F424CFB88561A63A2DD888E7CF55171442946",
    ]:
        downloader.enqueue(hash)
```

You can also add callbacks to handle success and failure cases.

```python
from zookeeper import APKDownloader, DownloadJob

def on_success(job: DownloadJob):
    print(f"Downloaded {job.hash}")

def on_failure(job: DownloadJob):
    print(f"Failed to download {job.hash}")

with APKDownloader(on_success=on_success, on_failure=on_failure) as downloader:
    for hash in [
        "0000003B455A6C7AF837EF90F2EAFFD856E3B5CF49F5E27191430328DE2FA670",
        "0000014A634DB98F85038B833A8DFC50D5FB13A464E0B25994E439AEF830CD70",
        "000001A94F46A0C3DDA514E1F24E675648835BBA5EF3C3AA72D9C378534FCAD6",
        "000002B63FAD4B030787F6DE4081DC1E12325026EB7DDAD146C52F5F4FC2D525",
        "000003D3981DC548A772A30D688F424CFB88561A63A2DD888E7CF55171442946",
    ]:
        downloader.enqueue(hash)
```

### Query the APK Lists

To use the lists, you need to import the `APKLists` class and create an instance of it. This will download the latest APK lists from AndroZoo and insert them into a SQLite database.

```python
from zookeeper import APKDownloader, APKLists

lists = APKLists()
```

On the first run, you need to sync the database. This will take a long time, so please be patient.

```python
lists.sync() # Takes a long time, please be patient
```

Once the database is synced once, you do not need to sync again next time unless you want to keep
the database up to date with the latest APK lists.

To search for an app, you can use the `search` method. This returns all APKs with `google` in its package name.

```python
apps = lists.search("google")
for app in apps:
print(app)
```

For more complex queries, you can use [SQLModel](https://sqlmodel.tiangolo.com/).

This example shows how to query the database for all APKs with `play.google.com` in its markets.

```python
from sqlmodel import select, Session

from zookeeper import APKLists, APKInfo

lists = APKLists()
with Session(lists.engine) as session:
    stmt = select(APKInfo).where(APKInfo.markets == "play.google.com")
    results = session.exec(stmt).all()

for app in results:
    print(app)
```

### Use `APKLists` and `APKDownloader` together:

This example shows how to use `APKLists` and `APKDownloader` together. It queries the database for a list of app names and downloads them.

```python
from zookeeper import APKDownloader, APKLists
from sqlmodel import select, Session, col

lists = APKLists()
names = [
    "com.zte.bamachaye",
    "com.tanersenel.onlinetvizle",
    "com.firstchoice.myfirstchoice",
    "com.deperu.sitiosarequipa",
    "com.safetravels.safetravelsmain"
]
with APKDownloader() as dl:
    with Session(lists.engine) as session:
        stmt = select(APKInfo).where(col(APKInfo.name).in_(names))
        results = session.exec(stmt).all()

        for app in results:
            dl.enqueue(app.sha256)
```
