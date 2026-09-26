import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

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

/** The latest usage (possibly stale — see `fetchedAt`), or null if it's never been available. */
export async function getClaudeUsage() {
  if (Date.now() - lastAttemptAt >= CACHE_MS) {
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

const BAR_WIDTH = 20;

function bar(percent) {
  const filled = Math.round((Math.min(Math.max(percent, 0), 100) / 100) * BAR_WIDTH);
  return '█'.repeat(filled) + '░'.repeat(BAR_WIDTH - filled);
}

function dot(percent) {
  if (percent >= 90) return '🔴';
  if (percent >= 70) return '🟡';
  return '🟢';
}

function formatWindow(label, w, resetStyle) {
  if (!w) return `${label} — no data`;
  // A window whose reset has passed since the last fetch has started over.
  const reset = w.resetsAt && w.resetsAt > Date.now() ? w.resetsAt : null;
  const percent = w.resetsAt && !reset ? 0 : w.percent;
  const unix = reset ? Math.floor(reset / 1000) : null;
  const resetText = unix ? ` · resets <t:${unix}:${resetStyle}>` : '';
  return `${dot(percent)} ${label}\n\`${bar(percent)}\` **${Math.round(percent)}%**${resetText}`;
}

/**
 * Discord message lines for the usage bars. Reset times use Discord
 * timestamps, so "in 2 hours" keeps counting down on its own between edits.
 * Returns '' if usage isn't available.
 */
export function formatClaudeUsage(usage) {
  if (!usage) return '';
  const lines = [
    '**Claude usage**',
    formatWindow('Session (5-hour)', usage.fiveHour, 'R'),
    formatWindow('Weekly', usage.sevenDay, 'f'),
  ];
  if (Date.now() - usage.fetchedAt > 15 * 60 * 1000) {
    lines.push(`-# Last checked <t:${Math.floor(usage.fetchedAt / 1000)}:R> — updates after the next Claude message`);
  }
  return lines.join('\n');
}
