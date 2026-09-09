// homography.js — homografía (transformación proyectiva) 3x3 en JS puro.
//
// Resuelve H tal que  H · [x y 1]^T  ~  [x' y' 1]^T  para 4 correspondencias.
// Método: DLT con eliminación gaussiana sobre el sistema 8x8.
//
// En este MVP el tracker usa cv.findHomography de OpenCV para el tracking robusto
// (RANSAC). Este módulo cubre la matemática que NO necesita OpenCV: warp de rejilla
// para el debug "show homography", y más adelante el render de la carta digital.

// src, dst: arrays de 4 puntos {x, y}. Devuelve Float64Array(9) en fila-mayor, o null.
export function computeHomography(src, dst) {
  const A = [];
  const b = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = src[i];
    const { x: X, y: Y } = dst[i];
    A.push([x, y, 1, 0, 0, 0, -X * x, -X * y]);
    b.push(X);
    A.push([0, 0, 0, x, y, 1, -Y * x, -Y * y]);
    b.push(Y);
  }
  const h = solve8(A, b);
  if (!h) return null;
  return new Float64Array([h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1]);
}

function solve8(A, b) {
  const n = 8;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    }
    if (Math.abs(M[piv][col]) < 1e-12) return null;
    [M[col], M[piv]] = [M[piv], M[col]];
    const d = M[col][col];
    for (let c = col; c <= n; c++) M[col][c] /= d;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col];
      if (f === 0) continue;
      for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
    }
  }
  return M.map((row) => row[n]);
}

export function applyH(H, p) {
  const x = H[0] * p.x + H[1] * p.y + H[2];
  const y = H[3] * p.x + H[4] * p.y + H[5];
  const w = H[6] * p.x + H[7] * p.y + H[8];
  return { x: x / w, y: y / w };
}

export function invertH(H) {
  const [a, b, c, d, e, f, g, h, i] = H;
  const A = e * i - f * h;
  const B = c * h - b * i;
  const C = b * f - c * e;
  const D = f * g - d * i;
  const E = a * i - c * g;
  const F = c * d - a * f;
  const G = d * h - e * g;
  const Hh = b * g - a * h;
  const I = a * e - b * d;
  const det = a * A + b * D + c * G;
  if (Math.abs(det) < 1e-12) return null;
  const s = 1 / det;
  return new Float64Array([A * s, B * s, C * s, D * s, E * s, F * s, G * s, Hh * s, I * s]);
}

// Genera una rejilla n×n en el rectángulo unidad y la proyecta por H.
// Se usa para dibujar la malla de homografía en modo debug.
export function warpGrid(H, n = 4, w = 1, h = 1) {
  const rows = [];
  for (let r = 0; r <= n; r++) {
    const row = [];
    for (let c = 0; c <= n; c++) {
      row.push(applyH(H, { x: (c / n) * w, y: (r / n) * h }));
    }
    rows.push(row);
  }
  return rows;
}
