// cv.js — carga de OpenCV.js y utilidades de gestión de memoria.
//
// OpenCV.js expone objetos `Mat` respaldados por memoria WASM que el recolector de
// basura de JS NO libera. Cada Mat debe borrarse a mano con .delete(). Si no se hace,
// Safari mata la pestaña por consumo de memoria en segundos. `scope()` centraliza esto.

let _cv = null;
let _readyPromise = null;
let _scriptInjected = false;

// Carga perezosa de OpenCV.js (~10 MB). Se llama al pulsar START, para que la
// pantalla inicial pinte al instante y el compilado WASM ocurra mientras el
// usuario concede el permiso de cámara. Idempotente.
export function loadOpenCV(src = "./js/vendor/opencv.js") {
  if (!_scriptInjected && !window.cv) {
    _scriptInjected = true;
    const s = document.createElement("script");
    s.src = src;
    s.async = true;
    s.onerror = () => { _readyPromise = Promise.reject(new Error("no se pudo cargar opencv.js")); };
    document.head.appendChild(s);
  }
  return cvReady();
}

export function cvReady() {
  if (_readyPromise) return _readyPromise;
  _readyPromise = new Promise((resolve) => {
    const tick = () => {
      const g = window.cv;
      if (g && g.Mat) { _cv = g; resolve(g); return; }
      // Builds recientes exponen `cv` como promesa (Module) hasta inicializar el runtime.
      if (g && typeof g.then === "function") {
        g.then((c) => { _cv = c; window.cv = c; resolve(c); });
        return;
      }
      setTimeout(tick, 30);
    };
    tick();
  });
  return _readyPromise;
}

export function cv() {
  if (!_cv) throw new Error("OpenCV no está listo todavía");
  return _cv;
}

// Ejecuta `fn(track)`. Todo Mat pasado a track(mat) se borra al terminar,
// incluso si fn lanza una excepción.
export function scope(fn) {
  const bag = [];
  const track = (m) => { bag.push(m); return m; };
  try {
    return fn(track);
  } finally {
    for (let i = bag.length - 1; i >= 0; i--) {
      const m = bag[i];
      try { if (m && !m.isDeleted?.() && m.delete) m.delete(); } catch (_) { /* noop */ }
    }
  }
}

export function safeDelete(...mats) {
  for (const m of mats) {
    try { if (m && m.delete) m.delete(); } catch (_) { /* noop */ }
  }
}

// Convierte un array de puntos {x,y} en un Mat CV_32FC2 Nx1 (formato que piden
// calcOpticalFlowPyrLK / findHomography / perspectiveTransform).
export function pointsToMat(pts) {
  const c = cv();
  const m = new c.Mat(pts.length, 1, c.CV_32FC2);
  const d = m.data32F;
  for (let i = 0; i < pts.length; i++) {
    d[i * 2] = pts[i].x;
    d[i * 2 + 1] = pts[i].y;
  }
  return m;
}

export function matToPoints(m) {
  const d = m.data32F;
  const out = [];
  for (let i = 0; i < m.rows; i++) out.push({ x: d[i * 2], y: d[i * 2 + 1] });
  return out;
}
