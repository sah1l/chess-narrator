/**
 * Vertical evaluation bar (Lichess-style) — shows whose position is stronger.
 *
 * Inputs are White-POV: positive cp = White ahead; positive mate = White mates.
 * Renders as an HTML <div> tree (not SVG) so it composes cleanly next to the
 * board SVG in the existing .board-pane flex layout.
 *
 *   renderEvalBar({ cp: 120, height: 880 })   →  white fills ~67% from bottom, label "+1.20"
 *   renderEvalBar({ mate: -5, height: 880 })  →  black fills full, label "−M5"
 *   renderEvalBar({ cp: null, mate: null })   →  even (50/50), label "0.00"
 */

const SAT_K = 0.00368208; // Lichess winning-chance constant
const CLAMP_MIN = 0.03; // never fully collapse one side — leave a sliver
const CLAMP_MAX = 1 - CLAMP_MIN;

export function renderEvalBar({ cp = null, mate = null, height = 880, width = 48 } = {}) {
  const whiteShare = winChance({ cp, mate });
  const fillPct = (whiteShare * 100).toFixed(2);
  const label = formatLabel({ cp, mate });
  const whiteAhead = whiteShare >= 0.5;
  // Label sits at the losing side's end so it doesn't obscure the strong color,
  // and uses contrasting text against that end's background.
  const labelClass = whiteAhead
    ? "eval-bar-label eval-bar-label-top eval-bar-label-on-dark"
    : "eval-bar-label eval-bar-label-bot eval-bar-label-on-light";

  return `<div class="eval-bar" style="width:${width}px;height:${height}px" data-cp="${cp ?? ""}" data-mate="${mate ?? ""}">
  <div class="eval-bar-fill" style="height:${fillPct}%"></div>
  <span class="${labelClass}">${escapeHtml(label)}</span>
</div>`;
}

/**
 * White's expected score (0..1) given a centipawn or mate eval.
 * Uses the Lichess winning-chance formula on cp; clamps mate to near-edge.
 */
export function winChance({ cp = null, mate = null } = {}) {
  if (mate != null) {
    if (mate > 0) return CLAMP_MAX;
    if (mate < 0) return CLAMP_MIN;
  }
  if (cp == null) return 0.5;
  const raw = 1 / (1 + Math.exp(-SAT_K * cp));
  return Math.max(CLAMP_MIN, Math.min(CLAMP_MAX, raw));
}

function formatLabel({ cp, mate }) {
  if (mate != null && mate !== 0) {
    const n = Math.abs(mate);
    return mate > 0 ? `M${n}` : `−M${n}`; // unicode minus
  }
  if (cp == null) return "0.00";
  const v = Math.abs(cp / 100).toFixed(2);
  if (cp > 0) return `+${v}`;
  if (cp < 0) return `−${v}`;
  return v;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** CSS rules consumed by the bar; imported by templates.js into SHARED_CSS. */
export const EVAL_BAR_CSS = `
  .eval-bar {
    position: relative;
    background: #1f2330;
    border-radius: 6px;
    overflow: hidden;
    box-shadow: 0 12px 28px rgba(0,0,0,0.35);
    flex: 0 0 auto;
  }
  .eval-bar-fill {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    background: linear-gradient(to top, #fafafa 0%, #e6e6e6 100%);
    transition: none;
  }
  .eval-bar-label {
    position: absolute;
    left: 0;
    right: 0;
    text-align: center;
    font-size: 16px;
    font-weight: 700;
    letter-spacing: 0.02em;
    font-variant-numeric: tabular-nums;
    pointer-events: none;
  }
  .eval-bar-label-top { top: 8px; }
  .eval-bar-label-bot { bottom: 8px; }
  .eval-bar-label-on-dark { color: #f0e6d2; }
  .eval-bar-label-on-light { color: #1a1a1a; }
`;
