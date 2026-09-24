import { config } from '../config.js';

/**
 * Thin HTTP client for the bridge-discord control API (see the Coms
 * server repo's bridge-discord/README.md for the authoritative contract —
 * this must stay in sync with whatever that service actually implements).
 *
 * Base URL/API key come from BRIDGE_DISCORD_URL / BRIDGE_DISCORD_API_KEY;
 * both optional — /voice is simply unavailable if BRIDGE_DISCORD_URL isn't set.
 */

export function isConfigured() {
  return Boolean(config.bridgeDiscord.url);
}

function headers() {
  const h = { 'Content-Type': 'application/json' };
  if (config.bridgeDiscord.apiKey) h['x-api-key'] = config.bridgeDiscord.apiKey;
  return h;
}

async function request(method, path, body) {
  if (!isConfigured()) {
    throw new Error('Voice bridge is not configured (BRIDGE_DISCORD_URL is unset).');
  }
  const url = `${config.bridgeDiscord.url.replace(/\/+$/, '')}${path}`;
  const res = await fetch(url, {
    method,
    headers: headers(),
    body: body ? JSON.stringify(body) : undefined,
  });

  let data = null;
  try {
    data = await res.json();
  } catch {
    // Some responses (e.g. a bare 404) may not have a JSON body.
  }

  if (!res.ok) {
    const message = data?.error || data?.message || `${res.status} ${res.statusText}`;
    const err = new Error(message);
    err.status = res.status;
    throw err;
  }
  return data;
}

/** Starts a pairing. Throws on failure (including a duplicate id — see bridge-discord README, currently surfaced as a 502). */
export function createPairing({ id, liveKitChannelId, discordGuildId, discordVoiceChannelId }) {
  return request('POST', '/pairings', { id, liveKitChannelId, discordGuildId, discordVoiceChannelId });
}

/** Stops a pairing. Returns false (not an error) if it didn't exist. */
export async function leavePairing(id) {
  try {
    await request('POST', `/pairings/${encodeURIComponent(id)}/leave`);
    return true;
  } catch (err) {
    if (err.status === 404) return false;
    throw err;
  }
}

export function getPairing(id) {
  return request('GET', `/pairings/${encodeURIComponent(id)}`).catch((err) => {
    if (err.status === 404) return null;
    throw err;
  });
}

export function listPairings() {
  return request('GET', '/pairings');
}
