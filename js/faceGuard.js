// faceGuard.js — detector de caras Haar OPCIONAL (OpenCV).
//
// El guardián principal contra "seguir la cara" es el conjunto NCC + aspecto +
// edgeSupport de cardValidator.js, que no necesita esto. Este módulo añade una
// comprobación EXPLÍCITA extra: si hay una cara solapando el quad y el parecido
// con la carta es bajo, se fuerza CARD LOST de inmediato.
//
// Se carga bajo demanda (cascada ~900 KB) sólo si el usuario activa "Face guard".

import { cv, scope } from "./cv.js";

const CASCADE_URL =
  "https://cdn.jsdelivr.net/gh/opencv/opencv@4.10.0/data/haarcascades/haarcascade_frontalface_default.xml";
const CASCADE_FILE = "haarcascade_frontalface_default.xml";

let _classifier = null;
let _loading = null;

export function isFaceGuardReady() { return !!_classifier; }

export async function loadFaceGuard() {
  if (_classifier) return _classifier;
  if (_loading) return _loading;
  _loading = (async () => {
    const c = cv();
    const buf = new Uint8Array(await (await fetch(CASCADE_URL)).arrayBuffer());
    try { c.FS_unlink(CASCADE_FILE); } catch (_) { /* no existía */ }
    c.FS_createDataFile("/", CASCADE_FILE, buf, true, false, false);
    const cls = new c.CascadeClassifier();
    if (!cls.load(CASCADE_FILE)) throw new Error("no se pudo cargar la cascada Haar");
    _classifier = cls;
    return cls;
  })();
  return _loading;
}

export function unloadFaceGuard() {
  try { _classifier?.delete(); } catch (_) { /* noop */ }
  _classifier = null;
  _loading = null;
}

// Devuelve array de {x,y,w,h} en proc-space. gray: Mat CV_8U del frame actual.
export function detectFaces(gray) {
  if (!_classifier) return [];
  const c = cv();
  return scope((t) => {
    const faces = t(new c.RectVector());
    const small = t(new c.Mat());
    // Detección a media resolución: suficiente y más rápida.
    const scale = 0.5;
    c.resize(gray, small, new c.Size(0, 0), scale, scale, c.INTER_AREA);
    const minSize = new c.Size(Math.round(small.cols * 0.18), Math.round(small.cols * 0.18));
    _classifier.detectMultiScale(small, faces, 1.2, 4, 0, minSize, new c.Size());
    const out = [];
    for (let i = 0; i < faces.size(); i++) {
      const r = faces.get(i);
      out.push({ x: r.x / scale, y: r.y / scale, w: r.width / scale, h: r.height / scale });
    }
    return out;
  });
}
