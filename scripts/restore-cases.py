"""Restore the versioned public demo files to a checkout before a static deployment."""
import hashlib
import os
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[1]
PUBLIC = ROOT / "web/app/public"
SOURCE = "https://longmarker.vercel.app/"


def restore(line):
    digest, relative = line.split("  ", 1)
    target = PUBLIC / relative
    if target.is_file() and hashlib.sha256(target.read_bytes()).hexdigest() == digest:
        return
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_suffix(target.suffix + ".part")
    try:
        checksum = hashlib.sha256()
        with urlopen(SOURCE + relative, timeout=90) as response, temporary.open("wb") as output:
            while chunk := response.read(1024 * 1024):
                checksum.update(chunk)
                output.write(chunk)
        if checksum.hexdigest() != digest:
            raise ValueError(f"Checksum mismatch for {relative}")
        os.replace(temporary, target)
    finally:
        temporary.unlink(missing_ok=True)


if __name__ == "__main__":
    files = (ROOT / "scripts/cases.sha256").read_text().splitlines()
    with ThreadPoolExecutor(max_workers=4) as pool:
        list(pool.map(restore, files))
    print(f"Verified {len(files)} public case files")
