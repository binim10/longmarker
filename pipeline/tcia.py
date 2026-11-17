"""Minimal TCIA NBIA v1 client (public collections, no auth)."""
import io, json, zipfile, pathlib, requests
BASE = "https://services.cancerimagingarchive.net/nbia-api/services/v1"

def get_series(collection, **kw):
    p = {"Collection": collection, "format": "json", **kw}
    return requests.get(f"{BASE}/getSeries", params=p, timeout=120).json()

def download_series(uid, out_dir):
    """Stream the series zip to disk with a short per-chunk timeout and retries."""
    import time, tempfile, os
    out = pathlib.Path(out_dir) / uid
    if out.exists() and any(out.iterdir()):
        return out
    out.mkdir(parents=True, exist_ok=True)
    for attempt in range(8):
        tmp = tempfile.NamedTemporaryFile(delete=False, suffix=".zip")
        try:
            with requests.get(f"{BASE}/getImage", params={"SeriesInstanceUID": uid}, stream=True, timeout=(30, 60)) as r:
                r.raise_for_status()
                for chunk in r.iter_content(1 << 20):
                    tmp.write(chunk)
            tmp.close()
            zipfile.ZipFile(tmp.name).extractall(out)
            os.unlink(tmp.name)
            return out
        except Exception as e:
            tmp.close()
            try: os.unlink(tmp.name)
            except OSError: pass
            print(f"  retry {attempt + 1} for ...{uid[-10:]}: {type(e).__name__}", flush=True)
            time.sleep(5 * (attempt + 1))
    raise RuntimeError(f"download failed {uid}")
