import * as ffmpeg from "./ffmpeg.js";
import * as hyperframes from "./hyperframes.js";

export { renderBoardSvg } from "./board.js";
export {
  renderShotPage,
  renderShotBody,
  SHARED_CSS,
  FRAME_WIDTH,
  FRAME_HEIGHT,
} from "./templates.js";
export { renderPreviewHtml } from "./preview.js";
export { writeManifest } from "./manifest.js";

const RENDERERS = { ffmpeg, hyperframes };
// Continuous animated video is the default; ffmpeg stays as the offline/still
// fallback (no HyperFrames CLI / no network).
export const DEFAULT_RENDERER = "hyperframes";

export function getRenderer(name = DEFAULT_RENDERER) {
  const r = RENDERERS[name];
  if (!r) {
    throw new Error(
      `Unknown renderer "${name}". Valid: ${Object.keys(RENDERERS).join(", ")}`
    );
  }
  return r;
}
