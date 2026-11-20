import { useEffect, useMemo, useRef, useState } from 'react'
import './App.css'
import { Viewer, caseFiles, rleDecode, rleEncode } from './lib/viewer'
import { forget, getBuffer, getJson, keepOnly } from './lib/fetchCache'
import {
  ALGO_VERSION, DEFAULT_SOLID_HU, applyM, componentNear, findInFollowUp, growAuto, lobeAt, lpsToVox, metrics,
  suggestType, voxToLps, type Box, type GrowResult, type Metrics, type Vec3,
} from './lib/measure'
import { download, loadSession, saveSession, toCsv, type Provenance, type Row, type Session } from './lib/session'

interface CaseItem {
  case_id: string; source: string; patient_id: string; timepoint: string; scan_date: string; series_number: number
  slice_thickness_mm: number; teaching_case?: string | null; difficulty?: string | null; tags?: string[]
  pair?: { case_id: string; role: 'baseline' | 'follow-up' } | null; note?: string
}
interface Current {
  mask: Uint8Array; box: Box; m: Metrics; seed: Vec3; params: GrowResult['params'] | null; autoLo: number | null
  provenance: Provenance; uncertain: boolean; reasons: string[]; noduleId: string; type: string; lobe: string
  matchStatus: string; notes: string; editEvents: number; expert: Metrics | null
}

const fmt = (x: number | undefined, d = 1) => (x === undefined || Number.isNaN(x) ? '–' : x.toFixed(d))
/** Warm every file a case needs (same cache the viewer reads from), so opening it costs no network. */
function prefetchCase(id: string) {
  const base = `/cases/${id}/`
  getJson(base + 'meta.json').then(m => {
    const f = caseFiles(m)
    for (const file of [f.ct, f.expert, f.lungs, f.lobes]) if (file) getBuffer(base + file).catch(() => {})
    if (m.files?.candidates) getJson(base + m.files.candidates).catch(() => {})
  }).catch(() => {})
}
const caseLabel = (c: CaseItem) => c.source === 'RIDER'
  ? `${c.patient_id.replace('RIDER-', 'R-')} · ${c.timepoint === 'test' ? 'baseline (test)' : 'follow-up (retest)'}`
  : `${c.patient_id} · ${c.timepoint || 'scan'}`

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const viewerRef = useRef<Viewer | null>(null)
  const [cases, setCases] = useState<CaseItem[]>([])
  const [active, setActive] = useState<CaseItem | null>(null)
  const [meta, setMeta] = useState<any>(null)
  const [loading, setLoading] = useState<string>('')
  const [loadMs, setLoadMs] = useState<number | null>(null)
  const [loadError, setLoadError] = useState<{ c: CaseItem; message: string } | null>(null)
  const [slowFor, setSlowFor] = useState('') // the loading label that has been running for 15 s
  // each openCase gets a sequence number; only the latest may touch the viewer or the state
  const loadSeq = useRef(0)
  const loadingRef = useRef(false)
  // NiiVue holds one scene, so viewer loads run one after another and never interleave
  const viewerQueue = useRef<Promise<unknown>>(Promise.resolve())
  const [session, setSession] = useState<Session>(() => loadSession())
  const [cur, setCur] = useState<Current | null>(null)
  const [mode, setMode] = useState<'measure' | 'add' | 'erase'>('measure')
  const [win, setWin] = useState<'lung' | 'mediastinum'>('lung')
  const [showExpert, setShowExpert] = useState(true)
  const [showTool, setShowTool] = useState(true)
  const [solidHu, setSolidHu] = useState(DEFAULT_SOLID_HU)
  const [penSize, setPenSize] = useState(3)
  const [msg, setMsg] = useState('')
  const [webglOk, setWebglOk] = useState(true)
  const [cands, setCands] = useState<{ rank: number; vox: Vec3; score: number; scale_mm: number }[]>([])
  const [showCands, setShowCands] = useState(false)
  // timed study (decision 43): separate timers per condition; manual condition disables the tool's help
  const [study, setStudy] = useState<'off' | 'manual' | 'tool'>('off')
  const studyRef = useRef(study)
  studyRef.current = study
  const timerKey = (id: string) => (studyRef.current === 'off' ? id : `${id}|${studyRef.current}`)
  const lastAct = useRef(Date.now())
  const handlers = useRef<{ onClick: (p: Vec3) => void; onEdited: () => void }>({ onClick: () => {}, onEdited: () => {} })
  const sessionRef = useRef(session)
  sessionRef.current = session
  const activeRef = useRef<CaseItem | null>(null)
  activeRef.current = active
  const metaRef = useRef<any>(null)
  metaRef.current = meta
  const solidRef = useRef(solidHu)
  solidRef.current = solidHu

  // ---- boot ----
  useEffect(() => {
    const gl = document.createElement('canvas').getContext('webgl2')
    if (!gl) { setWebglOk(false); return }
    fetch('/manifest.json').then(r => r.json()).then(m => setCases(m.cases))
    if (canvasRef.current && !viewerRef.current) {
      const nv = viewerRef.current = new Viewer(canvasRef.current)
      nv.onClickVox = p => handlers.current.onClick(p)
      nv.onEdited = () => handlers.current.onEdited()
    }
  }, [])
  useEffect(() => { saveSession(session) }, [session])

  // ---- timer: counts only while a case is open, tab visible, and user active in last 60 s (decision 36) ----
  useEffect(() => {
    const bump = () => { lastAct.current = Date.now() }
    window.addEventListener('pointerdown', bump); window.addEventListener('keydown', bump); window.addEventListener('wheel', bump)
    const t = setInterval(() => {
      if (!active || loading || document.hidden || Date.now() - lastAct.current > 60000) return
      const k = timerKey(active.case_id)
      setSession(s => ({ ...s, seconds: { ...s.seconds, [k]: (s.seconds[k] || 0) + 1 } }))
    }, 1000)
    return () => { clearInterval(t); window.removeEventListener('pointerdown', bump); window.removeEventListener('keydown', bump); window.removeEventListener('wheel', bump) }
  }, [active, loading])

  const v = viewerRef.current
  const vol = () => ({ dims: v!.dims, spacing: v!.spacing })
  const ctData = () => v!.volumeData(0) as Int16Array
  const lungsData = () => v!.volumeData(v!.expertIndex > 0 ? 2 : 1) as Uint8Array
  const lobesData = () => (metaRef.current?.files?.lobes ? v!.volumeData(v!.expertIndex > 0 ? 3 : 2) : null) as Uint8Array | null
  const expertData = () => (v!.expertIndex > 0 ? v!.volumeData(1) : null) as Uint8Array | null

  const rowsForCase = (id: string) => sessionRef.current.rows.filter(r => r.caseId === id)
  const nextNoduleId = () => {
    const ids = rowsForCase(activeRef.current!.case_id).map(r => r.nodule_id)
    let i = 1; while (ids.includes(`N${i}`)) i++
    return `N${i}`
  }

  // ---- open case ----
  async function openCase(c: CaseItem, retry = false) {
    if (!v) return
    const seq = ++loadSeq.current
    const stale = () => seq !== loadSeq.current
    const base = `/cases/${c.case_id}/`
    if (retry) forget(base) // a retry downloads this case again instead of waiting on a stalled request
    setCur(null); setActive(c); activeRef.current = c; setMsg('')
    setLoadError(null); setLoadMs(null); setMeta(null); metaRef.current = null; setCands([])
    loadingRef.current = true; setLoading(`Loading ${caseLabel(c)}…`)
    const t0 = performance.now()
    // next case is prefetched below so Daniel does not wait (advisor: load must stay out of the timing);
    // keep only this case's and the next case's volume buffers in memory
    const nx = cases[cases.findIndex(x => x.case_id === c.case_id) + 1]
    keepOnly([base, ...(nx ? [`/cases/${nx.case_id}/`] : [])])
    try {
      getBuffer(base + 'ct.nii.gz').catch(() => {}) // the big file: start it alongside meta.json
      const m = await getJson(base + 'meta.json')
      if (stale()) return
      const f = caseFiles(m)
      // download every volume first (the network is the slow part); a failure lands in catch below
      await Promise.all([f.ct, f.expert, f.lungs, f.lobes].filter((x): x is string => !!x).map(x => getBuffer(base + x)))
      if (stale()) return
      const run = viewerQueue.current.then(() => (stale() ? undefined : v.load(base, f, { win, showExpert, showTool })))
      viewerQueue.current = run.catch(() => {})
      await run
      if (stale()) return
      setMeta(m); metaRef.current = m
      if (m.files?.candidates) getJson(base + m.files.candidates).then(j => { if (!stale()) setCands(j.candidates || []) }).catch(() => {})
      setMode('measure')
      setLoadMs(performance.now() - t0); loadingRef.current = false; setLoading(''); lastAct.current = Date.now()
      if (nx) prefetchCase(nx.case_id)
    } catch (e) {
      if (stale()) return
      loadingRef.current = false; setLoading('')
      setLoadError({ c, message: e instanceof Error ? e.message : String(e) })
    }
  }
  // offer a retry while a load is slow (a stalled request never errors on its own)
  useEffect(() => {
    if (!loading) return
    const t = setTimeout(() => setSlowFor(loading), 15000)
    return () => clearTimeout(t)
  }, [loading])
  const slowLoad = !!loading && slowFor === loading

  // ---- measurement ----
  function computeCurrent(mask: Uint8Array, box: Box, seed: Vec3, g: GrowResult | null, prev: Partial<Current>): Current | null {
    const m = metrics(mask, box, vol(), ctData(), solidRef.current)
    if (!m) return null
    const ex = expertData()
    const e = ex ? componentNear(ex, vol(), [Math.round(m.centroid[0]), Math.round(m.centroid[1]), Math.round(m.centroid[2])], 80) : null
    const expert = e ? metrics(e.mask, e.box, vol(), ctData(), solidRef.current) : null
    const reasons: string[] = []
    if (g?.leaked) reasons.push('outline reached the 60 mm search limit (possible leak into vessels / mediastinum)')
    if (g?.touchesWall) reasons.push('touches chest wall or mediastinum: edge is a judgement call')
    if (g?.vesselLike || m.longMm > 2.5 * m.shortMm) reasons.push('elongated outline: a vessel may be attached — raise the edge threshold or erase it')
    if (m.longMm < 4) reasons.push('very small (<4 mm)')
    if (m.longMm > 30) reasons.push('large lesion (>30 mm): edge against mediastinum / vessels is often unclear — check the outline')
    if (prev.reasons) reasons.push(...prev.reasons.filter(r => r.startsWith('match')))
    return {
      mask, box, m, seed, params: g?.params ?? prev.params ?? null, autoLo: g?.autoLo ?? prev.autoLo ?? null,
      provenance: prev.provenance ?? 'tool', uncertain: reasons.length > 0 || !!prev.uncertain, reasons,
      noduleId: prev.noduleId ?? nextNoduleId(), type: prev.type ?? suggestType(m.solidFraction),
      lobe: prev.lobe ?? lobeAt(lobesData(), vol(), mask, box), matchStatus: prev.matchStatus ?? (activeRef.current?.pair?.role === 'follow-up' ? 'new' : ''),
      notes: prev.notes ?? '', editEvents: prev.editEvents ?? 0, expert,
    }
  }
  function show(c: Current) {
    v!.showMask(c.mask, c.box)
    v!.drawLines(c.m.slice, [c.m.longLine, c.m.shortLine])
    v!.goToSlice(c.m.slice, Math.round(c.m.centroid[0]), Math.round(c.m.centroid[1]))
    v!.checkpoint()
  }
  function onClick(p: Vec3, lo?: number, keep?: Partial<Current>) {
    if (loadingRef.current) return // the viewer may still hold the previous case
    if (studyRef.current === 'manual') { setMsg('Manual condition: outline with the brush (+ Brush), as you would by hand.'); return }
    const t0 = performance.now()
    const g = growAuto(ctData(), lungsData(), vol(), p, lo !== undefined ? { lo } : {})
    if (!g) { setMsg('No nodule-like tissue under the click (within 3 mm). Click inside the nodule, or use the brush.'); return }
    const c = computeCurrent(g.mask, g.box, g.seed, g, keep ?? {})
    if (!c) return
    setCur(c); show(c)
    setMsg(`Outlined in ${Math.round(performance.now() - t0)} ms`)
  }
  function onEdited() {
    if (loadingRef.current) return
    const r =viewerRef.current!.readMask()
    setCur(prev => {
      if (!r) return null
      const c = computeCurrent(r.mask, r.box, prev?.seed ?? [r.box.lo[0], r.box.lo[1], r.box.lo[2]], null, {
        ...(prev ?? {}), provenance: prev ? 'edited' : 'manual', editEvents: (prev?.editEvents ?? 0) + 1, uncertain: false,
      } as Partial<Current>)
      if (c) { viewerRef.current!.drawLines(c.m.slice, [c.m.longLine, c.m.shortLine]) }
      return c
    })
  }
  function setThreshold(lo: number) {
    if (!cur) return
    onClick(cur.seed, lo, { noduleId: cur.noduleId, matchStatus: cur.matchStatus, notes: cur.notes, type: undefined, lobe: undefined })
  }

  // ---- follow-up matching (decisions 24–27) ----
  const baselineRows = useMemo(() => active?.pair?.role === 'follow-up' ? session.rows.filter(r => r.caseId === active.pair!.case_id) : [], [active, session.rows])
  async function findFromBaseline(r: Row) {
    if (studyRef.current === 'manual') { setMsg('Manual condition: find the nodule yourself.'); return }
    if (loadingRef.current || !metaRef.current) return
    const seq = loadSeq.current
    const bm = await getJson(`/cases/${r.caseId}/meta.json`)
    if (seq !== loadSeq.current || loadingRef.current) return // another case was opened meanwhile
    const pred = lpsToVox(metaRef.current, applyM(bm.pair.M_to_pair, voxToLps(bm, r.seed)))
    const lo = r.params ? JSON.parse(r.params).lo ?? -450 : -450
    const f = findInFollowUp(ctData(), lungsData(), vol(), pred, r.volume_mm3, lo)
    if (!f) { setMsg(`${r.nodule_id}: nothing nodule-like within 15 mm of the predicted spot. Mark as not found or measure by hand.`); v!.goToSlice(Math.round(pred[2]), Math.round(pred[0]), Math.round(pred[1])); return }
    const reasons = f.uncertain ? [`match: ${f.candidates > 1 ? f.candidates + ' candidates nearby' : 'single candidate'}, ${fmt(f.dist)} mm from prediction, volume ×${fmt(f.ratio, 2)}`] : []
    const c = computeCurrent(f.best.mask, f.best.box, f.best.seed, f.best, { noduleId: r.nodule_id, matchStatus: f.uncertain ? 'uncertain' : 'matched', reasons, uncertain: f.uncertain, type: r.type, lobe: r.lobe })
    if (!c) return
    setCur(c); show(c)
    setMsg(`${r.nodule_id}: ${f.uncertain ? 'possible match — please confirm' : 'matched'} (${fmt(f.dist)} mm from registered position, volume ×${fmt(f.ratio, 2)} vs baseline)`)
  }

  // ---- save / export ----
  function saveCurrent() {
    const active = activeRef.current, meta = metaRef.current
    if (!cur || !active || !meta) return
    const row: Row = {
      id: `${active.case_id}#${cur.noduleId}`, caseId: active.case_id, patient_id: meta.patient_id, scan_date: meta.scan_date,
      timepoint: active.timepoint, series: String(meta.series_number), slice_thickness: meta.slice_thickness_mm,
      nodule_id: cur.noduleId, lobe: cur.lobe, image_number: cur.m.slice + 1, type: cur.type,
      long_axis_mm: cur.m.longMm, short_axis_mm: cur.m.shortMm, mean_diameter_mm: cur.m.meanMm,
      solid_component_mm: cur.type === 'part-solid' ? cur.m.solidMm : '', volume_mm3: cur.m.volumeMm3,
      match_status: cur.matchStatus, initials: session.initials, notes: cur.notes, provenance: cur.provenance,
      algo_version: ALGO_VERSION, params: JSON.stringify({ lo: cur.params?.lo, hi: cur.params?.hi, open: cur.params?.openPx, open3d: cur.params?.open3d, solidHu, autoLo: cur.autoLo }),
      uncertain: cur.uncertain, seed: cur.seed, savedAt: Date.now(), editEvents: cur.editEvents,
      mask: { box: cur.box, rle: rleEncode(cur.mask) },
    }
    setSession(s => ({ ...s, rows: [...s.rows.filter(x => x.id !== row.id), row] }))
    setCur(null); v!.clearDrawing()
    setMsg(`Saved ${row.nodule_id}. Click the next nodule, or export.`)
  }
  function reopen(r: Row) {
    if (!r.mask || r.caseId !== active?.case_id) return
    const b = r.mask.box
    const n = (b.hi[0] - b.lo[0]) * (b.hi[1] - b.lo[1]) * (b.hi[2] - b.lo[2])
    const c = computeCurrent(rleDecode(r.mask.rle, n), b, r.seed, null, {
      noduleId: r.nodule_id, provenance: r.provenance, matchStatus: r.match_status, notes: r.notes, type: r.type, lobe: r.lobe,
      uncertain: r.uncertain, editEvents: r.editEvents, params: r.params ? { ...JSON.parse(r.params), radiusMm: 60, openPx: 2 } : null,
    })
    if (c) { setCur(c); show(c) }
  }
  function removeRow(id: string) { setSession(s => ({ ...s, rows: s.rows.filter(r => r.id !== id) })) }
  function exportStudy() {
    const lines = ['case_id,teaching_case,timepoint,condition,minutes']
    for (const [k, sec] of Object.entries(session.seconds)) {
      if (!k.includes('|')) continue
      const [id, cond] = k.split('|')
      const c = cases.find(x => x.case_id === id)
      lines.push([id, c?.teaching_case ?? '', c?.timepoint ?? '', cond, (sec / 60).toFixed(2)].join(','))
    }
    download('longmarker_timed_study.csv', lines.join('\n') + '\n')
  }
  function exportCsv() { download(`longmarker_${new Date().toISOString().slice(0, 10)}.csv`, toCsv(session)) }
  function saveSessionFile() { download('longmarker_session.json', JSON.stringify(session), 'application/json') }
  function loadSessionFile(f: File) {
    f.text().then(t => { const s = JSON.parse(t); if (s.version === 1) setSession(s); else alert('Not a LongMarker session file') })
  }

  handlers.current = { onClick: (p: Vec3) => onClick(p), onEdited: () => onEdited() }

  // test hook (used by the automated end-to-end check; harmless for users)
  ;(window as any).__lm = { viewer: v, click: (p: Vec3) => { v!.goToSlice(p[2], p[0], p[1]); onClick(p) }, find: findFromBaseline, save: () => saveCurrent(), session }

  const patients = useMemo(() => {
    const g: Record<string, CaseItem[]> = {}
    for (const c of cases) (g[c.source + '|' + c.patient_id] ||= []).push(c)
    return Object.entries(g)
  }, [cases])
  const secs = active ? session.seconds[timerKey(active.case_id)] || 0 : 0

  if (!webglOk) return <div className="unsupported">This tool needs a browser with WebGL2 (current Chrome or Edge).</div>

  return (
    <div className="app">
      <header>
        <div className="brand"><span className="logo">◎</span> LongMarker <span className="sub">lung nodule measurement · pilot</span></div>
        <div className="ruo">Research use only · not for clinical decisions</div>
        <div className="hdr-actions">
          <label className="initials">Initials <input value={session.initials} maxLength={4} onChange={e => setSession(s => ({ ...s, initials: e.target.value.toUpperCase() }))} /></label>
          <button onClick={exportCsv} disabled={!session.rows.length} className="primary">Export CSV ({session.rows.length})</button>
          <label className="initials" title="Timed study: separate timer per condition (eval/timed-study.md)">Study
            <select value={study} onChange={e => { setStudy(e.target.value as any); studyRef.current = e.target.value as any; setCur(null); v?.clearDrawing(); if (e.target.value === 'manual') { setMode('add'); v?.setMode('add', penSize) } }}>
              <option value="off">off</option><option value="manual">manual</option><option value="tool">tool</option>
            </select></label>
          {study !== 'off' && <button onClick={exportStudy}>Export study</button>}
          <button onClick={saveSessionFile}>Save session</button>
          <label className="btn">Load session<input type="file" accept=".json" hidden onChange={e => e.target.files?.[0] && loadSessionFile(e.target.files[0])} /></label>
        </div>
      </header>

      <aside className="cases">
        <h3>Cases <span className="muted">(public TCIA data)</span></h3>
        {patients.map(([k, list]) => (
          <div key={k} className="patient">
            <div className="pname">{list[0].patient_id}{list[0].tags?.filter(Boolean).length ? <span className="tags">{list[0].tags.filter(Boolean).join(' · ')}</span> : null}</div>
            {list.map(c => {
              const n = rowsForCase(c.case_id).length
              return (
                <button key={c.case_id} className={'case' + (active?.case_id === c.case_id ? ' on' : '')} onClick={() => openCase(c)}>
                  <span>{caseLabel(c)}</span>
                  <span className="cmeta">{c.teaching_case ? <em>{c.teaching_case}</em> : null}{n ? <b>✓{n}</b> : null}</span>
                </button>
              )
            })}
          </div>
        ))}
      </aside>

      <main>
        <div className="toolbar">
          <div className="grp">
            <button className={mode === 'measure' ? 'on' : ''} disabled={study === 'manual'} onClick={() => { setMode('measure'); v?.setMode('measure') }} title="Click a nodule to outline and measure it">● Click-to-measure</button>
            <button className={mode === 'add' ? 'on' : ''} disabled={!active} onClick={() => { setMode('add'); v?.setMode('add', penSize) }} title="Paint to add to the outline">＋ Brush</button>
            <button className={mode === 'erase' ? 'on' : ''} disabled={!active} onClick={() => { setMode('erase'); v?.setMode('erase', penSize) }} title="Paint to remove from the outline">− Erase</button>
            <select value={penSize} onChange={e => { const p = +e.target.value; setPenSize(p); if (mode !== 'measure') v?.setMode(mode, p) }} title="Brush size (voxels)">
              {[1, 3, 5, 9].map(p => <option key={p} value={p}>{p}px</option>)}
            </select>
            <button disabled={!active} onClick={() => { v?.nv.drawUndo(); setTimeout(onEdited, 30) }}>Undo</button>
          </div>
          <div className="grp">
            <button className={win === 'lung' ? 'on' : ''} onClick={() => { setWin('lung'); v?.setWindow('lung') }}>Lung window</button>
            <button className={win === 'mediastinum' ? 'on' : ''} onClick={() => { setWin('mediastinum'); v?.setWindow('mediastinum') }}>Mediastinum</button>
          </div>
          <div className="grp">
            <label><input type="checkbox" checked={showExpert} onChange={e => { setShowExpert(e.target.checked); v?.setExpertVisible(e.target.checked) }} /> <span className="sw expert" /> Expert outline</label>
            <label><input type="checkbox" checked={showTool} onChange={e => { setShowTool(e.target.checked); v?.setToolVisible(e.target.checked) }} /> <span className="sw tool" /> Tool outline</label>
          </div>
        </div>
        <div className="viewer">
          <canvas ref={canvasRef} />
          {!active && <div className="empty">
            <h2>Pick a case on the left</h2>
            <ol><li><b>Click</b> inside a nodule: the tool outlines it in 3D and measures long/short axis, volume and solid part.</li>
              <li>Compare with the <span className="sw expert" /> expert outline. <b>Correct</b> with the brush or the threshold slider if you disagree.</li>
              <li><b>Save</b>, then <b>Export CSV</b>: same columns as your sheet, plus where each value came from.</li>
              <li>On a <b>follow-up</b> scan, press <b>Find</b> next to a baseline nodule to jump to it.</li></ol>
            <p className="muted">Scroll = change slice · right-drag = contrast · the timer runs only while you work on a case.</p>
          </div>}
          {loading && <div className="loading" role="status"><div className="spinner" />{loading}
            {slowLoad && active && <span className="slow">Still downloading. <button onClick={() => openCase(active, true)}>Retry</button></span>}</div>}
          {loadError && <div className="loading error" role="alert">
            <p>Could not load <b>{caseLabel(loadError.c)}</b>.</p>
            <p className="muted small">{loadError.message}</p>
            <button className="primary" onClick={() => openCase(loadError.c, true)}>Retry</button>
          </div>}
        </div>
        <div className="status">
          <span>{msg}</span>
          <span className="muted">{active ? `${caseLabel(active)} · ${loading ? 'loading…' : loadError ? 'not loaded' : `${meta?.slice_thickness_mm ?? ''} mm slices${loadMs !== null ? ` · loaded in ${(loadMs / 1000).toFixed(1)} s` : ''}`} · time on case ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}` : ''}</span>
        </div>
      </main>

      <section className="panel">
        {active?.pair?.role === 'follow-up' && (
          <div className="card fu">
            <h4>Follow-up: nodules from baseline</h4>
            {baselineRows.length === 0
              ? <p className="muted">No baseline measurements yet. Measure the baseline scan of {active.patient_id} first, then come back here.</p>
              : baselineRows.map(r => {
                const done = rowsForCase(active.case_id).find(x => x.nodule_id === r.nodule_id)
                return <div key={r.id} className="fu-row">
                  <span><b>{r.nodule_id}</b> {r.lobe} · {fmt(r.long_axis_mm)} mm</span>
                  {done ? <span className="ok">{done.match_status || 'saved'}</span> : <button disabled={!!loading} onClick={() => findFromBaseline(r)}>Find in this scan →</button>}
                </div>
              })}
          </div>
        )}

        {active && cands.length > 0 && (
          <div className="card">
            <label className="chk"><input type="checkbox" checked={showCands} onChange={e => setShowCands(e.target.checked)} /> <b>Candidates (experimental)</b></label>
            {showCands && <>
              <p className="muted small">Classical blob filter, top {cands.length} per scan. Finds about half of the nodules in the test set and misses ground-glass; most entries are vessels. Use it as a second look, not as a replacement for your own search.</p>
              <div className="cands">{cands.map(c => (
                <button key={c.rank} onClick={() => v?.goToSlice(c.vox[2], c.vox[0], c.vox[1])} title={`score ${c.score.toFixed(0)}`}>#{c.rank} · img {c.vox[2] + 1}</button>
              ))}</div>
            </>}
          </div>
        )}

        {cur ? (
          <div className="card measure">
            <div className="row2">
              <h4>Nodule <input className="nid" value={cur.noduleId} onChange={e => setCur({ ...cur, noduleId: e.target.value })} /></h4>
              <span className={'prov ' + cur.provenance}>{cur.provenance}</span>
            </div>
            {cur.uncertain && <div className="warn">⚠ Uncertain<ul>{cur.reasons.map(r => <li key={r}>{r}</li>)}</ul></div>}
            <table className="nums">
              <thead><tr><th /><th>Tool</th>{cur.expert && <th>Expert</th>}</tr></thead>
              <tbody>
                <tr><td>Long axis</td><td>{fmt(cur.m.longMm)} mm</td>{cur.expert && <td>{fmt(cur.expert.longMm)}</td>}</tr>
                <tr><td>Short axis</td><td>{fmt(cur.m.shortMm)} mm</td>{cur.expert && <td>{fmt(cur.expert.shortMm)}</td>}</tr>
                <tr><td>Mean diameter</td><td>{fmt(cur.m.meanMm)} mm</td>{cur.expert && <td>{fmt(cur.expert.meanMm)}</td>}</tr>
                <tr><td>Volume</td><td>{fmt(cur.m.volumeMm3 / 1000, 2)} cm³</td>{cur.expert && <td>{fmt(cur.expert.volumeMm3 / 1000, 2)}</td>}</tr>
                <tr><td>Solid part</td><td>{cur.type === 'part-solid' ? `${fmt(cur.m.solidMm)} mm` : '–'}</td>{cur.expert && <td />}</tr>
                <tr><td>Image #</td><td>{cur.m.slice + 1}</td>{cur.expert && <td>{cur.expert.slice + 1}</td>}</tr>
              </tbody>
            </table>
            <div className="fields">
              <label>Type <select value={cur.type} onChange={e => setCur({ ...cur, type: e.target.value })}>
                <option>solid</option><option>part-solid</option><option>ground-glass</option></select></label>
              <label>Lobe <select value={cur.lobe} onChange={e => setCur({ ...cur, lobe: e.target.value })}>
                {['', 'RUL', 'RML', 'RLL', 'LUL', 'LLL'].map(l => <option key={l}>{l}</option>)}</select></label>
              {active?.pair?.role === 'follow-up' && <label>Match <select value={cur.matchStatus} onChange={e => setCur({ ...cur, matchStatus: e.target.value })}>
                {['matched', 'uncertain', 'new', 'not found'].map(l => <option key={l}>{l}</option>)}</select></label>}
              <label className="chk"><input type="checkbox" checked={cur.uncertain} onChange={e => setCur({ ...cur, uncertain: e.target.checked })} /> Uncertain</label>
            </div>
            {cur.params && <label className="slider">Edge threshold {cur.params.lo} HU <span className="muted">(auto {cur.autoLo})</span>
              <input type="range" min={-900} max={-100} step={25} value={cur.params.lo} onChange={e => setThreshold(+e.target.value)} /></label>}
            {cur.type === 'part-solid' && <label className="slider">Solid part from {solidHu} HU <span className="muted">(suggestion — confirm by eye)</span>
              <input type="range" min={-500} max={0} step={25} value={solidHu} onChange={e => { setSolidHu(+e.target.value); solidRef.current = +e.target.value; setTimeout(() => cur && setCur(computeCurrent(cur.mask, cur.box, cur.seed, null, cur)), 0) }} /></label>}
            <textarea placeholder="Notes" value={cur.notes} onChange={e => setCur({ ...cur, notes: e.target.value })} />
            <div className="row2">
              <button className="primary" onClick={saveCurrent}>Save nodule</button>
              <button onClick={() => { setCur(null); v?.clearDrawing() }}>Discard</button>
            </div>
          </div>
        ) : active && <div className="card muted">Click inside a nodule to measure it{active.pair?.role === 'follow-up' ? ', or use “Find” above' : ''}.</div>}

        {active && rowsForCase(active.case_id).length > 0 && (
          <div className="card">
            <h4>Saved on this scan</h4>
            {rowsForCase(active.case_id).map(r => (
              <div key={r.id} className="saved">
                <button className="link" onClick={() => reopen(r)}>{r.nodule_id}</button>
                <span>{r.lobe} {r.type} · {fmt(r.long_axis_mm)}×{fmt(r.short_axis_mm)} mm · {fmt(r.volume_mm3 / 1000, 2)} cm³ {r.uncertain ? '⚠' : ''}</span>
                <span className={'prov ' + r.provenance}>{r.provenance}</span>
                <button className="x" onClick={() => removeRow(r.id)} title="Delete">×</button>
              </div>
            ))}
          </div>
        )}
      </section>

      <footer>
        Data: <a href="https://doi.org/10.7937/K9/TCIA.2015.U1X8A5NR" target="_blank">RIDER Lung CT</a> (CC BY 4.0) ·
        {' '}<a href="https://doi.org/10.7937/tcia.2020.jit9grk8" target="_blank">RIDER-LungCT-Seg</a> (CC BY 3.0) ·
        {' '}<a href="https://doi.org/10.7937/K9/TCIA.2015.LO9QL9SX" target="_blank">LIDC-IDRI</a> (CC BY 3.0), via The Cancer Imaging Archive.
        {' '}Lung/lobe masks: lungmask (Hofmanninger et al. 2020). Tool {ALGO_VERSION}. Research use only.
      </footer>
    </div>
  )
}
