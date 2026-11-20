import assert from 'node:assert/strict'
import { test } from 'node:test'
import { metrics, voxToLps, lpsToVox } from '../src/lib/measure.ts'
import { toCsv } from '../src/lib/session.ts'
import { forget, getBuffer } from '../src/lib/fetchCache.ts'

test('mask volume uses all three physical spacings; empty mask has no measurement', () => {
  const vol = { dims: [3, 3, 2], spacing: [0.5, 1, 2.5] }
  const box = { lo: [0, 0, 0], hi: vol.dims }
  const mask = new Uint8Array(18)
  assert.equal(metrics(mask, box, vol), null)
  mask.fill(1)
  assert.equal(metrics(mask, box, vol).volumeMm3, 22.5)
})

test('follow-up coordinates respect scan orientation, origin and spacing', () => {
  const geometry = { origin: [10, 20, 30], spacing: [0.5, 2, 3], direction: [0,-1,0, 1,0,0, 0,0,1] }
  assert.deepEqual(voxToLps(geometry, [4,3,2]), [4,22,36])
  assert.deepEqual(lpsToVox(geometry, [4,22,36]), [4,3,2])
})

test('CSV preserves the sheet contract, review flag, escaped notes and units', () => {
  const row = { caseId: 'scan', patient_id: 'P1', nodule_id: 'N1', long_axis_mm: 18.24,
    short_axis_mm: 13.68, mean_diameter_mm: 15.96, volume_mm3: 1678.7,
    solid_component_mm: '', uncertain: true, provenance: 'edited', notes: 'check, "edge"' }
  const csv = toCsv({ rows: [row], seconds: { scan: 90 }, initials: 'QA' })
  const [notice, columns, data] = csv.trimEnd().split('\n')
  assert.match(notice, /Research use only/)
  assert.equal(columns, 'patient_id,scan_date,timepoint,series,slice_thickness,nodule_id,lobe,image_number,type,long_axis_mm,short_axis_mm,mean_diameter_mm,solid_component_mm,volume_mm3,match_status,minutes,initials,notes,provenance,algo_version,params')
  assert.equal(data, 'P1,,,,,N1,,,,18.2,13.7,16,,1679,,1.5,QA,"Uncertain; check, ""edge""",edited,,')
})

test('late failure cannot evict an in-flight retry', async (t) => {
  const requests = []
  t.mock.method(globalThis, 'fetch', () => new Promise((resolve, reject) => requests.push({resolve, reject})))
  const url = '/cases/test/ct.nii.gz'
  const first = getBuffer(url)
  forget('/cases/test/')
  const retry = getBuffer(url)
  requests[0].reject(new Error('download failed'))
  await assert.rejects(first)
  assert.equal(getBuffer(url), retry)
  assert.equal(requests.length, 2)
  requests[1].resolve(new Response(new Uint8Array([7])))
  assert.deepEqual(new Uint8Array(await retry), new Uint8Array([7]))
})
