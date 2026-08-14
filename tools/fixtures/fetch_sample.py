#!/usr/bin/env python3
"""Fetch small, curated Gaussian-splat fixtures without third-party packages."""

from __future__ import annotations

import argparse
import hashlib
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import BinaryIO, Mapping


# SHA-256 values are deliberately null until they are independently pinned from
# a canonical download.  `get` makes this trust boundary conspicuous.
SOURCES: dict[str, dict[str, str | None]] = {
    "bonsai": {
        "name": "bonsai",
        "url": "https://projects.markkellogg.org/downloads/gaussian_splat_data/bonsai.ksplat",
        "format": "ksplat",
        "approximate_size": "8 MB",
        "license": "Distributed as a sample with gaussian-splats-3d (MIT); see SOURCES.md.",
        "sha256": None,
    },
    "garden": {
        "name": "garden",
        "url": "https://projects.markkellogg.org/downloads/gaussian_splat_data/garden.ksplat",
        "format": "ksplat",
        "approximate_size": "18 MB",
        "license": "Distributed as a sample with gaussian-splats-3d (MIT); see SOURCES.md.",
        "sha256": None,
    },
}

CHUNK_SIZE = 1024 * 128
DEFAULT_OUTPUT = Path(__file__).resolve().parent / "data"


def filename_for(source: Mapping[str, str | None]) -> str:
    return f"{source['name']}.{source['format']}"


def checksum_status(path: Path, expected: str | None) -> bool | None:
    """Return True/False for a checked file, or None when no hash is pinned."""
    if expected is None:
        return None
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(CHUNK_SIZE), b""):
            digest.update(block)
    return digest.hexdigest().lower() == expected.lower()


def _progress(downloaded: int, total: int | None) -> None:
    if total:
        percent = min(100, downloaded * 100 // total)
        print(f"\r  Downloaded {downloaded / 1024 / 1024:.1f} / {total / 1024 / 1024:.1f} MiB ({percent}%)", end="", flush=True)
    else:
        print(f"\r  Downloaded {downloaded / 1024 / 1024:.1f} MiB", end="", flush=True)


def download_source(source: Mapping[str, str | None], output_dir: Path) -> Path:
    """Download one source through a .part file and atomically publish it."""
    output_dir.mkdir(parents=True, exist_ok=True)
    destination = output_dir / filename_for(source)
    partial = destination.with_name(destination.name + ".part")
    expected = source["sha256"]

    if destination.exists():
        status = checksum_status(destination, expected)
        if status is True:
            print(f"Already present and checksum verified: {destination}")
            return destination
        if status is None:
            print(f"Already present but UNVERIFIED (no SHA-256 pinned): {destination}")
            return destination
        print(f"Existing file checksum mismatch; downloading again: {destination}")

    offset = partial.stat().st_size if partial.exists() else 0
    request = urllib.request.Request(str(source["url"]), headers={"User-Agent": "SplatScene-fixture-fetcher/1.0"})
    if offset:
        request.add_header("Range", f"bytes={offset}-")
        print(f"Resuming partial download at {offset / 1024 / 1024:.1f} MiB")
    else:
        print(f"Downloading {source['name']} to {destination}")

    try:
        with urllib.request.urlopen(request) as response:  # nosec B310: curated HTTPS URLs
            status = getattr(response, "status", response.getcode())
            # A server that ignores Range returns a complete 200 response.
            append = offset > 0 and status == 206
            if not append:
                offset = 0
            length = response.headers.get("Content-Length")
            total = offset + int(length) if length and length.isdigit() else None
            with partial.open("ab" if append else "wb") as handle:
                downloaded = offset
                while block := response.read(CHUNK_SIZE):
                    handle.write(block)
                    downloaded += len(block)
                    _progress(downloaded, total)
    except urllib.error.HTTPError as error:
        raise RuntimeError(f"HTTP {error.code} while downloading {source['url']}: {error.reason}") from error
    except urllib.error.URLError as error:
        raise RuntimeError(f"Network error while downloading {source['url']}: {error.reason}") from error
    except OSError as error:
        raise RuntimeError(f"Could not write fixture in {output_dir}: {error}") from error

    print()
    status = checksum_status(partial, expected)
    if status is False:
        raise RuntimeError(f"SHA-256 mismatch for {partial}; keeping partial file for inspection.")
    if status is None:
        print("WARNING: download is UNVERIFIED because this source has no pinned SHA-256 checksum.")
    else:
        print("SHA-256 verified.")
    os.replace(partial, destination)
    print(f"Saved {destination}")
    return destination


def print_catalog() -> None:
    for source in SOURCES.values():
        verification = source["sha256"] or "UNVERIFIED (no SHA-256 pinned)"
        print(f"{source['name']}: .{source['format']}, about {source['approximate_size']}")
        print(f"  {source['url']}")
        print(f"  License: {source['license']}")
        print(f"  SHA-256: {verification}")


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUTPUT, metavar="DIR", help="download directory (default: tools/fixtures/data)")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("list", help="print the curated source catalog")
    get = commands.add_parser("get", help="download one fixture")
    get.add_argument("name", choices=sorted(SOURCES), help="fixture name")
    get.add_argument("--out", type=Path, dest="out_override", metavar="DIR", help="download directory (also accepted before the command)")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    if args.command == "list":
        print_catalog()
        return 0
    try:
        download_source(SOURCES[args.name], args.out_override or args.out)
    except RuntimeError as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
