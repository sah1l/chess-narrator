/**
 * Fetch PGN from Lichess or Chess.com game URLs.
 *
 * Lichess: well-documented public API; pass any game URL.
 * Chess.com: no auth-free per-game PGN endpoint exists. We use the public
 *   /callback/{type}/game/{id} JSON endpoint to discover the players + date,
 *   then fetch the player's monthly archive PGN and grep for the game by URL.
 *   Daily games may span months — we try the end date first.
 */

const USER_AGENT =
  "chess-game-explainer/0.1 (https://github.com/sahil/chess-game-explainer)";

/**
 * @param {string} url
 * @returns {Promise<string>} raw PGN text
 */
export async function fetchGamePgn(url) {
  const lichess = parseLichessUrl(url);
  if (lichess) return fetchLichessPgn(lichess.gameId);

  const chesscom = parseChessComUrl(url);
  if (chesscom) return fetchChessComPgn(chesscom);

  throw new Error(
    `Unrecognized chess game URL: ${url}\n` +
      `Supported: https://lichess.org/<id>  |  https://www.chess.com/game/{live,daily}/<id>`
  );
}

export function isChessGameUrl(s) {
  return !!(parseLichessUrl(s) || parseChessComUrl(s));
}

// ---------- Lichess ----------

function parseLichessUrl(url) {
  // https://lichess.org/<8-char-id>[/black][#move]  or full 12-char id
  const m = url.match(
    /^https?:\/\/(?:www\.)?lichess\.org\/([A-Za-z0-9]{8})(?:[A-Za-z0-9]{4})?(?:\/|$|#|\?)/
  );
  return m ? { gameId: m[1] } : null;
}

async function fetchLichessPgn(gameId) {
  // public, no auth needed
  const url = `https://lichess.org/game/export/${gameId}?clocks=false&evals=false&moves=true`;
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "application/x-chess-pgn" },
  });
  if (!res.ok) {
    throw new Error(`Lichess fetch failed (${res.status}): ${await res.text()}`);
  }
  return await res.text();
}

// ---------- Chess.com ----------

function parseChessComUrl(url) {
  // /game/live/<id>, /game/daily/<id>, /analysis/game/{live,daily}/<id>
  const m = url.match(
    /^https?:\/\/(?:www\.)?chess\.com\/(?:analysis\/)?game\/(live|daily)\/(\d+)/
  );
  return m ? { type: m[1], gameId: m[2] } : null;
}

async function fetchChessComPgn({ type, gameId }) {
  const callbackUrl = `https://www.chess.com/callback/${type}/game/${gameId}`;
  const res = await fetch(callbackUrl, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) {
    throw new Error(`Chess.com callback failed (${res.status}) for ${type} ${gameId}`);
  }
  const data = await res.json();
  const headers = data?.game?.pgnHeaders;
  const players = data?.players;
  if (!headers || !players) {
    throw new Error("Chess.com callback response missing headers/players");
  }

  const username = players.top?.username || players.bottom?.username;
  if (!username) throw new Error("Chess.com callback response missing usernames");

  // Live games: Date is the played date. Daily games can span months — try
  // EndDate first, fall back to Date.
  const dates = [headers.EndDate, headers.Date].filter(Boolean);
  const tried = new Set();
  for (const d of dates) {
    const [y, m] = d.split(".");
    const key = `${y}-${m}`;
    if (tried.has(key)) continue;
    tried.add(key);
    const pgn = await scanChessComArchive(username, y, m, type, gameId);
    if (pgn) return pgn;
  }
  throw new Error(
    `Could not locate game ${gameId} in ${username}'s ${tried.size > 1 ? "archives" : "archive"}.`
  );
}

async function scanChessComArchive(username, year, month, type, gameId) {
  const url = `https://api.chess.com/pub/player/${username.toLowerCase()}/games/${year}/${month.padStart(2, "0")}/pgn`;
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) return null;
  const text = await res.text();
  // Games are separated by blank lines. Each block contains a [Link "..."] tag.
  const marker = `/game/${type}/${gameId}`;
  const games = text.split(/\n(?=\[Event )/);
  for (const g of games) {
    if (g.includes(marker)) return g.trim();
  }
  return null;
}
