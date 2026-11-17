// Offline evaluation of the exact browser measurement code against expert outlines.
// Seeds = expert-component voxel with the median HU near its centroid (simulates Daniel's click).
// Usage: npx tsx eval/eval.ts > ../../eval/results.json
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { parseNifti } from '../src/lib/nifti'
import { growAuto as grow, metrics, componentNear, findInFollowUp, voxToLps, lpsToVox, applyM, type Vec3, type Vol } from '../src/lib/measure'

const ROOT = new URL('../public/cases/', import.meta.url).pathname
const load = (p: string) => { const b = gunzipSync(readFileSync(p)); return parseNifti(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)) }

function seedFromRef(ref: ArrayLike<number>, ct: ArrayLike<number>, v: Vol): Vec3 | null {
  let sx = 0, sy = 0, sz = 0, n = 0
  const [nx, ny, nz] = v.dims
  for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    if (ref[x + y * nx + z * nx * ny]) { sx += x; sy += y; sz += z; n++ }
  }
  if (!n) return null
  const c: Vec3 = [Math.round(sx / n), Math.round(sy / n), Math.round(sz / n)]
  // nearest expert voxel to the centroid with solid-ish HU
  let best = Infinity, b: Vec3 = c
  for (let z = c[2] - 4; z <= c[2] + 4; z++) for (let y = c[1] - 15; y <= c[1] + 15; y++) for (let x = c[0] - 15; x <= c[0] + 15; x++) {
    const i = x + y * nx + z * nx * ny
    if (!ref[i]) continue
    const d = (x - c[0]) ** 2 + (y - c[1]) ** 2 + 4 * (z - c[2]) ** 2 - (ct[i] > -300 ? 50 : 0)
    if (d < best) { best = d; b = [x, y, z] }
  }
  return b
}

const out: any[] = []
const metas: Record<string, any> = {}
for (const id of readdirSync(ROOT).sort()) {
  const dir = ROOT + id + '/'
  if (!existsSync(dir + 'meta.json')) continue
  const meta = JSON.parse(readFileSync(dir + 'meta.json', 'utf8'))
  const ct = load(dir + 'ct.nii.gz'), lungs = load(dir + 'lungs.nii.gz')
  const v: Vol = { dims: ct.dims, spacing: ct.spacing }
  const ref = load(dir + meta.files.refs.expert)
  const seeds: Vec3[] = meta.nodules?.length
    ? meta.nodules.map((n: any) => nearestRefVoxel(ref.data, ct.data, v, n.centroid_vox.map(Math.round) as Vec3))
    : [seedFromRef(ref.data, ct.data, v)].filter(Boolean) as Vec3[]
  const readers: Record<string, Uint8Array> = {}
  for (const [name, fn] of Object.entries<string>(meta.files.refs)) if (name !== 'expert') readers[name] = load(dir + fn).data as Uint8Array
  seeds.forEach((seed, ni) => {
    const t0 = performance.now()
    const g = grow(ct.data, lungs.data, v, seed)
    const ms = performance.now() - t0
    const exp = componentNear(ref.data, v, seed, 80)
    const me = exp && metrics(exp.mask, exp.box, v, ct.data)
    const mt = g && metrics(g.mask, g.box, v, ct.data)
    const dice = g && exp ? diceOf(g, exp, v) : null
    const rm = Object.values(readers).map(r => { const c = componentNear(r, v, seed, 80); const m = c && metrics(c.mask, c.box, v, ct.data); return m && { long: +m.longMm.toFixed(2), short: +m.shortMm.toFixed(2), vol: Math.round(m.volumeMm3) } }).filter(Boolean)
    const nod = meta.nodules?.[ni]
    out.push({
      case_id: id, nodule: ni + 1, source: meta.source, timepoint: meta.timepoint, patient_id: meta.patient_id,
      teaching_case: meta.teaching_case ?? null, texture: nod?.texture ?? null, readers_n: nod?.readers ?? 1, seed, ms: Math.round(ms),
      tool: mt && { long: +mt.longMm.toFixed(2), short: +mt.shortMm.toFixed(2), vol: Math.round(mt.volumeMm3), solidFrac: +mt.solidFraction.toFixed(2) },
      expert: me && { long: +me.longMm.toFixed(2), short: +me.shortMm.toFixed(2), vol: Math.round(me.volumeMm3) },
      readers: rm, leaked: g?.leaked ?? null, uncertain: !!g && (g.leaked || g.touchesWall || !!g.vesselLike), lo: g?.params.lo, open: g?.params.openPx, dice: dice && +dice.toFixed(3),
    })
    if (ni === 0) metas[id] = { meta, seed, vol: mt?.volumeMm3, lo: g?.params.lo }
    const o = out[out.length - 1]
    console.error(id, ni + 1, JSON.stringify(o.tool), JSON.stringify(o.expert), 'dice', o.dice, `${o.ms}ms`, o.uncertain ? 'UNCERTAIN' : '')
  })
}
function diceOf(g: any, exp: any, v: Vol) {
  let inter = 0, a = 0, b = 0
  const bd = [g.box.hi[0] - g.box.lo[0], g.box.hi[1] - g.box.lo[1], g.box.hi[2] - g.box.lo[2]]
  const ed = [exp.box.hi[0] - exp.box.lo[0], exp.box.hi[1] - exp.box.lo[1], exp.box.hi[2] - exp.box.lo[2]]
  const eset = new Set<number>()
  for (let z = 0; z < ed[2]; z++) for (let y = 0; y < ed[1]; y++) for (let x = 0; x < ed[0]; x++)
    if (exp.mask[x + y * ed[0] + z * ed[0] * ed[1]]) { eset.add((x + exp.box.lo[0]) + (y + exp.box.lo[1]) * v.dims[0] + (z + exp.box.lo[2]) * v.dims[0] * v.dims[1]); b++ }
  for (let z = 0; z < bd[2]; z++) for (let y = 0; y < bd[1]; y++) for (let x = 0; x < bd[0]; x++)
    if (g.mask[x + y * bd[0] + z * bd[0] * bd[1]]) { a++; if (eset.has((x + g.box.lo[0]) + (y + g.box.lo[1]) * v.dims[0] + (z + g.box.lo[2]) * v.dims[0] * v.dims[1])) inter++ }
  return (2 * inter) / (a + b)
}
function nearestRefVoxel(ref: ArrayLike<number>, ct: ArrayLike<number>, v: Vol, c: Vec3): Vec3 {
  const [nx, ny] = v.dims
  let best = Infinity, b: Vec3 = c
  for (let z = c[2] - 3; z <= c[2] + 3; z++) for (let y = c[1] - 10; y <= c[1] + 10; y++) for (let x = c[0] - 10; x <= c[0] + 10; x++) {
    const i = x + y * nx + z * nx * ny
    if (!ref[i]) continue
    const d = (x - c[0]) ** 2 + (y - c[1]) ** 2 + 4 * (z - c[2]) ** 2
    if (d < best) { best = d; b = [x, y, z] }
  }
  return b
}
// follow-up matching: map baseline seed into follow-up, snap, compare to follow-up expert component
const match: any[] = []
for (const [id, m] of Object.entries<any>(metas)) {
  const pair = m.meta.pair
  if (!pair || pair.role !== 'baseline' || !metas[pair.case_id]) continue
  const fu = metas[pair.case_id]
  const dir = ROOT + pair.case_id + '/'
  const ct = load(dir + 'ct.nii.gz'), lungs = load(dir + 'lungs.nii.gz'), ref = load(dir + 'ref_expert.nii.gz')
  const v: Vol = { dims: ct.dims, spacing: ct.spacing }
  const pred = lpsToVox(fu.meta, applyM(m.meta.pair.M_to_pair, voxToLps(m.meta, m.seed)))
  const r = findInFollowUp(ct.data, lungs.data, v, pred, m.vol ?? 1000, m.lo ?? -450)
  let hit = false
  if (r) {
    const b = r.best.box, bd = [b.hi[0] - b.lo[0], b.hi[1] - b.lo[1]]
    let inter = 0
    for (let z = 0; z < b.hi[2] - b.lo[2]; z++) for (let y = 0; y < bd[1]; y++) for (let x = 0; x < bd[0]; x++)
      if (r.best.mask[x + y * bd[0] + z * bd[0] * bd[1]] && ref.data[(x + b.lo[0]) + (y + b.lo[1]) * v.dims[0] + (z + b.lo[2]) * v.dims[0] * v.dims[1]]) inter++
    hit = inter > 0
  }
  const predErr = Math.hypot(...[0, 1, 2].map(a => (pred[a] - fu.seed[a]) * v.spacing[a]))
  match.push({ baseline: id, followup: pair.case_id, predicted_error_mm: +predErr.toFixed(1), found: !!r, correct: hit, uncertain: r?.uncertain ?? true, dist: r && +r.dist.toFixed(1), ratio: r && +r.ratio.toFixed(2) })
  console.error('match', id, JSON.stringify(match[match.length - 1]))
}
console.log(JSON.stringify({ measurements: out, matching: match }, null, 1))
