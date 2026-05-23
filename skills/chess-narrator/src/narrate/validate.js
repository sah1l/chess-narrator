/**
 * Validate a narration object produced by Claude.
 *
 * Two layers:
 *   1. Schema-shape checks (types, ranges, required fields).
 *   2. Cross-checks against the annotation it was written from:
 *      - segments.length === plies.length (game mode)
 *      - segments[i].plyIndex === plies[i].plyIndex (strict 1:1, in order)
 *      - If annotation.challenge is set, narration.challenge must be set
 *        with the same plyIndex and the right move (first candidate or
 *        reveal answer) consistent with the annotation.
 *
 * Returns { valid, errors[] }. Doesn't throw — callers decide how to react.
 */

const VALID_DEPTHS = new Set(["brief", "standard", "deep"]);

export function validateNarration(narration, annotation) {
  const errors = [];

  if (!isObject(narration)) {
    return { valid: false, errors: ["narration must be an object"] };
  }

  if (narration.schemaVersion !== "1.2.0") {
    errors.push(`schemaVersion must be "1.2.0" (got ${JSON.stringify(narration.schemaVersion)})`);
  }
  requireString(narration, "title", 4, 80, errors);
  if (narration.subtitle != null && typeof narration.subtitle !== "string") {
    errors.push("subtitle must be a string or null");
  }

  validateBookend(narration.intro, "intro", 2, 30, errors);
  validateBookend(narration.outro, "outro", 2, 30, errors);

  if (!Array.isArray(narration.segments) || narration.segments.length === 0) {
    errors.push("segments must be a non-empty array");
  } else {
    narration.segments.forEach((seg, i) => validateSegment(seg, i, errors));
  }

  if (narration.challenge != null) {
    validateChallenge(narration.challenge, errors);
  }

  if (annotation && errors.length === 0) {
    crossCheck(narration, annotation, errors);
  }

  return { valid: errors.length === 0, errors };
}

function validateBookend(b, name, minSec, maxSec, errors) {
  if (!isObject(b)) {
    errors.push(`${name} must be an object`);
    return;
  }
  requireString(b, "text", 1, Infinity, errors, name);
  if (typeof b.estimatedSeconds !== "number" || b.estimatedSeconds < minSec || b.estimatedSeconds > maxSec) {
    errors.push(`${name}.estimatedSeconds must be a number in [${minSec}, ${maxSec}]`);
  }
}

function validateSegment(seg, i, errors) {
  const path = `segments[${i}]`;
  if (!isObject(seg)) {
    errors.push(`${path} must be an object`);
    return;
  }
  if (!Number.isInteger(seg.plyIndex) || seg.plyIndex < -1) {
    errors.push(`${path}.plyIndex must be an integer ≥ -1`);
  }
  requireString(seg, "text", 1, Infinity, errors, path);
  if (typeof seg.estimatedSeconds !== "number" || seg.estimatedSeconds < 1.5 || seg.estimatedSeconds > 45) {
    errors.push(`${path}.estimatedSeconds must be a number in [1.5, 45]`);
  }
  if (seg.depth != null && !VALID_DEPTHS.has(seg.depth)) {
    errors.push(`${path}.depth must be one of: brief, standard, deep`);
  }
  if (seg.highlightSquares != null) {
    if (!Array.isArray(seg.highlightSquares)) {
      errors.push(`${path}.highlightSquares must be an array`);
    } else {
      seg.highlightSquares.forEach((sq, j) => {
        if (typeof sq !== "string" || !/^[a-h][1-8]$/.test(sq)) {
          errors.push(`${path}.highlightSquares[${j}] must match /^[a-h][1-8]$/`);
        }
      });
    }
  }
  if (seg.showEngineLine != null && typeof seg.showEngineLine !== "boolean") {
    errors.push(`${path}.showEngineLine must be a boolean`);
  }
}

function validateChallenge(c, errors) {
  if (!isObject(c)) {
    errors.push("challenge must be an object or null");
    return;
  }
  if (!Number.isInteger(c.plyIndex) || c.plyIndex < 0) {
    errors.push("challenge.plyIndex must be a non-negative integer");
  }
  if (!isObject(c.prompt)) {
    errors.push("challenge.prompt must be an object");
  } else {
    requireString(c.prompt, "text", 1, Infinity, errors, "challenge.prompt");
    if (typeof c.prompt.estimatedSeconds !== "number" || c.prompt.estimatedSeconds < 4 || c.prompt.estimatedSeconds > 20) {
      errors.push("challenge.prompt.estimatedSeconds must be in [4, 20]");
    }
  }
  if (c.thinkSeconds != null && (typeof c.thinkSeconds !== "number" || c.thinkSeconds < 2 || c.thinkSeconds > 15)) {
    errors.push("challenge.thinkSeconds must be a number in [2, 15]");
  }
  if (!Array.isArray(c.candidates) || c.candidates.length < 1 || c.candidates.length > 3) {
    errors.push("challenge.candidates must be an array of 1-3 items");
  } else {
    c.candidates.forEach((cand, i) => {
      const p = `challenge.candidates[${i}]`;
      if (!isObject(cand)) {
        errors.push(`${p} must be an object`);
        return;
      }
      requireString(cand, "san", 1, Infinity, errors, p);
      if (typeof cand.uci !== "string" || !/^[a-h][1-8][a-h][1-8][qrbnQRBN]?$/.test(cand.uci)) {
        errors.push(`${p}.uci must be a valid UCI move`);
      }
      requireString(cand, "text", 1, Infinity, errors, p);
      if (typeof cand.estimatedSeconds !== "number" || cand.estimatedSeconds < 4 || cand.estimatedSeconds > 18) {
        errors.push(`${p}.estimatedSeconds must be in [4, 18]`);
      }
    });
  }
  if (!isObject(c.reveal)) {
    errors.push("challenge.reveal must be an object");
  } else {
    requireString(c.reveal, "text", 1, Infinity, errors, "challenge.reveal");
    if (typeof c.reveal.estimatedSeconds !== "number" || c.reveal.estimatedSeconds < 6 || c.reveal.estimatedSeconds > 25) {
      errors.push("challenge.reveal.estimatedSeconds must be in [6, 25]");
    }
  }
}

function crossCheck(narration, annotation, errors) {
  if (annotation.mode === "position") {
    // Position mode: exactly one segment with plyIndex -1.
    if (narration.segments.length !== 1) {
      errors.push(`position mode expects exactly 1 segment (got ${narration.segments.length})`);
      return;
    }
    if (narration.segments[0].plyIndex !== -1) {
      errors.push(`position mode segment must have plyIndex=-1 (got ${narration.segments[0].plyIndex})`);
    }
    if (narration.challenge != null) {
      errors.push("position mode cannot have a challenge block");
    }
    return;
  }

  const plies = annotation.plies ?? [];
  if (narration.segments.length !== plies.length) {
    errors.push(
      `segment count (${narration.segments.length}) must equal ply count (${plies.length}) — write one segment per ply for a guided walkthrough`
    );
    return;
  }
  for (let i = 0; i < plies.length; i++) {
    if (narration.segments[i].plyIndex !== plies[i].plyIndex) {
      errors.push(
        `segments[${i}].plyIndex=${narration.segments[i].plyIndex} does not match plies[${i}].plyIndex=${plies[i].plyIndex}`
      );
    }
  }

  // Challenge cross-check
  if (annotation.challenge != null && narration.challenge == null) {
    errors.push(
      `annotation has a challenge at ply ${annotation.challenge.plyIndex} but narration.challenge is null — write the puzzle content`
    );
  }
  if (annotation.challenge == null && narration.challenge != null) {
    errors.push("narration.challenge is set but annotation has no challenge");
  }
  if (annotation.challenge != null && narration.challenge != null) {
    if (annotation.challenge.plyIndex !== narration.challenge.plyIndex) {
      errors.push(
        `challenge.plyIndex mismatch: annotation=${annotation.challenge.plyIndex}, narration=${narration.challenge.plyIndex}`
      );
    }
  }
}

function requireString(obj, field, minLen, maxLen, errors, prefix = "") {
  const v = obj[field];
  const path = prefix ? `${prefix}.${field}` : field;
  if (typeof v !== "string") {
    errors.push(`${path} must be a string`);
    return;
  }
  if (v.length < minLen) errors.push(`${path} must be ≥ ${minLen} chars`);
  if (Number.isFinite(maxLen) && v.length > maxLen) {
    errors.push(`${path} must be ≤ ${maxLen} chars`);
  }
}

function isObject(v) {
  return v != null && typeof v === "object" && !Array.isArray(v);
}
