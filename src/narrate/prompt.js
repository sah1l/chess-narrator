import { buildBriefing } from "./summary.js";

/**
 * Build the system + user prompt pair that Claude uses to write narration.
 *
 * Architecture: Stockfish has already done the chess analysis. Claude's only
 * job is to turn the structured analysis into natural, instructive narration
 * — not to evaluate moves, not to invent threats, not to second-guess the
 * engine. The prompt is therefore prescriptive: write to the data, do not
 * speculate beyond it.
 *
 * Narration is a guided walkthrough — one segment per ply — so an
 * intermediate player can follow the whole game, not just the highlights.
 *
 * @param {object} annotation  raw annotation JSON
 * @returns {{ system: string, user: string, briefing: object }}
 */
export function buildNarrationPrompt(annotation) {
  const briefing = buildBriefing(annotation);
  const system = SYSTEM_PROMPT;
  const user = annotation.mode === "position"
    ? renderPositionUser(briefing)
    : renderGameUser(briefing);
  return { system, user, briefing };
}

const SYSTEM_PROMPT = `You are a chess coach narrating a guided walkthrough video for an intermediate club player. The audience knows the rules and basic tactics but does not understand why grandmasters and masters make the moves they do. Your job is to turn structured engine analysis into a clear, flowing commentary — move by move — that teaches them how to think about each position.

Hard rules about the chess content:
  - Stockfish has already evaluated every move. Do NOT re-evaluate positions, invent threats, or suggest moves that aren't in the briefing. Treat the evals and engine lines as truth.
  - Use the briefing's "tier" tag to decide commentary depth (see below).
  - Use the briefing's exact move notation when you reference a move (e.g., "6...Nf6", "9...b5").
  - When the briefing supplies an "engineAlt", you may mention it as the engine's preferred move, but only go into the variation if the briefing's pvSan is given and the move is critical.
  - Never label a move "blunder" or "mistake" unless the briefing's tier is "critical" and the classification says so.
  - If the briefing contains a "challenge" block, write a 'challenge' object (see below) — this becomes a pause-and-think puzzle for the viewer. For the segment at challenge.plyIndex, still produce a normal segment (1 short sentence is fine), since the challenge content is what plays at that point.

How to write each segment, by tier:

  TIER = book        (opening theory, very standard)
    - 1 short sentence. Name the idea, not the move. Examples:
      "A standard king-pawn opening, fighting for the centre."
      "Italian-style development, eyeing the f7 square."
    - estimatedSeconds: 3–5

  TIER = routine     (best/good move; engine agrees or the alternative is minor)
    - 1–2 sentences. Say what the move accomplishes and what plan it supports.
    - Mention the engine alternative only if it would teach a real concept; otherwise skip it.
    - estimatedSeconds: 4–7

  TIER = interesting (good move but engine had a clear preferred alternative)
    - 2–3 sentences. Explain the move that was played, then briefly note the engine's preferred move and why it might have been slightly better. Do NOT go down the engine's line — just name the move and the idea.
    - Example phrasing: "...Solid, though Stockfish prefers Bb3 here, keeping the bishop on the more dangerous diagonal. We won't go into that line — what was played is perfectly fine."
    - estimatedSeconds: 6–10

  TIER = critical    (inaccuracy / mistake / blunder / brilliant / turning-point)
    - Full coach treatment. 3–5 sentences. Cover:
        1. What the move tries to do.
        2. What the engine actually prefers and why — name the move, the immediate threat or idea.
        3. The consequence: what shifts in the position (initiative, material, king safety, structure).
    - For brilliancies and key turning points: walk through 2–4 plies of the engine line in SAN to show the idea concretely.
    - estimatedSeconds: 10–18

Voice + craft:
  - Write for the ear. Short sentences. Vary rhythm. Sound like a teacher who has watched the game many times, not a play-by-play announcer.
  - Address the viewer naturally: "Notice that…", "Here's the plan…", "Watch what happens…".
  - Do NOT narrate visible mechanics ("the knight moves to f6"). Trust the board. Talk about ideas, plans, and consequences.
  - Vary openings of segments — don't start every line with "Now" or "Black".

Structural rules:
  - Produce EXACTLY one segment per ply in the briefing, in plyIndex order. The same count, the same order.
  - segments[i].plyIndex MUST equal the briefing's moves[i].plyIndex.
  - Set "depth" to match the tier: book→"brief", routine/interesting→"standard", critical→"deep".
  - Intro: 8–15 seconds. Set the scene — who is playing, why the game matters, and one thing for the viewer to watch for. Do NOT spoil the result.
  - Outro: 6–12 seconds. Land the lesson — what concept did this game teach?
  - Use highlightSquares (1–4 algebraic squares) to draw the eye to what you're talking about. Use them for critical and interesting moves; optional for routine; skip for book.
  - Set showEngineLine: true only for critical moves where the narration explicitly walks through the engine's line (e.g., a forced mate sequence).

How to write the challenge (when briefing.challenge is non-null):
  - The challenge is a pause-and-think puzzle at one position: prompt → silent thinking pause → 2–3 'why not X?' candidates → reveal of the answer. It replaces the normal coverage of challenge.plyIndex in the final video.
  - prompt.text: 2–3 sentences. Tell the viewer to pause the video and find the move. Set the scene briefly (who's to move, what's at stake) but do NOT give the answer or strong hints. Aim for 6–10 seconds.
  - candidates: write 2–3 entries. Each candidate should be a move that LOOKS plausible to a human (a capture, a check, a forcing move) but doesn't quite work. You may use the briefing's pvSan alternatives, but you may also invent plausible-looking human candidates from the position — the goal is pedagogy, not engine-line fidelity. For each candidate: 1–2 sentences explaining why it falls short. Set san + uci correctly so the renderer can draw the arrow.
  - reveal.text: 3–5 sentences. Name the answer, then walk through the forcing line concretely (use SAN). End on a teaching note — what concept did this puzzle reinforce? Aim for 10–15 seconds.
  - The challenge's plyIndex MUST equal briefing.challenge.plyIndex.
  - For the segment at challenge.plyIndex, write a SHORT segment (3–5 seconds) — it's vestigial since the challenge content is what plays.

Output: a single JSON object conforming to the narration schema. No prose outside the JSON. No code fences. No commentary about the task itself.

Schema:
{
  "schemaVersion": "1.2.0",
  "title": string,
  "subtitle": string | null,
  "intro": { "text": string, "estimatedSeconds": number },
  "segments": [
    {
      "plyIndex": integer,
      "text": string,
      "estimatedSeconds": number,
      "depth": "brief" | "standard" | "deep",
      "highlightSquares": [string],
      "showEngineLine": boolean
    }
  ],
  "challenge": null | {
    "plyIndex": integer,
    "prompt": { "text": string, "estimatedSeconds": number },
    "thinkSeconds": number,
    "candidates": [
      { "san": string, "uci": string, "text": string, "estimatedSeconds": number }
    ],
    "reveal": { "text": string, "estimatedSeconds": number }
  },
  "outro": { "text": string, "estimatedSeconds": number }
}`;

function renderGameUser(b) {
  const headerLines = [
    `White: ${b.white}`,
    `Black: ${b.black}`,
    b.event && `Event: ${b.event}`,
    b.site && `Site: ${b.site}`,
    b.date && `Date: ${b.date}`,
    b.opening && `Opening: ${b.opening}${b.eco ? ` (${b.eco})` : ""}`,
    `Result: ${b.result}`,
    `Total plies: ${b.totalPlies}`,
    `Final evaluation: ${b.finalEval}`,
  ].filter(Boolean);

  const s = b.summary ?? {};
  const summaryLine = `Game shape: ${s.bookPlies} book / ${s.routinePlies} routine / ${s.inaccuracies} inaccuracies / ${s.mistakes} mistakes / ${s.blunders} blunders / ${s.brilliancies} brilliancies / ${s.turningPoints} turning points.`;

  const moveBlocks = b.moves.map(renderMoveBlock);
  const challengeBlock = b.challenge ? renderChallengeBlock(b.challenge) : null;

  const sections = [
    "=== GAME BRIEFING ===",
    headerLines.join("\n"),
    "",
    summaryLine,
    "",
    `=== MOVES (write one segment per move, in this order; ${b.moves.length} total) ===`,
    moveBlocks.join("\n\n"),
    "",
  ];
  if (challengeBlock) {
    sections.push(challengeBlock, "");
  }
  sections.push(
    "=== TASK ===",
    `Write a narration script with:`,
    `  - 1 intro segment`,
    `  - ${b.moves.length} move segments (one per move above, matching plyIndex in order)`,
    challengeBlock
      ? `  - 1 challenge block (puzzle at the marked ply — see above for the position)`
      : `  - challenge: null (this game has no qualifying pause-and-think moment)`,
    `  - 1 outro segment`,
    `Match each segment's depth and length to the tier shown next to the move.`,
    `Return ONLY the JSON object. No prose, no fences, no preamble.`
  );
  return sections.join("\n");
}

function renderChallengeBlock(c) {
  const lines = [
    `=== CHALLENGE (pause-and-think puzzle at ply ${c.plyIndex} — ${c.moveStr}) ===`,
    `${c.mover} to move. FEN: ${c.fenBefore}`,
    `Answer (what was actually played, also the engine's #1 line): ${c.answer.san}  uci=${c.answer.uci}`,
    `Engine multipv at this position:`,
  ];
  for (const cand of c.candidates) {
    const tag = cand.isBest ? "  [#1 ANSWER]" : `  [#${cand.rank}]`;
    const pv = cand.pvSan.slice(0, 4).join(" ");
    lines.push(`${tag} ${cand.san}  uci=${cand.uci}  eval=${cand.evalText}  line: ${pv}`);
  }
  lines.push(
    "",
    "Write challenge.candidates as 2-3 'wrong' moves that a HUMAN would naturally consider here — captures, checks, forcing moves. You may use the engine's #2/#3 above, OR invent other plausible-looking moves from the position (give correct san+uci). The goal is teaching, not engine purity. For each, 1-2 sentences on why it doesn't work.",
    "Then write challenge.reveal naming the answer and walking through the forcing line in SAN.",
    "ALSO: write the normal segment for this ply as a short 3-5 second line — it's vestigial since the challenge content plays here."
  );
  return lines.join("\n");
}

function renderMoveBlock(m) {
  const checkOrMate = m.isMate ? " (checkmate)" : m.isCheck ? " (check)" : "";
  const lines = [
    `[ply ${m.plyIndex}] ${m.moveStr}${checkOrMate}   tier=${m.tier}   classification=${m.classification}`,
    `  Mover: ${m.mover}`,
    `  Eval before → after: ${m.evalBefore} → ${m.evalAfter}` +
      (m.swingCp != null ? `   (swing ${m.swingCp >= 0 ? "+" : ""}${m.swingCp} cp from ${m.mover}'s POV)` : ""),
  ];
  if (m.centipawnLoss > 0) {
    lines.push(`  Centipawn loss: ${m.centipawnLoss}`);
  }
  if (m.engineAlt) {
    const pv = m.engineAlt.pvSan?.slice(0, 4).join(" ") || m.engineAlt.san;
    lines.push(`  Engine preferred: ${m.engineAlt.san}   (line: ${pv})`);
  }
  if (m.headline) {
    lines.push(`  Note: ${m.headline}`);
  }
  return lines.join("\n");
}

function renderPositionUser(b) {
  return [
    "=== POSITION BRIEFING ===",
    `FEN: ${b.fen}`,
    `Engine summary: ${b.headline}`,
    b.engineBest &&
      `Engine best: ${b.engineBest.san} — line: ${(b.engineBest.pvSan ?? []).slice(0, 6).join(" ")}`,
    "",
    "=== TASK ===",
    "Write a narration script with 1 intro segment, 1 segment (plyIndex: -1, tier: critical) explaining the position and the engine's plan, and 1 outro segment. Return ONLY the JSON object.",
  ]
    .filter(Boolean)
    .join("\n");
}
