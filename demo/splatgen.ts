/**
 * Procedural `.splat` scenes for the offline demo.
 *
 * The published demo page has no backend and no network, so it cannot fetch a
 * reconstruction. Instead it synthesises scenes in the very same 32-byte
 * `.splat` record the worker's `ply_to_splat` writes
 * (`<3f 3f 4B 4B`: position, scale, RGBA, quaternion as `q*128+128`), so the
 * renderer and the picking code are exercised on exactly the layout the real
 * pipeline produces.
 *
 * The two scenes mirror the two use cases in PLAN.md: a construction detail to
 * review after a site visit, and a fish from a day out.
 */

const BYTES_PER_SPLAT = 32;

export interface SplatRecord {
  position: [number, number, number];
  /** Per-axis standard deviation, in scene units. */
  scale: [number, number, number];
  /** 0–255 per channel. */
  color: [number, number, number];
  /** 0–255. */
  alpha: number;
}

export function encodeSplats(records: readonly SplatRecord[]): Uint8Array {
  const buffer = new ArrayBuffer(records.length * BYTES_PER_SPLAT);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  records.forEach((record, index) => {
    const offset = index * BYTES_PER_SPLAT;
    for (let axis = 0; axis < 3; axis += 1) {
      view.setFloat32(offset + axis * 4, record.position[axis], true);
      view.setFloat32(offset + 12 + axis * 4, record.scale[axis], true);
    }
    bytes[offset + 24] = record.color[0];
    bytes[offset + 25] = record.color[1];
    bytes[offset + 26] = record.color[2];
    bytes[offset + 27] = record.alpha;
    // Identity quaternion (w=1, x=y=z=0) encoded as q * 128 + 128. Axis-aligned
    // ellipsoids are enough for a demo scene and keep the generator readable.
    bytes[offset + 28] = 255;
    bytes[offset + 29] = 128;
    bytes[offset + 30] = 128;
    bytes[offset + 31] = 128;
  });

  return bytes;
}

/** Deterministic PRNG so a scene looks identical on every device and reload. */
function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function jitter(random: () => number, amount: number): number {
  return (random() - 0.5) * 2 * amount;
}

function shade(
  base: readonly [number, number, number],
  amount: number,
): [number, number, number] {
  return [
    Math.max(0, Math.min(255, Math.round(base[0] * amount))),
    Math.max(0, Math.min(255, Math.round(base[1] * amount))),
    Math.max(0, Math.min(255, Math.round(base[2] * amount))),
  ];
}

interface SlabOptions {
  min: [number, number, number];
  max: [number, number, number];
  color: [number, number, number];
  /** Splats per scene unit along each axis. */
  density?: number;
  grain?: number;
  splatScale?: number;
}

/**
 * Fill a box with splats concentrated on its surface.
 *
 * Real Gaussian splatting reconstructs surfaces, not volumes — photographs only
 * ever see the outside of things — so a hollow shell is both far cheaper and a
 * much more honest stand-in than a solid block.
 */
function slab(random: () => number, options: SlabOptions): SplatRecord[] {
  const { min, max, color } = options;
  const density = options.density ?? 26;
  const grain = options.grain ?? 0.18;
  const splatScale = options.splatScale ?? 0.009;

  const size: [number, number, number] = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  const counts = size.map((length) => Math.max(2, Math.round(length * density))) as [
    number,
    number,
    number,
  ];

  const records: SplatRecord[] = [];
  for (let ix = 0; ix < counts[0]; ix += 1) {
    for (let iy = 0; iy < counts[1]; iy += 1) {
      for (let iz = 0; iz < counts[2]; iz += 1) {
        const onSurface =
          ix === 0 ||
          iy === 0 ||
          iz === 0 ||
          ix === counts[0] - 1 ||
          iy === counts[1] - 1 ||
          iz === counts[2] - 1;
        if (!onSurface) continue;

        const position: [number, number, number] = [
          min[0] + (size[0] * ix) / Math.max(1, counts[0] - 1) + jitter(random, 0.004),
          min[1] + (size[1] * iy) / Math.max(1, counts[1] - 1) + jitter(random, 0.004),
          min[2] + (size[2] * iz) / Math.max(1, counts[2] - 1) + jitter(random, 0.004),
        ];
        records.push({
          position,
          scale: [splatScale, splatScale, splatScale],
          color: shade(color, 1 + jitter(random, grain)),
          alpha: 218,
        });
      }
    }
  }
  return records;
}

function cylinder(
  random: () => number,
  options: {
    from: [number, number, number];
    to: [number, number, number];
    radius: number;
    color: [number, number, number];
    rings?: number;
    perRing?: number;
    splatScale?: number;
  },
): SplatRecord[] {
  const { from, to, radius, color } = options;
  const rings = options.rings ?? 16;
  const perRing = options.perRing ?? 14;
  const splatScale = options.splatScale ?? 0.01;

  const axis: [number, number, number] = [to[0] - from[0], to[1] - from[1], to[2] - from[2]];
  const length = Math.hypot(...axis);
  const unit = axis.map((component) => component / (length || 1)) as [number, number, number];
  // Any vector not parallel to the axis gives us a usable perpendicular basis.
  const seed: [number, number, number] = Math.abs(unit[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const u: [number, number, number] = [
    unit[1] * seed[2] - unit[2] * seed[1],
    unit[2] * seed[0] - unit[0] * seed[2],
    unit[0] * seed[1] - unit[1] * seed[0],
  ];
  const uLength = Math.hypot(...u) || 1;
  const uHat = u.map((component) => component / uLength) as [number, number, number];
  const vHat: [number, number, number] = [
    unit[1] * uHat[2] - unit[2] * uHat[1],
    unit[2] * uHat[0] - unit[0] * uHat[2],
    unit[0] * uHat[1] - unit[1] * uHat[0],
  ];

  const records: SplatRecord[] = [];
  for (let ring = 0; ring < rings; ring += 1) {
    const t = rings === 1 ? 0 : ring / (rings - 1);
    for (let step = 0; step < perRing; step += 1) {
      const angle = (step / perRing) * Math.PI * 2;
      const cos = Math.cos(angle) * radius;
      const sin = Math.sin(angle) * radius;
      records.push({
        position: [
          from[0] + axis[0] * t + uHat[0] * cos + vHat[0] * sin + jitter(random, 0.003),
          from[1] + axis[1] * t + uHat[1] * cos + vHat[1] * sin + jitter(random, 0.003),
          from[2] + axis[2] * t + uHat[2] * cos + vHat[2] * sin + jitter(random, 0.003),
        ],
        scale: [splatScale, splatScale, splatScale],
        color: shade(color, 1 + jitter(random, 0.16)),
        alpha: 240,
      });
    }
  }
  return records;
}

function ellipsoidShell(
  random: () => number,
  options: {
    center: [number, number, number];
    radii: [number, number, number];
    color: [number, number, number];
    count?: number;
    splatScale?: number;
    shading?: (nx: number, ny: number, nz: number) => number;
  },
): SplatRecord[] {
  const { center, radii, color } = options;
  const count = options.count ?? 2600;
  const splatScale = options.splatScale ?? 0.012;
  const records: SplatRecord[] = [];

  for (let index = 0; index < count; index += 1) {
    // Fibonacci sphere: even coverage without clumping at the poles.
    const y = 1 - (index / Math.max(1, count - 1)) * 2;
    const ringRadius = Math.sqrt(Math.max(0, 1 - y * y));
    const theta = index * 2.399963229728653;
    const nx = Math.cos(theta) * ringRadius;
    const nz = Math.sin(theta) * ringRadius;

    const tint = options.shading ? options.shading(nx, y, nz) : 1;
    records.push({
      position: [
        center[0] + nx * radii[0] + jitter(random, 0.004),
        center[1] + y * radii[1] + jitter(random, 0.004),
        center[2] + nz * radii[2] + jitter(random, 0.004),
      ],
      scale: [splatScale, splatScale, splatScale],
      color: shade(color, tint * (1 + jitter(random, 0.1))),
      alpha: 242,
    });
  }
  return records;
}

/**
 * A wall corner carrying a steel angle bracket bolted to it.
 *
 * This is the "review a construction detail after the visit" case: the bracket
 * is 300 mm long and sits 120 mm off the wall, so measuring it is a real check
 * with a knowable right answer.
 */
export function buildConstructionDetail(): Uint8Array {
  const random = makeRandom(20260814);
  const records: SplatRecord[] = [];

  // Two wall faces meeting in a corner, plus a floor slab.
  records.push(
    ...slab(random, {
      min: [-0.9, -0.7, -0.05],
      max: [0.9, 0.75, 0.0],
      color: [206, 202, 194],
      density: 44,
      splatScale: 0.010,
    }),
  );
  records.push(
    ...slab(random, {
      min: [-0.95, -0.7, -0.05],
      max: [-0.9, 0.75, 0.9],
      color: [188, 184, 177],
      density: 44,
      splatScale: 0.010,
    }),
  );
  records.push(
    ...slab(random, {
      min: [-0.95, -0.75, -0.05],
      max: [0.9, -0.7, 0.9],
      color: [151, 149, 146],
      density: 42,
      splatScale: 0.011,
    }),
  );

  // Steel angle bracket: a vertical leg against the wall and a horizontal leg
  // cantilevering 120 mm out from it, 300 mm wide.
  const steel: [number, number, number] = [96, 104, 116];
  records.push(
    ...slab(random, {
      min: [-0.15, -0.02, 0.0],
      max: [0.15, 0.28, 0.012],
      color: steel,
      density: 64,
      grain: 0.1,
      splatScale: 0.006,
    }),
  );
  records.push(
    ...slab(random, {
      min: [-0.15, -0.02, 0.0],
      max: [0.15, -0.008, 0.12],
      color: shade(steel, 1.12),
      density: 64,
      grain: 0.1,
      splatScale: 0.006,
    }),
  );
  // Gusset triangle stiffening the corner of the two legs.
  for (let step = 0; step < 340; step += 1) {
    const along = random();
    const up = random() * (1 - along);
    records.push({
      position: [
        -0.152 + random() * 0.006,
        -0.008 + up * 0.26,
        0.002 + along * 0.1,
      ],
      scale: [0.006, 0.006, 0.006],
      color: shade(steel, 0.92 + jitter(random, 0.1)),
      alpha: 240,
    });
  }

  // Four bolts through the vertical leg, plus their washers.
  const bolt: [number, number, number] = [64, 68, 76];
  for (const [bx, by] of [
    [-0.095, 0.04],
    [0.095, 0.04],
    [-0.095, 0.22],
    [0.095, 0.22],
  ] as const) {
    records.push(
      ...cylinder(random, {
        from: [bx, by, 0.008],
        to: [bx, by, 0.032],
        radius: 0.011,
        color: bolt,
        rings: 8,
        perRing: 12,
        splatScale: 0.005,
      }),
    );
    records.push(
      ...cylinder(random, {
        from: [bx, by, 0.006],
        to: [bx, by, 0.01],
        radius: 0.019,
        color: shade(bolt, 1.25),
        rings: 3,
        perRing: 16,
        splatScale: 0.005,
      }),
    );
  }

  // A conduit running across the wall behind the bracket.
  records.push(
    ...cylinder(random, {
      from: [-0.88, 0.52, 0.045],
      to: [0.85, 0.52, 0.045],
      radius: 0.035,
      color: [176, 158, 96],
      rings: 54,
      perRing: 18,
      splatScale: 0.009,
    }),
  );

  // A 150 mm calibration target lying on the floor, exactly the ArUco marker
  // the worker looks for — so the demo's calibrate flow has a real reference.
  const marker: [number, number, number] = [0.42, -0.699, 0.34];
  const half = 0.075;
  for (let ix = 0; ix <= 30; ix += 1) {
    for (let iz = 0; iz <= 30; iz += 1) {
      const u = ix / 30;
      const v = iz / 30;
      const border = u < 0.16 || u > 0.84 || v < 0.16 || v > 0.84;
      const cell = Math.floor((u - 0.16) / 0.17) + Math.floor((v - 0.16) / 0.17);
      const dark = border || cell % 2 === 0;
      records.push({
        position: [
          marker[0] + (u * 2 - 1) * half,
          marker[1] + 0.001,
          marker[2] + (v * 2 - 1) * half,
        ],
        scale: [0.005, 0.002, 0.005],
        color: dark ? [26, 26, 28] : [238, 238, 236],
        alpha: 250,
      });
    }
  }

  return encodeSplats(records);
}

/**
 * A caught fish on wet planking — the "relive the session" case.
 *
 * Roughly 420 mm nose to tail, so a measurement in the demo answers the only
 * question anyone actually asks about a fish.
 */
export function buildFishScene(): Uint8Array {
  const random = makeRandom(760413);
  const records: SplatRecord[] = [];

  // Wet decking: planks with darker gaps between them.
  for (let plank = -4; plank <= 4; plank += 1) {
    const z = plank * 0.14;
    records.push(
      ...slab(random, {
        min: [-0.75, -0.055, z - 0.062],
        max: [0.75, -0.045, z + 0.062],
        color: plank % 2 === 0 ? [124, 96, 68] : [112, 86, 60],
        density: 46,
        grain: 0.22,
        splatScale: 0.011,
      }),
    );
  }

  // Body: an ellipsoid with a countershaded back, the way a real fish is lit.
  records.push(
    ...ellipsoidShell(random, {
      center: [0, 0.02, 0],
      radii: [0.21, 0.075, 0.045],
      color: [128, 152, 168],
      count: 4200,
      splatScale: 0.012,
      shading: (_nx, ny) => (ny > 0.15 ? 0.72 : ny < -0.2 ? 1.45 : 1.05),
    }),
  );
  // Flank stripe.
  records.push(
    ...ellipsoidShell(random, {
      center: [0, 0.012, 0],
      radii: [0.2, 0.016, 0.047],
      color: [206, 190, 120],
      count: 700,
      splatScale: 0.009,
    }),
  );
  // Head shading and the eye.
  records.push(
    ...ellipsoidShell(random, {
      center: [-0.175, 0.03, 0],
      radii: [0.05, 0.055, 0.04],
      color: [104, 126, 146],
      count: 700,
      splatScale: 0.01,
    }),
  );
  records.push(
    ...ellipsoidShell(random, {
      center: [-0.2, 0.05, 0.03],
      radii: [0.014, 0.014, 0.012],
      color: [22, 22, 26],
      count: 180,
      splatScale: 0.006,
    }),
  );
  records.push(
    ...ellipsoidShell(random, {
      center: [-0.2, 0.05, -0.03],
      radii: [0.014, 0.014, 0.012],
      color: [22, 22, 26],
      count: 180,
      splatScale: 0.006,
    }),
  );

  // Tail fin: two triangular lobes.
  for (let step = 0; step < 900; step += 1) {
    const along = random();
    const spread = along * 0.085;
    const lobe = random() < 0.5 ? 1 : -1;
    records.push({
      position: [
        0.205 + along * 0.09 + jitter(random, 0.004),
        0.02 + lobe * spread * (0.6 + random() * 0.4),
        jitter(random, 0.012),
      ],
      scale: [0.009, 0.009, 0.009],
      color: shade([118, 138, 156], 0.85 + jitter(random, 0.18)),
      alpha: 228,
    });
  }
  // Dorsal and pectoral fins.
  for (let step = 0; step < 520; step += 1) {
    const along = random();
    records.push({
      position: [
        -0.06 + along * 0.16 + jitter(random, 0.005),
        0.085 + random() * 0.05 * (1 - Math.abs(along - 0.4)),
        jitter(random, 0.008),
      ],
      scale: [0.008, 0.008, 0.008],
      color: shade([110, 130, 150], 0.9 + jitter(random, 0.16)),
      alpha: 222,
    });
  }
  for (const side of [1, -1]) {
    for (let step = 0; step < 260; step += 1) {
      const along = random();
      records.push({
        position: [
          -0.11 + along * 0.07,
          -0.005 - random() * 0.03,
          side * (0.04 + random() * 0.035),
        ],
        scale: [0.008, 0.008, 0.008],
        color: shade([124, 144, 162], 0.92 + jitter(random, 0.14)),
        alpha: 224,
      });
    }
  }

  // A folding rule beside it: 300 mm of known length to calibrate against.
  records.push(
    ...slab(random, {
      min: [-0.15, -0.043, 0.16],
      max: [0.15, -0.038, 0.19],
      color: [222, 196, 92],
      density: 70,
      grain: 0.08,
      splatScale: 0.005,
    }),
  );
  for (let tick = 0; tick <= 30; tick += 1) {
    if (tick % 5 !== 0) continue;
    records.push(
      ...slab(random, {
        min: [-0.15 + tick * 0.01, -0.0375, 0.16],
        max: [-0.148 + tick * 0.01, -0.037, 0.176],
        color: [40, 36, 30],
        density: 90,
        grain: 0.05,
        splatScale: 0.004,
      }),
    );
  }

  return encodeSplats(records);
}

export interface DemoScene {
  id: string;
  name: string;
  blurb: string;
  /** What the scene is worth measuring, and the answer if calibrated. */
  hint: string;
  build: () => Uint8Array;
}

export const DEMO_SCENES: DemoScene[] = [
  {
    id: 'construction',
    name: 'Construction detail',
    blurb: 'Wall corner with a bolted steel angle bracket, conduit and a 150 mm floor marker.',
    hint: 'The bracket leg cantilevers 120 mm from the wall and the plate is 300 mm wide. Calibrate on the 150 mm marker, then check them.',
    build: buildConstructionDetail,
  },
  {
    id: 'fish',
    name: 'The catch',
    blurb: 'A fish on wet decking with a folding rule laid alongside it.',
    hint: 'The rule is 300 mm. Calibrate on it, then measure the fish nose to tail — it should read about 420 mm.',
    build: buildFishScene,
  },
];
