# Magic Camera

Aplicación web para iPhone/Safari que usa la cámara trasera para detectar una
carta física real, seguir sus 4 esquinas en tiempo real y (más adelante) colocar
encima una carta digital con perspectiva correcta.

Todo el procesamiento de imagen ocurre **en el dispositivo**. No se sube vídeo ni
frames a ningún servidor. No hay backend.

Este repositorio contiene el MVP de las **Fases 1–5**:

1. Cámara a pantalla completa (getUserMedia, `facingMode: environment`).
2. Detección de un cuadrilátero con forma de carta.
3. Cálculo de las 4 esquinas (TL, TR, BR, BL) con precisión sub-píxel.
4. Tracking visual real de esas esquinas entre frames.
5. Detección de pérdida de la carta (**CARD LOST**) con ocultado inmediato del
   overlay y reinicio de la búsqueda.

Las fases siguientes (homografía de render, carta digital realista, efecto de
transformación 9♥→A♠) están documentadas como *stubs* en `js/cardRenderer.js` y
`js/effectEngine.js`, sin implementar todavía.

---

## Cómo probarlo en el iPhone

getUserMedia **exige HTTPS** (o `localhost`). El iPhone no es `localhost`, así que
necesitas un origen HTTPS real. La vía recomendada es Vercel.

### Opción A — Vercel (recomendada)

1. Sube esta carpeta `magic-camera/` a un repositorio Git.
2. En Vercel: *New Project* → importa el repo.
3. **Framework Preset:** *Other*. **Root Directory:** `magic-camera`.
   **Build Command:** vacío. **Output Directory:** `.` (la raíz).
4. Deploy. Vercel te da una URL `https://…vercel.app`.
5. En el iPhone, abre esa URL **en Safari** (no dentro de Instagram, X, etc.: los
   navegadores embebidos en otras apps no dan acceso a la cámara).
6. Pulsa **START CAMERA** y acepta el permiso de cámara.

Si ya habías denegado el permiso: *Ajustes ▸ Safari ▸ Cámara ▸ Preguntar/Permitir*,
o mantén pulsado el botón de recarga en la barra de direcciones ▸ *Configuración
del sitio web*.

### Opción B — servidor local con HTTPS en la misma red

Necesitas un certificado de confianza; Safari iOS es estricto con los
autofirmados. Lo más simple es [`mkcert`](https://github.com/FiloSottile/mkcert):

```bash
mkcert -install
mkcert 192.168.1.50   # la IP LAN de tu ordenador
npx http-server ./magic-camera -S -C 192.168.1.50.pem -K 192.168.1.50-key.pem -p 8443
```

Luego, en el iPhone (misma Wi-Fi): `https://192.168.1.50:8443`.
Alternativa rápida sin certificados: un túnel como `cloudflared tunnel --url http://localhost:8080`
o `ngrok http 8080`, que te dan una URL HTTPS pública temporal.

### Parámetros de URL útiles

- `?nocv` — no carga OpenCV.js. Sólo cámara + UI (para depurar la Fase 1).

---

## Uso

- **START CAMERA** — abre la cámara trasera a pantalla completa.
- Pon una carta delante. Cuando el sistema la valida durante 3 frames seguidos,
  pasa a **TRACKING** y aparece un relleno translúcido pegado a la carta (marcador
  provisional de la "carta digital"; la textura realista llega en la Fase 7).
- **DEBUG** — panel con FPS, coste del bucle de visión, estado, confianza, NCC,
  ratio de inliers, aspecto, soporte de bordes, coordenadas de las 4 esquinas, y
  toggles: *corners / quadrilateral / tracking points / FPS / confidence /
  homography / detected contour / face guard*.
- **PERF** — Performance Mode: oculta absolutamente todo menos la cámara y el
  overlay del efecto. Se sale con **doble toque** en la pantalla.
- **RESET** — suelta el tracking actual y vuelve a buscar carta.

---

## Arquitectura

```
magic-camera/
  index.html
  css/style.css
  js/
    app.js            Orquestación: bucle por frame + máquina de estados + UI/HUD
    camera.js         getUserMedia, <video>, muestreo de frames a buffer reducido
    cv.js             Carga perezosa de OpenCV.js + gestión de memoria (scope/delete)
    stateMachine.js   IDLE → SEARCHING → CANDIDATE → TRACKING → LOST → SEARCHING
    cardDetector.js   Detección del cuadrilátero-carta (Canny + contornos + filtros)
    cardTracker.js    Optical flow Lucas-Kanade + forward-backward + homografía RANSAC
    cardValidator.js  Multi-check por frame + confianza + decisión CARD LOST
    faceGuard.js      Detector de caras Haar OPCIONAL (guardián anti-cara explícito)
    geometry.js       Utilidades 2D puras (orden de esquinas, área, convexidad, IoU…)
    homography.js     Homografía 3x3 en JS puro (DLT) para malla de debug y Fase 7
    debugOverlay.js   Capa canvas independiente sobre el vídeo (no toca el vídeo)
    perf.js           FPS + resolución de procesamiento adaptativa
    cardRenderer.js   STUB — Fase 7 (render de la carta digital con homografía)
    effectEngine.js   STUB — Fase 8 (transformación 9♥ → A♠)
    vendor/opencv.js  OpenCV.js 4.9.0 (vendorizado, sin CDN en runtime)
  assets/cards/
    ace-of-spades.svg     Provisional (Fase 7 usará una textura de cartulina completa)
    nine-of-hearts.svg    Provisional
  vercel.json
```

### Pipeline por frame

```
<video>  ──►  grab a buffer reducido (≈320–576 px lado mayor, según rendimiento)
             │
             ▼
     ┌───────────────────────────────┐
     │ SEARCHING / CANDIDATE         │  detectCard() cada frame
     │  gris → blur → Canny → cierre │  + exige 3 detecciones consistentes
     │  → findContours → filtros     │
     └───────────────┬───────────────┘
                     ▼  lock
     ┌───────────────────────────────┐
     │ TRACKING                      │  cada frame:
     │  calcOpticalFlowPyrLK         │   1. flujo óptico de los features
     │  + filtro forward-backward    │   2. descarta correspondencias falsas
     │  + findHomography(RANSAC)     │   3. H(prev→actual)
     │  → proyecta las 4 esquinas    │   4. nuevas esquinas
     │  + NCC contra template canón. │   5. ¿se sigue pareciendo a la carta?
     │  + re-siembra de features     │
     │  + re-detección periódica     │   corrige deriva sin saltar a otro objeto
     └───────────────┬───────────────┘
                     ▼  cardValidator: confidence < umbral N frames seguidos
     ┌───────────────────────────────┐
     │ LOST  →  oculta overlay,      │
     │         suelta tracker,       │
     │         vuelve a SEARCHING    │
     └───────────────────────────────┘
```

El overlay es un `<canvas>` transparente encima del `<video>`; el vídeo original
nunca se modifica.

---

## Explicación técnica

### 1. Algoritmo utilizado

- **Detección:** visión clásica con OpenCV.js — escala de grises, desenfoque
  gaussiano, bordes de Canny, cierre morfológico, `findContours`, y para cada
  contorno `approxPolyDP` + una batería de restricciones geométricas de carta.
- **Tracking:** flujo óptico piramidal **Lucas-Kanade** (`calcOpticalFlowPyrLK`)
  sobre *features* (`goodFeaturesToTrack`), con **verificación forward-backward** y
  una **homografía RANSAC** (`findHomography`) que convierte el movimiento de los
  puntos en una transformación proyectiva de las 4 esquinas.
- **Validación / pérdida:** combinación de métricas independientes por frame
  (supervivencia de features, inliers RANSAC, **NCC** contra un *template* canónico
  de la carta, relación de aspecto, geometría del cuadrilátero, área, y soporte de
  gradiente en las aristas), con tolerancia de varios frames.

No se usa ML pesado. Un detector Haar de caras es **opcional** y sólo como
guardián extra.

### 2. Cómo se detecta la carta

`cardDetector.js`, todo sobre el buffer reducido:

1. RGBA → gris → `GaussianBlur` 5×5.
2. `Canny(60, 180)` + `morphologyEx(MORPH_CLOSE)` para unir tramos de borde.
3. `findContours(RETR_LIST)`.
4. Por contorno:
   - Área entre el **2 %** y el **92 %** del frame.
   - `approxPolyDP` con ε = 2 % del perímetro (y 3.5 % como respaldo) → exige
     exactamente **4 vértices**.
   - `isContourConvex` → descarta cóncavos.
   - **Rectangularidad** = área del contorno / área de `minAreaRect` ≥ **0.78**.
   - **Relación de aspecto** del `minAreaRect` entre **1.12 y 2.00** (una carta de
     poker es 2.5×3.5 ≈ **1.40**; el margen absorbe la perspectiva).
   - **Solidez** = área / área del casco convexo ≥ **0.90** → descarta siluetas
     dentadas (manos, pliegues de ropa).
5. Se puntúa cada candidato (`rectangularidad + solidez − |aspecto−1.4| + tamaño`)
   y se queda el mejor.
6. Si Canny no encuentra nada, **fallback** con `adaptiveThreshold` en las dos
   polaridades.
7. Se exige que la detección sea **consistente durante 3 frames** (mismo centro
   ±8 % y misma área ±28 %) antes de hacer *lock*. Esto evita falsos positivos con
   un objeto rectangular que aparece un frame suelto.

### 3. Cómo se calculan las esquinas

- Los 4 vértices salen de `approxPolyDP`.
- Se **ordenan** a TL, TR, BR, BL con el truco suma/resta: TL = menor `x+y`,
  BR = mayor `x+y`, TR = menor `y−x`, BL = mayor `y−x` (con respaldo por ordenado
  angular si hay degeneración).
- Se **afinan a sub-píxel** con `cornerSubPix` sobre la imagen en gris (ventana
  5×5). Si una esquina cae pegada al borde del frame y `cornerSubPix` falla, se
  mantiene la de `approxPolyDP`.
- Durante el tracking, las esquinas ya **no** se vuelven a detectar cada frame:
  se **proyectan** por la homografía del movimiento (ver punto 4). Cada ~18 frames
  hay una re-detección de control para corregir deriva acumulada, pero sólo se
  aplica si el cuadrilátero fresco **solapa** (IoU > 0.55) al que se está
  siguiendo; si no, se ignora (no se salta a otro objeto).

### 4. Cómo se hace el tracking

`cardTracker.js`, cada frame:

1. En el *lock*: `goodFeaturesToTrack` dentro del cuadrilátero (máscara
   **erosionada** para no coger puntos del borde de la mesa), hasta 110 puntos.
   Se guarda además un **template canónico**: la carta des-proyectada a un
   rectángulo 120×168 en gris (vía `getPerspectiveTransform` + `warpPerspective`).
2. `calcOpticalFlowPyrLK(prevGray → gray)` sigue esos puntos (ventana 21×21,
   2 niveles de pirámide).
3. **Forward-backward:** se re-trackea `gray → prevGray` y se descarta todo punto
   cuyo viaje de ida y vuelta se desvíe más de **1.6 px**. Esto elimina las
   correspondencias inventadas por el flujo — que son justo las que harían que el
   tracker "resbalara" hacia una cara o una pared.
4. `findHomography(RANSAC, 3 px)` con los puntos supervivientes → matriz **H** del
   frame anterior al actual. Se comprueba que **H** no sea degenerada
   (determinante de la parte lineal en un rango sano, sin reflexión ni colapso).
5. Las 4 esquinas anteriores se pasan por **H** → nuevas esquinas.
6. **Re-siembra:** si quedan menos de 26 inliers, se vuelve a llamar a
   `goodFeaturesToTrack` dentro del nuevo cuadrilátero y se completan.
7. Se calcula el **NCC** (`matchTemplate` `TM_CCOEFF_NORMED`) entre el template y
   el contenido actual des-proyectado. Si el parecido es alto (> 0.72) el template
   se actualiza **muy despacio** (92 % / 8 %) para seguir cambios de luz — pero
   nunca lo bastante rápido como para "aprender" una cara.

Resultado: las esquinas van pegadas a la carta cuando gira, se inclina, se acerca
o se aleja, porque lo que se propaga es una **homografía real**, no una traslación
ni una caja rígida.

### 5. Cómo se detecta que la carta ha desaparecido

`cardValidator.js` calcula una **confianza 0–1** por frame combinando:

| Señal | Qué mide | Peso |
|---|---|---|
| `ncc` | parecido con el template de la carta | 0.32 |
| `inlierRatio` | fracción de inliers RANSAC (rigidez planar) | 0.22 |
| `edgeSupport` | las 4 aristas caen sobre gradientes reales (Sobel) | 0.16 |
| `survivalRatio` | features que sobreviven a flujo + forward-backward | 0.12 |
| `aspect` | proporción ~1.4 y coherente con su historial | 0.12 |
| `area` | sin colapsos/explosiones respecto a su media móvil | 0.06 |

Además hay **puertas geométricas** booleanas (convexo, sin auto-intersección,
ángulos interiores 33°–147°, lado mínimo, centro dentro del frame). Si alguna
falla, la confianza se multiplica por 0.15.

Decisión:

- `confidence < 0.42` **o** puerta geométrica rota → cuenta como frame malo.
- **5 frames malos seguidos** → `CARD LOST`. Un frame malo aislado no pierde la
  carta (tolerancia a *motion blur* / oclusiones breves). Cinco frames son
  ≈ 150–330 ms: al retirar la carta el overlay desaparece casi al instante.
- **Catástrofe** (pérdida inmediata, sin tolerancia): cuadrilátero imposible
  con NCC muy bajo, o NCC casi nulo con inliers casi nulos, o el *face guard*.

Al entrar en `LOST`, `app.js` **obliga** a: `tracker.release()` +
`validator.reset()` + ocultar overlay + volver a `SEARCHING`. No existe ningún
camino de código en el que el tracking siga vivo sin una carta validada.

### 6. Cómo se evita que el tracking se vaya a la cara

Cuatro barreras, de más a menos importante:

1. **NCC contra el template canónico.** Es la barrera decisiva. Al retirar la
   carta, aunque el flujo óptico arrastre las esquinas hacia tu cara, el contenido
   des-proyectado dentro del cuadrilátero deja de parecerse a la carta original y
   el NCC se desploma. El template se actualiza tan despacio que nunca "aprende"
   la cara.
2. **Filtro forward-backward.** La piel tiene pocas esquinas estables; las
   correspondencias que el flujo inventa sobre una cara no pasan el viaje de ida y
   vuelta, así que RANSAC se queda sin puntos y `inlierRatio` cae.
3. **Relación de aspecto + geometría.** Una cara no sostiene un cuadrilátero
   convexo de proporción ~1.4 mientras te mueves; en cuanto la geometría se vuelve
   imposible para una carta, la puerta geométrica se cierra.
4. **`edgeSupport` (Sobel).** Las 4 aristas del cuadrilátero de una carta caen
   sobre bordes con gradiente fuerte. Sobre una mejilla, una camiseta o una pared
   lisa no hay ese gradiente y el soporte de bordes cae.
5. **Face guard opcional (Haar).** Si lo activas en DEBUG, cuando una caja de cara
   solapa > 45 % el cuadrilátero **y** el NCC es bajo, se fuerza `CARD LOST`
   inmediato.

### 7. Limitaciones de Safari / iPhone

- **HTTPS obligatorio** para `getUserMedia` (o `localhost`, que el iPhone no es).
- El `<video>` **debe** llevar `playsinline`; si no, iOS lo abre en pantalla
  completa nativa y no se puede componer el overlay.
- `facingMode: { exact: 'environment' }` puede lanzar `OverconstrainedError` en
  algunos iPhone; se usa `ideal` y se reintenta.
- Los navegadores **embebidos** en otras apps (Instagram, X, Gmail…) no dan
  acceso a la cámara. Tiene que ser Safari.
- OpenCV.js son ~10 MB de JS + WASM. La primera carga tarda unos segundos y el
  *compile* del WASM bloquea el hilo principal un instante. Aquí se carga de forma
  perezosa al pulsar START.
- **Sin hilos en OpenCV**: activar los `pthreads` de WASM requiere las cabeceras
  COOP/COEP, que a su vez complican cargar recursos de terceros. Este proyecto
  corre OpenCV **monohilo**, por eso el análisis va en un buffer reducido.
- `requestVideoFrameCallback` existe desde iOS 15.4 (se usa si está; si no,
  `requestAnimationFrame`).
- La cámara de iOS suele entregar **~30 fps** reales. "60 fps" es un objetivo para
  el pintado del overlay, no para el pipeline de visión. El *target* real es
  15–30 fps de análisis sobre 320–576 px, con la cámara en alta resolución sólo
  para mostrar.
- El **Modo de Bajo Consumo** de iOS limita `requestAnimationFrame` y los timers.
- Al pasar Safari a segundo plano, el stream se pausa; el bucle se reanuda al
  volver.
- La gestión de memoria de OpenCV.js es manual: cada `Mat` se libera a mano
  (`cv.js` centraliza esto con `scope()`); si se escapa alguno, Safari mata la
  pestaña en segundos.
- Rendimiento realista en iPhone moderno: detección + tracking estables. El
  render con homografía y el efecto de transformación (Fases 7–8) tendrán que
  cuidar mucho el presupuesto de GPU/CPU.

**Qué NO es fiable en Safari/iPhone y por qué no se ha hecho así:** no hay una API
de visión nativa del navegador (tipo `Shape Detection`) que funcione de forma
consistente en Safari; `BarcodeDetector` no aplica a cartas; los modelos de
segmentación en `WebGL`/`WebGPU` son pesados y `WebGPU` en Safari iOS es aún
irregular. Por eso el enfoque es visión clásica (Canny + contornos + Lucas-Kanade
+ homografía), que es lo más fiable hoy en ese entorno.

### 8. Cómo probarlo en tu iPhone (resumen)

1. Despliega `magic-camera/` en Vercel (Root Directory = `magic-camera`, sin build).
2. Abre la URL `https://…vercel.app` **en Safari** del iPhone.
3. **START CAMERA** → acepta el permiso.
4. Fondo liso y contrastado (p. ej. carta clara sobre una superficie oscura mate),
   buena luz, sin reflejos directos.
5. Abre **DEBUG** y activa *corners*, *quadrilateral*, *tracking points*,
   *confidence*, *detected contour*.
6. Ejecuta los tests:
   - Carta quieta → tracking estable, confianza alta.
   - Carta girando / inclinada / acercándose / alejándose → las 4 esquinas siguen
     pegadas; el marcador cambia de tamaño y perspectiva con ella.
   - Mover rápido → el tracker sigue, o pierde limpiamente (sin quedarse enganchado).
   - **Retirar la carta → el overlay desaparece en ~0.2 s y NO salta a tu cara,
     tu mano ni la pared.**
   - Volver a poner la carta → nueva detección, nuevo tracking.
7. **PERF** para ver la experiencia limpia (doble toque para salir).

---

## Notas

- Las imágenes SVG de `assets/cards/` son **provisionales**. La Fase 7 generará
  una textura de carta completa (cartulina, esquinas redondeadas, borde, marco
  interior, índice, símbolo, aspecto 5:7, imperfecciones sutiles) como **una sola
  textura** que se deforma por homografía; no se dibujará el "AS" por separado.
- Sin analítica, sin cookies, sin red en runtime (OpenCV va vendorizado).
