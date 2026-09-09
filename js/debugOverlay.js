// debugOverlay.js — dibuja sobre un canvas transparente encima del vídeo.
// NO modifica el vídeo original: es una capa independiente.
//
// Mapea coordenadas de proc-space (buffer reducido que analiza OpenCV) al espacio
// CSS del vídeo, usando la MISMA matemática "cover" que object-fit: cover del <video>,
// para que el quad quede pegado a la carta real en pantalla.

import { computeHomography, warpGrid } from "./homography.js";

const CORNER_COLORS = ["#ff4d5e", "#ffd23f", "#16f0b8", "#4d9bff"];
const CORNER_LABELS = ["TL", "TR", "BR", "BL"];

export class Overlay {
  constructor(canvasEl) {
    this.canvas = canvasEl;
    this.ctx = canvasEl.getContext("2d");
    this.dpr = 1;
    this.cssW = 0;
    this.cssH = 0;
    this._map = null;
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.cssW = rect.width;
    this.cssH = rect.height;
    this.canvas.width = Math.round(rect.width * this.dpr);
    this.canvas.height = Math.round(rect.height * this.dpr);
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this._recomputeMap();
  }

  setSource(intrinsicW, intrinsicH, procW, procH) {
    this._intrinsic = { w: intrinsicW, h: intrinsicH };
    this._proc = { w: procW, h: procH };
    this._recomputeMap();
  }

  _recomputeMap() {
    if (!this._intrinsic || !this._proc || !this.cssW) { this._map = null; return; }
    const { w: iw, h: ih } = this._intrinsic;
    const procScale = this._proc.w / iw; // proc = intrinsic * procScale
    const cover = Math.max(this.cssW / iw, this.cssH / ih);
    const offX = (this.cssW - iw * cover) / 2;
    const offY = (this.cssH - ih * cover) / 2;
    this._map = (p) => ({
      x: offX + (p.x / procScale) * cover,
      y: offY + (p.y / procScale) * cover,
    });
  }

  clear() {
    this.ctx.clearRect(0, 0, this.cssW, this.cssH);
  }

  // frame = { state, quad, contour, points, confidence, toggles, perf }
  render(frame) {
    this.clear();
    const m = this._map;
    if (!m) return;
    const ctx = this.ctx;
    const { quad, toggles, perf } = frame;

    // --- Capa "efecto": relleno del quad bloqueado (marcador de la carta digital) ---
    if (quad && (frame.state === "TRACKING" || frame.state === "CANDIDATE")) {
      const q = quad.map(m);
      ctx.beginPath();
      ctx.moveTo(q[0].x, q[0].y);
      for (let i = 1; i < 4; i++) ctx.lineTo(q[i].x, q[i].y);
      ctx.closePath();
      if (perf) {
        ctx.fillStyle = "rgba(255,255,255,0.09)";
        ctx.fill();
        ctx.strokeStyle = "rgba(255,255,255,0.45)";
        ctx.lineWidth = 1.5;
        ctx.stroke();
      } else {
        ctx.fillStyle = frame.state === "TRACKING" ? "rgba(22,240,184,0.16)" : "rgba(255,210,63,0.14)";
        ctx.fill();
      }
    }

    if (perf) return; // en performance mode NO se dibuja nada de debug

    // --- Contorno detectado ---
    if (toggles.contour && frame.contour && frame.contour.length > 2) {
      const cpts = frame.contour.map(m);
      ctx.beginPath();
      ctx.moveTo(cpts[0].x, cpts[0].y);
      for (let i = 1; i < cpts.length; i++) ctx.lineTo(cpts[i].x, cpts[i].y);
      ctx.closePath();
      ctx.strokeStyle = "rgba(80,255,120,0.9)";
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    // --- Malla de homografía ---
    if (toggles.homography && quad) {
      const H = computeHomography(
        [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }],
        quad
      );
      if (H) {
        const grid = warpGrid(H, 5, 1, 1);
        ctx.strokeStyle = "rgba(255,255,255,0.35)";
        ctx.lineWidth = 1;
        for (let r = 0; r < grid.length; r++) {
          ctx.beginPath();
          for (let cIdx = 0; cIdx < grid[r].length; cIdx++) {
            const p = m(grid[r][cIdx]);
            cIdx === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y);
          }
          ctx.stroke();
        }
        for (let cIdx = 0; cIdx < grid[0].length; cIdx++) {
          ctx.beginPath();
          for (let r = 0; r < grid.length; r++) {
            const p = m(grid[r][cIdx]);
            r === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y);
          }
          ctx.stroke();
        }
      }
    }

    // --- Cuadrilátero ---
    if (toggles.quad && quad) {
      const q = quad.map(m);
      ctx.beginPath();
      ctx.moveTo(q[0].x, q[0].y);
      for (let i = 1; i < 4; i++) ctx.lineTo(q[i].x, q[i].y);
      ctx.closePath();
      ctx.strokeStyle = frame.state === "TRACKING" ? "#16f0b8" : "#ffd23f";
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    // --- Puntos de tracking ---
    if (toggles.points && frame.points && frame.points.length) {
      ctx.fillStyle = "rgba(255,255,255,0.85)";
      for (const p of frame.points) {
        const mp = m(p);
        ctx.beginPath();
        ctx.arc(mp.x, mp.y, 1.6, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // --- Esquinas + etiquetas ---
    if (toggles.corners && quad) {
      for (let i = 0; i < 4; i++) {
        const p = m(quad[i]);
        ctx.beginPath();
        ctx.arc(p.x, p.y, 6, 0, Math.PI * 2);
        ctx.fillStyle = CORNER_COLORS[i];
        ctx.fill();
        ctx.fillStyle = "#fff";
        ctx.font = "bold 11px -apple-system, sans-serif";
        ctx.fillText(CORNER_LABELS[i], p.x + 9, p.y - 9);
      }
    }
  }
}
