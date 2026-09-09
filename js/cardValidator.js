// cardValidator.js — decide cada frame si la carta SIGUE existiendo.
//
// Es el guardián contra el error nº3 ("cuando quito la carta el tracking sigue")
// y contra "el tracker se va a mi cara". Combina varias comprobaciones
// independientes; ninguna por sí sola es fiable, juntas sí:
//
//   · survivalRatio  — fracción de features que sobreviven al optical flow + FB
//   · inlierRatio    — fracción de inliers de la homografía RANSAC (rigidez planar)
//   · ncc            — parecido del contenido actual con el template de la carta
//   · aspect         — el quad mantiene proporción ~1.4 y coherente con su historial
//   · geometría      — convexo, sin auto-intersección, ángulos y lados razonables
//   · área           — sin colapsos ni explosiones respecto a su media móvil
//   · edgeSupport    — las 4 aristas del quad caen sobre gradientes reales de imagen
//   · faceGuard      — (opcional) si una cara solapa el quad y el ncc es bajo -> perdido
//
// Tolerancia: un frame malo NO pierde la carta. Varios frames malos seguidos, sí.

import { cv, scope } from "./cv.js";
import {
  isConvex, selfIntersects, interiorAngles, sideLengths,
  quadAspect, shoelaceArea, centroid, boundsOf, POKER_ASPECT,
} from "./geometry.js";

const LOST_CONF = 0.42;
const MAX_BAD_STREAK = 5;      // ~5 frames malos seguidos => CARD LOST
const CONFIRM_GOOD = 3;        // frames buenos para confirmar un lock

export class CardValidator {
  constructor() {
    this.reset();
  }

  reset() {
    this.emaArea = 0;
    this.emaAspect = POKER_ASPECT;
    this.badStreak = 0;
    this.goodStreak = 0;
    this.lastConfidence = 0;
    this.lastChecks = null;
  }

  seed(quad) {
    this.emaArea = shoelaceArea(quad);
    this.emaAspect = quadAspect(quad) || POKER_ASPECT;
    this.badStreak = 0;
    this.goodStreak = 0;
  }

  // trackResult: salida de CardTracker.track()
  // gray: Mat CV_8U del frame actual (proc-space) — reutilizado del tracker
  // faceBoxes: array de {x,y,w,h} en proc-space o null
  evaluate(trackResult, gray, faceBoxes) {
    const W = gray.cols, H = gray.rows;
    const frameArea = W * H;

    // --- Fallo duro del tracker: no hay homografía / flujo colapsado ---
    if (!trackResult || !trackResult.ok) {
      this.badStreak++;
      this.goodStreak = 0;
      this.lastConfidence = 0;
      this.lastChecks = { hardFail: trackResult?.reason || "no_track" };
      return this._verdict(null);
    }

    const quad = trackResult.quad;
    const area = shoelaceArea(quad);
    const aspect = quadAspect(quad);
    const angles = interiorAngles(quad);
    const sides = sideLengths(quad);
    const minSide = Math.min(sides.top, sides.right, sides.bottom, sides.left);
    const minDim = Math.min(W, H);
    const c = centroid(quad);

    // --- Puertas geométricas booleanas ---
    const gConvex = isConvex(quad);
    const gSimple = !selfIntersects(quad);
    const gAngles = angles.every((a) => a > 33 && a < 147);
    const gSide = minSide > minDim * 0.045;
    const gInside = c.x > -W * 0.1 && c.x < W * 1.1 && c.y > -H * 0.1 && c.y < H * 1.1;
    const gArea = area > frameArea * 0.012 && area < frameArea * 0.96;
    const geomGate = gConvex && gSimple && gAngles && gSide && gInside && gArea;

    // --- Términos graduados [0..1] ---
    const cNcc = clamp01((trackResult.ncc - 0.18) / 0.55);
    const cInlier = clamp01(trackResult.inlierRatio / 0.72);
    const cSurv = clamp01(trackResult.survivalRatio / 0.75);
    const aspErrAbs = Math.abs(aspect - POKER_ASPECT);
    const aspErrHist = this.emaAspect ? Math.abs(aspect - this.emaAspect) / this.emaAspect : 1;
    const cAspect = clamp01(1 - aspErrAbs / 0.62) * clamp01(1 - aspErrHist / 0.4);
    const areaRatio = this.emaArea > 1 ? area / this.emaArea : 1;
    const cArea = clamp01(1 - Math.abs(Math.log(Math.max(areaRatio, 1e-3))) / Math.log(2.4));
    const edgeSupport = geomGate ? edgeSupportScore(gray, quad) : 0;
    const cEdge = clamp01(edgeSupport / 0.55);

    let confidence =
      cNcc * 0.32 +
      cInlier * 0.22 +
      cEdge * 0.16 +
      cSurv * 0.12 +
      cAspect * 0.12 +
      cArea * 0.06;
    confidence *= geomGate ? 1 : 0.15;

    // --- Face guard explícito ---
    let faceHit = false;
    if (faceBoxes && faceBoxes.length) {
      const qb = boundsOf(quad);
      for (const f of faceBoxes) {
        const ov = rectOverlapFrac(qb, f);
        if (ov > 0.45 && trackResult.ncc < 0.5) { faceHit = true; break; }
      }
    }

    // --- Catástrofe: pérdida inmediata sin tolerancia ---
    const catastrophic =
      faceHit ||
      (!gConvex && !gSimple && trackResult.ncc < 0.3) ||
      (trackResult.ncc < 0.12 && cInlier < 0.15);

    // --- Racha ---
    const bad = confidence < LOST_CONF || !geomGate;
    if (bad) { this.badStreak++; this.goodStreak = 0; }
    else {
      this.badStreak = Math.max(0, this.badStreak - 2);
      this.goodStreak++;
      // Actualiza referencias sólo con frames claramente buenos.
      if (confidence > 0.6) {
        this.emaArea = this.emaArea > 1 ? this.emaArea * 0.9 + area * 0.1 : area;
        this.emaAspect = this.emaAspect * 0.9 + aspect * 0.1;
      }
    }

    this.lastConfidence = confidence;
    this.lastChecks = {
      confidence, geomGate, cNcc, cInlier, cSurv, cAspect, cArea, cEdge,
      ncc: trackResult.ncc, inlierRatio: trackResult.inlierRatio,
      survivalRatio: trackResult.survivalRatio, aspect, edgeSupport,
      angles, faceHit, badStreak: this.badStreak,
    };

    return this._verdict(quad, catastrophic);
  }

  _verdict(quad, catastrophic = false) {
    const lost = catastrophic || this.badStreak >= MAX_BAD_STREAK;
    return {
      lost,
      catastrophic,
      confidence: this.lastConfidence,
      badStreak: this.badStreak,
      goodStreak: this.goodStreak,
      confirmed: this.goodStreak >= CONFIRM_GOOD,
      checks: this.lastChecks,
      quad,
    };
  }
}

function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }

// Solape del rect f (cara) sobre el bounding box del quad: intersección / área(f).
function rectOverlapFrac(qb, f) {
  const x1 = Math.max(qb.minX, f.x);
  const y1 = Math.max(qb.minY, f.y);
  const x2 = Math.min(qb.maxX, f.x + f.w);
  const y2 = Math.min(qb.maxY, f.y + f.h);
  if (x2 <= x1 || y2 <= y1) return 0;
  const inter = (x2 - x1) * (y2 - y1);
  const fa = f.w * f.h;
  return fa > 1 ? inter / fa : 0;
}

// Fracción de las 4 aristas del quad que se apoya en gradientes reales de imagen.
// Una carta retirada deja el quad "flotando" sobre cara/pared/mesa lisas -> soporte bajo.
function edgeSupportScore(gray, quad) {
  const c = cv();
  return scope((t) => {
    const gx = t(new c.Mat());
    const gy = t(new c.Mat());
    c.Sobel(gray, gx, c.CV_32F, 1, 0, 3);
    c.Sobel(gray, gy, c.CV_32F, 0, 1, 3);
    const mag = t(new c.Mat());
    c.magnitude(gx, gy, mag);
    const meanScalar = c.mean(mag);
    const thresh = Math.max(40, meanScalar[0] * 2.4);

    const W = mag.cols, Hh = mag.rows;
    const d = mag.data32F;
    const at = (x, y) => {
      const xi = x | 0, yi = y | 0;
      if (xi < 0 || yi < 0 || xi >= W || yi >= Hh) return -1;
      return d[yi * W + xi];
    };
    const edgeScore = (a, b) => {
      const N = 22;
      let hit = 0, tot = 0;
      const nx = -(b.y - a.y), ny = (b.x - a.x);
      const nl = Math.hypot(nx, ny) || 1;
      for (let k = 1; k < N; k++) {
        const tt = k / N;
        const px = a.x + (b.x - a.x) * tt;
        const py = a.y + (b.y - a.y) * tt;
        let m = -1;
        for (let s = -1.5; s <= 1.5; s += 0.75) {
          m = Math.max(m, at(px + (nx / nl) * s, py + (ny / nl) * s));
        }
        if (m < 0) continue;
        tot++;
        if (m > thresh) hit++;
      }
      return tot ? hit / tot : 0;
    };
    const es = [
      edgeScore(quad[0], quad[1]),
      edgeScore(quad[1], quad[2]),
      edgeScore(quad[2], quad[3]),
      edgeScore(quad[3], quad[0]),
    ];
    const avg = (es[0] + es[1] + es[2] + es[3]) / 4;
    const mn = Math.min(...es);
    return avg * 0.6 + mn * 0.4;
  });
}
