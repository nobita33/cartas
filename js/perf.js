// perf.js — medidor de FPS y resolución de procesamiento adaptativa.
//
// Prioridad del proyecto: ESTABILIDAD > CALIDAD DE DETECCIÓN > EFECTOS.
// Si el bucle de visión se pasa de presupuesto de tiempo, bajamos el lado de
// procesamiento. Si sobra, lo subimos hasta un tope. La cámara sigue en alta
// resolución; sólo cambia el buffer que analiza OpenCV.

const LADDER = [320, 384, 448, 512, 576];
const DEFAULT_INDEX = 2; // 448

export class Perf {
  constructor() {
    this.frameTimes = [];
    this.cvMs = 0;           // media móvil del coste del bucle de visión
    this.fps = 0;
    this._idx = DEFAULT_INDEX;
    this._lastAdjust = 0;
    this._last = performance.now();
  }

  get procMaxSide() { return LADDER[this._idx]; }

  markFrame(now) {
    const dt = now - this._last;
    this._last = now;
    this.frameTimes.push(dt);
    if (this.frameTimes.length > 30) this.frameTimes.shift();
    const avg = this.frameTimes.reduce((a, b) => a + b, 0) / this.frameTimes.length;
    this.fps = avg > 0 ? Math.min(60, Math.round(1000 / avg)) : 0;
  }

  markCV(ms) {
    // EMA para suavizar picos.
    this.cvMs = this.cvMs === 0 ? ms : this.cvMs * 0.8 + ms * 0.2;
  }

  // Llamar una vez por frame. Devuelve true si cambió la resolución.
  maybeAdjust(now) {
    if (now - this._lastAdjust < 1200) return false; // no oscilar
    let changed = false;
    if (this.cvMs > 42 && this._idx > 0) { this._idx--; changed = true; }
    else if (this.cvMs < 20 && this._idx < LADDER.length - 1) { this._idx++; changed = true; }
    if (changed) this._lastAdjust = now;
    return changed;
  }
}
