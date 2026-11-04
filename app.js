(function () {
  'use strict';
  const S = window.MarkerScanner;
  const $ = id => document.getElementById(id);
  const video = $('video'), overlay = $('overlay'), octx = overlay.getContext('2d');
  const shutter = $('shutter'), statusText = $('statusText'), dots = [...document.querySelectorAll('.dots i')];
  const DETECT_DIM = 480;     // live detection resolution
  const CAPTURE_DETECT_DIM = 800;

  const small = document.createElement('canvas');
  const sctx = small.getContext('2d', { willReadFrequently: true });

  let stream = null, running = false, lastFour = null, lastScale = 1, stable = 0, autoOn = false, capturing = false;
  let captured = null; // { full: ImageData, detect: ImageData, scale, fallbackFour }
  let cropMode = 'outer', enhanceOn = false;

  // ---------- camera ----------
  async function startCamera() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      return showMsg('Camera unavailable', 'Live camera needs HTTPS and a supporting browser. You can still take or upload a photo.');
    }
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } }
      });
      video.srcObject = stream;
      await video.play();
      running = true;
      statusText.textContent = 'Point at the 4 markers';
      requestAnimationFrame(loop);
    } catch (e) {
      showMsg('Camera blocked', 'Allow camera access, or take/upload a photo instead. (' + (e.name || e) + ')');
    }
  }
  function stopCamera() { running = false; }

  function showMsg(t, p) { $('msgTitle').textContent = t; $('msgText').textContent = p; $('msg').classList.add('show'); statusText.textContent = 'Photo mode'; }

  // object-fit: contain mapping from video px -> overlay css px
  function coverMap() {
    const cw = overlay.clientWidth, ch = overlay.clientHeight, vw = video.videoWidth, vh = video.videoHeight;
    const s = Math.min(cw / vw, ch / vh); // matches object-fit: contain
    return { s, ox: (cw - vw * s) / 2, oy: (ch - vh * s) / 2 };
  }

  let lastT = 0;
  function loop(t) {
    if (!running) return;
    requestAnimationFrame(loop);
    if (t - lastT < 60 || !video.videoWidth || capturing) return; // ~15 fps
    lastT = t;
    const vw = video.videoWidth, vh = video.videoHeight;
    const sc = DETECT_DIM / Math.max(vw, vh);
    small.width = Math.round(vw * sc); small.height = Math.round(vh * sc);
    sctx.drawImage(video, 0, 0, small.width, small.height);
    const img = sctx.getImageData(0, 0, small.width, small.height);
    const markers = S.detectMarkers(img);
    const four = S.selectFour(markers);
    draw(markers, four, 1 / sc);

    const found = four ? 4 : Math.min(4, markers.length);
    dots.forEach((d, i) => d.classList.toggle('on', i < found));
    shutter.disabled = !four; shutter.classList.toggle('ready', !!four);
    statusText.textContent = four ? (autoOn ? 'Hold steady…' : 'Ready — tap to capture') : `Found ${found} of 4 markers`;

    if (four) {
      const corners = four.map(m => m.center);
      if (lastFour) {
        const move = Math.max(...corners.map((c, i) => Math.hypot(c.x - lastFour[i].center.x, c.y - lastFour[i].center.y)));
        stable = move < small.width * 0.012 ? stable + 1 : 0;
      }
      lastFour = four; lastScale = 1 / sc;
      if (autoOn && stable >= 10) { stable = 0; capture(); }
    } else { lastFour = null; stable = 0; }
  }

  function draw(markers, four, toVideo) {
    const dpr = window.devicePixelRatio || 1;
    if (overlay.width !== overlay.clientWidth * dpr) { overlay.width = overlay.clientWidth * dpr; overlay.height = overlay.clientHeight * dpr; }
    octx.setTransform(dpr, 0, 0, dpr, 0, 0);
    octx.clearRect(0, 0, overlay.clientWidth, overlay.clientHeight);
    const { s, ox, oy } = coverMap();
    const P = p => [p.x * toVideo * s + ox, p.y * toVideo * s + oy];
    const poly = (pts, close) => { octx.beginPath(); pts.forEach((p, i) => { const [x, y] = P(p); i ? octx.lineTo(x, y) : octx.moveTo(x, y); }); if (close) octx.closePath(); };

    if (four) {
      const bc = S.boardCorners(four, cropMode);
      poly(bc, true);
      octx.fillStyle = 'rgba(61,220,132,.16)'; octx.fill();
      octx.lineWidth = 3; octx.strokeStyle = '#3ddc84'; octx.stroke();
    }
    const inFour = new Set(four || []);
    for (const m of markers) {
      poly(m.corners, true);
      octx.lineWidth = 3;
      octx.strokeStyle = inFour.has(m) ? '#3ddc84' : '#ffb020';
      octx.stroke();
    }
    if (four) {
      const labels = ['TL', 'TR', 'BR', 'BL'];
      octx.font = '600 13px system-ui'; octx.fillStyle = '#fff';
      four.forEach((m, i) => { const [x, y] = P(m.center); octx.fillText(labels[i], x - 9, y + 4); });
    }
  }

  // ---------- capture ----------
  function imageDataFrom(source, w, h, maxDim) {
    const sc = maxDim ? Math.min(1, maxDim / Math.max(w, h)) : 1;
    const c = document.createElement('canvas');
    c.width = Math.round(w * sc); c.height = Math.round(h * sc);
    const x = c.getContext('2d', { willReadFrequently: true });
    x.drawImage(source, 0, 0, c.width, c.height);
    return { img: x.getImageData(0, 0, c.width, c.height), scale: 1 / sc };
  }

  function flash() { const f = $('flash'); f.style.transition = 'none'; f.style.opacity = '.8'; requestAnimationFrame(() => { f.style.transition = 'opacity .3s'; f.style.opacity = '0'; }); }

  async function capture() {
    if (capturing || !video.videoWidth) return;
    capturing = true; flash();
    const vw = video.videoWidth, vh = video.videoHeight;
    const full = imageDataFrom(video, vw, vh).img;
    const det = imageDataFrom(video, vw, vh, CAPTURE_DETECT_DIM);
    const fallback = lastFour ? { four: lastFour, scale: lastScale } : null;
    await processCapture(full, det.img, det.scale, fallback);
    capturing = false;
  }

  async function processPhoto(file) {
    $('busy').classList.add('show');
    try {
      const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }).catch(() => null) || await loadImg(file);
      const w = bmp.width, h = bmp.height;
      // cap full res to keep memory sane on phones
      const fullR = imageDataFrom(bmp, w, h, 4000);
      const det = imageDataFrom(bmp, w, h, CAPTURE_DETECT_DIM);
      const ok = await processCapture(fullR.img, det.img, det.scale / fullR.scale, null);
      if (!ok) alert('Could not find all 4 markers in that photo. Make sure every corner marker is fully in frame.');
    } finally { $('busy').classList.remove('show'); }
  }
  function loadImg(file) {
    return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = URL.createObjectURL(file); });
  }

  async function processCapture(full, detect, scale, fallback) {
    let four = S.selectFour(S.detectMarkers(detect));
    let fourScale = scale;
    if (!four && fallback) { four = fallback.four; fourScale = fallback.scale; }
    if (!four) return false;
    captured = { full, four, fourScale };
    stopCamera();
    show('result');
    await render();
    return true;
  }

  async function render() {
    if (!captured) return;
    $('busy').classList.add('show');
    await new Promise(r => setTimeout(r, 30)); // let the overlay paint
    const { full, four, fourScale } = captured;
    const corners = S.boardCorners(four, cropMode).map(p => ({ x: p.x * fourScale, y: p.y * fourScale }));
    const aspect = S.estimateAspect(corners, full.width, full.height);
    const [tl, tr, br, bl] = corners;
    const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
    let outH = Math.max(Math.max(d(tl, bl), d(tr, br)), Math.max(d(tl, tr), d(bl, br)) / aspect);
    let outW = outH * aspect;
    const k = Math.min(1, 2400 / Math.max(outW, outH));
    outW = Math.round(outW * k); outH = Math.round(outH * k);
    const img = S.warp(full, corners, outW, outH);
    if (enhanceOn) S.enhance(img);
    const out = $('out');
    out.width = outW; out.height = outH;
    out.getContext('2d').putImageData(img, 0, 0);
    $('busy').classList.remove('show');
  }

  function show(id) { document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === id)); }

  // ---------- save ----------
  async function save() {
    const blob = await new Promise(r => $('out').toBlob(r, 'image/jpeg', 0.92));
    const name = 'scan-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + '.jpg';
    const file = new File([blob], name, { type: 'image/jpeg' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: 'Scan' }); return; } catch (e) { if (e.name === 'AbortError') return; }
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  // ---------- wiring ----------
  shutter.addEventListener('click', capture);
  $('autoBtn').addEventListener('click', e => { autoOn = !autoOn; e.currentTarget.setAttribute('aria-pressed', autoOn); stable = 0; });
  const pick = () => $('file').click();
  $('photoBtn').addEventListener('click', pick);
  $('msgPhoto').addEventListener('click', pick);
  $('file').addEventListener('change', e => { const f = e.target.files[0]; e.target.value = ''; if (f) processPhoto(f); });
  $('retake').addEventListener('click', () => {
    captured = null; show('camera');
    if (stream) { running = true; requestAnimationFrame(loop); }
  });
  $('save').addEventListener('click', save);
  function seg(id, fn) {
    $(id).addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b) return;
      $(id).querySelectorAll('button').forEach(x => x.setAttribute('aria-pressed', x === b));
      fn(b.dataset.v);
    });
  }
  seg('cropSeg', v => { cropMode = v; render(); });
  seg('enhSeg', v => { enhanceOn = v === '1'; render(); });

  startCamera();
})();
