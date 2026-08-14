"""Offline tests for the fixture downloader."""

from __future__ import annotations

import hashlib
import http.server
import io
import threading
import unittest
from contextlib import redirect_stdout
from functools import partial
from pathlib import Path
from tempfile import TemporaryDirectory

import fetch_sample


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, format: str, *args: object) -> None:
        pass


class FetchSampleTests(unittest.TestCase):
    def test_catalog_integrity(self) -> None:
        names = []
        for key, source in fetch_sample.SOURCES.items():
            names.append(source["name"])
            self.assertEqual(key, source["name"])
            self.assertTrue(source["url"].startswith("https://"))
            self.assertIn(source["format"], {"ply", "splat", "ksplat", "spz"})
            self.assertTrue(source["approximate_size"])
            self.assertTrue(source["license"])
            self.assertIn("sha256", source)
        self.assertEqual(len(names), len(set(names)))

    def test_checksum_status(self) -> None:
        with TemporaryDirectory() as temporary:
            path = Path(temporary) / "sample.bin"
            path.write_bytes(b"known test payload")
            digest = hashlib.sha256(path.read_bytes()).hexdigest()
            self.assertTrue(fetch_sample.checksum_status(path, digest))
            self.assertFalse(fetch_sample.checksum_status(path, "0" * 64))
            self.assertIsNone(fetch_sample.checksum_status(path, None))

    def test_download_uses_part_then_atomic_rename(self) -> None:
        payload = b"fixture payload\x00" * 2048
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            served = root / "served"
            served.mkdir()
            (served / "scene.ksplat").write_bytes(payload)
            handler = partial(QuietHandler, directory=str(served))
            try:
                server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
            except PermissionError as error:
                self.skipTest(f"sandbox does not permit a local HTTP listener: {error}")
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                port = server.server_address[1]
                source = {
                    "name": "scene",
                    "url": f"http://127.0.0.1:{port}/scene.ksplat",
                    "format": "ksplat",
                    "approximate_size": "small",
                    "license": "test-only",
                    "sha256": hashlib.sha256(payload).hexdigest(),
                }
                output = root / "output"
                with redirect_stdout(io.StringIO()):
                    destination = fetch_sample.download_source(source, output)
                self.assertEqual(destination.read_bytes(), payload)
                self.assertFalse((output / "scene.ksplat.part").exists())
                self.assertTrue(destination.exists())
            finally:
                server.shutdown()
                server.server_close()
                thread.join()


if __name__ == "__main__":
    unittest.main()
