// cardDetector.js — detección "desde cero" de un cuadrilátero con forma de carta.
//
// NO reconoce el palo/valor. Sólo responde: "¿hay aquí un rectángulo con
// proporciones y geometría de carta de poker?" y devuelve sus 4 esquinas.
//
// Pipeline (todo en proc-space, buffer reducido):
//   1. RGBA -> gris -> desenfoque gaussiano
//   2. Canny (bordes) -> cierre morfológico para unir tramos
//   3. findContours
//   4. Para cada contorno: filtro de área -> approxPolyDP -> ¿4 vértices convexos?
//   5. Restricciones de carta: rectangularidad, solidez, relación de aspecto ~1.4
//   6. Se puntúa cada candidato y se queda el mejor
//   7. cornerSubPix afina las 4 esquinas a precisión sub-píxel
//   8. Fallback: umbral adaptativo si Canny no encuentra nada
//
// Devuelve { quad:[TL,TR,BR,BL], contour:[...], score, rectangularity, solidity, aspect } | null

import { cv, scope } from "./cv.js";
import { orderCorners, POKER_ASPECT, shoelaceArea } from "./geometry.js";

const MIN_AREA_FRAC = 0.020; // la carta ocupa al menos el 2% del frame
const MAX_AREA_FRAC = 0.92;
const MIN_RECTANGULARITY = 0.78;
const MIN_SOLIDITY = 0.90;
const ASPECT_MIN = 1.12;
const ASPECT_MAX = 2.00;

export function detectCard(imageData) {
  const c = cv();
  return scope((t) => {
    const src = t(c.matFromImageData(imageData));
    const gray = t(new c.Mat());
    c.cvtColor(src, gray, c.COLOR_RGBA2GRAY);
    const blur = t(new c.Mat());
    c.GaussianBlur(gray, blur, new c.Size(5, 5), 0, 0, c.BORDER_DEFAULT);

    const frameArea = imageData.width * imageData.height;
    let best = null;

    // --- Camino A: Canny + cierre morfológico ---
    {
      const edges = t(new c.Mat());
      c.Canny(blur, edges, 60, 180, 3, false);
      const k = t(c.getStructuringElement(c.MORPH_RECT, new c.Size(3, 3)));
      c.morphologyEx(edges, edges, c.MORPH_CLOSE, k, new c.Point(-1, -1), 1);
      best = pickBest(c, t, edges, gray, frameArea, best);
    }

    // --- Camino B (fallback): umbral adaptativo, ambas polaridades ---
    if (!best) {
      for (const inv of [c.THRESH_BINARY, c.THRESH_BINARY_INV]) {
        const bin = t(new c.Mat());
        c.adaptiveThreshold(blur, bin, 255, c.ADAPTIVE_THRESH_GAUSSIAN_C, inv, 21, 5);
        best = pickBest(c, t, bin, gray, frameArea, best);
        if (best) break;
      }
    }

    if (!best) return null;

    // Afinado sub-píxel de las 4 esquinas.
    refineCorners(c, gray, best.quad);
    return best;
  });
}

function pickBest(c, t, binary, gray, frameArea, current) {
  const contours = t(new c.MatVector());
  const hierarchy = t(new c.Mat());
  c.findContours(binary, contours, hierarchy, c.RETR_LIST, c.CHAIN_APPROX_SIMPLE);

  let best = current;
  const n = contours.size();
  for (let i = 0; i < n; i++) {
    const cnt = contours.get(i); // MatVector.get() devuelve un Mat propio: hay que borrarlo
    try {
      const area = c.contourArea(cnt, false);
      if (area < frameArea * MIN_AREA_FRAC || area > frameArea * MAX_AREA_FRAC) continue;

      const peri = c.arcLength(cnt, true);
      let quadPts = approxQuad(c, cnt, peri, 0.02);
      if (!quadPts) quadPts = approxQuad(c, cnt, peri, 0.035);
      if (!quadPts) continue;

      // Convexidad (usando el propio approx como Mat).
      const approxMat = new c.Mat(4, 1, c.CV_32SC2);
      for (let j = 0; j < 4; j++) {
        approxMat.data32S[j * 2] = Math.round(quadPts[j].x);
        approxMat.data32S[j * 2 + 1] = Math.round(quadPts[j].y);
      }
      const convex = c.isContourConvex(approxMat);
      approxMat.delete();
      if (!convex) continue;

      // Rectangularidad vía minAreaRect.
      const rot = c.minAreaRect(cnt);
      const rw = rot.size.width, rh = rot.size.height;
      if (rw < 4 || rh < 4) continue;
      const rectArea = rw * rh;
      const rectangularity = area / rectArea;
      if (rectangularity < MIN_RECTANGULARITY) continue;

      const aspect = Math.max(rw, rh) / Math.min(rw, rh);
      if (aspect < ASPECT_MIN || aspect > ASPECT_MAX) continue;

      // Solidez: área / área del casco convexo (rechaza contornos dentados).
      const hull = new c.Mat();
      c.convexHull(cnt, hull, false, true);
      const hullArea = c.contourArea(hull, false);
      hull.delete();
      const solidity = hullArea > 1 ? area / hullArea : 0;
      if (solidity < MIN_SOLIDITY) continue;

      const areaFrac = area / frameArea;
      const score =
        rectangularity * 1.0 +
        solidity * 0.5 -
        Math.abs(aspect - POKER_ASPECT) * 0.45 +
        Math.min(areaFrac, 0.5) * 0.30;

      if (!best || score > best.score) {
        best = {
          quad: orderCorners(quadPts.map((p) => ({ x: p.x, y: p.y }))),
          contour: readContour(cnt, 60),
          score,
          rectangularity,
          solidity,
          aspect,
        };
      }
    } finally {
      cnt.delete();
    }
  }
  return best;
}

function approxQuad(c, cnt, peri, epsFrac) {
  const approx = new c.Mat();
  c.approxPolyDP(cnt, approx, epsFrac * peri, true);
  let out = null;
  if (approx.rows === 4) {
    out = [];
    for (let j = 0; j < 4; j++) {
      out.push({ x: approx.data32S[j * 2], y: approx.data32S[j * 2 + 1] });
    }
    // descarta cuadriláteros degenerados
    if (shoelaceArea(out) < 16) out = null;
  }
  approx.delete();
  return out;
}

function readContour(cnt, maxPts) {
  const total = cnt.rows;
  const step = Math.max(1, Math.floor(total / maxPts));
  const pts = [];
  for (let i = 0; i < total; i += step) {
    pts.push({ x: cnt.data32S[i * 2], y: cnt.data32S[i * 2 + 1] });
  }
  return pts;
}

function refineCorners(c, gray, quad) {
  try {
    const m = new c.Mat(4, 1, c.CV_32FC2);
    for (let i = 0; i < 4; i++) {
      m.data32F[i * 2] = quad[i].x;
      m.data32F[i * 2 + 1] = quad[i].y;
    }
    const crit = new c.TermCriteria(c.TermCriteria_EPS + c.TermCriteria_COUNT, 20, 0.03);
    c.cornerSubPix(gray, m, new c.Size(5, 5), new c.Size(-1, -1), crit);
    for (let i = 0; i < 4; i++) {
      const x = m.data32F[i * 2], y = m.data32F[i * 2 + 1];
      if (Number.isFinite(x) && Number.isFinite(y)) { quad[i].x = x; quad[i].y = y; }
    }
    m.delete();
  } catch (_) {
    // esquinas demasiado cerca del borde: nos quedamos con las de approxPolyDP
  }
}
