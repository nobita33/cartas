// app.js — orquestación: cámara -> detección -> 4 esquinas -> tracking -> card lost.
//
// Bucle por frame (requestVideoFrameCallback si existe, si no requestAnimationFrame):
//   grab frame reducido -> máquina de estados -> render overlay -> HUD
//
// Pipeline de estados en step():
//   SEARCHING / CANDIDATE : detectCard() cada frame; se exige consistencia
//   TRACKING              : cardTracker.track() + cardValidator.evaluate() cada frame
//                           + re-detección periódica para corregir deriva (fija PROBLEMA 1)
//   LOST                  : oculta overlay, suelta tracker, vuelve a SEARCHING (PROBLEMA 3)

import { cvReady, loadOpenCV } from "./cv.js";
import { Camera } from "./camera.js";
import { Overlay } from "./debugOverlay.js";
import { Perf } from "./perf.js";
import { StateMachine, S } from "./stateMachine.js";
import { detectCard } from "./cardDetector.js";
import { CardTracker } from "./cardTracker.js";
import { CardValidator } from "./cardValidator.js";
import { loadFaceGuard, unloadFaceGuard, detectFaces, isFaceGuardReady } from "./faceGuard.js";
import { centroid, shoelaceArea, iou } from "./geometry.js";

const $ = (id) => document.getElementById(id);

const dom = {
  startScreen: $("start-screen"),
  cameraScreen: $("camera-screen"),
  btnStart: $("btn-start"),
  startError: $("start-error"),
  startHint: $("start-hint"),
  cvStatus: $("cv-status"),
  cvLoading: $("cv-loading"),
  video: $("video"),
  overlay: $("overlay"),
  statusPill: $("status-pill"),
  btnReset: $("btn-reset"),
  btnDebug: $("btn-debug"),
  btnPerf: $("btn-perf"),
  debugPanel: $("debug-panel"),
  hud: {
    fps: $("hud-fps"), cvms: $("hud-cvms"), proc: $("hud-proc"),
    card: $("hud-card"), track: $("hud-track"), conf: $("hud-conf"),
    state: $("hud-state"), pts: $("hud-pts"), ncc: $("hud-ncc"),
    inlier: $("hud-inlier"), aspect: $("hud-aspect"), edges: $("hud-edges"),
    tl: $("hud-tl"), tr: $("hud-tr"), br: $("hud-br"), bl: $("hud-bl"),
  },
  toggles: {
    corners: $("t-corners"), quad: $("t-quad"), points: $("t-points"),
    fps: $("t-fps"), conf: $("t-conf"), homography: $("t-homography"),
    contour: $("t-contour"), faceguard: $("t-faceguard"),
  },
};

const camera = new Camera(dom.video);
const overlay = new Overlay(dom.overlay);
const perf = new Perf();
const tracker = new CardTracker();
const validator = new CardValidator();
const machine = new StateMachine(onStateChange);

// ?nocv en la URL: salta la carga de OpenCV (útil para probar sólo la cámara / UI).
const NO_CV = new URLSearchParams(location.search).has("nocv");
let cvOk = false;
let running = false;
let frameId = 0;
let detHistory = [];      // detecciones consistentes acumuladas en CANDIDATE
let candidateMiss = 0;
let lastGoodDetection = null; // { quad, contour } del último detectCard con éxito
let redetectCooldown = 0;
let lostFlashUntil = 0;
let faceGuardBusy = false;

// ---------------- arranque ----------------
// OpenCV.js NO se carga aquí. Es ~10 MB y compilar su WASM bloquea el hilo
// principal varios segundos en un móvil ("web congelada"). Se carga DESPUÉS de
// que la cámara esté visible (ver startCamera): la Fase 1 no necesita OpenCV.
dom.cvStatus.textContent = NO_CV ? "OpenCV desactivado (?nocv)" : "";

function beginVisionLoad() {
  if (NO_CV || cvOk) return;
  if (dom.cvLoading) dom.cvLoading.hidden = false;
  loadOpenCV();
  cvReady().then(() => {
    cvOk = true;
    if (dom.cvLoading) dom.cvLoading.hidden = true;
  }).catch(() => {
    if (dom.cvLoading) dom.cvLoading.textContent = "Visión no disponible";
  });
}

// Diagnóstico visible en la pantalla inicial (para saber por qué no abre la cámara).
(function showDiag() {
  const secure = window.isSecureContext;
  const hasGUM = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  const ua = navigator.userAgent;
  const inApp = /(FBAN|FBAV|Instagram|Line|Twitter|TikTok|Snapchat|GSA)/i.test(ua);
  const isSafari = /^((?!chrome|android|crios|fxios|edgios).)*safari/i.test(ua);
  const lines = [
    `origen: ${location.protocol}//${location.host}`,
    `secureContext (HTTPS): ${secure ? "sí" : "NO"}`,
    `getUserMedia: ${hasGUM ? "sí" : "NO"}`,
    inApp ? "⚠ navegador embebido en otra app: usa Safari" : (isSafari ? "navegador: Safari ✓" : "navegador: no-Safari"),
  ];
  dom.startHint.textContent = lines.join("  ·  ");
  if (!secure || !hasGUM || inApp) {
    dom.startError.hidden = false;
    dom.startError.textContent = !secure
      ? "Esta página NO está en HTTPS. La cámara no funcionará. Abre la URL https://…vercel.app."
      : inApp
        ? "Estás en un navegador dentro de otra app. Ábrelo en Safari."
        : "getUserMedia no disponible en este navegador.";
  }
})();

dom.btnStart.addEventListener("click", startCamera, { once: false });
dom.btnReset.addEventListener("click", hardReset);
dom.btnDebug.addEventListener("click", () => {
  const show = dom.debugPanel.hidden;
  dom.debugPanel.hidden = !show;
  dom.btnDebug.classList.toggle("on", show);
});
dom.btnPerf.addEventListener("click", () => setPerf(!document.body.classList.contains("perf")));

function setPerf(on) {
  document.body.classList.toggle("perf", on);
  dom.btnPerf.classList.toggle("on", on);
}

// En performance mode no hay botones visibles: se sale con doble toque en pantalla.
let _lastTap = 0;
dom.cameraScreen.addEventListener("pointerup", () => {
  const now = performance.now();
  if (document.body.classList.contains("perf") && now - _lastTap < 320) setPerf(false);
  _lastTap = now;
});
dom.toggles.faceguard.addEventListener("change", async (e) => {
  if (e.target.checked) {
    dom.cvStatus.textContent = "Cargando face guard…";
    try { await loadFaceGuard(); } catch (_) { e.target.checked = false; }
  } else {
    unloadFaceGuard();
  }
});

window.addEventListener("resize", onResize);
window.addEventListener("orientationchange", () => setTimeout(onResize, 250));
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && running) scheduleFrame();
});

async function startCamera() {
  dom.startError.hidden = true;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    dom.startError.hidden = false;
    dom.startError.textContent =
      "Este navegador no expone getUserMedia. Abre la web en Safari real por HTTPS (no dentro de otra app).";
    return;
  }
  dom.btnStart.disabled = true;
  dom.btnStart.textContent = "ABRIENDO…";
  try {
    await camera.start();
  } catch (e) {
    dom.btnStart.disabled = false;
    dom.btnStart.textContent = "START CAMERA";
    dom.startError.hidden = false;
    dom.startError.textContent = explainCameraError(e);
    return;
  }
  dom.startScreen.hidden = true;
  dom.cameraScreen.hidden = false;
  onResize();
  running = true;
  machine.set(S.SEARCHING);
  scheduleFrame();

  // Cámara ya visible: ahora carga OpenCV en segundo plano. La detección
  // arranca sola cuando cvOk pasa a true. Un pequeño retardo deja pintar
  // los primeros frames de vídeo antes del hitch de compilado del WASM.
  setTimeout(beginVisionLoad, 400);
}

function explainCameraError(e) {
  const name = (e && e.name) || "Error";
  const msg = (e && e.message) || "";
  let head;
  switch (name) {
    case "InsecureContextError":
      head = "NO es HTTPS. La cámara sólo funciona en https:// o localhost. " +
        "Abre la URL de Vercel (https://…vercel.app), no una IP http://.";
      break;
    case "UnsupportedError":
      head = "Este navegador no expone getUserMedia. Usa Safari de verdad, " +
        "no un navegador dentro de otra app (Instagram, Telegram, Notas…).";
      break;
    case "NotAllowedError":
    case "SecurityError":
      head = "Permiso de cámara denegado. Ajustes ▸ Safari ▸ Cámara ▸ Permitir " +
        "(o icono 'aA' de la barra ▸ Ajustes del sitio web ▸ Cámara), y recarga.";
      break;
    case "NotFoundError":
      head = "No se encontró ninguna cámara.";
      break;
    case "NotReadableError":
      head = "La cámara está en uso por otra app. Ciérrala y reintenta.";
      break;
    case "OverconstrainedError":
      head = "La cámara no admite la configuración pedida.";
      break;
    case "TimeoutError":
      head = "La cámara no respondió. Si no salió el diálogo de permiso: " +
        "recarga; si sale y no pasa nada, revisa Ajustes ▸ Safari ▸ Cámara.";
      break;
    default:
      head = "No se pudo abrir la cámara. Requiere HTTPS y Safari real.";
  }
  return `${head}\n[${name}] ${msg}\norigen: ${location.protocol}//${location.host} · secureContext: ${window.isSecureContext}`;
}

// ---------------- layout ----------------
function onResize() {
  overlay.resize();
  if (camera.ready) {
    const { w, h } = camera.setProcessingSize(perf.procMaxSide);
    overlay.setSource(camera.intrinsicWidth, camera.intrinsicHeight, w, h);
  }
}

// ---------------- bucle ----------------
function scheduleFrame() {
  if (!running) return;
  if ("requestVideoFrameCallback" in HTMLVideoElement.prototype) {
    dom.video.requestVideoFrameCallback((now) => frame(now));
  } else {
    requestAnimationFrame((now) => frame(now));
  }
}

function frame(now) {
  scheduleFrame();
  if (document.hidden || !camera.ready) return;

  perf.markFrame(now);
  if (perf.maybeAdjust(now)) {
    const { w, h } = camera.setProcessingSize(perf.procMaxSide);
    overlay.setSource(camera.intrinsicWidth, camera.intrinsicHeight, w, h);
  }
  if (!camera.procW) {
    const { w, h } = camera.setProcessingSize(perf.procMaxSide);
    overlay.setSource(camera.intrinsicWidth, camera.intrinsicHeight, w, h);
  }

  // Sin OpenCV todavía: sólo cámara (Fase 1). No se muestrea el frame.
  if (!cvOk) {
    drawOverlay({ quad: null, contour: null, points: null, confidence: 0 });
    if (!dom.debugPanel.hidden) updateHUD({ quad: null, confidence: 0 });
    return;
  }

  const img = camera.grab();
  if (!img) return;

  frameId++;
  let cvT0 = performance.now();
  let renderState = { quad: null, contour: null, points: null, confidence: 0 };

  if (cvOk) {
    try {
      renderState = step(img);
    } catch (err) {
      // Un fallo puntual de OpenCV no debe romper el bucle.
      console.warn("step error", err);
    }
  }
  perf.markCV(performance.now() - cvT0);

  drawOverlay(renderState);
  updateHUD(renderState);
}

// ---------------- máquina de estados por frame ----------------
function step(img) {
  const minDim = Math.min(img.width, img.height);

  if (machine.is(S.SEARCHING, S.CANDIDATE)) {
    const det = detectCard(img);
    if (det) lastGoodDetection = det;

    if (!det) {
      candidateMiss++;
      if (machine.is(S.CANDIDATE) && candidateMiss >= 2) {
        detHistory = [];
        candidateMiss = 0;
        machine.set(S.SEARCHING);
      }
      return { quad: null, contour: det?.contour || null, points: null, confidence: 0 };
    }

    candidateMiss = 0;
    if (machine.is(S.SEARCHING)) {
      detHistory = [det.quad];
      machine.set(S.CANDIDATE);
    } else {
      const last = detHistory[detHistory.length - 1];
      if (detectionsConsistent(last, det.quad, minDim)) {
        detHistory.push(det.quad);
      } else {
        detHistory = [det.quad]; // empieza de nuevo la cuenta
      }
    }

    if (detHistory.length >= 3) {
      // Lock: arranca el tracking visual sobre estas esquinas.
      const locked = tracker.lock(img, det.quad);
      if (locked) {
        validator.reset();
        validator.seed(det.quad);
        redetectCooldown = 16;
        machine.set(S.TRACKING);
        return {
          quad: det.quad, contour: det.contour, points: tracker.points, confidence: 1,
        };
      }
      detHistory = [];
    }
    return { quad: det.quad, contour: det.contour, points: null, confidence: 0.3 };
  }

  if (machine.is(S.TRACKING)) {
    const tr = tracker.track(img);
    const gray = tracker.currentGray();

    // Face guard opcional (cada 4 frames, sin bloquear).
    let faceBoxes = null;
    if (dom.toggles.faceguard.checked && isFaceGuardReady() && gray && frameId % 4 === 0) {
      try { faceBoxes = detectFaces(gray); } catch (_) { faceBoxes = null; }
    }

    const verdict = gray ? validator.evaluate(tr, gray, faceBoxes) : { lost: true, confidence: 0, checks: null };

    if (verdict.lost) {
      machine.set(S.LOST);
      return { quad: null, contour: null, points: null, confidence: 0, verdict };
    }

    // Re-detección periódica: corrige deriva SIN saltar a otro objeto.
    if (redetectCooldown > 0) redetectCooldown--;
    if (redetectCooldown === 0 && tr.ok) {
      redetectCooldown = 18;
      const fresh = detectCard(img);
      if (fresh && iou(fresh.quad, tr.quad) > 0.55) {
        tracker.resync(img, fresh.quad);
        validator.seed(fresh.quad);
        return { quad: fresh.quad, contour: fresh.contour, points: tracker.points, confidence: verdict.confidence, verdict };
      }
    }

    return {
      quad: tr.ok ? tr.quad : tracker.prevQuad,
      contour: null,
      points: tracker.points,
      confidence: verdict.confidence,
      verdict,
    };
  }

  if (machine.is(S.LOST)) {
    // Ya se ocultó el overlay en onStateChange. Vuelve a buscar de inmediato.
    machine.set(S.SEARCHING);
    return { quad: null, contour: null, points: null, confidence: 0 };
  }

  return { quad: null, contour: null, points: null, confidence: 0 };
}

function detectionsConsistent(a, b, minDim) {
  if (!a || !b) return false;
  const ca = centroid(a), cb = centroid(b);
  const d = Math.hypot(ca.x - cb.x, ca.y - cb.y);
  const aa = shoelaceArea(a), ab = shoelaceArea(b);
  const areaRel = Math.abs(aa - ab) / Math.max(aa, ab, 1);
  return d < minDim * 0.08 && areaRel < 0.28;
}

// ---------------- transiciones ----------------
function onStateChange(next, prev) {
  if (next === S.LOST) {
    // OBLIGATORIO: ocultar overlay + soltar tracker + reiniciar validador.
    tracker.release();
    validator.reset();
    detHistory = [];
    candidateMiss = 0;
    lostFlashUntil = performance.now() + 500;
  }
  if (next === S.SEARCHING && prev === S.LOST) {
    detHistory = [];
  }
}

function hardReset() {
  tracker.release();
  validator.reset();
  detHistory = [];
  candidateMiss = 0;
  lastGoodDetection = null;
  machine.set(S.SEARCHING);
}

// ---------------- render + HUD ----------------
function drawOverlay(rs) {
  const st = machine.state;
  overlay.render({
    state: st,
    quad: rs.quad,
    contour: rs.contour,
    points: rs.points,
    confidence: rs.confidence,
    perf: document.body.classList.contains("perf"),
    toggles: {
      corners: dom.toggles.corners.checked,
      quad: dom.toggles.quad.checked,
      points: dom.toggles.points.checked,
      homography: dom.toggles.homography.checked,
      contour: dom.toggles.contour.checked,
    },
  });

  // Pill de estado
  const now = performance.now();
  let label = st;
  let cls = "";
  if (now < lostFlashUntil) { label = "CARD LOST"; cls = "lost"; }
  else if (st === S.TRACKING) cls = "tracking";
  else if (st === S.CANDIDATE) cls = "candidate";
  dom.statusPill.textContent = label;
  dom.statusPill.className = "status-pill " + cls;
}

function updateHUD(rs) {
  if (dom.debugPanel.hidden) return;
  const h = dom.hud;
  h.fps.textContent = perf.fps;
  h.cvms.textContent = perf.cvMs.toFixed(1);
  h.proc.textContent = camera.procW ? `${camera.procW}×${camera.procH}` : "–";
  h.state.textContent = machine.state;

  const tracking = machine.state === S.TRACKING;
  const c = rs.verdict?.checks || {};
  h.card.textContent = tracking ? "DETECTED" : "LOST";
  h.card.style.color = tracking ? "#16f0b8" : "#ff4d5e";
  h.track.textContent = tracking && rs.quad ? "ACTIVE" : "LOST";
  h.track.style.color = tracking && rs.quad ? "#16f0b8" : "#ff4d5e";
  h.conf.textContent = (rs.confidence || 0).toFixed(2);
  h.pts.textContent = rs.points ? rs.points.length : 0;
  h.ncc.textContent = (c.ncc ?? 0).toFixed(2);
  h.inlier.textContent = (c.inlierRatio ?? 0).toFixed(2);
  h.aspect.textContent = (c.aspect ?? 0).toFixed(2);
  h.edges.textContent = (c.edgeSupport ?? 0).toFixed(2);

  const q = rs.quad;
  const fmt = (p) => (p ? `${p.x.toFixed(0)},${p.y.toFixed(0)}` : "–");
  h.tl.textContent = fmt(q?.[0]);
  h.tr.textContent = fmt(q?.[1]);
  h.br.textContent = fmt(q?.[2]);
  h.bl.textContent = fmt(q?.[3]);
}
