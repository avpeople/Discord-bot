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

/** Raw general status for one unit (battery: { percentage, connected }, ...). */
export function getStatus(bossId) {
  return central(`/units/${encodeURIComponent(bossId)}/status`);
}

/**
 * The unit's stream: { status: 'streaming' | ..., destination: <id>, destinationName }.
 * `destination` is the unit's selected destination — what Go Live streams to —
 * resolved to a name from the account's destination inventory.
 */
export async function getStream(bossId) {
  const data = await central(`/units/${encodeURIComponent(bossId)}/stream`);
  const stream = data?.data?.stream ?? data?.stream ?? null;
  if (stream?.destination) {
    const email = encodeURIComponent(config.liveu.email);
    const dest = await central(`/inventories/${email}/destinations/${encodeURIComponent(stream.destination)}`).catch(() => null);
    const d = dest?.data?.destination ?? dest?.data ?? dest;
    stream.destinationName = d?.name ?? d?.title ?? null;
  }
  return stream;
}

/** The unit's stream presets as the Solo portal lists them: title, streaming_provider, is_active, ... */
export async function getDestinations(bossId) {
  const data = await request(`${SOLO_API_DIRECT}/streamtooldestinations?unit_id=${encodeURIComponent(bossId)}`);
  return data?.data?.response ?? [];
}

const soloPost = (path, body) => request(`${SOLO_API_BASE}${path}`, { method: 'POST', body: JSON.stringify(body) });

/**
 * Points a unit at an SRT caller destination and makes it the one Go Live
 * streams to — the same three calls the Studio Patch app makes when a
 * MediaMTX stream is applied to a LiveU: link it to the unit on the Solo
 * API, create it in the LiveU Central inventory (the shared external_id
 * ties the two together), then select it on the unit.
 *
 * Each call creates a new destination on the account, like Studio Patch
 * does; old ones can be tidied up in the Solo portal.
 */
export async function setSrtDestination(bossId, { title, url, streamId, latencyMs = 1000, profile = 'SRT-Out solo h265 1080p50/60' }) {
  const externalId = randomUUID();
  const provider = 'SRT-OUT-Caller-Solo';

  await soloPost('/destination', {
    destination_id: externalId,
    unit_id: bossId,
    title,
    type: 'stream',
    provider,
    profileSelected: profile,
    pri_url: url,
    streamname: streamId,
    latency: String(latencyMs),
  });

  const email = encodeURIComponent(config.liveu.email);
  const created = await central(`/inventories/${email}/destinations?overwrite=true`, {
    method: 'POST',
    body: JSON.stringify({
      destination: {
        name: title,
        type: 'stream',
        streaming_destination: {
          external_id: externalId,
          streaming_provider: provider,
          streaming_destination_outputs: [
            {
              streaming_profile: profile,
              stream_name: streamId,
              min_res_override: '',
              max_res_override: '',
              min_fps_override: '',
              max_fps_override: '',
              min_bitrate_override: '',
              max_bitrate_override: '',
              audio_bitrate_override: '',
            },
          ],
          streaming_ingest: {
            username: '',
            password: '',
            primary_url: url,
            secondary_url: '',
            streamingSrt: { mode: 'caller', latency: String(latencyMs), passphrase: '' },
          },
        },
      },
    }),
  });

  const destId = created?.data?.destination?.id ?? created?.data?.id ?? created?.id ?? null;
  if (!destId) throw new Error('LiveU created the destination but returned no id to select it with.');
  await central(`/units/${encodeURIComponent(bossId)}`, {
    method: 'PUT',
    body: JSON.stringify({ unit: { selected_destination: String(destId) } }),
  });
}

// Same calls the Studio Patch app's Start/Stop Stream buttons use. Go Live
// streams to the unit's currently selected destination (see getStream).

export function startStream(bossId) {
  return central(`/units/${encodeURIComponent(bossId)}/stream`, {
    method: 'POST',
    body: JSON.stringify({ unit_id: bossId }),
  });
}

export function stopStream(bossId) {
  return central(`/units/${encodeURIComponent(bossId)}/stream`, { method: 'DELETE' });
}
