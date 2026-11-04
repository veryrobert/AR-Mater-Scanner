/*
 * AR Marker Scanner — dependency-free marker detection + perspective rectification.
 *
 * Markers: a thick dark square frame with a dark glyph inside (and usually a
 * blue sticky note behind it). Four of them mark the corners of the area to
 * capture. Pipeline:
 *   1. grayscale + adaptive threshold (integral-image local mean)
 *   2. connected components on dark pixels
 *   3. for each component: convex hull -> best-fit quad, then check that it is
 *      a square-ish *ring* (frame) with a dark glyph in its middle
 *   4. choose the best 4 markers, order them TL, TR, BR, BL
 *   5. estimate the real aspect ratio and warp with a homography
 */

  // ---------- small geometry helpers ----------
  const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });
  const cross2 = (a, b) => a.x * b.y - a.y * b.x;
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

  function polyArea(pts) {
    let s = 0;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i], q = pts[(i + 1) % pts.length];
      s += p.x * q.y - q.x * p.y;
    }
    return Math.abs(s) / 2;
  }

  function convexHull(points) {
    const pts = points.slice().sort((a, b) => a.x - b.x || a.y - b.y);
    if (pts.length < 3) return pts;
    const lower = [], upper = [];
    for (const p of pts) {
      while (lower.length >= 2 && cross2(sub(lower[lower.length - 1], lower[lower.length - 2]), sub(p, lower[lower.length - 1])) <= 0) lower.pop();
      lower.push(p);
    }
    for (let i = pts.length - 1; i >= 0; i--) {
      const p = pts[i];
      while (upper.length >= 2 && cross2(sub(upper[upper.length - 1], upper[upper.length - 2]), sub(p, upper[upper.length - 1])) <= 0) upper.pop();
      upper.push(p);
    }
    upper.pop(); lower.pop();
    return lower.concat(upper);
  }

  // Approximate largest-area quadrilateral using hull vertices:
  // seed with farthest-point heuristic, then refine each vertex in turn.
  function hullToQuad(hull) {
    const n = hull.length;
    if (n < 4) return null;
    if (n === 4) return hull.slice();
    const c = { x: 0, y: 0 };
    hull.forEach(p => { c.x += p.x / n; c.y += p.y / n; });
    let i1 = 0;
    hull.forEach((p, i) => { if (dist(p, c) > dist(hull[i1], c)) i1 = i; });
    let i2 = 0;
    hull.forEach((p, i) => { if (dist(p, hull[i1]) > dist(hull[i2], hull[i1])) i2 = i; });
    const a = hull[i1], b = hull[i2];
    let i3 = -1, i4 = -1, s3 = 0, s4 = 0;
    hull.forEach((p, i) => {
      const s = cross2(sub(b, a), sub(p, a));
      if (s > s3) { s3 = s; i3 = i; }
      if (s < s4) { s4 = s; i4 = i; }
    });
    if (i3 < 0 || i4 < 0) return null;
    let idx = [i1, i3, i2, i4].sort((x, y) => x - y);
    const area = ids => polyArea(ids.map(i => hull[i]));
    for (let round = 0; round < 3; round++) {
      let improved = false;
      for (let k = 0; k < 4; k++) {
        const lo = idx[(k + 3) % 4], hi = idx[(k + 1) % 4];
        let best = idx[k], bestA = area(idx);
        for (let j = (lo + 1) % n; j !== hi; j = (j + 1) % n) {
          const t = idx.slice(); t[k] = j;
          const A = area(t);
          if (A > bestA + 1e-9) { bestA = A; best = j; }
        }
        if (best !== idx[k]) { idx[k] = best; improved = true; }
      }
      if (!improved) break;
    }
    return idx.map(i => hull[i]);
  }

  // Bilinear point inside quad (q in order around the quad), u,v in [0,1].
  function quadPoint(q, u, v) {
    const ax = q[0].x + (q[1].x - q[0].x) * u, ay = q[0].y + (q[1].y - q[0].y) * u;
    const bx = q[3].x + (q[2].x - q[3].x) * u, by = q[3].y + (q[2].y - q[3].y) * u;
    return { x: ax + (bx - ax) * v, y: ay + (by - ay) * v };
  }

  // ---------- image prep ----------
  function toGray(img) {
    const { data, width, height } = img;
    const g = new Uint8ClampedArray(width * height);
    for (let i = 0, j = 0; j < g.length; i += 4, j++) {
      g[j] = (data[i] * 77 + data[i + 1] * 150 + data[i + 2] * 29) >> 8;
    }
    return g;
  }

  function adaptiveThreshold(gray, w, h, radius, k) {
    const W = w + 1;
    const integ = new Float64Array(W * (h + 1));
    for (let y = 0; y < h; y++) {
      let row = 0;
      for (let x = 0; x < w; x++) {
        row += gray[y * w + x];
        integ[(y + 1) * W + x + 1] = integ[y * W + x + 1] + row;
      }
    }
    const bin = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      const y0 = Math.max(0, y - radius), y1 = Math.min(h, y + radius + 1);
      for (let x = 0; x < w; x++) {
        const x0 = Math.max(0, x - radius), x1 = Math.min(w, x + radius + 1);
        const sum = integ[y1 * W + x1] - integ[y0 * W + x1] - integ[y1 * W + x0] + integ[y0 * W + x0];
        const mean = sum / ((x1 - x0) * (y1 - y0));
        const v = gray[y * w + x];
        bin[y * w + x] = (v < mean * (1 - k) && v < 150) ? 1 : 0;
      }
    }
    return bin;
  }

  function label(bin, w, h) {
    const labels = new Int32Array(w * h);
    const comps = [];
    const stack = new Int32Array(w * h);
    let next = 1;
    for (let start = 0; start < bin.length; start++) {
      if (!bin[start] || labels[start]) continue;
      const id = next++;
      let sp = 0, count = 0, minx = w, maxx = 0, miny = h, maxy = 0;
      stack[sp++] = start; labels[start] = id;
      while (sp) {
        const p = stack[--sp];
        const x = p % w, y = (p - x) / w;
        count++;
        if (x < minx) minx = x; if (x > maxx) maxx = x;
        if (y < miny) miny = y; if (y > maxy) maxy = y;
        // 8-connectivity
        for (let dy = -1; dy <= 1; dy++) {
          const ny = y + dy; if (ny < 0 || ny >= h) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx; if (nx < 0 || nx >= w) continue;
            const q = ny * w + nx;
            if (bin[q] && !labels[q]) { labels[q] = id; stack[sp++] = q; }
          }
        }
      }
      comps.push({ id, count, minx, maxx, miny, maxy });
    }
    return { labels, comps };
  }

  // ---------- marker detection ----------
  function detectMarkers(img, opts) {
    opts = opts || {};
    const { width: w, height: h, data } = img;
    const gray = toGray(img);
    const minDim = Math.min(w, h);
    const radius = Math.max(8, Math.round(Math.max(w, h) / 32));
    const bin = adaptiveThreshold(gray, w, h, radius, opts.k ?? 0.22);
    const { labels, comps } = label(bin, w, h);

    const minSide = Math.max(10, minDim * 0.015);
    const maxSide = minDim * 0.45;
    const out = [];
    const dbg = opts.debug;
    const rej = (c, why) => { if (dbg) dbg.push({ x: (c.minx + c.maxx) / 2, y: (c.miny + c.maxy) / 2, why }); };

    for (const c of comps) {
      const bw = c.maxx - c.minx + 1, bh = c.maxy - c.miny + 1;
      if (bw < minSide || bh < minSide || bw > maxSide || bh > maxSide) continue;
      if (c.count < 40) continue;
      if (Math.max(bw, bh) / Math.min(bw, bh) > 3) { rej(c, 'bbox aspect'); continue; }

      // Row extremes -> hull
      const edge = [];
      for (let y = c.miny; y <= c.maxy; y++) {
        let l = -1, r = -1;
        const row = y * w;
        for (let x = c.minx; x <= c.maxx; x++) if (labels[row + x] === c.id) { if (l < 0) l = x; r = x; }
        if (l >= 0) { edge.push({ x: l, y }); edge.push({ x: r + 1, y }); edge.push({ x: l, y: y + 1 }); edge.push({ x: r + 1, y: y + 1 }); }
      }
      const hull = convexHull(edge);
      const quad = hullToQuad(hull);
      if (!quad) continue;
      const qArea = polyArea(quad), hArea = polyArea(hull);
      if (qArea < minSide * minSide) continue;
      if (qArea / hArea < 0.84) { rej(c, '(qArea / hArea < 0.84)'); continue; } // outline isn't a quadrilateral

      const sides = [0, 1, 2, 3].map(i => dist(quad[i], quad[(i + 1) % 4]));
      if (Math.max(...sides) / Math.min(...sides) > 2.5) { rej(c, '(Math.max(...sides) / Math.min(...sides) > 2.5)'); continue; }
      // diagonals roughly similar (rules out thin parallelograms)
      const d1 = dist(quad[0], quad[2]), d2 = dist(quad[1], quad[3]);
      if (Math.max(d1, d2) / Math.min(d1, d2) > 1.8) { rej(c, '(Math.max(d1, d2) / Math.min(d1, d2) > 1.8)'); continue; }

      const fill = c.count / qArea; // frame ring ~0.25-0.6
      if (fill < 0.15 || fill > 0.75) { rej(c, '(fill < 0.15 || fill > 0.75)'); continue; }

      // Sample the quad interior on a grid
      let ownCenter = 0, darkCenter = 0, nCenter = 0, ownEdge = 0, nEdge = 0, lightGap = 0, nGap = 0;
      const N = 16;
      for (let iy = 0; iy < N; iy++) {
        for (let ix = 0; ix < N; ix++) {
          const u = (ix + 0.5) / N, v = (iy + 0.5) / N;
          const p = quadPoint(quad, u, v);
          const px = Math.min(w - 1, Math.max(0, Math.round(p.x)));
          const py = Math.min(h - 1, Math.max(0, Math.round(p.y)));
          const idx = py * w + px;
          const m = Math.max(Math.abs(u - 0.5), Math.abs(v - 0.5)); // 0 centre .. 0.5 edge
          if (m < 0.22) {
            nCenter++;
            if (labels[idx] === c.id) ownCenter++;
            else if (bin[idx]) darkCenter++;
          } else if (m > 0.44) {
            nEdge++;
            let hit = false;
            for (let dy = -1; dy <= 1 && !hit; dy++) for (let dx = -1; dx <= 1; dx++) {
              const X = px + dx, Y = py + dy;
              if (X >= 0 && Y >= 0 && X < w && Y < h && labels[Y * w + X] === c.id) { hit = true; break; }
            }
            if (hit) ownEdge++;
          }
          if (m > 0.22 && m < 0.44) { nGap++; if (labels[idx] !== c.id) lightGap++; }
        }
      }
      const ownC = ownCenter / nCenter, darkC = darkCenter / nCenter, edgeF = ownEdge / nEdge, gapF = lightGap / nGap;
      // The glyph may be its own component or, where it touches the frame, part of it
      const glyph = ownC + darkC;
      if (ownC > 0.6) { rej(c, '(ownC > 0.6)'); continue; }              // must be a ring, not a blob
      if (edgeF < 0.5) { rej(c, '(edgeF < 0.5)'); continue; }            // border must be mostly solid
      if (glyph < 0.12 || glyph > 0.95) { rej(c, '(glyph < 0.12 || glyph > 0.95)'); continue; } // glyph inside
      if (gapF < (ownC > 0.08 ? 0.4 : 0.25)) { rej(c, '(gapF too low)'); continue; } // a touching glyph needs a clear gap elsewhere

      // Blue backing (soft score): sample a band just outside the frame
      let blue = 0, nb = 0;
      const cx = (quad[0].x + quad[1].x + quad[2].x + quad[3].x) / 4;
      const cy = (quad[0].y + quad[1].y + quad[2].y + quad[3].y) / 4;
      for (let t = 0; t < 1; t += 1 / 24) {
        for (let s = 0; s < 4; s++) {
          const a = quad[s], b = quad[(s + 1) % 4];
          const p = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
          const ox = Math.round(cx + (p.x - cx) * 1.18), oy = Math.round(cy + (p.y - cy) * 1.18);
          if (ox < 0 || oy < 0 || ox >= w || oy >= h) continue;
          const i4 = (oy * w + ox) * 4;
          const r = data[i4], g = data[i4 + 1], bl = data[i4 + 2];
          nb++;
          if (bl - r > 35 && bl >= g - 10) blue++;
        }
      }
      const blueF = nb ? blue / nb : 0;

      // Orient quad clockwise (y-down) starting from top-left-most corner
      let q = quad.slice();
      if (cross2(sub(q[1], q[0]), sub(q[2], q[1])) < 0) q.reverse();
      let si = 0;
      for (let i = 1; i < 4; i++) if (q[i].x + q[i].y < q[si].x + q[si].y) si = i;
      q = q.slice(si).concat(q.slice(0, si));

      const size = Math.sqrt(qArea);
      const score = edgeF + gapF * 0.5 + (1 - ownC) * 0.5 + blueF * 1.5 + (glyph > 0.25 && glyph < 0.8 ? 0.5 : 0);
      out.push({ corners: q, center: { x: cx, y: cy }, size, score, blue: blueF });
    }

    // Remove nested / duplicate detections (keep the larger)
    out.sort((a, b) => b.size - a.size);
    const kept = [];
    for (const m of out) {
      if (kept.some(k => dist(k.center, m.center) < k.size * 0.6)) continue;
      kept.push(m);
    }
    return kept;
  }

  // ---------- choose 4 & order ----------
  function orderFour(ms) {
    const c = { x: 0, y: 0 };
    ms.forEach(m => { c.x += m.center.x / 4; c.y += m.center.y / 4; });
    const sorted = ms.slice().sort((a, b) =>
      Math.atan2(a.center.y - c.y, a.center.x - c.x) - Math.atan2(b.center.y - c.y, b.center.x - c.x));
    // sorted is clockwise in y-down coords; start at top-left (min x+y)
    let si = 0;
    for (let i = 1; i < 4; i++) if (sorted[i].center.x + sorted[i].center.y < sorted[si].center.x + sorted[si].center.y) si = i;
    return sorted.slice(si).concat(sorted.slice(0, si)); // TL, TR, BR, BL
  }

  function selectFour(markers) {
    if (markers.length < 4) return null;
    const cand = markers.slice().sort((a, b) => b.score - a.score).slice(0, 10);
    let best = null, bestScore = -Infinity;
    const n = cand.length;
    for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) for (let c = b + 1; c < n; c++) for (let d = c + 1; d < n; d++) {
      const set = [cand[a], cand[b], cand[c], cand[d]];
      const ord = orderFour(set);
      const pts = ord.map(m => m.center);
      // must be convex
      let sign = 0, ok = true;
      for (let i = 0; i < 4; i++) {
        const cr = cross2(sub(pts[(i + 1) % 4], pts[i]), sub(pts[(i + 2) % 4], pts[(i + 1) % 4]));
        if (i === 0) sign = Math.sign(cr); else if (Math.sign(cr) !== sign) { ok = false; break; }
      }
      if (!ok) continue;
      const sizes = set.map(m => m.size);
      const sim = Math.min(...sizes) / Math.max(...sizes);
      if (sim < 0.3) continue;
      const area = polyArea(pts);
      const meanSize = sizes.reduce((s, v) => s + v, 0) / 4;
      if (area < meanSize * meanSize * 9) continue; // markers must be spread out
      const s = set.reduce((t, m) => t + m.score, 0) + sim * 2 + Math.min(1, area / (meanSize * meanSize * 200));
      if (s > bestScore) { bestScore = s; best = ord; }
    }
    return best;
  }

  /** corner mode: 'outer' | 'center' | 'inner' */
  function boardCorners(four, mode) {
    if (mode === 'center') return four.map(m => ({ ...m.center }));
    const g = { x: 0, y: 0 };
    four.forEach(m => { g.x += m.center.x / 4; g.y += m.center.y / 4; });
    return four.map(m => {
      let best = m.corners[0], bd = mode === 'inner' ? Infinity : -Infinity;
      for (const p of m.corners) {
        const d = dist(p, g);
        if (mode === 'inner' ? d < bd : d > bd) { bd = d; best = p; }
      }
      return { ...best };
    });
  }

  // ---------- aspect ratio (Zhang & He, "Whiteboard scanning and image enhancement") ----------
  function estimateAspect(corners, imgW, imgH) {
    const [tl, tr, br, bl] = corners;
    const fallback = ((dist(tl, tr) + dist(bl, br)) / 2) / ((dist(tl, bl) + dist(tr, br)) / 2);
    const u0 = imgW / 2, v0 = imgH / 2;
    const P = p => [p.x - u0, p.y - v0, 1];
    const m1 = P(tl), m2 = P(tr), m3 = P(bl), m4 = P(br);
    const cr = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const k2 = dot(cr(m1, m4), m3) / dot(cr(m2, m4), m3);
    const k3 = dot(cr(m1, m4), m2) / dot(cr(m3, m4), m2);
    const n2 = m2.map((v, i) => k2 * v - m1[i]);
    const n3 = m3.map((v, i) => k3 * v - m1[i]);
    const eps = 1e-6;
    if (Math.abs(n2[2]) < eps || Math.abs(n3[2]) < eps) return fallback; // nearly fronto-parallel
    const f2 = -(n2[0] * n3[0] + n2[1] * n3[1]) / (n2[2] * n3[2]);
    if (!(f2 > 0)) return fallback;
    const f = Math.sqrt(f2);
    // Sanity: plausible phone focal length (0.4x .. 4x the larger image dimension)
    const D = Math.max(imgW, imgH);
    if (f < 0.4 * D || f > 4 * D) return fallback;
    const r = Math.sqrt((n2[0] ** 2 + n2[1] ** 2 + f2 * n2[2] ** 2) / (n3[0] ** 2 + n3[1] ** 2 + f2 * n3[2] ** 2));
    if (!isFinite(r) || r <= 0 || r / fallback > 2 || fallback / r > 2) return fallback;
    return r;
  }

  // ---------- homography + warp ----------
  function solve(A, b) {
    const n = b.length;
    for (let i = 0; i < n; i++) {
      let p = i;
      for (let r = i + 1; r < n; r++) if (Math.abs(A[r][i]) > Math.abs(A[p][i])) p = r;
      [A[i], A[p]] = [A[p], A[i]]; [b[i], b[p]] = [b[p], b[i]];
      for (let r = i + 1; r < n; r++) {
        const f = A[r][i] / A[i][i];
        for (let c = i; c < n; c++) A[r][c] -= f * A[i][c];
        b[r] -= f * b[i];
      }
    }
    const x = new Array(n);
    for (let i = n - 1; i >= 0; i--) {
      let s = b[i];
      for (let c = i + 1; c < n; c++) s -= A[i][c] * x[c];
      x[i] = s / A[i][i];
    }
    return x;
  }

  // Homography mapping src[i] -> dst[i]
  function homography(src, dst) {
    const A = [], b = [];
    for (let i = 0; i < 4; i++) {
      const { x, y } = src[i], { x: X, y: Y } = dst[i];
      A.push([x, y, 1, 0, 0, 0, -X * x, -X * y]); b.push(X);
      A.push([0, 0, 0, x, y, 1, -Y * x, -Y * y]); b.push(Y);
    }
    const h = solve(A, b);
    return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
  }

  /** Warp src ImageData so that `corners` (TL,TR,BR,BL in src px) fill an outW x outH image. */
  function warp(src, corners, outW, outH) {
    const H = homography([{ x: 0, y: 0 }, { x: outW, y: 0 }, { x: outW, y: outH }, { x: 0, y: outH }], corners);
    const sw = src.width, sh = src.height, sd = src.data;
    const out = new ImageData(outW, outH);
    const od = out.data;
    let o = 0;
    for (let y = 0; y < outH; y++) {
      const yy = y + 0.5;
      for (let x = 0; x < outW; x++, o += 4) {
        const xx = x + 0.5;
        const z = H[6] * xx + H[7] * yy + 1;
        const sx = (H[0] * xx + H[1] * yy + H[2]) / z - 0.5;
        const sy = (H[3] * xx + H[4] * yy + H[5]) / z - 0.5;
        const x0 = Math.floor(sx), y0 = Math.floor(sy);
        if (x0 < 0 || y0 < 0 || x0 >= sw - 1 || y0 >= sh - 1) { od[o + 3] = 255; continue; }
        const fx = sx - x0, fy = sy - y0;
        const i00 = (y0 * sw + x0) * 4, i10 = i00 + 4, i01 = i00 + sw * 4, i11 = i01 + 4;
        const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;
        od[o] = sd[i00] * w00 + sd[i10] * w10 + sd[i01] * w01 + sd[i11] * w11;
        od[o + 1] = sd[i00 + 1] * w00 + sd[i10 + 1] * w10 + sd[i01 + 1] * w01 + sd[i11 + 1] * w11;
        od[o + 2] = sd[i00 + 2] * w00 + sd[i10 + 2] * w10 + sd[i01 + 2] * w01 + sd[i11 + 2] * w11;
        od[o + 3] = 255;
      }
    }
    return out;
  }

  /** Flatten uneven lighting so paper becomes white (in place). */
  function enhance(img) {
    const { width: w, height: h, data: d } = img;
    const B = Math.max(16, Math.round(Math.max(w, h) / 48));
    const gw = Math.ceil(w / B), gh = Math.ceil(h / B);
    const bg = new Float32Array(gw * gh * 3);
    // per-block bright estimate: 90th-ish percentile via max of channel-sum sampled
    for (let by = 0; by < gh; by++) for (let bx = 0; bx < gw; bx++) {
      const hist = [];
      for (let y = by * B; y < Math.min(h, (by + 1) * B); y += 2) for (let x = bx * B; x < Math.min(w, (bx + 1) * B); x += 2) {
        const i = (y * w + x) * 4;
        hist.push([d[i] + d[i + 1] + d[i + 2], d[i], d[i + 1], d[i + 2]]);
      }
      hist.sort((a, b) => a[0] - b[0]);
      const p = hist[Math.floor(hist.length * 0.9)] || [0, 255, 255, 255];
      const j = (by * gw + bx) * 3;
      bg[j] = p[1]; bg[j + 1] = p[2]; bg[j + 2] = p[3];
    }
    // smooth background grid (3x3 box, twice)
    for (let pass = 0; pass < 2; pass++) {
      const copy = bg.slice();
      for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) for (let c = 0; c < 3; c++) {
        let s = 0, n = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const X = x + dx, Y = y + dy;
          if (X < 0 || Y < 0 || X >= gw || Y >= gh) continue;
          s += copy[(Y * gw + X) * 3 + c]; n++;
        }
        bg[(y * gw + x) * 3 + c] = s / n;
      }
    }
    for (let y = 0; y < h; y++) {
      const gy = Math.min(gh - 1, Math.max(0, (y + 0.5) / B - 0.5));
      const y0 = Math.floor(gy), y1 = Math.min(gh - 1, y0 + 1), fy = gy - y0;
      for (let x = 0; x < w; x++) {
        const gx = Math.min(gw - 1, Math.max(0, (x + 0.5) / B - 0.5));
        const x0 = Math.floor(gx), x1 = Math.min(gw - 1, x0 + 1), fx = gx - x0;
        const i = (y * w + x) * 4;
        for (let c = 0; c < 3; c++) {
          const b = (bg[(y0 * gw + x0) * 3 + c] * (1 - fx) + bg[(y0 * gw + x1) * 3 + c] * fx) * (1 - fy) +
                    (bg[(y1 * gw + x0) * 3 + c] * (1 - fx) + bg[(y1 * gw + x1) * 3 + c] * fx) * fy;
          let v = d[i + c] / Math.max(30, b);
          v = Math.min(1, v);
          v = Math.pow(v, 2.2); // deepen ink
          d[i + c] = v * 255;
        }
      }
    }
    return img;
  }

  /**
   * Full pipeline on a full-resolution ImageData-like source.
   * detectImg: downscaled ImageData used for detection; scale = full/detect.
   */
  function rectify(full, detectImg, scale, opts) {
    opts = opts || {};
    const markers = detectMarkers(detectImg);
    const four = selectFour(markers);
    if (!four) return { ok: false, markers };
    const corners = boardCorners(four, opts.cornerMode || 'outer').map(p => ({ x: p.x * scale, y: p.y * scale }));
    const aspect = estimateAspect(corners, full.width, full.height);
    const [tl, tr, br, bl] = corners;
    const hPx = Math.max(dist(tl, bl), dist(tr, br));
    const wPx = Math.max(dist(tl, tr), dist(bl, br));
    let outH = Math.max(hPx, wPx / aspect);
    let outW = outH * aspect;
    const maxDim = opts.maxDim || 2400;
    const s = Math.min(1, maxDim / Math.max(outW, outH));
    outW = Math.round(outW * s); outH = Math.round(outH * s);
    const img = warp(full, corners, outW, outH);
    if (opts.enhance) enhance(img);
    return { ok: true, image: img, corners, aspect, markers, four };
  }

  /**
   * Ink only: flatten the lighting, then keep the dark strokes and drop the paper.
   * Returns a new ImageData with transparent background (alpha = ink strength).
   */
  function inkOnly(img) {
    const out = new ImageData(new Uint8ClampedArray(img.data), img.width, img.height);
    enhance(out);
    const d = out.data;
    for (let i = 0; i < d.length; i += 4) {
      const L = (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) / 65280; // 0..1
      const a = Math.min(1, Math.max(0, (0.82 - L) / 0.32));
      // deepen the stroke colour a little so faint ink stays legible
      d[i] = d[i] * 0.7; d[i + 1] = d[i + 1] * 0.7; d[i + 2] = d[i + 2] * 0.7;
      d[i + 3] = a * 255;
    }
    return out;
  }

  /** Map points with a 3x3 homography (row-major, h[8] = 1). */
  function applyH(H, p) {
    const z = H[6] * p.x + H[7] * p.y + H[8];
    return { x: (H[0] * p.x + H[1] * p.y + H[2]) / z, y: (H[3] * p.x + H[4] * p.y + H[5]) / z };
  }

  /**
   * Where each marker (and the sticky note around it) lands in the warped output,
   * so it can be erased. corners: TL,TR,BR,BL board corners in source px.
   */
  function markerRegionsOut(four, scale, corners, outW, outH, grow) {
    const H = homography(corners, [{ x: 0, y: 0 }, { x: outW, y: 0 }, { x: outW, y: outH }, { x: 0, y: outH }]);
    const g = grow || 1.6;
    return four.map(m => m.corners.map(p => {
      const q = { x: (m.center.x + (p.x - m.center.x) * g) * scale, y: (m.center.y + (p.y - m.center.y) * g) * scale };
      return applyH(H, q);
    }));
  }

export { detectMarkers, selectFour, boardCorners, estimateAspect, homography, warp, enhance, inkOnly, markerRegionsOut, rectify };
