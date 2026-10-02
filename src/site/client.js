import { config } from '../config.js';

const TIMEOUT_MS = 30_000;

/**
 * Client for the avp.nz site's content API (server/content.js in that
 * repo): a fixed list of named text and image fields that can be changed
 * without a redeploy. Writes need the site's CONTENT_API_KEY.
 */
export function isConfigured() {
  return Boolean(config.site.url && config.site.apiKey);
}

async function request(method, pathname, { body, contentType } = {}) {
  const res = await fetch(new URL(pathname, config.site.url), {
    method,
    headers: {
      Authorization: `Bearer ${config.site.apiKey}`,
      ...(contentType ? { 'Content-Type': contentType } : {}),
    },
    body,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error || `the site returned ${res.status}`);
  return data;
}

const fieldPath = (key, suffix = '') => `/api/content/${encodeURIComponent(key)}${suffix}`;

/** Every editable field: `{ key, type, label, value, edited, maxLength?, multiline? }`. */
export async function listFields() {
  return (await request('GET', '/api/content')).fields;
}

export async function setText(key, value) {
  return (await request('PUT', fieldPath(key), { body: JSON.stringify({ value }), contentType: 'application/json' })).field;
}

/** `buffer` is the image file itself (JPEG, PNG or WebP — the site checks the bytes). */
export async function setImage(key, buffer) {
  return (await request('POST', fieldPath(key, '/image'), { body: buffer, contentType: 'application/octet-stream' })).field;
}

/** Puts a field back to the site's built-in default. */
export async function resetField(key) {
  return (await request('DELETE', fieldPath(key))).field;
}

/** Downloads an image field's current file (its `value` is a path on the site), for Undo. */
export async function downloadImage(value) {
  const res = await fetch(new URL(value, config.site.url), { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`the site returned ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}
