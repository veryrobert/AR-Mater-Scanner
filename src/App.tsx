import { useCallback, useEffect, useRef, useState } from 'react'
import { Camera, Copy, Download, ScanLine, SlidersHorizontal, Upload } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ToolButton } from '@/components/shell/ToolButton'
import { Toolbar, ToolbarSeparator } from '@/components/shell/Toolbar'
import { OnOff, Segmented } from '@/components/shell/Segmented'
import { Field, FieldGroup } from '@/components/shell/Field'
import { Splash } from '@/components/shell/Splash'
import { PanelRail } from '@/components/shell/PanelRail'
import { PanelSheet } from '@/components/shell/PanelSheet'
import { ActionDock } from '@/components/shell/ActionDock'
import { PANEL_W, PHONE_SHEET, SAFE_BOTTOM, usePhone } from '@/components/shell/layout'
import { thumbnail } from '@/components/shell/thumbnail'
import { boardCorners, detectMarkers, estimateAspect, inkOnly, markerRegionsOut, selectFour, warp, type CornerMode, type Marker } from '@/lib/scanner'
import { cn } from '@/lib/utils'

// Point the camera at the four corner markers, capture, and get the board back straight:
// as ink only (paper, shadows and markers removed) and as transcribed text.

const panels = [
  { id: 'scan', label: 'Scan', icon: ScanLine },
  { id: 'settings', label: 'Settings', icon: SlidersHorizontal },
  { id: 'export', label: 'Export', icon: Download },
] as const
type PanelId = (typeof panels)[number]['id']

type Shot = { full: ImageData; four: Marker[]; scale: number }
type Reading = { state: 'idle' | 'reading' | 'done' | 'error'; text: string; error?: string }

const LIVE_DIM = 640 // live detection size
const HOLD = 6 // frames a marker is kept after it was last seen
const SHOT_DIM = 800 // detection size for a captured frame
const KEY = 'scanner.apiKey'

function readKey() {
  try { return localStorage.getItem(KEY) ?? '' } catch { return '' }
}

function pixels(src: CanvasImageSource, w: number, h: number, maxDim?: number) {
  const k = maxDim ? Math.min(1, maxDim / Math.max(w, h)) : 1
  const c = document.createElement('canvas')
  c.width = Math.round(w * k)
  c.height = Math.round(h * k)
  const g = c.getContext('2d', { willReadFrequently: true })!
  g.drawImage(src, 0, 0, c.width, c.height)
  return { img: g.getImageData(0, 0, c.width, c.height), scale: 1 / k }
}

const toCanvas = (img: ImageData) => {
  const c = document.createElement('canvas')
  c.width = img.width
  c.height = img.height
  c.getContext('2d')!.putImageData(img, 0, 0)
  return c
}

const toBlob = (c: HTMLCanvasElement, type: string, q?: number) =>
  new Promise<Blob>((ok, fail) => c.toBlob(b => (b ? ok(b) : fail(new Error('Couldn’t save the image'))), type, q))

async function saveFile(blob: Blob, name: string) {
  const file = new File([blob], name, { type: blob.type })
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file] }); return } catch (e) { if ((e as Error).name === 'AbortError') return }
  }
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 5000)
}

// Email: on phones the share sheet attaches the image and the text (pick Mail); elsewhere a mailto
// link opens a draft with the text, and the image is saved so it can be attached.
async function emailScan(image: Blob | null, text: string) {
  const subject = `Scan ${new Date().toLocaleDateString()}`
  const files = image ? [new File([image], `scan-${stamp()}.png`, { type: 'image/png' })] : []
  if (files.length && navigator.canShare?.({ files, text })) {
    try { await navigator.share({ files, title: subject, text }); return } catch (e) { if ((e as Error).name === 'AbortError') return }
  }
  if (image) await saveFile(image, `scan-${stamp()}.png`)
  const body = text.length > 1800 ? `${text.slice(0, 1800)}…` : text // keep the link within mail clients' limits
  location.href = `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`
}

const stamp = () => new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')

export default function App() {
  const phone = usePhone()
  const [panel, setPanel] = useState<PanelId | null>(null)
  const [phase, setPhase] = useState<'camera' | 'result'>('camera')
  const [camError, setCamError] = useState<string | null>(() => (typeof navigator.mediaDevices?.getUserMedia === 'function' ? null : 'No camera here'))
  const [found, setFound] = useState(0)
  const [crop, setCrop] = useState<CornerMode>('outer')
  const [auto, setAuto] = useState(false)
  const [view, setView] = useState<'ink' | 'text'>('ink')
  const [background, setBackground] = useState<'paper' | 'clear'>('paper')
  const [apiKey, setApiKey] = useState(readKey)
  const [reading, setReading] = useState<Reading>({ state: 'idle', text: '' })
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  const video = useRef<HTMLVideoElement>(null)
  const overlay = useRef<HTMLCanvasElement>(null)
  const stage = useRef<HTMLCanvasElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const shot = useRef<Shot | null>(null)
  const ink = useRef<HTMLCanvasElement | null>(null) // ink on transparent
  const straight = useRef<HTMLCanvasElement | null>(null) // cleaned photo, for reading
  const live = useRef<{ four: Marker[] | null; scale: number; stable: number }>({ four: null, scale: 1, stable: 0 })
  const abort = useRef<AbortController | null>(null)
  // Latest settings, for the camera loop and callbacks
  const cropRef = useRef(crop)
  const autoRef = useRef(auto)
  const keyRef = useRef(apiKey)
  useEffect(() => { cropRef.current = crop; autoRef.current = auto; keyRef.current = apiKey }, [crop, auto, apiKey])

  const current = panels.find(p => p.id === panel)

  // ---------- camera ----------
  useEffect(() => {
    let stream: MediaStream | null = null
    if (typeof navigator.mediaDevices?.getUserMedia !== 'function') return
    navigator.mediaDevices
      .getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } } })
      .then(s => {
        stream = s
        if (video.current) { video.current.srcObject = s; void video.current.play() }
      })
      .catch(() => setCamError('Camera blocked'))
    return () => stream?.getTracks().forEach(t => t.stop())
  }, [])

  // ---------- straighten ----------
  const render = useCallback(() => {
    const s = shot.current
    if (!s) return
    const corners = boardCorners(s.four, cropRef.current).map(p => ({ x: p.x * s.scale, y: p.y * s.scale }))
    const aspect = estimateAspect(corners, s.full.width, s.full.height)
    const [tl, tr, br, bl] = corners
    const d = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y)
    let h = Math.max(d(tl, bl), d(tr, br), Math.max(d(tl, tr), d(bl, br)) / aspect)
    let w = h * aspect
    const k = Math.min(1, 2400 / Math.max(w, h))
    w = Math.round(w * k)
    h = Math.round(h * k)

    const flat = warp(s.full, corners, w, h)
    straight.current = toCanvas(flat)

    // Ink only, with the markers and their sticky notes cut away
    const c = toCanvas(inkOnly(flat))
    const g = c.getContext('2d')!
    g.globalCompositeOperation = 'destination-out'
    for (const quad of markerRegionsOut(s.four, s.scale, corners, w, h)) {
      g.beginPath()
      quad.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y)))
      g.closePath()
      g.fill()
    }
    ink.current = c

    const out = stage.current
    if (out) {
      out.width = w
      out.height = h
      out.getContext('2d')!.drawImage(c, 0, 0)
    }
  }, [])

  const read = useCallback(async () => {
    const src = straight.current
    abort.current?.abort()
    if (!src) return
    if (!keyRef.current) { setReading({ state: 'error', text: '', error: 'Add a Claude API key in Settings' }); return }
    const ctrl = new AbortController()
    abort.current = ctrl
    setReading({ state: 'reading', text: '' })
    const api = await import('@/lib/transcribe') // the SDK loads only when needed
    try {
      // Vision works best at about 1.5k px on the long side
      const k = Math.min(1, 1568 / Math.max(src.width, src.height))
      const small = document.createElement('canvas')
      small.width = Math.round(src.width * k)
      small.height = Math.round(src.height * k)
      small.getContext('2d')!.drawImage(src, 0, 0, small.width, small.height)
      const text = await api.transcribe(await toBlob(small, 'image/jpeg', 0.9), keyRef.current, t => setReading({ state: 'reading', text: t }), ctrl.signal)
      setReading({ state: 'done', text })
    } catch (e) {
      if (ctrl.signal.aborted) return
      setReading({ state: 'error', text: '', error: api.errorText(e) })
    }
  }, [])

  const finish = useCallback((s: Shot) => {
    shot.current = s
    setPhase('result')
    setView('ink')
    // paint after the stage canvas is shown
    requestAnimationFrame(() => { render(); void read() })
  }, [render, read])

  const capture = useCallback(() => {
    const v = video.current
    if (!v?.videoWidth) return
    const full = pixels(v, v.videoWidth, v.videoHeight).img
    const det = pixels(v, v.videoWidth, v.videoHeight, SHOT_DIM)
    const four = selectFour(detectMarkers(det.img))
    if (four) finish({ full, four, scale: det.scale })
    else if (live.current.four) finish({ full, four: live.current.four, scale: live.current.scale })
  }, [finish])

  const fromFile = useCallback(async (file: File) => {
    setBusy(true)
    try {
      const bmp = await createImageBitmap(file)
      const full = pixels(bmp, bmp.width, bmp.height, 4000)
      const det = pixels(bmp, bmp.width, bmp.height, SHOT_DIM)
      const four = selectFour(detectMarkers(det.img))
      if (four) finish({ full: full.img, four, scale: det.scale / full.scale })
      else { setNotice('Couldn’t find all 4 markers'); setTimeout(() => setNotice(null), 3000) }
    } finally {
      setBusy(false)
    }
  }, [finish])

  // ---------- live detection ----------
  useEffect(() => {
    if (phase !== 'camera') return
    const small = document.createElement('canvas')
    const sg = small.getContext('2d', { willReadFrequently: true })!
    const css = getComputedStyle(document.documentElement)
    const ink = css.getPropertyValue('--foreground').trim() || '#ecebe8'
    const red = css.getPropertyValue('--marker').trim() || '#ff3b30'
    let raf = 0, last = 0
    // Markers seen in recent frames, so one missed frame doesn't drop a marker
    let held: { m: Marker; age: number }[] = []
    const tick = (t: number) => {
      raf = requestAnimationFrame(tick)
      const v = video.current, o = overlay.current
      if (!v?.videoWidth || !o || t - last < 60) return
      last = t
      const vw = v.videoWidth, vh = v.videoHeight
      const k = LIVE_DIM / Math.max(vw, vh)
      small.width = Math.round(vw * k)
      small.height = Math.round(vh * k)
      sg.drawImage(v, 0, 0, small.width, small.height)
      const seen = detectMarkers(sg.getImageData(0, 0, small.width, small.height))
      held = held.filter(h => !seen.some(m => Math.hypot(m.center.x - h.m.center.x, m.center.y - h.m.center.y) < Math.max(m.size, h.m.size) * 0.8))
      held = [...seen.map(m => ({ m, age: 0 })), ...held.map(h => ({ m: h.m, age: h.age + 1 })).filter(h => h.age <= HOLD)]
      const markers = held.map(h => h.m)
      const four = selectFour(markers)
      setFound(four ? 4 : Math.min(3, markers.length))

      // overlay (video is object-fit: contain)
      const dpr = devicePixelRatio || 1
      const cw = o.clientWidth, ch = o.clientHeight
      if (o.width !== cw * dpr || o.height !== ch * dpr) { o.width = cw * dpr; o.height = ch * dpr }
      const g = o.getContext('2d')!
      g.setTransform(dpr, 0, 0, dpr, 0, 0)
      g.clearRect(0, 0, cw, ch)
      const s = Math.min(cw / vw, ch / vh), ox = (cw - vw * s) / 2, oy = (ch - vh * s) / 2
      const path = (pts: { x: number; y: number }[]) => {
        g.beginPath()
        pts.forEach((p, i) => { const x = p.x / k * s + ox, y = p.y / k * s + oy; if (i) g.lineTo(x, y); else g.moveTo(x, y) })
        g.closePath()
      }
      // Dim everything outside the capture area; outline with a dark halo so it reads on white paper
      const line = (w: number, colour = ink) => {
        g.lineWidth = w + 2.5; g.strokeStyle = 'rgba(0,0,0,0.55)'; g.stroke()
        g.lineWidth = w; g.strokeStyle = colour; g.stroke()
      }
      if (four) {
        g.fillStyle = 'rgba(0,0,0,0.45)'
        g.beginPath(); g.rect(0, 0, cw, ch)
        boardCorners(four, cropRef.current).forEach((p, i) => { const x = p.x / k * s + ox, y = p.y / k * s + oy; if (i) g.lineTo(x, y); else g.moveTo(x, y) })
        g.closePath(); g.fill('evenodd')
        path(boardCorners(four, cropRef.current)); line(1.5)
      }
      for (const m of markers) {
        g.globalAlpha = four?.includes(m) ? 1 : 0.6
        path(m.corners); line(2.5, red)
      }
      g.globalAlpha = 1

      const L = live.current
      if (four) {
        const moved = L.four ? Math.max(...four.map((m, i) => Math.hypot(m.center.x - L.four![i].center.x, m.center.y - L.four![i].center.y))) : Infinity
        L.stable = moved < small.width * 0.012 ? L.stable + 1 : 0
        L.four = four
        L.scale = 1 / k
        if (autoRef.current && L.stable >= 10) { L.stable = 0; capture() }
      } else {
        L.four = null
        L.stable = 0
      }
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [phase, capture])

  // Re-straighten when the crop changes
  useEffect(() => { if (phase === 'result') render() }, [crop, phase, render])

  // ---------- export ----------
  const exportInk = async (forThumb = false) => {
    const c = ink.current
    if (!c) return null
    if (background === 'clear' && !forThumb) return toBlob(c, 'image/png')
    const p = document.createElement('canvas')
    p.width = c.width
    p.height = c.height
    const g = p.getContext('2d')!
    g.fillStyle = '#ffffff' // paper
    g.fillRect(0, 0, p.width, p.height)
    g.drawImage(c, 0, 0)
    return forThumb ? p : toBlob(p, 'image/png')
  }

  const ready = found === 4
  const stageStyle = phone
    ? { bottom: panel ? `${PHONE_SHEET * 100}dvh` : `calc(${SAFE_BOTTOM} + 96px)`, top: 'calc(env(safe-area-inset-top, 0px) + 64px)' }
    : { right: panel ? PANEL_W : 0, top: 0, bottom: 96 }

  return (
    <TooltipProvider delayDuration={400}>
      <Splash label="Loading">
        <path pathLength={1} d="M5 11V7a2 2 0 0 1 2-2h4" />
        <path pathLength={1} d="M21 5h4a2 2 0 0 1 2 2v4" />
        <path pathLength={1} d="M27 21v4a2 2 0 0 1-2 2h-4" />
        <path pathLength={1} d="M11 27H7a2 2 0 0 1-2-2v-4" />
        <path pathLength={1} d="M10 16h12" />
      </Splash>

      {/* Camera: full bleed, behind everything */}
      <div className={cn('fixed inset-0 bg-background', phase !== 'camera' && 'invisible')}>
        <video ref={video} playsInline muted autoPlay className="absolute inset-0 size-full object-contain" />
        <canvas ref={overlay} className="absolute inset-0 size-full" />
        {camError && (
          <div className="absolute inset-0 grid place-items-center">
            <div className="panel flex flex-col items-center gap-3 rounded-2xl p-5 text-sm">
              <span>{camError}</span>
              <Button variant="secondary" onClick={() => fileInput.current?.click()}>
                <Upload className="size-4" strokeWidth={1.5} /> Photo
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* Result */}
      {phase === 'result' && (
        <main className="fixed inset-x-0 grid place-items-center p-4 transition-[right,bottom] duration-200" style={stageStyle}>
          <canvas
            ref={stage}
            aria-label="Ink only"
            className={cn('max-h-full max-w-full rounded-sm bg-foreground object-contain', view !== 'ink' && 'hidden')}
          />
          {view === 'text' && (
            <div className="panel size-full max-w-2xl overflow-y-auto rounded-2xl p-5">
              {reading.state === 'error' ? (
                <div className="flex flex-col items-start gap-3 text-sm">
                  <span className="text-muted-foreground">{reading.error}</span>
                  {apiKey
                    ? <Button variant="secondary" onClick={() => void read()}>Try again</Button>
                    : <Button variant="secondary" onClick={() => setPanel('settings')}>Settings</Button>}
                </div>
              ) : (
                <pre className="font-sans text-sm leading-relaxed whitespace-pre-wrap">
                  {reading.text || <span className="text-muted-foreground">Reading…</span>}
                </pre>
              )}
            </div>
          )}
        </main>
      )}

      <PanelRail panels={panels} open={panel} onToggle={id => setPanel(panel === id ? null : id)} phone={phone} />

      <PanelSheet open={panel !== null} title={current?.label} onClose={() => setPanel(null)} phone={phone}>
        {panel === 'scan' && (
          <FieldGroup>
            <Field label="Crop to">
              <Segmented label="Crop to" value={crop} onChange={setCrop} options={[
                { value: 'outer', label: 'Outer' },
                { value: 'center', label: 'Centres' },
                { value: 'inner', label: 'Inner' },
              ]} />
            </Field>
            <Field label="Auto capture">
              <OnOff label="Auto capture" value={auto} onChange={setAuto} />
            </Field>
          </FieldGroup>
        )}
        {panel === 'settings' && (
          <FieldGroup>
            <Field label="Claude API key">
              <Input
                type="password"
                autoComplete="off"
                placeholder="sk-ant-…"
                value={apiKey}
                onChange={e => {
                  setApiKey(e.target.value)
                  try { localStorage.setItem(KEY, e.target.value) } catch { /* private mode */ }
                }}
              />
            </Field>
          </FieldGroup>
        )}
        {panel === 'export' && (<>
          <FieldGroup>
            <Field label="Background">
              <Segmented label="Background" value={background} onChange={setBackground} options={[
                { value: 'paper', label: 'White' },
                { value: 'clear', label: 'Clear' },
              ]} />
            </Field>
          </FieldGroup>
          <FieldGroup>
            <Button variant="secondary" disabled={phase !== 'result'} onClick={async () => { const b = await exportInk(); if (b) await saveFile(b as Blob, `scan-${stamp()}.png`) }}>Image</Button>
            <Button variant="secondary" disabled={!reading.text} onClick={() => saveFile(new Blob([reading.text], { type: 'text/plain' }), `scan-${stamp()}.txt`)}>Text</Button>
            <Button variant="secondary" disabled={phase !== 'result'} onClick={async () => { await emailScan((await exportInk()) as Blob | null, reading.text) }}>Email</Button>
            <Button variant="secondary" disabled={phase !== 'result'} onClick={async () => { const p = await exportInk(true); if (p) await saveFile(await thumbnail(p as HTMLCanvasElement), 'thumbnail.png') }}>Thumbnail</Button>
          </FieldGroup>
        </>)}
      </PanelSheet>

      <ActionDock phone={phone} panelOpen={panel !== null}>
        {notice && <div className="text-xs text-muted-foreground" role="alert">{notice}</div>}
        {phase === 'camera' && !camError && !notice && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground" role="status">
            <span className="flex gap-1">
              {[0, 1, 2, 3].map(i => <i key={i} className={cn('size-1.5 rounded-full', i < found ? 'bg-foreground' : 'bg-muted')} />)}
            </span>
            {ready ? (auto ? 'Hold steady' : 'Ready') : `${found} of 4`}
          </div>
        )}
        <Toolbar aria-label="Actions">
          {phase === 'camera' ? (<>
            <ToolButton icon={Camera} label="Capture" side="top" disabled={!ready} onClick={capture} className={cn(ready && 'bg-primary text-primary-foreground hover:bg-primary', !ready && 'opacity-40')} />
            <ToolButton icon={Upload} label="Your photo" side="top" onClick={() => fileInput.current?.click()} />
          </>) : (<>
            <div className="w-40">
              <Segmented label="View" size="lg" value={view} onChange={setView} options={[{ value: 'ink', label: 'Ink' }, { value: 'text', label: 'Text' }]} />
            </div>
            <ToolbarSeparator />
            <ToolButton icon={Copy} label="Copy text" side="top" disabled={!reading.text} onClick={() => navigator.clipboard?.writeText(reading.text)} />
            <ToolButton icon={Camera} label="New scan" side="top" onClick={() => { abort.current?.abort(); setReading({ state: 'idle', text: '' }); shot.current = null; setPhase('camera') }} />
          </>)}
        </Toolbar>
      </ActionDock>

      <input ref={fileInput} type="file" accept="image/*" hidden aria-label="Your photo" onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void fromFile(f) }} />

      {busy && <div className="fixed inset-0 z-50 grid place-items-center bg-background/60 text-sm" role="status">Straightening</div>}
    </TooltipProvider>
  )
}
