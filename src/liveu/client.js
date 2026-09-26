import { randomUUID } from 'node:crypto';
import { config } from '../config.js';

/**
 * LiveU Solo / LiveU Central API client, ported from the standalone
 * `liveu api` project. These are the private endpoints the solo.liveu.tv
 * web portal uses (captured from DevTools), not a documented public API —
 * so they can change without notice, and response shapes are parsed
 * defensively in parse.js rather than trusted.
 */

const SOLO_API_BASE = 'https://solo-api.liveu.tv/v1_prod/awsluc';
const SOLO_API_DIRECT = 'https://solo-api.liveu.tv/v1_prod';
const LU_CENTRAL_V0 = 'https://lu-central.liveu.tv/luc/luc-core-web/rest/v0';

const APPLICATION_ID = 'SlZ3SHqiqtYJRkF0zO';

const BROWSER_HEADERS = {
  Origin: 'https://solo.liveu.tv',
  Referer: 'https://solo.liveu.tv/',
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
};

const REQUEST_TIMEOUT_MS = 15_000;

let accessToken = null;
let tokenExpiresAt = 0;
let cookies = '';
let loginPromise = null;
const userUuid = randomUUID();

export function isConfigured() {
  return Boolean(config.liveu.email && config.liveu.password);
}

async function login() {
  const basic = Buffer.from(`${config.liveu.email}:${config.liveu.password}`).toString('base64');
  const response = await fetch(`${SOLO_API_BASE}/login`, {
    method: 'POST',
    headers: {
      ...BROWSER_HEADERS,
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'x-user-uuid': userUuid,
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`LiveU login failed: ${response.status} ${response.statusText}${body ? ` — ${body.slice(0, 200)}` : ''}`);
  }

  const setCookie = response.headers.getSetCookie?.() ?? [];
  if (setCookie.length) cookies = setCookie.map((c) => c.split(';')[0]).join('; ');

  const json = await response.json();
  const { access_token: token, expires_in: expiresIn } = json.data.credentials;
  accessToken = token;
  tokenExpiresAt = Date.now() + expiresIn * 1000 - 60_000;
}

/** Logs in if there's no token or it's about to expire. Concurrent callers share one login. */
async function ensureAuth(force = false) {
  if (!force && accessToken && Date.now() < tokenExpiresAt) return;
  loginPromise ??= login().finally(() => {
    loginPromise = null;
  });
  await loginPromise;
}

async function request(url, options = {}, retried = false) {
  if (!isConfigured()) throw new Error('LiveU is not configured (set LIVEU_EMAIL and LIVEU_PASSWORD).');
  await ensureAuth();

  const headers = {
    ...BROWSER_HEADERS,
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
    'x-user-uuid': userUuid,
    ...options.headers,
  };
  if (cookies) headers.Cookie = cookies;

  const response = await fetch(url, { ...options, headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });

  // Token revoked early (e.g. logged in elsewhere) — log in again once and retry.
  if (response.status === 401 && !retried) {
    await ensureAuth(true);
    return request(url, options, true);
  }
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(
      `${options.method || 'GET'} ${new URL(url).pathname} failed: ${response.status} ${response.statusText}${body ? ` — ${body.slice(0, 200)}` : ''}`,
    );
  }

  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

const central = (path, options = {}) =>
  request(`${LU_CENTRAL_V0}${path}`, { ...options, headers: { 'application-id': APPLICATION_ID, ...options.headers } });

/** Every Solo unit on the account (BOSSID, name, SN, status: 'online' | 'streaming' | 'offline', ...). */
export async function listUnits() {
  const email = encodeURIComponent(config.liveu.email);
  const data = await central(`/inventories/${email}/units/light?soloOnly=true`);
  return data?.data?.units ?? [];
}

/** Raw per-modem/interface status for one unit. Only answers while the unit is online. */
export function getInterfaces(bossId) {
  return central(`/units/${encodeURIComponent(bossId)}/status/interfaces`);
}

/** Raw video input status for one unit. Only answers while the unit is online. */
export function getVideo(bossId) {
  return central(`/units/${encodeURIComponent(bossId)}/status/video`);
}

/** The unit's stream presets (destinations): title, streaming_provider, is_active, ... */
export async function getDestinations(bossId) {
  const data = await request(`${SOLO_API_DIRECT}/streamtooldestinations?unit_id=${encodeURIComponent(bossId)}`);
  return data?.data?.response ?? [];
}

// TODO: the start/stop endpoints below were never captured from the
// solo.liveu.tv portal's DevTools — they're the `liveu api` project's
// placeholders. Capture the real request the portal's "Go Live" / "Stop"
// buttons send (URL, method, body) and put it here; nothing else changes.

export function startStream(bossId, destination) {
  return request(`${SOLO_API_DIRECT}/streamtools/start`, {
    method: 'POST',
    body: JSON.stringify({ boss_id: bossId, destination_id: destinationId(destination) }),
  });
}

export function stopStream(bossId) {
  return request(`${SOLO_API_DIRECT}/streamtools/stop`, {
    method: 'POST',
    body: JSON.stringify({ boss_id: bossId }),
  });
}

export function destinationId(destination) {
  return String(destination?.id ?? destination?.destination_id ?? destination?.external_id ?? '');
}
