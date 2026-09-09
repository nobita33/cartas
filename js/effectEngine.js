// effectEngine.js — STUB (Fase 8).
//
// Todavía no implementado. Plan de la transformación 9♥ -> A♠:
//   · Dos texturas de carta completas (source y target), ambas renderizadas con
//     la MISMA homografía del frame actual, así que el efecto sigue la carta
//     física aunque se mueva durante la animación (el tracking NO se congela).
//   · Duración 300–500 ms. Técnicas a probar: crossfade + máscara de barrido +
//     displacement muy leve + micro-blur. Nada de animación "de interfaz":
//     debe parecer que el diseño de la cartulina cambia físicamente.
//   · El bucle de tracking sigue corriendo; effectEngine sólo interpola el mix
//     entre texturas y se lo pasa a CardRenderer.
//
// API prevista:
//   const fx = new EffectEngine(renderer);
//   fx.transform(sourceTex, targetTex, { durationMs: 400 });
//   fx.update(nowMs); // llamado cada frame; devuelve progreso 0..1

export class EffectEngine {
  constructor() {
    throw new Error("EffectEngine: pendiente de Fase 8");
  }
}
