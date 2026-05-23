# chess-narrator

Turn a chess game into a narrated MP4 explainer video. Stockfish handles the chess. Claude handles the teaching. Edge-tts and ffmpeg handle the delivery.

Designed for intermediate club players who want to understand *why* a game went the way it did — not just see the moves played.

![Node](https://img.shields.io/badge/Node-%3E%3D22-339933) ![Stockfish](https://img.shields.io/badge/Stockfish-18-lightgrey) ![License](https://img.shields.io/badge/license-MIT-blue)

## Sample videos

- [Morphy's Opera Game (Paris, 1858)](https://youtu.be/YFo5eR5-g_8) — the canonical attacking miniature
- [My queen went on a pawn-grabbing road trip behind enemy lines](https://youtu.be/9Kj2KtpoAjc) — a personal game walkthrough

## What it produces

A 1920×1080 MP4, typically 5–7 minutes, that:

- Opens with a title card and a scene-setting intro
- Walks through **every move** with tiered commentary (book / routine / interesting / critical)
- Visually marks mistakes, brilliancies, and engine alternatives
- Pauses at one critical position and asks the viewer to find the move themselves ("What would you play here?"), then explains why each plausible-looking alternative fails before revealing the answer
- Closes with an outro that lands the lesson

## Install as an agent skill

This repo is an agent skill compatible with GitHub Copilot, Claude Code, Cursor, OpenCode, Windsurf, and [many other AI coding agents](https://cli.github.com/manual/gh_skill_install). Install it with the GitHub CLI's skill subcommand (currently in preview), then run `npm install` + `verify` to set up the Node side.

The skill lives at [`skills/chess-narrator/`](skills/chess-narrator) in this repo. `gh skill install` reads that path and drops it into your agent's skills directory.

**Project-scoped (only inside the current repo, default):**

```bash
gh skill install sah1l/chess-narrator chess-narrator --agent <your-agent>
cd .agents/skills/chess-narrator
npm install
node src/cli.js verify
```

**User-scoped (available in every project on your machine):**

```bash
gh skill install sah1l/chess-narrator chess-narrator --agent <your-agent> --scope user
# gh prints the install path — cd into it, then:
npm install
node src/cli.js verify
```

**Pin to a version / commit** (avoid surprise updates):

```bash
gh skill install sah1l/chess-narrator chess-narrator --agent <your-agent> --pin <tag-or-sha>
```

> Replace `<your-agent>` with your AI coding agent: `claude-code`, `opencode`, `github-copilot`, `cursor`, `windsurf`, etc. See the [full list of supported agents](https://cli.github.com/manual/gh_skill_install#gh-skill-install).

**Update later:**

```bash
gh skill update chess-narrator
# or all skills at once:
gh skill update --all
```

> `gh skill` is in preview and ships in recent `gh` builds. If your `gh` doesn't have it yet, use the clone fallback below.

<details>
<summary>Fallback: plain <code>git clone</code> (no <code>gh skill</code>)</summary>

Clone the whole repo and work directly inside the skill directory:

```bash
git clone https://github.com/sah1l/chess-narrator
cd chess-narrator/skills/chess-narrator
npm install && node src/cli.js verify
```

To wire it up as an agent skill without `gh`, copy or symlink the `skills/chess-narrator/` directory into `.agents/skills/chess-narrator/` (project scope) or your user-scoped agent skills dir.
</details>

Once installed, just say things like *"make a video of this Lichess game: https://lichess.org/abc123"* or *"explain this PGN as a walkthrough"* and your agent will run the pipeline. See [`skills/chess-narrator/SKILL.md`](skills/chess-narrator/SKILL.md) for the full trigger surface.

## Verify your setup

The skill ships with a one-shot env check that tells you exactly what's missing and how to install it:

```bash
node src/cli.js verify
# or
npm run verify
```

Sample output on a healthy machine:

```
chess-narrator environment check

  [OK]   Node ≥22                 — v22.22.3
  [OK]   stockfish (npm)
  [OK]   chess.js (npm)
  [OK]   msedge-tts (npm)
  [OK]   ffmpeg on PATH           — ffmpeg version 6.1.1
  [OK]   Chrome/Edge/Chromium     — /Applications/Google Chrome.app/…
  [OK]   edge-tts reachable       — speech.platform.bing.com

All required dependencies present.
```

When you ask Claude *"verify chess-narrator"* (or *"check the chess-narrator setup"*, *"is everything installed?"*), it will run this command and walk you through any `[MISS]` items. Use `--skip-network` to skip the edge-tts reachability probe.

Required: Node 22+, ffmpeg on PATH, Chrome / Chromium / Edge. The npm deps install via `npm install`. The edge-tts network check is optional — only needed if you plan to use `--engine edge` for neural-voice narration.

## Quick start

```bash
# 1. Clone + install (skip if already installed as a skill above)
git clone https://github.com/sah1l/chess-narrator
cd chess-narrator/skills/chess-narrator
npm install
node src/cli.js verify

# 2. Analyze a game
node src/cli.js analyze samples/sample-game.pgn
# → samples/output/annotation.json

# 3. (Have Claude write narration.json — see the SKILL.md prompt)
# Or use the bundled sample:
cp samples/sample-narration.json my-narration.json

# 4. Build the shot list
node src/cli.js build-script samples/output/annotation.json my-narration.json
# → samples/output/script.json

# 5. Synthesize audio (edge-tts neural voices, free, requires internet)
node src/cli.js synthesize samples/output/script.json --engine edge
# → samples/output/script.audio.json + samples/output/audio/*.wav

# 6. Render the MP4
node src/cli.js render samples/output/script.audio.json --renderer ffmpeg --mp4 video.mp4
# → video.mp4
```

## Architecture

```
                     ┌─────────────────┐
   PGN / URL / FEN ──┤   Input Loader  │── normalized game/position
                     └────────┬────────┘
                              │
                     ┌────────▼────────┐
                     │    Stockfish    │  multipv at sweep depth 10,
                     │   (truth layer) │  deep re-eval at depth 18
                     └────────┬────────┘
                              │  annotation.json
                              │  ── per-ply evals, classifications
                              │  ── key moments (4-7 per game)
                              │  ── one challenge pick (or null)
                              ▼
                     ┌─────────────────┐
                     │     Claude      │  one segment per ply, tiered
                     │ (teacher layer) │  challenge prompt + candidates + reveal
                     └────────┬────────┘
                              │  narration.json (validated)
                              ▼
                     ┌─────────────────┐
                     │  Shot Builder   │  ply → shot mapping
                     │                 │  challenge expansion (5 shots)
                     └────────┬────────┘
                              │  script.json
                              ▼
                     ┌─────────────────┐    edge-tts → MP3 → ffmpeg → WAV
                     │      TTS        │
                     └────────┬────────┘
                              │  script.audio.json + audio/*.wav
                              ▼
                     ┌─────────────────┐    Chrome headless → PNG
                     │    Renderer     │    ffmpeg → per-shot MP4 → concat
                     └────────┬────────┘
                              │
                              ▼
                          video.mp4
```

## Why three layers?

Hard separation of concerns:

- **Truth layer (Stockfish)** never speculates. Numbers in, numbers out. Cached on disk so re-runs are free.
- **Teacher layer (Claude)** is constrained — must consume the structured briefing, cannot invent threats, cannot override evaluations. Coach voice over engine analysis.
- **Delivery layer** is dumb. Takes the shot list and produces frames; no chess knowledge required.

This means you can swap any layer independently: try Leela instead of Stockfish, GPT instead of Claude, or HeyGen instead of edge-tts + ffmpeg.

## Inputs

```bash
# PGN file
node src/cli.js analyze game.pgn

# Lichess game URL
node src/cli.js analyze https://lichess.org/abc123

# Chess.com game URL
node src/cli.js analyze https://www.chess.com/game/live/12345678

# Raw FEN (single-position mode — different narration shape)
node src/cli.js analyze --fen "r1bq1rk1/pppp1ppp/2n2n2/2b1p3/2B1P3/2N2N2/PPPP1PPP/R1BQK2R w KQ - 6 6"

# Inline PGN text via stdin / temp file
```

## TTS voice options

The `edge` engine uses Microsoft's free neural voices. Default is `en-US-AndrewMultilingualNeural` (warm narrator). Other strong choices for chess commentary:

```bash
node src/cli.js synthesize script.json --engine edge --voice en-US-GuyNeural          # clear broadcast
node src/cli.js synthesize script.json --engine edge --voice en-US-ChristopherNeural  # deeper, authoritative
node src/cli.js synthesize script.json --engine edge --voice en-US-DavisNeural        # younger
node src/cli.js list-voices --engine edge   # ~500 voices across languages
```

Falls back to Windows SAPI 5 with `--engine system` if you have no internet (sounds robotic).

## What this skill is NOT

- Not an opening trainer or repertoire builder
- Not a tactics puzzle generator (though the "pause and think" feature gives you one puzzle per game)
- Not real-time commentary — analysis takes ~2 min per game at default depth
- Not a chess engine — it's a wrapper over Stockfish

## Dependencies

- **Node ≥22** (ES modules, `node:test`)
- **chess.js ^1.4.0** — PGN parsing, SAN↔UCI, FEN validation
- **stockfish ^18.0.7** — engine (lite-single flavor, runs in-process)
- **msedge-tts ^2** — edge-tts WebSocket client
- **ffmpeg** on PATH — audio conversion + video stitching
- **Chrome / Chromium** on PATH — headless board screenshots

## Tests

```bash
npm test
# 51 tests across annotate, classify, narrate, render, tts
```

## License

MIT — see [LICENSE](LICENSE).

## Acknowledgments

- Stockfish, the open-source engine that does the actual chess work
- chess.js, for keeping PGN parsing pleasant
- The Opera Game (Morphy vs Karl/Isouard, Paris 1858), used as the canonical sample because it's the most famous attacking game ever played and demonstrates every tier of commentary the pipeline produces
