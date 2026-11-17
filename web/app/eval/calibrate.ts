// Calibrate the default edge threshold for solid nodules on RIDER *test* scans only.
// Retest scans and LIDC are held out for the report (no peeking).
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { parseNifti } from '../src/lib/nifti'
import { growAuto, metrics, componentNear, type Vec3, type Vol } from '../src/lib/measure'
const ROOT = new URL('../public/cases/', import.meta.url).pathname
const load = (p: string) => { const b = gunzipSync(readFileSync(p)); return parseNifti(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)) }
const res = JSON.parse(readFileSync(new URL('../../../eval/results.json', import.meta.url), 'utf8'))
const rows: Record<string, number[][]> = {}
for (const id of readdirSync(ROOT).filter(d => d.endsWith('_test')).sort()) {
  const dir = ROOT + id + '/'
  if (!existsSync(dir + 'meta.json')) continue
  const seed: Vec3 = res.measurements.find((m: any) => m.case_id === id)?.seed
  if (!seed) continue
  const meta = JSON.parse(readFileSync(dir + 'meta.json', 'utf8'))
  const ct = load(dir + 'ct.nii.gz'), lungs = load(dir + 'lungs.nii.gz'), ref = load(dir + meta.files.refs.expert)
  const v: Vol = { dims: ct.dims, spacing: ct.spacing }
  const exp = componentNear(ref.data, v, seed, 80)
  const me = exp && metrics(exp.mask, exp.box, v)
  if (!me) { console.error('skip', id, '(no expert component near seed)'); continue }
  for (const lo of [-550, -500, -450, -400, -350, -300, -250]) {
    // production path: growAuto with this starting threshold (the app always uses growAuto)
    const g = growAuto(ct.data, lungs.data, v, seed, { lo })
    const m = g && metrics(g.mask, g.box, v)
    const err = m ? Math.abs(m.longMm - me.longMm) / me.longMm : 1
    ;(rows[lo] ||= []).push([err, g?.leaked ? 1 : 0])
  }
}
for (const [lo, r] of Object.entries(rows)) {
  const e = r.map(x => x[0]).sort((a, b) => a - b), h = Math.floor(e.length / 2)
  const med = e.length % 2 ? e[h] : (e[h - 1] + e[h]) / 2
  console.log(lo, `n=${r.length}`, 'median rel. long-axis error', (med * 100).toFixed(1) + '%', 'leaks', r.filter(x => x[1]).length, '/', r.length)
}
