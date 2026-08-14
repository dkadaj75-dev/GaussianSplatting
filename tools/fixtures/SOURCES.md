# Fixture source provenance

The fixtures are compact `.ksplat` files published by the
[`@mkkellogg/gaussian-splats-3d`](https://github.com/mkkellogg/GaussianSplats3D)
project for its public viewer demo. The project is licensed under MIT; these
demo downloads are its intended sample content. Retain this attribution when
redistributing a fixture outside this repository.

| Fixture | Download | Format / approximate size | License and attribution |
| --- | --- | --- | --- |
| `bonsai` | [bonsai.ksplat](https://projects.markkellogg.org/downloads/gaussian_splat_data/bonsai.ksplat) | `.ksplat`, about 8 MB | Mark Kellogg's GaussianSplats3D demo sample; distributed with the MIT-licensed GaussianSplats3D project. |
| `garden` | [garden.ksplat](https://projects.markkellogg.org/downloads/gaussian_splat_data/garden.ksplat) | `.ksplat`, about 18 MB | Mark Kellogg's GaussianSplats3D demo sample; distributed with the MIT-licensed GaussianSplats3D project. |

## Integrity status

Neither upstream download currently publishes an authoritative SHA-256 value.
Consequently both catalog entries deliberately have `sha256: null` and the
fetcher prints **UNVERIFIED**. This avoids presenting a hash copied from an
unreviewed mirror as a trust guarantee. Pin a digest only after downloading the
canonical URL and recording the review in this file.
