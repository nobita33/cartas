// stateMachine.js — máquina de estados explícita del ciclo de vida de la carta.
//
//   IDLE ──(cámara lista)──► SEARCHING
//   SEARCHING ──(1ª detección válida)──► CANDIDATE
//   CANDIDATE ──(N detecciones consistentes)──► TRACKING
//   CANDIDATE ──(fallos)──► SEARCHING
//   TRACKING ──(validador: lost)──► LOST
//   LOST ──(inmediato, tras ocultar overlay)──► SEARCHING
//
// La transición a LOST está OBLIGADA a: ocultar overlay + soltar el tracker +
// volver a buscar. No existe ningún camino en el que el tracking "siga vivo"
// sin una carta validada.

export const S = {
  IDLE: "IDLE",
  SEARCHING: "SEARCHING",
  CANDIDATE: "CANDIDATE",
  TRACKING: "TRACKING",
  LOST: "LOST",
};

export class StateMachine {
  constructor(onChange) {
    this.state = S.IDLE;
    this.since = performance.now();
    this.onChange = onChange || (() => {});
  }

  set(next) {
    if (next === this.state) return;
    const prev = this.state;
    this.state = next;
    this.since = performance.now();
    this.onChange(next, prev);
  }

  is(...states) { return states.includes(this.state); }
  elapsed() { return performance.now() - this.since; }
}
