import gleam/javascript/promise.{type Promise}

pub type DownloadStatus {
  Downloaded(etag: String)
  Skipped(etag: String)
}

@external(javascript, "./http_ffi.mjs", "download_chunked")
fn do_download_chunked(
  url: String,
  dest: String,
  label: String,
  workers: Int,
  cached_etag: String,
) -> Promise(Result(#(String, String), String))

pub fn download_chunked(
  url url: String,
  dest dest: String,
  label label: String,
  workers workers: Int,
  cached_etag cached_etag: String,
) -> Promise(Result(DownloadStatus, String)) {
  do_download_chunked(url, dest, label, workers, cached_etag)
  |> promise.map(fn(result) {
    case result {
      Ok(#("skipped", etag)) -> Ok(Skipped(etag))
      Ok(#(_, etag)) -> Ok(Downloaded(etag))
      Error(e) -> Error(e)
    }
  })
}

@external(javascript, "./http_ffi.mjs", "download_file")
pub fn download_file(url: String, dest: String) -> Promise(Result(Nil, String))
