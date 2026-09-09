// geometry.js — utilidades puras de geometría 2D (sin dependencias).
// Un "quad" es siempre un array de 4 puntos {x, y} en orden TL, TR, BR, BL.

export const POKER_ASPECT = 3.5 / 2.5; // 1.4 — alto/ancho de una carta de poker

export function sub(a, b) { return { x: a.x - b.x, y: a.y - b.y }; }
export function add(a, b) { return { x: a.x + b.x, y: a.y + b.y }; }
export function scale(a, s) { return { x: a.x * s, y: a.y * s }; }
export function dot(a, b) { return a.x * b.x + a.y * b.y; }
export function cross(a, b) { return a.x * b.y - a.y * b.x; }
export function len(a) { return Math.hypot(a.x, a.y); }
export function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
export function lerp(a, b, t) { return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }; }

export function centroid(pts) {
  let x = 0, y = 0;
  for (const p of pts) { x += p.x; y += p.y; }
  return { x: x / pts.length, y: y / pts.length };
}

// Ordena 4 puntos arbitrarios a TL, TR, BR, BL usando el truco suma/resta.
// TL tiene la menor suma (x+y); BR la mayor. TR la menor resta (y-x); BL la mayor.
export function orderCorners(pts) {
  const bySum = [...pts].sort((a, b) => (a.x + a.y) - (b.x + b.y));
  const byDiff = [...pts].sort((a, b) => (a.y - a.x) - (b.y - b.x));
  const tl = bySum[0];
  const br = bySum[3];
  const tr = byDiff[0];
  const bl = byDiff[3];
  // Si hay degeneración (dos iguales), cae a un ordenado angular.
  const uniq = new Set([tl, tr, br, bl]);
  if (uniq.size === 4) return [tl, tr, br, bl];
  return orderByAngle(pts);
}

function orderByAngle(pts) {
  const c = centroid(pts);
  const sorted = [...pts].sort((a, b) => Math.atan2(a.y - c.y, a.x - c.x) - Math.atan2(b.y - c.y, b.x - c.x));
  // rota para que el primero sea el más arriba-izquierda
  let startIdx = 0, best = Infinity;
  sorted.forEach((p, i) => { const s = p.x + p.y; if (s < best) { best = s; startIdx = i; } });
  return [0, 1, 2, 3].map((k) => sorted[(startIdx + k) % 4]);
}

export function sideLengths(quad) {
  const [tl, tr, br, bl] = quad;
  return {
    top: dist(tl, tr),
    right: dist(tr, br),
    bottom: dist(br, bl),
    left: dist(bl, tl),
  };
}

// Relación de aspecto observada del quad (alto/ancho), normalizada a >= 1 por robustez.
export function quadAspect(quad) {
  const s = sideLengths(quad);
  const w = (s.top + s.bottom) / 2;
  const h = (s.right + s.left) / 2;
  if (w < 1e-3 || h < 1e-3) return 0;
  const r = h / w;
  return r >= 1 ? r : 1 / r;
}

export function shoelaceArea(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length];
    a += p.x * q.y - q.x * p.y;
  }
  return Math.abs(a) / 2;
}

// Ángulos interiores del quad en grados.
export function interiorAngles(quad) {
  const out = [];
  for (let i = 0; i < 4; i++) {
    const prev = quad[(i + 3) % 4];
    const cur = quad[i];
    const next = quad[(i + 1) % 4];
    const v1 = sub(prev, cur);
    const v2 = sub(next, cur);
    const c = dot(v1, v2) / (len(v1) * len(v2) + 1e-9);
    out.push(Math.acos(Math.max(-1, Math.min(1, c))) * 180 / Math.PI);
  }
  return out;
}

// Convexo si todos los productos cruzados de aristas consecutivas tienen el mismo signo.
export function isConvex(quad) {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = sub(quad[(i + 1) % 4], quad[i]);
    const b = sub(quad[(i + 2) % 4], quad[(i + 1) % 4]);
    const z = cross(a, b);
    if (Math.abs(z) < 1e-6) continue;
    const s = Math.sign(z);
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

function segIntersect(p1, p2, p3, p4) {
  const d = (p2.x - p1.x) * (p4.y - p3.y) - (p2.y - p1.y) * (p4.x - p3.x);
  if (Math.abs(d) < 1e-9) return false;
  const t = ((p3.x - p1.x) * (p4.y - p3.y) - (p3.y - p1.y) * (p4.x - p3.x)) / d;
  const u = ((p3.x - p1.x) * (p2.y - p1.y) - (p3.y - p1.y) * (p2.x - p1.x)) / d;
  return t > 0 && t < 1 && u > 0 && u < 1;
}

// ¿El quad tiene forma de "lazo" (aristas opuestas que se cruzan)?
export function selfIntersects(quad) {
  return (
    segIntersect(quad[0], quad[1], quad[2], quad[3]) ||
    segIntersect(quad[1], quad[2], quad[3], quad[0])
  );
}

export function pointInPoly(pt, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y;
    const hit = (yi > pt.y) !== (yj > pt.y) &&
      pt.x < ((xj - xi) * (pt.y - yi)) / (yj - yi + 1e-12) + xi;
    if (hit) inside = !inside;
  }
  return inside;
}

// Recorte de polígono convexo contra polígono convexo (Sutherland–Hodgman).
function clipPoly(subject, clip) {
  let output = subject;
  for (let i = 0; i < clip.length; i++) {
    const A = clip[i], B = clip[(i + 1) % clip.length];
    const input = output;
    output = [];
    const edge = sub(B, A);
    const insideOf = (p) => cross(edge, sub(p, A)) >= -1e-9;
    for (let k = 0; k < input.length; k++) {
      const cur = input[k];
      const prev = input[(k + input.length - 1) % input.length];
      const curIn = insideOf(cur);
      const prevIn = insideOf(prev);
      if (curIn) {
        if (!prevIn) output.push(lineIx(prev, cur, A, B));
        output.push(cur);
      } else if (prevIn) {
        output.push(lineIx(prev, cur, A, B));
      }
    }
    if (output.length === 0) return [];
  }
  return output;
}

function lineIx(p1, p2, p3, p4) {
  const d = (p1.x - p2.x) * (p3.y - p4.y) - (p1.y - p2.y) * (p3.x - p4.x);
  const a = p1.x * p2.y - p1.y * p2.x;
  const b = p3.x * p4.y - p3.y * p4.x;
  return {
    x: (a * (p3.x - p4.x) - (p1.x - p2.x) * b) / d,
    y: (a * (p3.y - p4.y) - (p1.y - p2.y) * b) / d,
  };
}

// Intersección-sobre-unión de dos quads convexos. Se usa para decidir si una
// re-detección corresponde a la misma carta que estamos trackeando.
export function iou(quadA, quadB) {
  const inter = clipPoly(quadA, quadB);
  if (inter.length < 3) return 0;
  const ai = shoelaceArea(inter);
  const aa = shoelaceArea(quadA);
  const ab = shoelaceArea(quadB);
  const uni = aa + ab - ai;
  return uni > 1e-6 ? ai / uni : 0;
}

export function boundsOf(pts) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY };
}
