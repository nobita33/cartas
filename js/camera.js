// camera.js — acceso a la cámara trasera vía getUserMedia y muestreo de frames.
//
// Notas iOS/Safari:
//  - getUserMedia sólo funciona sobre HTTPS (o localhost).
//  - El <video> DEBE tener el atributo `playsinline`, si no iOS lo abre en pantalla
//    completa nativa y no se puede componer el overlay encima.
//  - `facingMode: { exact: 'environment' }` puede lanzar OverconstrainedError en
//    algunos iPhone; usamos `ideal` y reintentamos sin restricción.
//  - La resolución real la decide el sistema; se lee de video.videoWidth/Height.

export class Camera {
  constructor(videoEl) {
    this.video = videoEl;
    this.stream = null;
    this.grabCanvas = document.createElement("canvas");
    this.grabCtx = this.grabCanvas.getContext("2d", { willReadFrequently: true });
    this.procW = 0;
    this.procH = 0;
  }

  get ready() {
    return this.video.readyState >= 2 && this.video.videoWidth > 0;
  }

  get intrinsicWidth() { return this.video.videoWidth; }
  get intrinsicHeight() { return this.video.videoHeight; }

  async start() {
    const attempts = [
      { video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } }, audio: false },
      { video: { facingMode: "environment" }, audio: false },
      { video: true, audio: false },
    ];
    let lastErr = null;
    for (const constraints of attempts) {
      try {
        this.stream = await navigator.mediaDevices.getUserMedia(constraints);
        break;
      } catch (e) {
        lastErr = e;
        if (e.name === "NotAllowedError" || e.name === "SecurityError") throw e; // permiso denegado: no reintentar
      }
    }
    if (!this.stream) throw lastErr || new Error("No se pudo abrir la cámara");

    this.video.srcObject = this.stream;
    this.video.setAttribute("playsinline", "");
    this.video.muted = true;

    await new Promise((resolve, reject) => {
      const onMeta = () => { this.video.removeEventListener("loadedmetadata", onMeta); resolve(); };
      this.video.addEventListener("loadedmetadata", onMeta);
      setTimeout(() => reject(new Error("timeout esperando metadata de vídeo")), 8000);
    });
    await this.video.play();
    return { width: this.intrinsicWidth, height: this.intrinsicHeight };
  }

  stop() {
    if (this.stream) {
      for (const t of this.stream.getTracks()) t.stop();
      this.stream = null;
    }
    this.video.srcObject = null;
  }

  // Fija el tamaño del buffer de procesamiento manteniendo el aspect ratio.
  // maxSide limita el lado mayor (rendimiento). Devuelve {w, h}.
  setProcessingSize(maxSide) {
    const vw = this.intrinsicWidth;
    const vh = this.intrinsicHeight;
    if (!vw || !vh) return { w: 0, h: 0 };
    const s = Math.min(1, maxSide / Math.max(vw, vh));
    this.procW = Math.round(vw * s);
    this.procH = Math.round(vh * s);
    this.grabCanvas.width = this.procW;
    this.grabCanvas.height = this.procH;
    return { w: this.procW, h: this.procH };
  }

  // Copia el frame actual del vídeo al canvas de procesamiento y devuelve el ImageData
  // (RGBA, tamaño procW×procH). No toca el vídeo original.
  grab() {
    if (!this.ready || !this.procW) return null;
    this.grabCtx.drawImage(this.video, 0, 0, this.procW, this.procH);
    return this.grabCtx.getImageData(0, 0, this.procW, this.procH);
  }
}
