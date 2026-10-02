import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { usageBar } from './usage-bar-emojis.js';

/**
 * The Claude account's plan usage — the same 5-hour session and weekly
 * limits Claude Code's `/usage` shows. Read from the OAuth usage endpoint
 * Claude Code itself uses, authenticated with the `claude login`
 * credentials in CLAUDE_CONFIG_DIR. Not a documented API, so everything
 * here fails soft: no credentials, an API key login, or an error just means
 * no usage section.
 *
 * The access token is never refreshed here — refreshing rotates the refresh
 * token, which would log the CLI out. Claude Code refreshes it whenever a
 * session runs, so while the bot sits idle with an expired token, the last
 * known numbers are shown instead.
 */

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
// Several picker messages (one per guild) may ask at once — share one fetch.
const CACHE_MS = 60_000;

let cached = null; // { fiveHour, sevenDay, fetchedAt }
let lastAttemptAt = 0;
let inFlight = null;

function readAccessToken() {
  try {
    const file = path.join(config.claude.configDir, '.credentials.json');
    const oauth = JSON.parse(fs.readFileSync(file, 'utf8')).claudeAiOauth;
    if (!oauth?.accessToken) return null;
    return { token: oauth.accessToken, expired: oauth.expiresAt ? oauth.expiresAt <= Date.now() : false };
  } catch {
    return null;
  }
}

function parseWindow(w) {
  if (!w || typeof w.utilization !== 'number') return null;
  const resetsAt = w.resets_at ? new Date(w.resets_at).getTime() : null;
  return { percent: w.utilization, resetsAt: Number.isFinite(resetsAt) ? resetsAt : null };
}

async function fetchUsage() {
  const creds = readAccessToken();
  if (!creds || creds.expired) return;

  const res = await fetch(USAGE_URL, {
    headers: {
      Authorization: `Bearer ${creds.token}`,
      'anthropic-beta': 'oauth-2025-04-20',
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`usage endpoint returned ${res.status}`);
  const body = await res.json();
  cached = {
    fiveHour: parseWindow(body.five_hour),
    sevenDay: parseWindow(body.seven_day),
    fetchedAt: Date.now(),
  };
}

/**
 * The latest usage (possibly stale — see `fetchedAt`), or null if it's never
 * been available. `fresh` skips the cache, for right after a Claude turn
 * when the numbers have just moved.
 */
export async function getClaudeUsage({ fresh = false } = {}) {
  if (fresh || Date.now() - lastAttemptAt >= CACHE_MS) {
    lastAttemptAt = Date.now();
    inFlight = fetchUsage()
      .catch((err) => console.error('Failed to fetch Claude usage:', err.message))
      .finally(() => {
        inFlight = null;
      });
  }
  if (inFlight) await inFlight;
  return cached;
}

const BAR_WIDTH = 10;

function barColor(percent) {
  if (percent >= 90) return 'red';
  if (percent >= 70) return 'yellow';
  return 'green';
}

const SQUARES = { green: '🟩', yellow: '🟨', red: '🟥' };

// The smooth custom-emoji bar when it's set up (see usage-bar-emojis.js),
// otherwise standard emoji squares.
function bar(percent) {
  const clamped = Math.min(Math.max(percent, 0), 100);
  const color = barColor(clamped);
  const custom = usageBar(clamped, color);
  if (custom) return custom;
  const filled = Math.round((clamped / 100) * BAR_WIDTH);
  return SQUARES[color].repeat(filled) + '⬛'.repeat(BAR_WIDTH - filled);
}

/** The window's reset time if it's still ahead, else null. */
function upcomingReset(w) {
  return w.resetsAt && w.resetsAt > Date.now() ? w.resetsAt : null;
}

/** The window's percent used — 0 once its reset has passed since the last fetch, as it has started over. */
function currentPercent(w) {
  return w.resetsAt && !upcomingReset(w) ? 0 : w.percent;
}

/** `<bar> **50%** · resets <time>` for one usage window. */
function formatBarLine(w, resetStyle) {
  const reset = upcomingReset(w);
  const percent = currentPercent(w);
  const unix = reset ? Math.floor(reset / 1000) : null;
  const resetText = unix ? ` · resets <t:${unix}:${resetStyle}>` : '';
  return `${bar(percent)} **${Math.round(percent)}%**${resetText}`;
}

function formatWindow(label, w, resetStyle) {
  if (!w) return `${label} — no data`;
  return `**${label}**\n${formatBarLine(w, resetStyle)}`;
}

/**
 * Discord message lines for the usage bars. Reset times use Discord
 * timestamps, so "in 2 hours" keeps counting down on its own between edits.
 * Returns '' if usage isn't available.
 */
export function formatClaudeUsage(usage) {
  if (!usage) return '';
  const lines = [
    '### Claude usage',
    formatWindow('Session (5-hour)', usage.fiveHour, 'R'),
    formatWindow('Weekly', usage.sevenDay, 'f'),
  ];
  if (Date.now() - usage.fetchedAt > 15 * 60 * 1000) {
    lines.push(`-# Last checked <t:${Math.floor(usage.fetchedAt / 1000)}:R> — updates after the next Claude message`);
  }
  return lines.join('\n');
}

/**
 * Just the 5-hour session bar on one line, for the end of each Claude turn
 * in session and chat channels. Returns '' if usage isn't available.
 */
export function formatSessionUsageLine(usage) {
  if (!usage?.fiveHour) return '';
  return `**Session** ${formatBarLine(usage.fiveHour, 'R')}`;
}

const EMBED_COLORS = { green: 0x23a55a, yellow: 0xf0b232, red: 0xf23f43 };

/** Embed stripe colour matching the session bar, or null if usage isn't available. */
export function sessionUsageColor(usage) {
  if (!usage?.fiveHour) return null;
  return EMBED_COLORS[barColor(currentPercent(usage.fiveHour))];
}
