// NiiVue wrapper: axial viewer, overlays, drawing bitmap <-> file-order masks.
import { Niivue } from '@niivue/niivue'
import type { Box, Vec3 } from './measure'
import { getBuffer } from './fetchCache'

export const LABEL_TOOL = 2 // green in NiiVue draw LUT
export const LABEL_AXIS = 3 // blue: caliper lines

export type WindowPreset = 'lung' | 'mediastinum'
const WINDOWS: Record<WindowPreset, [number, number]> = { lung: [-1350, 150], mediastinum: [-160, 240] }

export interface CaseFiles { ct: string; expert: string | null; lungs: string; lobes: string | null }
/** The volume files a case's meta.json points at (expert outline, else the first reader's). */
export function caseFiles(meta: any): CaseFiles {
  const refs = meta.files.refs || {}
  return { ct: meta.files.ct ?? 'ct.nii.gz', expert: refs.expert ?? (Object.values(refs)[0] as string) ?? null, lungs: meta.files.lungs, lobes: meta.files.lobes ?? null }
}

export class Viewer {
  nv: Niivue
  dims: Vec3 = [0, 0, 0]
  spacing: Vec3 = [1, 1, 1]
  private lut: { x: Int32Array; y: Int32Array; z: Int32Array } | null = null
  onClickVox: ((v: Vec3) => void) | null = null
  onEdited: (() => void) | null = null
  mode: 'measure' | 'add' | 'erase' = 'measure'
  private down: { x: number; y: number } | null = null
  suppressEdit = false

  constructor(canvas: HTMLCanvasElement) {
    this.nv = new Niivue({
      backColor: [0.06, 0.07, 0.09, 1], show3Dcrosshair: false, crosshairColor: [1, 0.85, 0.2, 0.6],
      crosshairWidth: 1, isColorbar: false, textHeight: 0.035, dragAndDropEnabled: false,
    } as any)
    this.nv.attachToCanvas(canvas)
    canvas.addEventListener('pointerdown', e => { this.down = { x: e.clientX, y: e.clientY } })
    canvas.addEventListener('pointerup', e => {
      const d = this.down; this.down = null
      if (!d || e.button !== 0) return
      if (this.mode !== 'measure') { setTimeout(() => !this.suppressEdit && this.onEdited?.(), 30); return }
      if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4) return
      setTimeout(() => {
        const v = this.currentVox()
        if (v) this.onClickVox?.(v)
      }, 0)
    })
  }

  /** Load a case with its display state applied up front, so the CT is uploaded to the GPU once. */
  async load(base: string, f: CaseFiles, o: { win: WindowPreset; showExpert: boolean; showTool: boolean }) {
    const vol = async (file: string, opts: object) => ({ url: await getBuffer(base + file), name: file, ...opts })
    const [lo, hi] = WINDOWS[o.win]
    const vols = await Promise.all([
      vol(f.ct, { colormap: 'gray', cal_min: lo, cal_max: hi }),
      ...(f.expert ? [vol(f.expert, { colormap: 'warm', opacity: o.showExpert ? 0.35 : 0, cal_min: 0.5, cal_max: 1 })] : []),
      vol(f.lungs, { colormap: 'gray', opacity: 0 }),
      ...(f.lobes ? [vol(f.lobes, { colormap: 'gray', opacity: 0 })] : []),
    ])
    await this.nv.loadVolumes(vols as any)
    this.nv.setSliceType(this.nv.sliceTypeAxial)
    const h: any = this.nv.volumes[0].hdr
    this.dims = [h.dims[1], h.dims[2], h.dims[3]]
    this.spacing = [h.pixDims[1], h.pixDims[2], h.pixDims[3]]
    this.nv.createEmptyDrawing()
    this.setToolVisible(o.showTool)
    this.buildLut()
    this.setMode('measure')
  }

  volumeData(i: number): any { return (this.nv.volumes[i] as any)?.img }
  get expertIndex() { return this.nv.volumes.length >= 3 && (this.nv.volumes[1] as any).colormap === 'warm' ? 1 : -1 }

  setWindow(w: WindowPreset) {
    const v: any = this.nv.volumes[0]
    if (!v) return
    ;[v.cal_min, v.cal_max] = WINDOWS[w]
    this.nv.updateGLVolume()
  }
  setExpertVisible(on: boolean) { if (this.expertIndex > 0) this.nv.setOpacity(this.expertIndex, on ? 0.35 : 0) }
  setToolVisible(on: boolean) { this.nv.setDrawOpacity(on ? 0.5 : 0) }

  setMode(m: 'measure' | 'add' | 'erase', penSize = 3) {
    this.mode = m
    if (m === 'measure') { this.nv.setDrawingEnabled(false); return }
    this.nv.setDrawingEnabled(true)
    ;(this.nv.opts as any).penSize = penSize
    this.nv.setPenValue(m === 'add' ? LABEL_TOOL : 0, false)
  }

  // NiiVue's voxel coordinates (frac2vox, moveCrosshairInVox) are in the RAS-reoriented volume, while the
  // engine and every saved seed use file order. For these scans permRAS = [-1,-2,3]: x and y are mirrored.
  private ras2file(r: number[]): Vec3 {
    const p: number[] = (this.nv.volumes[0] as any).permRAS, f: Vec3 = [0, 0, 0]
    for (let i = 0; i < 3; i++) { const a = Math.abs(p[i]) - 1; f[a] = p[i] < 0 ? this.dims[a] - 1 - r[i] : r[i] }
    return f
  }
  private file2ras(f: number[]): Vec3 {
    const p: number[] = (this.nv.volumes[0] as any).permRAS, r: Vec3 = [0, 0, 0]
    for (let i = 0; i < 3; i++) { const a = Math.abs(p[i]) - 1; r[i] = p[i] < 0 ? this.dims[a] - 1 - f[a] : f[a] }
    return r
  }
  /** Crosshair position as a voxel in FILE order (what the engine, the masks and the session use). */
  currentVox(): Vec3 | null {
    const f = (this.nv as any).scene?.crosshairPos
    if (!f) return null
    const v = this.ras2file(this.nv.frac2vox(f) as any)
    return [Math.round(v[0]), Math.round(v[1]), Math.round(v[2])]
  }
  /** Move the crosshair to a FILE-order voxel (z = axial slice; x, y default to the current position). */
  goToSlice(z: number, x?: number, y?: number) {
    const c = this.currentVox()
    if (!c) return
    const from = this.file2ras(c), to = this.file2ras([x ?? c[0], y ?? c[1], z])
    this.nv.moveCrosshairInVox(to[0] - from[0], to[1] - from[1], to[2] - from[2])
  }

  // ----- drawing bitmap (NiiVue stores it in RAS order) -----
  private buildLut() {
    const vol: any = this.nv.volumes[0]
    const perm: number[] = vol.permRAS
    const dims = [3, ...this.dims]
    const layout = [0, 0, 0]
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) if (Math.abs(perm[i]) - 1 === j) layout[j] = i * Math.sign(perm[i])
    let stride = 1
    const instride = [1, 1, 1], inflip = [false, false, false]
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
      if (Math.abs(layout[j]) !== i) continue
      instride[j] = stride
      if (layout[j] < 0 || Object.is(layout[j], -0)) inflip[j] = true
      stride *= dims[j + 1]
    }
    const mk = (n: number, s: number, f: boolean) => { const a = new Int32Array(n); for (let i = 0; i < n; i++) a[i] = (f ? n - 1 - i : i) * s; return a }
    this.lut = { x: mk(this.dims[0], instride[0], inflip[0]), y: mk(this.dims[1], instride[1], inflip[1]), z: mk(this.dims[2], instride[2], inflip[2]) }
  }
  private di(x: number, y: number, z: number) { const l = this.lut!; return l.x[x] + l.y[y] + l.z[z] }

  clearDrawing() {
    const b = this.nv.drawBitmap as Uint8Array | null
    if (b) b.fill(0)
    this.refresh()
  }
  refresh() { this.suppressEdit = true; this.nv.refreshDrawing(true); this.suppressEdit = false }
  /** Make the current drawing an undo point, so Undo after a brush stroke returns to the tool's outline, not to empty. */
  checkpoint() { this.nv.drawAddUndoBitmap() }

  /** Write an ROI mask (file order) into the drawing as LABEL_TOOL. */
  showMask(mask: Uint8Array, box: Box) {
    const b = this.nv.drawBitmap as Uint8Array
    b.fill(0)
    const bd = [box.hi[0] - box.lo[0], box.hi[1] - box.lo[1], box.hi[2] - box.lo[2]]
    for (let z = 0; z < bd[2]; z++) for (let y = 0; y < bd[1]; y++) for (let x = 0; x < bd[0]; x++)
      if (mask[x + y * bd[0] + z * bd[0] * bd[1]]) b[this.di(x + box.lo[0], y + box.lo[1], z + box.lo[2])] = LABEL_TOOL
  }
  /** Rasterise caliper lines (voxel coords on slice z) as LABEL_AXIS on top of the mask. */
  drawLines(z: number, lines: number[][]) {
    const b = this.nv.drawBitmap as Uint8Array
    for (const l of lines) {
      const n = Math.ceil(Math.hypot(l[2] - l[0], l[3] - l[1]) * 2) + 1
      for (let i = 0; i <= n; i++) {
        const x = Math.round(l[0] + (l[2] - l[0]) * i / n), y = Math.round(l[1] + (l[3] - l[1]) * i / n)
        if (x < 0 || y < 0 || x >= this.dims[0] || y >= this.dims[1]) continue
        const k = this.di(x, y, z)
        if (b[k] === LABEL_TOOL) b[k] = LABEL_AXIS
      }
    }
    this.refresh()
  }
  /** Read the current drawing back into an ROI mask (file order). */
  readMask(): { mask: Uint8Array; box: Box } | null {
    const b = this.nv.drawBitmap as Uint8Array
    const [nx, ny, nz] = this.dims
    const lo: Vec3 = [nx, ny, nz], hi: Vec3 = [-1, -1, -1]
    const l = this.lut!
    for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) {
      const base = l.y[y] + l.z[z]
      for (let x = 0; x < nx; x++) if (b[l.x[x] + base] >= LABEL_TOOL) {
        if (x < lo[0]) lo[0] = x; if (y < lo[1]) lo[1] = y; if (z < lo[2]) lo[2] = z
        if (x > hi[0]) hi[0] = x; if (y > hi[1]) hi[1] = y; if (z > hi[2]) hi[2] = z
      }
    }
    if (hi[0] < 0) return null
    const box: Box = { lo, hi: [hi[0] + 1, hi[1] + 1, hi[2] + 1] }
    const bd = [box.hi[0] - lo[0], box.hi[1] - lo[1], box.hi[2] - lo[2]]
    const mask = new Uint8Array(bd[0] * bd[1] * bd[2])
    for (let z = 0; z < bd[2]; z++) for (let y = 0; y < bd[1]; y++) for (let x = 0; x < bd[0]; x++)
      if (b[this.di(x + lo[0], y + lo[1], z + lo[2])] >= LABEL_TOOL) mask[x + y * bd[0] + z * bd[0] * bd[1]] = 1
    return { mask, box }
  }
}

// RLE for storing edited masks in the session file
export function rleEncode(m: Uint8Array): number[] {
  const out: number[] = []; let cur = 0, run = 0
  for (let i = 0; i < m.length; i++) { const v = m[i] ? 1 : 0; if (v === cur) run++; else { out.push(run); cur = v; run = 1 } }
  out.push(run); return out
}
export function rleDecode(r: number[], n: number): Uint8Array {
  const m = new Uint8Array(n); let i = 0, v = 0
  for (const run of r) { if (v) m.fill(1, i, i + run); i += run; v ^= 1 }
  return m
}
