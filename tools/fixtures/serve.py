#!/usr/bin/env python3
"""Serve local Gaussian-splat fixtures with CORS and byte-range support."""

from __future__ import annotations

import argparse
import os
import re
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


DEFAULT_DIRECTORY = Path(__file__).resolve().parent / "data"
RANGE_RE = re.compile(r"bytes=(\d*)-(\d*)$")


class FixtureHandler(SimpleHTTPRequestHandler):
    """A static handler that permits browser cross-origin fixture loads."""

    range: tuple[int, int] | None = None

    def end_headers(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Range")
        self.send_header("Access-Control-Expose-Headers", "Accept-Ranges, Content-Length, Content-Range")
        super().end_headers()

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def send_head(self):  # type: ignore[override]
        path = self.translate_path(self.path)
        if os.path.isdir(path):
            return super().send_head()
        try:
            file = open(path, "rb")
        except OSError:
            self.send_error(404, "File not found")
            return None
        try:
            size = os.fstat(file.fileno()).st_size
            self.range = self._parse_range(self.headers.get("Range"), size)
            if self.range == (-1, -1):
                self.send_response(416)
                self.send_header("Content-Range", f"bytes */{size}")
                self.end_headers()
                file.close()
                return None
            start, end = self.range if self.range else (0, size - 1)
            self.send_response(206 if self.range else 200)
            self.send_header("Content-type", self.guess_type(path))
            self.send_header("Accept-Ranges", "bytes")
            self.send_header("Content-Length", str(max(0, end - start + 1)))
            if self.range:
                self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
                file.seek(start)
            self.end_headers()
            return file
        except Exception:
            file.close()
            raise

    @staticmethod
    def _parse_range(value: str | None, size: int) -> tuple[int, int] | None:
        if not value:
            return None
        match = RANGE_RE.fullmatch(value.strip())
        if not match:
            return (-1, -1)
        first, last = match.groups()
        if not first:  # suffix range: bytes=-500
            count = int(last)
            if count <= 0:
                return (-1, -1)
            return (max(0, size - count), size - 1)
        start = int(first)
        end = int(last) if last else size - 1
        if start >= size or start > end:
            return (-1, -1)
        return (start, min(end, size - 1))

    def copyfile(self, source, outputfile) -> None:  # type: ignore[override]
        if not self.range:
            return super().copyfile(source, outputfile)
        remaining = self.range[1] - self.range[0] + 1
        while remaining:
            block = source.read(min(64 * 1024, remaining))
            if not block:
                break
            outputfile.write(block)
            remaining -= len(block)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8090)
    parser.add_argument("--directory", type=Path, default=DEFAULT_DIRECTORY)
    args = parser.parse_args(argv)
    directory = args.directory.resolve()
    directory.mkdir(parents=True, exist_ok=True)
    handler = lambda *handler_args, **handler_kwargs: FixtureHandler(*handler_args, directory=str(directory), **handler_kwargs)
    server = ThreadingHTTPServer(("", args.port), handler)
    print(f"Serving {directory} at http://localhost:{args.port}/ (CORS enabled; Range supported)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
