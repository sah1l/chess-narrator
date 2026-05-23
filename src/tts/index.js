import * as system from "./engines/system.js";
import * as edge from "./engines/edge.js";
import * as kokoro from "./engines/kokoro.js";
import * as hyperframes from "./engines/hyperframes.js";

const ENGINES = { system, edge, kokoro, hyperframes };

export const DEFAULT_ENGINE = "system";

/**
 * Get a TTS engine by name. Throws on unknown names.
 * @param {"system"|"edge"|"kokoro"|"hyperframes"} name
 * @returns {{ synthesize: Function, listVoices: Function }}
 */
export function getEngine(name = DEFAULT_ENGINE) {
  const engine = ENGINES[name];
  if (!engine) {
    throw new Error(
      `Unknown TTS engine "${name}". Valid: ${Object.keys(ENGINES).join(", ")}`
    );
  }
  return engine;
}

export { readWavDuration } from "./duration.js";
export { synthesizeScript } from "./synthesize.js";
