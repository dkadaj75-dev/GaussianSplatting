# Gaussian-splat development fixtures

This directory supplies a real, small Gaussian-splat scene for local viewer
development and browser tests, without running COLMAP or training.

## Fetch and serve

From the repository root:

```bash
python tools/fixtures/fetch_sample.py list
python tools/fixtures/fetch_sample.py get bonsai
python tools/fixtures/serve.py
```

The downloaded file is local-only at `tools/fixtures/data/bonsai.ksplat`.
`data/` is ignored by Git, so no scene payload is committed. Use `--out DIR`
with `fetch_sample.py` to select another location, or `--port 9000` with the
server to change its port.

Open the Viewer page and paste:

```
http://localhost:8090/bonsai.ksplat
```

The server sends `Access-Control-Allow-Origin: *` and supports `GET`, `HEAD`,
and single byte ranges, allowing the Vite app at `localhost:5173` and splat
loaders that issue range requests to access it.

## Sources and attribution

| Fixture | Format / size | License / attribution |
| --- | --- | --- |
| `bonsai` | `.ksplat`, about 8 MB | GaussianSplats3D public demo sample, distributed with the MIT-licensed [GaussianSplats3D project](https://github.com/mkkellogg/GaussianSplats3D). |
| `garden` | `.ksplat`, about 18 MB | GaussianSplats3D public demo sample, distributed with the MIT-licensed [GaussianSplats3D project](https://github.com/mkkellogg/GaussianSplats3D). |

See [SOURCES.md](./SOURCES.md) for direct URLs and checksum policy. The source
site does not publish authoritative SHA-256 values, so downloads are explicitly
reported as unverified; they are convenient development fixtures, not trusted
production artifacts.

## Network note

Run `fetch_sample.py get` on a developer machine with open internet access.
Restricted environments (sandboxed CI, egress-filtered cloud sessions) may
allow only package registries and deny other hosts at the proxy level; the
script will report a clear tunnel/HTTP error in that case rather than hang.
