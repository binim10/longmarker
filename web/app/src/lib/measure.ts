// LongMarker measurement engine. Pure functions, no DOM, so the same code runs
// in the browser and in the offline evaluation (node). Research use only.

export const ALGO_VERSION = 'lm-measure-0.1.0'

export type Vec3 = [number, number, number]
export interface Vol {
  dims: Vec3 // nx, ny, nz (file voxel order, x fastest)
  spacing: Vec3 // mm
}
export interface Box { lo: Vec3; hi: Vec3 } // inclusive lo, exclusive hi
export interface GrowParams { lo: number; hi: number; radiusMm: number; openPx: number; open3d?: boolean }
export interface GrowResult {
  mask: Uint8Array // ROI mask (box dims)
  box: Box
  seed: Vec3
  leaked: boolean
  touchesWall: boolean
  voxels: number
  params: GrowParams
  autoLo: number
  vesselLike?: boolean
}
export interface Metrics {
  slice: number // axial image index (file z) where area is largest
  longMm: number
  shortMm: number
  meanMm: number
  volumeMm3: number
  longLine: [number, number, number, number] // x1,y1,x2,y2 in voxel coords on slice
  shortLine: [number, number, number, number]
  solidMm: number
  solidFraction: number
  centroid: Vec3
}

export const DEFAULT_SOLID_HU = -300 // adjustable; Daniel confirms visually (decision 22)

const idx = (x: number, y: number, z: number, d: Vec3) => x + y * d[0] + z * d[0] * d[1]

export function boxAround(seed: Vec3, v: Vol, radiusMm: number): Box {
  const lo = [0, 1, 2].map(a => Math.max(0, Math.floor(seed[a] - radiusMm / v.spacing[a]))) as Vec3
  const hi = [0, 1, 2].map(a => Math.min(v.dims[a], Math.ceil(seed[a] + radiusMm / v.spacing[a]) + 1)) as Vec3
  return { lo, hi }
}

/** Local intensity statistics around the seed to suggest the lower threshold. */
export function suggestLo(ct: ArrayLike<number>, v: Vol, seed: Vec3): number {
  let s = 0, s2 = 0, n = 0
  for (let dz = -1; dz <= 1; dz++) for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
    const x = seed[0] + dx, y = seed[1] + dy, z = seed[2] + dz
    if (x < 0 || y < 0 || z < 0 || x >= v.dims[0] || y >= v.dims[1] || z >= v.dims[2]) continue
    const h = ct[idx(x, y, z, v.dims)]; s += h; s2 += h * h; n++
  }
  const m = s / n, sd = Math.sqrt(Math.max(0, s2 / n - m * m))
  if (m > -300) return -450 // solid / soft tissue: standard lung-window boundary
  return Math.max(-750, Math.round(m - 1.5 * sd)) // ground-glass: adapt to the haze
}

/** 3D seeded region growing inside the lung constraint, with a small in-plane
 * opening + geodesic reconstruction to detach thin vessels. */
export function grow(ct: ArrayLike<number>, lungs: ArrayLike<number> | null, v: Vol, seed0: Vec3,
  p: Partial<GrowParams> = {}): GrowResult | null {
  const autoLo = suggestLo(ct, v, seed0)
  const params: GrowParams = { lo: p.lo ?? autoLo, hi: p.hi ?? 400, radiusMm: p.radiusMm ?? 60, openPx: p.openPx ?? 2, open3d: p.open3d ?? false }
  const box = boxAround(seed0, v, params.radiusMm)
  const bd: Vec3 = [box.hi[0] - box.lo[0], box.hi[1] - box.lo[1], box.hi[2] - box.lo[2]]
  const inRange = (gx: number, gy: number, gz: number) => {
    const g = idx(gx, gy, gz, v.dims)
    const h = ct[g]
    return h >= params.lo && h <= params.hi && (!lungs || lungs[g] > 0)
  }
  // snap seed to nearest in-range voxel within 3 mm
  let seed: Vec3 | null = null
  const r = Math.ceil(3 / v.spacing[0]), rz = Math.ceil(3 / v.spacing[2])
  let best = Infinity
  for (let dz = -rz; dz <= rz; dz++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
    const x = seed0[0] + dx, y = seed0[1] + dy, z = seed0[2] + dz
    if (x < box.lo[0] || y < box.lo[1] || z < box.lo[2] || x >= box.hi[0] || y >= box.hi[1] || z >= box.hi[2]) continue
    if (!inRange(x, y, z)) continue
    const d = (dx * v.spacing[0]) ** 2 + (dy * v.spacing[1]) ** 2 + (dz * v.spacing[2]) ** 2
    if (d < best) { best = d; seed = [x, y, z] }
  }
  if (!seed) return null
  const n = bd[0] * bd[1] * bd[2]
  const raw: Uint8Array = new Uint8Array(n)
  const li = (x: number, y: number, z: number) => x + y * bd[0] + z * bd[0] * bd[1]
  const stack: number[] = [li(seed[0] - box.lo[0], seed[1] - box.lo[1], seed[2] - box.lo[2])]
  raw[stack[0]] = 1
  let leaked = false
  while (stack.length) {
    const i = stack.pop()!
    const x = i % bd[0], y = Math.floor(i / bd[0]) % bd[1], z = Math.floor(i / (bd[0] * bd[1]))
    const nb: Vec3[] = [[x - 1, y, z], [x + 1, y, z], [x, y - 1, z], [x, y + 1, z], [x, y, z - 1], [x, y, z + 1]]
    for (const [a, b, c] of nb) {
      if (a < 0 || b < 0 || c < 0 || a >= bd[0] || b >= bd[1] || c >= bd[2]) { leaked = true; continue }
      const j = li(a, b, c)
      if (raw[j]) continue
      if (!inRange(a + box.lo[0], b + box.lo[1], c + box.lo[2])) continue
      raw[j] = 1; stack.push(j)
    }
  }
  // in-plane opening (erode k, dilate k) then keep seed component, then reconstruct within raw
  const k = params.openPx
  let m: Uint8Array = raw
  if (k > 0) {
    const mo = params.open3d ? morph3d : morph2d
    const er = mo(raw, bd, k, true)
    const op = mo(er, bd, k, false)
    for (let i = 0; i < n; i++) op[i] &= raw[i]
    const sIdx = li(seed[0] - box.lo[0], seed[1] - box.lo[1], seed[2] - box.lo[2])
    let comp = keepComponent(op, bd, sIdx)
    let erased = false
    if (!comp) { comp = keepComponent(raw, bd, sIdx)!; erased = true } // opening erased the nodule: fall back, flag
    // geodesic reconstruction by k px in-plane, constrained to raw
    let rec = comp
    for (let it = 0; it < k; it++) {
      const dl = (params.open3d ? morph3d : morph2d)(rec, bd, 1, false)
      for (let i = 0; i < n; i++) dl[i] &= raw[i]
      rec = dl
    }
    m = rec
    // leak only counts if the final mask touches the box
    leaked = touchesBox(m, bd) || (erased && k > 2)
  }
  let voxels = 0, wall = 0, surface = 0
  for (let z = 0; z < bd[2]; z++) for (let y = 0; y < bd[1]; y++) for (let x = 0; x < bd[0]; x++) {
    const i = li(x, y, z)
    if (!m[i]) continue
    voxels++
    if (lungs) {
      const nb: Vec3[] = [[x - 1, y, z], [x + 1, y, z], [x, y - 1, z], [x, y + 1, z]]
      for (const [a, b] of nb) {
        if (a < 0 || b < 0 || a >= bd[0] || b >= bd[1]) continue
        if (!m[li(a, b, z)]) {
          surface++
          if (!lungs[idx(a + box.lo[0], b + box.lo[1], z + box.lo[2], v.dims)]) wall++
        }
      }
    }
  }
  return { mask: m, box, seed, leaked, touchesWall: surface > 0 && wall / surface > 0.15, voxels, params, autoLo }
}

function touchesBox(m: Uint8Array, bd: Vec3) {
  for (let z = 0; z < bd[2]; z++) for (let y = 0; y < bd[1]; y++) for (let x = 0; x < bd[0]; x++) {
    if (x > 0 && y > 0 && z > 0 && x < bd[0] - 1 && y < bd[1] - 1 && z < bd[2] - 1) continue
    if (m[x + y * bd[0] + z * bd[0] * bd[1]]) return true
  }
  return false
}

function morph2d(src: Uint8Array, bd: Vec3, r: number, erode: boolean): Uint8Array {
  let cur = src
  for (let it = 0; it < r; it++) {
    const out = new Uint8Array(cur.length)
    for (let z = 0; z < bd[2]; z++) for (let y = 0; y < bd[1]; y++) for (let x = 0; x < bd[0]; x++) {
      const i = x + y * bd[0] + z * bd[0] * bd[1]
      const c = cur[i]
      const l = x > 0 ? cur[i - 1] : 0, rr = x < bd[0] - 1 ? cur[i + 1] : 0
      const u = y > 0 ? cur[i - bd[0]] : 0, d = y < bd[1] - 1 ? cur[i + bd[0]] : 0
      out[i] = erode ? (c & l & rr & u & d) : (c | l | rr | u | d)
    }
    cur = out
  }
  return cur
}

function morph3d(src: Uint8Array, bd: Vec3, r: number, erode: boolean): Uint8Array {
  let cur = src
  const sz = bd[0] * bd[1]
  for (let it = 0; it < r; it++) {
    const out = new Uint8Array(cur.length)
    for (let z = 0; z < bd[2]; z++) for (let y = 0; y < bd[1]; y++) for (let x = 0; x < bd[0]; x++) {
      const i = x + y * bd[0] + z * sz
      const c = cur[i]
      const l = x > 0 ? cur[i - 1] : 0, rr = x < bd[0] - 1 ? cur[i + 1] : 0
      const u = y > 0 ? cur[i - bd[0]] : 0, d = y < bd[1] - 1 ? cur[i + bd[0]] : 0
      // z neighbours only every other iteration: slices are ~2x thicker than pixels
      const zz = it % 2 === 0
      const a = zz && z > 0 ? cur[i - sz] : (erode ? 1 : 0), b = zz && z < bd[2] - 1 ? cur[i + sz] : (erode ? 1 : 0)
      out[i] = erode ? (c & l & rr & u & d & a & b) : (c | l | rr | u | d | a | b)
    }
    cur = out
  }
  return cur
}

function keepComponent(m: Uint8Array, bd: Vec3, seedIdx: number): Uint8Array | null {
  let start = seedIdx
  if (!m[start]) {
    // nearest set voxel to seed (in-plane first)
    const sx = seedIdx % bd[0], sy = Math.floor(seedIdx / bd[0]) % bd[1], sz = Math.floor(seedIdx / (bd[0] * bd[1]))
    let best = Infinity; start = -1
    for (let z = Math.max(0, sz - 2); z <= Math.min(bd[2] - 1, sz + 2); z++)
      for (let y = Math.max(0, sy - 6); y <= Math.min(bd[1] - 1, sy + 6); y++)
        for (let x = Math.max(0, sx - 6); x <= Math.min(bd[0] - 1, sx + 6); x++) {
          const i = x + y * bd[0] + z * bd[0] * bd[1]
          if (!m[i]) continue
          const d = (x - sx) ** 2 + (y - sy) ** 2 + (z - sz) ** 2
          if (d < best) { best = d; start = i }
        }
    if (start < 0) return null
  }
  const out = new Uint8Array(m.length)
  const st = [start]; out[start] = 1
  while (st.length) {
    const i = st.pop()!
    const x = i % bd[0], y = Math.floor(i / bd[0]) % bd[1], z = Math.floor(i / (bd[0] * bd[1]))
    const nb = [x > 0 ? i - 1 : -1, x < bd[0] - 1 ? i + 1 : -1, y > 0 ? i - bd[0] : -1, y < bd[1] - 1 ? i + bd[0] : -1,
      z > 0 ? i - bd[0] * bd[1] : -1, z < bd[2] - 1 ? i + bd[0] * bd[1] : -1]
    for (const j of nb) if (j >= 0 && m[j] && !out[j]) { out[j] = 1; st.push(j) }
  }
  return out
}

/** Extract the connected component of a full-volume label mask nearest to the seed, as an ROI. */
export function componentNear(full: ArrayLike<number>, v: Vol, seed: Vec3, radiusMm = 60): { mask: Uint8Array; box: Box } | null {
  const box = boxAround(seed, v, radiusMm)
  const bd: Vec3 = [box.hi[0] - box.lo[0], box.hi[1] - box.lo[1], box.hi[2] - box.lo[2]]
  const roi = new Uint8Array(bd[0] * bd[1] * bd[2])
  let any = false
  for (let z = 0; z < bd[2]; z++) for (let y = 0; y < bd[1]; y++) for (let x = 0; x < bd[0]; x++) {
    if (full[idx(x + box.lo[0], y + box.lo[1], z + box.lo[2], v.dims)] > 0) { roi[x + y * bd[0] + z * bd[0] * bd[1]] = 1; any = true }
  }
  if (!any) return null
  // nearest voxel to seed
  let best = Infinity, bi = -1
  for (let z = 0; z < bd[2]; z++) for (let y = 0; y < bd[1]; y++) for (let x = 0; x < bd[0]; x++) {
    const i = x + y * bd[0] + z * bd[0] * bd[1]
    if (!roi[i]) continue
    const d = ((x + box.lo[0] - seed[0]) * v.spacing[0]) ** 2 + ((y + box.lo[1] - seed[1]) * v.spacing[1]) ** 2 + ((z + box.lo[2] - seed[2]) * v.spacing[2]) ** 2
    if (d < best) { best = d; bi = i }
  }
  if (Math.sqrt(best) > 15) return null // nothing of the expert within 15 mm of the click
  const comp = keepComponent(roi, bd, bi)
  return comp ? { mask: comp, box } : null
}

/** Long/short axis (edge-to-edge, on the axial slice with the largest area), volume, solid part. */
export function metrics(mask: Uint8Array, box: Box, v: Vol, ct?: ArrayLike<number>, solidHu = DEFAULT_SOLID_HU): Metrics | null {
  const bd: Vec3 = [box.hi[0] - box.lo[0], box.hi[1] - box.lo[1], box.hi[2] - box.lo[2]]
  const areas = new Array(bd[2]).fill(0)
  let total = 0, solid = 0, cx = 0, cy = 0, cz = 0
  for (let z = 0; z < bd[2]; z++) for (let y = 0; y < bd[1]; y++) for (let x = 0; x < bd[0]; x++) {
    const i = x + y * bd[0] + z * bd[0] * bd[1]
    if (!mask[i]) continue
    areas[z]++; total++; cx += x; cy += y; cz += z
    if (ct && ct[idx(x + box.lo[0], y + box.lo[1], z + box.lo[2], v.dims)] >= solidHu) solid++
  }
  if (!total) return null
  let kz = 0
  for (let z = 1; z < bd[2]; z++) if (areas[z] > areas[kz]) kz = z
  const ax = axesOnSlice((x, y) => mask[x + y * bd[0] + kz * bd[0] * bd[1]] > 0, bd[0], bd[1], v.spacing)
  // solid component: longest diameter of the dense part on its own largest slice
  let solidMm = 0
  if (ct && solid > 0) {
    const sa = new Array(bd[2]).fill(0)
    const isSolid = (x: number, y: number, z: number) => mask[x + y * bd[0] + z * bd[0] * bd[1]] > 0 &&
      ct[idx(x + box.lo[0], y + box.lo[1], z + box.lo[2], v.dims)] >= solidHu
    for (let z = 0; z < bd[2]; z++) for (let y = 0; y < bd[1]; y++) for (let x = 0; x < bd[0]; x++) if (isSolid(x, y, z)) sa[z]++
    let sz = 0
    for (let z = 1; z < bd[2]; z++) if (sa[z] > sa[sz]) sz = z
    solidMm = axesOnSlice((x, y) => isSolid(x, y, sz), bd[0], bd[1], v.spacing).longMm
  }
  const sh = (l: number[]) => [l[0] + box.lo[0], l[1] + box.lo[1], l[2] + box.lo[0], l[3] + box.lo[1]] as [number, number, number, number]
  return {
    slice: kz + box.lo[2],
    longMm: ax.longMm, shortMm: ax.shortMm, meanMm: (ax.longMm + ax.shortMm) / 2,
    volumeMm3: total * v.spacing[0] * v.spacing[1] * v.spacing[2],
    longLine: sh(ax.longLine), shortLine: sh(ax.shortLine),
    solidMm, solidFraction: solid / total,
    centroid: [cx / total + box.lo[0], cy / total + box.lo[1], cz / total + box.lo[2]],
  }
}

function axesOnSlice(inside: (x: number, y: number) => boolean, w: number, h: number, sp: Vec3) {
  // pixel-corner points of boundary pixels -> convex hull (mm) -> calipers
  const pts: [number, number][] = []
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (!inside(x, y)) continue
    const edge = x === 0 || y === 0 || x === w - 1 || y === h - 1 || !inside(x - 1, y) || !inside(x + 1, y) || !inside(x, y - 1) || !inside(x, y + 1)
    if (!edge) continue
    for (const [dx, dy] of [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]]) pts.push([(x + dx) * sp[0], (y + dy) * sp[1]])
  }
  const hull = convexHull(pts)
  let longMm = 0, a = hull[0], b = hull[0]
  for (let i = 0; i < hull.length; i++) for (let j = i + 1; j < hull.length; j++) {
    const d = Math.hypot(hull[i][0] - hull[j][0], hull[i][1] - hull[j][1])
    if (d > longMm) { longMm = d; a = hull[i]; b = hull[j] }
  }
  // short axis: longest chord of the shape perpendicular to the long axis
  const ux = (b[0] - a[0]) / (longMm || 1), uy = (b[1] - a[1]) / (longMm || 1)
  const px = -uy, py = ux
  let shortMm = 0, sl: [number, number, number, number] = [a[0], a[1], a[0], a[1]]
  const steps = Math.max(2, Math.ceil(longMm / (sp[0] / 2)))
  for (let s = 0; s <= steps; s++) {
    const t = (s / steps) * longMm
    const ox = a[0] + ux * t, oy = a[1] + uy * t
    // march along perpendicular in both directions while inside
    let lo = 0, hi = 0
    const inMm = (mx: number, my: number) => {
      const x = Math.round(mx / sp[0]), y = Math.round(my / sp[1])
      return x >= 0 && y >= 0 && x < w && y < h && inside(x, y)
    }
    const st = sp[0] / 2
    if (!inMm(ox, oy)) continue
    while (inMm(ox + px * (hi + st), oy + py * (hi + st))) hi += st
    while (inMm(ox - px * (lo + st), oy - py * (lo + st))) lo += st
    const len = lo + hi + sp[0] // edge-to-edge
    if (len > shortMm) { shortMm = len; sl = [ox - px * lo, oy - py * lo, ox + px * hi, oy + py * hi] }
  }
  shortMm = Math.min(shortMm, longMm)
  const toVox = (l: number[]) => [l[0] / sp[0], l[1] / sp[1], l[2] / sp[0], l[3] / sp[1]]
  return { longMm, shortMm, longLine: toVox([a[0], a[1], b[0], b[1]]), shortLine: toVox(sl) }
}

function convexHull(p: [number, number][]): [number, number][] {
  if (p.length < 3) return p.slice()
  const s = p.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const cr = (o: number[], a: number[], b: number[]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
  const lower: [number, number][] = [], upper: [number, number][] = []
  for (const q of s) { while (lower.length >= 2 && cr(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop(); lower.push(q) }
  for (let i = s.length - 1; i >= 0; i--) { const q = s[i]; while (upper.length >= 2 && cr(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop(); upper.push(q) }
  return lower.slice(0, -1).concat(upper.slice(0, -1))
}

export function suggestType(solidFraction: number): 'solid' | 'part-solid' | 'ground-glass' {
  if (solidFraction >= 0.8) return 'solid'
  if (solidFraction <= 0.05) return 'ground-glass'
  return 'part-solid'
}

export const LOBES = ['', 'LUL', 'LLL', 'RUL', 'RML', 'RLL']

export function lobeAt(lobes: ArrayLike<number> | null, v: Vol, mask: Uint8Array, box: Box): string {
  if (!lobes) return ''
  const bd: Vec3 = [box.hi[0] - box.lo[0], box.hi[1] - box.lo[1], box.hi[2] - box.lo[2]]
  const cnt = new Array(6).fill(0)
  // lobe labels exclude the tumour itself, so look at a 3-voxel shell around it
  for (let z = 0; z < bd[2]; z++) for (let y = 0; y < bd[1]; y++) for (let x = 0; x < bd[0]; x++) {
    if (!mask[x + y * bd[0] + z * bd[0] * bd[1]]) continue
    for (let d = -3; d <= 3; d += 3) for (const [a, b] of [[x + d, y], [x, y + d]]) {
      const gx = a + box.lo[0], gy = b + box.lo[1], gz = z + box.lo[2]
      if (gx < 0 || gy < 0 || gx >= v.dims[0] || gy >= v.dims[1]) continue
      const l = lobes[idx(gx, gy, gz, v.dims)]
      if (l > 0 && l < 6) cnt[l]++
    }
  }
  let b = 0
  for (let i = 1; i < 6; i++) if (cnt[i] > cnt[b]) b = i
  return LOBES[b]
}

// ---- geometry: file voxel <-> LPS physical (SimpleITK convention, from meta.json) ----
export interface Geo { origin: Vec3; spacing: Vec3; direction: number[] }
export function voxToLps(g: Geo, p: Vec3): Vec3 {
  const d = g.direction, s = g.spacing, o = g.origin
  return [0, 1, 2].map(r => o[r] + d[r * 3] * p[0] * s[0] + d[r * 3 + 1] * p[1] * s[1] + d[r * 3 + 2] * p[2] * s[2]) as Vec3
}
export function lpsToVox(g: Geo, q: Vec3): Vec3 {
  const d = g.direction, s = g.spacing, o = g.origin
  const r = [q[0] - o[0], q[1] - o[1], q[2] - o[2]]
  // direction is orthonormal -> inverse is transpose
  return [0, 1, 2].map(c => (d[c] * r[0] + d[3 + c] * r[1] + d[6 + c] * r[2]) / s[c]) as Vec3
}
export function applyM(M: number[][], p: Vec3): Vec3 {
  return [0, 1, 2].map(r => M[r][0] * p[0] + M[r][1] * p[1] + M[r][2] * p[2] + M[r][3]) as Vec3
}

/** Follow-up: map a baseline nodule into the follow-up scan, then snap to the most
 * plausible blob within 15 mm (distance + volume similarity). Decision 24–27. */
export function findInFollowUp(ct: ArrayLike<number>, lungs: ArrayLike<number> | null, v: Vol, predicted: Vec3,
  baselineVolumeMm3: number, lo: number) {
  const searchMm = 15
  const cands: { res: GrowResult; dist: number; ratio: number; score: number }[] = []
  const pr = predicted.map(Math.round) as Vec3
  const pts: { p: Vec3; d: number }[] = []
  const rx = Math.ceil(searchMm / v.spacing[0]), rz = Math.ceil(searchMm / v.spacing[2])
  for (let dz = -rz; dz <= rz; dz++) for (let dy = -rx; dy <= rx; dy += 2) for (let dx = -rx; dx <= rx; dx += 2) {
    const p: Vec3 = [pr[0] + dx, pr[1] + dy, pr[2] + dz]
    if (p.some((c, a) => c < 0 || c >= v.dims[a])) continue
    const d = Math.hypot(dx * v.spacing[0], dy * v.spacing[1], dz * v.spacing[2])
    if (d > searchMm) continue
    if (ct[idx(p[0], p[1], p[2], v.dims)] < lo) continue
    pts.push({ p, d })
  }
  pts.sort((a, b) => a.d - b.d)
  const covered: Box[] = []
  for (const { p, d } of pts) {
    if (cands.length >= 4) break
    if (covered.some(b => p[0] >= b.lo[0] && p[0] < b.hi[0] && p[1] >= b.lo[1] && p[1] < b.hi[1] && p[2] >= b.lo[2] && p[2] < b.hi[2] &&
      inMask(cands, p))) continue
    const res = growAuto(ct, lungs, v, p, { lo })
    if (!res || res.voxels < 5) continue
    const vol = res.voxels * v.spacing[0] * v.spacing[1] * v.spacing[2]
    const ratio = vol / Math.max(1, baselineVolumeMm3)
    const score = d / searchMm + Math.abs(Math.log(ratio)) + (res.leaked ? 1 : 0)
    cands.push({ res, dist: d, ratio, score })
    covered.push(res.box)
  }
  cands.sort((a, b) => a.score - b.score)
  const best = cands[0]
  if (!best) return null
  const second = cands[1]
  const uncertain = best.ratio < 0.5 || best.ratio > 2 || best.dist > 10 || best.res.leaked || (!!second && second.score - best.score < 0.3)
  return { best: best.res, dist: best.dist, ratio: best.ratio, uncertain, candidates: cands.length }
}

function inMask(cands: { res: GrowResult }[], p: Vec3) {
  for (const c of cands) {
    const b = c.res.box, bd = [b.hi[0] - b.lo[0], b.hi[1] - b.lo[1]]
    const x = p[0] - b.lo[0], y = p[1] - b.lo[1], z = p[2] - b.lo[2]
    if (x < 0 || y < 0 || z < 0 || x >= bd[0] || y >= bd[1] || z >= b.hi[2] - b.lo[2]) continue
    if (c.res.mask[x + y * bd[0] + z * bd[0] * bd[1]]) return true
  }
  return false
}

/** grow(); if the outline leaks or is vessel-shaped (elongated), retry with a
 * stronger 3D opening to cut the bridge to vessels / mediastinum, and keep the
 * first compact result. Decision 20 (classical method + controls). */
export function growAuto(ct: ArrayLike<number>, lungs: ArrayLike<number> | null, v: Vol, seed: Vec3,
  p: Partial<GrowParams> = {}): GrowResult | null {
  const first = grow(ct, lungs, v, seed, p)
  if (!first || p.openPx !== undefined) return first
  const elong = (r: GrowResult) => { const m = metrics(r.mask, r.box, v); return m ? m.longMm / Math.max(0.5, m.shortMm) : 99 }
  const ok = (r: GrowResult | null): boolean => !!r && !r.leaked && r.voxels > 10 && elong(r) < 2.5
  if (ok(first)) return first
  const lo = first.params.lo
  const tries: Partial<GrowParams>[] = [
    { openPx: 3, open3d: true }, { openPx: 4, open3d: true },
    { lo: Math.min(-200, lo + 100) }, { lo: Math.min(-150, lo + 150) }, { lo: Math.min(-150, lo + 150), openPx: 3, open3d: true },
  ]
  for (const t of tries) {
    const r = grow(ct, lungs, v, seed, { ...p, ...t })
    if (r && ok(r)) return r
  }
  first.vesselLike = elong(first) >= 2.5
  return first
}
