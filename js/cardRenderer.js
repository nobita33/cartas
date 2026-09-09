// cardRenderer.js — STUB (Fase 7).
//
// Todavía no implementado: en el MVP actual (Fases 1–5) la "carta digital" es el
// relleno translúcido del quad que dibuja debugOverlay.js, cuyo único fin es
// demostrar visualmente que el lock se pega a la carta y desaparece al perderla.
//
// Plan de la Fase 7 (render real con homografía):
//   · Textura única de carta (una sola imagen del AS de picas completo, con
//     esquinas redondeadas, borde, marco interior, índice, símbolo, aspecto 5:7,
//     leves imperfecciones de cartulina). Generada por Canvas/SVG en drawCardTexture().
//   · WebGL: un quad con la textura y una matriz de homografía 3x3 pasada como
//     uniform mat3; el fragment shader hace el sampling proyectivo. Alternativa
//     Canvas 2D: subdivisión del quad en triángulos + setTransform por triángulo.
//   · La homografía se calcula desde SOURCE (0,0)-(W,0)-(W,H)-(0,H) hacia las 4
//     esquinas trackeadas cada frame -> perspectiva idéntica a la carta física.
//   · Capa independiente sobre el vídeo; nunca se toca el frame original.
//
// API prevista:
//   const r = new CardRenderer(glOrCanvas);
//   r.setTexture(imageBitmap);
//   r.draw(quad /* proc-space */, mapProcToDisplay);

export class CardRenderer {
  constructor() {
    throw new Error("CardRenderer: pendiente de Fase 7");
  }
}
