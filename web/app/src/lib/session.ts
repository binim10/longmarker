// Session store (browser) + CSV export in Daniel's exact sheet columns. Decisions 12, 33–36, 53.
import { ALGO_VERSION, type Box } from './measure.ts'

export type Provenance = 'tool' | 'edited' | 'manual'
export interface Row {
  id: string // caseId#noduleId
  caseId: string
  patient_id: string
  scan_date: string
  timepoint: string
  series: string
  slice_thickness: number
  nodule_id: string
  lobe: string
  image_number: number
  type: string
  long_axis_mm: number
  short_axis_mm: number
  mean_diameter_mm: number
  solid_component_mm: number | ''
  volume_mm3: number
  match_status: string
  initials: string
  notes: string
  provenance: Provenance
  algo_version: string
  params: string
  uncertain: boolean
  seed: [number, number, number]
  savedAt: number
  mask?: { box: Box; rle: number[] }
  editEvents: number
}
export interface Session { rows: Row[]; seconds: Record<string, number>; initials: string; version: 1 }

const KEY = 'longmarker.session.v1'
export function loadSession(): Session {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || '')
    if (s && s.version === 1) return s
  } catch { /* empty or blocked storage */ }
  return { rows: [], seconds: {}, initials: '', version: 1 }
}
export function saveSession(s: Session) {
  try { localStorage.setItem(KEY, JSON.stringify(s)) } catch { /* storage blocked: session file still works */ }
}

export const SHEET_COLUMNS = ['patient_id', 'scan_date', 'timepoint', 'series', 'slice_thickness', 'nodule_id', 'lobe',
  'image_number', 'type', 'long_axis_mm', 'short_axis_mm', 'mean_diameter_mm', 'solid_component_mm', 'volume_mm3',
  'match_status', 'minutes', 'initials', 'notes'] as const
export const EXTRA_COLUMNS = ['provenance', 'algo_version', 'params'] as const

const esc = (v: unknown) => {
  const s = v === undefined || v === null ? '' : String(v)
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
}
const r1 = (x: number) => Math.round(x * 10) / 10

export function toCsv(s: Session): string {
  const head = [...SHEET_COLUMNS, ...EXTRA_COLUMNS].join(',')
  const lines = s.rows.map(r => {
    const minutes = r1(((s.seconds[r.caseId] || 0) + (s.seconds[r.caseId + '|tool'] || 0) + (s.seconds[r.caseId + '|manual'] || 0)) / 60)
    const notes = [r.uncertain ? 'Uncertain' : '', r.notes].filter(Boolean).join('; ')
    const rec: Record<string, unknown> = {
      ...r, long_axis_mm: r1(r.long_axis_mm), short_axis_mm: r1(r.short_axis_mm), mean_diameter_mm: r1(r.mean_diameter_mm),
      solid_component_mm: r.solid_component_mm === '' ? '' : r1(r.solid_component_mm), volume_mm3: Math.round(r.volume_mm3),
      minutes, notes, initials: r.initials || s.initials,
    }
    return [...SHEET_COLUMNS, ...EXTRA_COLUMNS].map(c => esc(rec[c])).join(',')
  })
  return '# Research use only. Not for clinical use. Data: TCIA (CC BY). Tool ' + ALGO_VERSION + '\n' + head + '\n' + lines.join('\n') + '\n'
}

export function download(name: string, text: string, type = 'text/csv') {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob([text], { type }))
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 2000)
}
