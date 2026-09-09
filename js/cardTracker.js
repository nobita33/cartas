// cardTracker.js — tracking VISUAL de la carta entre frames.
//
// NO conserva simplemente las coordenadas anteriores. Cada frame mide el
// movimiento real de la textura de la carta:
//
//   1. En el "lock": goodFeaturesToTrack dentro del quad -> puntos a seguir.
//      Se guarda un "template" canónico (la carta des-proyectada a un rectángulo).
//   2. Cada frame: Lucas-Kanade piramidal (calcOpticalFlowPyrLK) sigue esos puntos.
//   3. Filtro forward-backward: se re-trackea al revés y se descartan los puntos
//      cuyo viaje de ida y vuelta no cuadra (mata correspondencias falsas -> clave
//      para que el tracker NO se enganche a una cara o a la mano).
//   4. findHomography(RANSAC) con los puntos supervivientes -> transformación
//      proyectiva del frame anterior al actual.
//   5. Las 4 esquinas anteriores se proyectan por esa homografía -> nuevas esquinas.
//   6. Se re-siembran features cuando quedan pocos.
//   7. NCC del template canónico vs. el contenido actual des-proyectado -> cuánto
//      se "parece" todavía a la carta original.
//
// El tracker NO decide por sí solo si la carta se perdió: expone métricas y
// cardValidator.js toma la decisión.

import { cv, scope, pointsToMat, matToPoints, safeDelete } from "./cv.js";
import { applyH } from "./homography.js";

// OpenCV entrega H como Float64 fila-mayor de 9 elementos: mismo layout que applyH().
function perspectiveTransformQuad(H, quad) {
  const h = H.data64F;
  return quad.map((p) => applyH(h, p));
}

const CANON_W = 120;
const CANON_H = 168; // ~1.4 : proporción de carta de poker
const MAX_FEATURES = 110;
const MIN_FEATURES = 26;
const FB_THRESHOLD = 1.6; // px de error máximo en el viaje ida-vuelta
const LK_ERR_MAX = 24;

export class CardTracker {
  constructor() {
    this.prevGray = null;   // Mat CV_8U persistente
    this.curGray = null;    // Mat CV_8U del frame actual (para reuso del validador)
    this.template = null;   // Mat CV_8U CANON_W x CANON_H
    this.prevQuad = null;   // [TL,TR,BR,BL]
    this.points = [];       // puntos trackeados del último frame (debug)
    this.active = false;
    this._canonDst = null;  // Mat 4x1 CV_32FC2 con el rectángulo canónico
  }

  _ensureCanonDst() {
    const c = cv();
    if (this._canonDst) return this._canonDst;
    const m = new c.Mat(4, 1, c.CV_32FC2);
    m.data32F.set([0, 0, CANON_W, 0, CANON_W, CANON_H, 0, CANON_H]);
    this._canonDst = m;
    return m;
  }

  _grayFrom(imageData, track) {
    const c = cv();
    const src = track(c.matFromImageData(imageData));
    const g = new c.Mat();
    c.cvtColor(src, g, c.COLOR_RGBA2GRAY);
    return track(g); // registrado en el scope: se libera al terminar; clónalo si necesitas conservarlo
  }

  _warpCanon(gray, quad) {
    const c = cv();
    const srcM = new c.Mat(4, 1, c.CV_32FC2);
    srcM.data32F.set([
      quad[0].x, quad[0].y, quad[1].x, quad[1].y,
      quad[2].x, quad[2].y, quad[3].x, quad[3].y,
    ]);
    const H = c.getPerspectiveTransform(srcM, this._ensureCanonDst());
    const out = new c.Mat();
    c.warpPerspective(gray, out, H, new c.Size(CANON_W, CANON_H), c.INTER_LINEAR, c.BORDER_REPLICATE, new c.Scalar());
    srcM.delete();
    H.delete();
    return out;
  }

  _detectFeatures(gray, quad) {
    const c = cv();
    return scope((t) => {
      const mask = t(c.Mat.zeros(gray.rows, gray.cols, c.CV_8UC1));
      const poly = t(new c.Mat(4, 1, c.CV_32SC2));
      poly.data32S.set([
        Math.round(quad[0].x), Math.round(quad[0].y),
        Math.round(quad[1].x), Math.round(quad[1].y),
        Math.round(quad[2].x), Math.round(quad[2].y),
        Math.round(quad[3].x), Math.round(quad[3].y),
      ]);
      const mv = t(new c.MatVector());
      mv.push_back(poly);
      c.fillPoly(mask, mv, new c.Scalar(255));
      // Encoge la máscara para no coger features del borde/mesa justo fuera de la carta.
      const k = t(c.getStructuringElement(c.MORPH_RECT, new c.Size(7, 7)));
      c.erode(mask, mask, k, new c.Point(-1, -1), 2);

      const corners = t(new c.Mat());
      c.goodFeaturesToTrack(gray, corners, MAX_FEATURES, 0.01, 7, mask, 7, false, 0.04);
      return matToPoints(corners);
    });
  }

  // Inicializa el tracking. imageData: frame actual. quad: 4 esquinas detectadas.
  lock(imageData, quad) {
    const c = cv();
    this.release();
    scope((t) => {
      const gray = this._grayFrom(imageData, t);
      this.prevGray = gray.clone();
      this.curGray = gray.clone();
      this.template = this._warpCanon(gray, quad);
      this.points = this._detectFeatures(gray, quad);
      this.prevQuad = quad.map((p) => ({ x: p.x, y: p.y }));
      this.active = this.points.length >= MIN_FEATURES;
    });
    return this.active;
  }

  // Re-ancla el tracker a un quad fresco (p. ej. tras una re-detección que coincide).
  resync(imageData, quad) {
    const c = cv();
    scope((t) => {
      const gray = this._grayFrom(imageData, t);
      safeDelete(this.prevGray, this.curGray, this.template);
      this.prevGray = gray.clone();
      this.curGray = gray.clone();
      this.template = this._warpCanon(gray, quad);
      this.points = this._detectFeatures(gray, quad);
      this.prevQuad = quad.map((p) => ({ x: p.x, y: p.y }));
      this.active = this.points.length >= MIN_FEATURES;
    });
    return this.active;
  }

  // Procesa un frame. Devuelve métricas + nuevo quad, o { ok:false } si degeneró.
  track(imageData) {
    if (!this.active) return { ok: false, reason: "inactive" };
    const c = cv();

    return scope((t) => {
      const gray = this._grayFrom(imageData, t);
      const w = gray.cols, h = gray.rows;

      if (this.points.length < 6) return this._degenerate(gray, "too_few_points");

      const p0 = t(pointsToMat(this.points));
      const p1 = t(new c.Mat());
      const st = t(new c.Mat());
      const errM = t(new c.Mat());
      const winSize = new c.Size(21, 21);
      const crit = new c.TermCriteria(c.TermCriteria_EPS + c.TermCriteria_COUNT, 20, 0.03);
      c.calcOpticalFlowPyrLK(this.prevGray, gray, p0, p1, st, errM, winSize, 2, crit, 0, 0.001);

      // Forward-backward: re-trackea p1 -> prevGray y compara con p0.
      const p0b = t(new c.Mat());
      const stB = t(new c.Mat());
      const errB = t(new c.Mat());
      c.calcOpticalFlowPyrLK(gray, this.prevGray, p1, p0b, stB, errB, winSize, 2, crit, 0, 0.001);

      const prevPts = this.points;
      const nextPts = matToPoints(p1);
      const backPts = matToPoints(p0b);
      const goodPrev = [];
      const goodNext = [];
      for (let i = 0; i < prevPts.length; i++) {
        if (st.data[i] !== 1 || stB.data[i] !== 1) continue;
        if (errM.data32F[i] > LK_ERR_MAX) continue;
        const fb = Math.hypot(prevPts[i].x - backPts[i].x, prevPts[i].y - backPts[i].y);
        if (fb > FB_THRESHOLD) continue;
        const np = nextPts[i];
        if (np.x < -8 || np.y < -8 || np.x > w + 8 || np.y > h + 8) continue;
        goodPrev.push(prevPts[i]);
        goodNext.push(np);
      }

      const survivalRatio = prevPts.length ? goodNext.length / prevPts.length : 0;
      if (goodNext.length < 6) return this._degenerate(gray, "flow_collapsed", { survivalRatio });

      // Homografía robusta prev -> actual.
      const srcM = t(pointsToMat(goodPrev));
      const dstM = t(pointsToMat(goodNext));
      const inlierMask = t(new c.Mat());
      const H = t(c.findHomography(srcM, dstM, c.RANSAC, 3.0, inlierMask, 2000, 0.995));
      if (H.rows !== 3 || H.cols !== 3) return this._degenerate(gray, "no_homography", { survivalRatio });

      let inliers = 0;
      const inlierPts = [];
      for (let i = 0; i < goodNext.length; i++) {
        if (inlierMask.data[i]) { inliers++; inlierPts.push(goodNext[i]); }
      }
      const inlierRatio = goodNext.length ? inliers / goodNext.length : 0;

      // Comprueba que H no sea una degeneración (colapso / reflexión).
      const Hd = H.data64F;
      const detA = Hd[0] * Hd[4] - Hd[1] * Hd[3];
      if (!Number.isFinite(detA) || detA <= 0.05 || detA > 20) {
        return this._degenerate(gray, "bad_homography_scale", { survivalRatio, inlierRatio });
      }

      const newQuad = perspectiveTransformQuad(H, this.prevQuad);

      // NCC del template canónico vs contenido actual des-proyectado.
      let ncc = 0;
      {
        const warpCur = this._warpCanon(gray, newQuad);
        const res = new c.Mat();
        c.matchTemplate(warpCur, this.template, res, c.TM_CCOEFF_NORMED);
        ncc = res.data32F[0];
        // Actualiza el template MUY despacio y sólo si aún se parece mucho:
        // así sigue cambios de luz pero nunca "aprende" una cara.
        if (ncc > 0.72) {
          c.addWeighted(this.template, 0.92, warpCur, 0.08, 0, this.template);
        }
        warpCur.delete();
        res.delete();
      }

      // Re-siembra si quedan pocos puntos.
      let keptPts = inlierPts.length >= MIN_FEATURES ? inlierPts : goodNext;
      if (keptPts.length < MIN_FEATURES) {
        const extra = this._detectFeatures(gray, newQuad);
        const merged = keptPts.slice();
        for (const e of extra) {
          if (merged.length >= MAX_FEATURES) break;
          merged.push(e);
        }
        keptPts = merged;
      }

      // Avanza estado.
      safeDelete(this.prevGray);
      this.prevGray = gray.clone();
      safeDelete(this.curGray);
      this.curGray = gray.clone();
      this.prevQuad = newQuad.map((p) => ({ x: p.x, y: p.y }));
      this.points = keptPts;

      return {
        ok: true,
        quad: newQuad,
        points: keptPts,
        pointCount: keptPts.length,
        survivalRatio,
        inlierRatio,
        ncc,
      };
    });
  }

  _degenerate(gray, reason, extra = {}) {
    // Aun así avanzamos prevGray para no re-comparar contra un frame viejo.
    safeDelete(this.prevGray);
    this.prevGray = gray.clone();
    safeDelete(this.curGray);
    this.curGray = gray.clone();
    return { ok: false, reason, survivalRatio: 0, inlierRatio: 0, ncc: 0, ...extra };
  }

  currentGray() { return this.curGray; }

  release() {
    safeDelete(this.prevGray, this.curGray, this.template);
    this.prevGray = null;
    this.curGray = null;
    this.template = null;
    this.prevQuad = null;
    this.points = [];
    this.active = false;
  }

  disposeCanon() {
    safeDelete(this._canonDst);
    this._canonDst = null;
  }
}
