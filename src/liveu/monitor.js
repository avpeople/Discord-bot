import * as liveu from './client.js';
import { buildSnapshot } from './parse.js';
import { allLiveuConfigs, lowBitrateKbps, updateLiveuConfig } from './store.js';
import { buildSummaryMessage, buildUnitMessage, formatBitrate, messageKey } from './view.js';
import { logEvent } from '../log-channel.js';

/**
 * Polls LiveU every POLL_INTERVAL_MS and:
 *  - keeps each guild's LiveU status channel up to date (summary + one
 *    message per unit, edited in place, only when something changed), and
 *  - posts changes to the guild's studio log (`/studio set-log-channel`):
 *    unit online/offline, went live/stopped, video input lost/back, SIM
 *    dropped/connected, bitrate below the alert threshold/recovered.
 *
 * The first poll after boot only records the current state, so a restart
 * doesn't re-announce everything. Does nothing unless LIVEU_EMAIL /
 * LIVEU_PASSWORD are set.
 */

const POLL_INTERVAL_MS = 15_000;
// Consecutive polls a live unit's bitrate must stay below (or back above) the
// threshold before it's logged, so one bad sample doesn't spam the log.
const BITRATE_POLLS_TO_ALERT = 2;
// The summary's "updated" time is refreshed at least this often even if nothing changed.
const SUMMARY_REFRESH_MS = 60_000;

let client = null;
let started = false;
let firstPoll = true;
let previous = new Map(); // bossId -> snapshot
let latest = []; // snapshots from the last successful poll, sorted by name
// `${guildId}:${bossId}` -> { low: boolean, streak: number }
const bitrateAlerts = new Map();
// messageId -> last rendered key, to skip no-op edits
const renderedKeys = new Map();
const summaryEditedAt = new Map(); // guildId -> ms

export function latestSnapshots() {
  return latest;
}

async function fetchDetails(unit, state) {
  if (state === 'offline') return null;
  const id = unit.BOSSID;
  const value = (result, fallback = null) => (result.status === 'fulfilled' ? result.value : fallback);
  const [interfaces, video, status, stream] = await Promise.allSettled([
    liveu.getInterfaces(id),
    liveu.getVideo(id),
    liveu.getStatus(id),
    liveu.getStream(id),
  ]);
  const details = { interfaces: value(interfaces), video: value(video), status: value(status), stream: value(stream), destinations: [] };
  // No named destination from /stream — fall back to the unit's preset list for a name to show.
  if (!details.stream?.destinationName) details.destinations = await liveu.getDestinations(id).catch(() => []);
  return details;
}

async function collectSnapshots() {
  const units = await liveu.listUnits();
  return Promise.all(
    units.map(async (unit) => {
      const base = buildSnapshot(unit, null);
      return buildSnapshot(unit, await fetchDetails(unit, base.state));
    }),
  ).then((snaps) => snaps.sort((a, b) => a.name.localeCompare(b.name)));
}

// ── Studio log events ────────────────────────────────────────────────────

/** Events that don't depend on per-guild settings. */
function stateEvents(prev, next) {
  const name = `**${next.name}**`;
  if (!prev) return [`🆕 LiveU ${name} added to the account (${next.state})`];

  const events = [];
  if (prev.state === 'offline' && next.state !== 'offline') events.push(`🟢 ${name} came online`);
  if (prev.state !== 'offline' && next.state === 'offline') {
    events.push(`${prev.state === 'live' ? '🚨' : '⚫'} ${name} went offline${prev.state === 'live' ? ' **while live**' : ''}`);
    return events; // everything else about it is moot
  }
  if (prev.state !== 'live' && next.state === 'live') {
    events.push(`🔴 ${name} is **LIVE**${next.destination ? ` to **${next.destination}**` : ''}`);
  }
  if (prev.state === 'live' && next.state === 'online') events.push(`⏹️ ${name} stopped streaming`);

  // Input/SIM changes only mean something between two polls where the unit was up and reporting.
  if (prev.state === 'offline' || !prev.detailsOk || !next.detailsOk) return events;

  const pv = prev.video.inputConnected;
  const nv = next.video.inputConnected;
  if (pv === true && nv === false) events.push(`⚠️ ${name} **lost video input**`);
  if (pv === false && nv === true) {
    events.push(`✅ ${name} video input back${next.video.resolution ? ` (${next.video.resolution})` : ''}`);
  }

  const prevUp = new Map(prev.interfaces.map((i) => [i.name, i.connected !== false]));
  for (const link of next.interfaces) {
    const wasUp = prevUp.get(link.name);
    const isUp = link.connected !== false;
    const label = link.kind === 'sim' ? 'SIM' : link.kind === 'wifi' ? 'Wi-Fi' : link.kind === 'ethernet' ? 'Ethernet' : 'link';
    if (wasUp === true && !isUp) events.push(`📵 ${name} lost ${label} **${link.name}**`);
    if (wasUp === false && isUp) events.push(`📶 ${name} ${label} **${link.name}** reconnected`);
    if (wasUp === undefined && isUp) events.push(`📶 ${name} ${label} **${link.name}** connected`);
  }
  const nextNames = new Set(next.interfaces.map((i) => i.name));
  for (const link of prev.interfaces) {
    if (!nextNames.has(link.name) && link.connected !== false) {
      events.push(`📵 ${name} lost ${link.kind === 'sim' ? 'SIM' : 'link'} **${link.name}** (no longer reported)`);
    }
  }
  return events;
}

/** Low-bitrate alert for one guild's threshold, with a streak so one bad sample doesn't alert. */
function bitrateEvent(guildId, snap) {
  const threshold = lowBitrateKbps(guildId);
  const key = `${guildId}:${snap.id}`;
  const alert = bitrateAlerts.get(key) ?? { low: false, streak: 0 };

  if (!threshold || snap.state !== 'live' || snap.totalKbps === null) {
    bitrateAlerts.delete(key);
    return null;
  }

  const isLow = snap.totalKbps < threshold;
  alert.streak = isLow !== alert.low ? alert.streak + 1 : 0;
  bitrateAlerts.set(key, alert);
  if (alert.streak < BITRATE_POLLS_TO_ALERT) return null;

  alert.low = isLow;
  alert.streak = 0;
  return isLow
    ? `📉 **${snap.name}** bitrate low: **${formatBitrate(snap.totalKbps)}** (alert below ${formatBitrate(threshold)})`
    : `📈 **${snap.name}** bitrate recovered: ${formatBitrate(snap.totalKbps)}`;
}

async function logEvents(snapshots) {
  const shared = [];
  if (!firstPoll) {
    for (const snap of snapshots) shared.push(...stateEvents(previous.get(snap.id), snap));
    const nextIds = new Set(snapshots.map((s) => s.id));
    for (const [id, snap] of previous) {
      if (!nextIds.has(id)) shared.push(`🗑️ LiveU **${snap.name}** removed from the account`);
    }
  }

  for (const guild of client.guilds.cache.values()) {
    const lines = [...shared];
    for (const snap of snapshots) {
      const event = bitrateEvent(guild.id, snap);
      if (event && !firstPoll) lines.push(event);
    }
    if (lines.length === 0) continue;
    // One message per poll keeps a burst (e.g. a unit dropping 3 SIMs) together.
    await logEvent(guild.id, lines.join('\n'), 'studio');
  }
}

// ── Status channel ───────────────────────────────────────────────────────

async function fetchMessage(channel, messageId) {
  if (!messageId) return null;
  return channel.messages.fetch(messageId).catch(() => null);
}

async function editIfChanged(message, payload, force = false) {
  const key = messageKey(payload);
  if (!force && renderedKeys.get(message.id) === key) return;
  await message.edit(payload);
  renderedKeys.set(message.id, key);
}

const renderQueues = new Map(); // guildId -> promise of the render in flight

/**
 * Brings one guild's status channel in line with `snapshots`. Missing
 * messages (a unit came online, someone deleted one) are posted; units that
 * went offline or left the account have their message removed. Renders for a guild
 * run one at a time, so two can't both post a missing message.
 */
export function renderPanel(guildId, snapshots, error = null) {
  const run = (renderQueues.get(guildId) ?? Promise.resolve()).then(() => renderPanelNow(guildId, snapshots, error));
  const queued = run.catch(() => {});
  renderQueues.set(guildId, queued);
  queued.then(() => {
    if (renderQueues.get(guildId) === queued) renderQueues.delete(guildId);
  });
  return run;
}

async function renderPanelNow(guildId, snapshots, error) {
  const cfg = allLiveuConfigs()[guildId];
  if (!cfg?.channelId) return;
  const channel = await client.channels.fetch(cfg.channelId).catch(() => null);
  if (!channel) return;

  const summaryPayload = buildSummaryMessage(snapshots, error);
  let summary = await fetchMessage(channel, cfg.summaryMessageId);
  if (!summary) {
    summary = await channel.send(summaryPayload);
    renderedKeys.set(summary.id, messageKey(summaryPayload));
    summaryEditedAt.set(guildId, Date.now());
    updateLiveuConfig(guildId, { summaryMessageId: summary.id });
  } else {
    const stale = Date.now() - (summaryEditedAt.get(guildId) ?? 0) > SUMMARY_REFRESH_MS;
    await editIfChanged(summary, summaryPayload, stale);
    if (stale) summaryEditedAt.set(guildId, Date.now());
  }

  // On an API error, keep showing the last known unit boxes rather than blanking them.
  if (error) return;

  // Only online/live units get a box; offline ones are just named in the summary.
  const shown = snapshots.filter((s) => s.state !== 'offline');
  const unitMessages = { ...cfg.unitMessages };
  for (const snap of shown) {
    const payload = buildUnitMessage(snap);
    const message = await fetchMessage(channel, unitMessages[snap.id]);
    if (message) {
      await editIfChanged(message, payload);
    } else {
      const sent = await channel.send(payload);
      renderedKeys.set(sent.id, messageKey(payload));
      unitMessages[snap.id] = sent.id;
    }
  }
  const shownIds = new Set(shown.map((s) => s.id));
  for (const [id, messageId] of Object.entries(unitMessages)) {
    if (shownIds.has(id)) continue;
    const message = await fetchMessage(channel, messageId);
    await message?.delete().catch(() => {});
    delete unitMessages[id];
  }
  updateLiveuConfig(guildId, { unitMessages });
}

async function renderAll(snapshots, error) {
  for (const guildId of Object.keys(allLiveuConfigs())) {
    if (!client.guilds.cache.has(guildId)) continue;
    await renderPanel(guildId, snapshots, error).catch((err) =>
      console.error(`[liveu] failed to update status channel for guild ${guildId}:`, err.message),
    );
  }
}

async function poll() {
  let snapshots;
  try {
    snapshots = await collectSnapshots();
  } catch (err) {
    console.error('[liveu] poll failed:', err.message);
    await renderAll(latest, err.message);
    return;
  }

  await logEvents(snapshots);
  previous = new Map(snapshots.map((s) => [s.id, s]));
  latest = snapshots;
  firstPoll = false;
  await renderAll(snapshots, null);
}

export function isMonitoring() {
  return started;
}

let inFlight = null;
/** One poll at a time; a caller arriving mid-poll waits for that one instead of starting another. */
function tick() {
  inFlight ??= poll()
    .catch((err) => console.error('[liveu] poll error:', err))
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

/** Polls right away (e.g. after a Go Live / Stop, so the panel catches up without waiting 15s). */
export function pollNow() {
  return started ? tick() : Promise.resolve();
}

/** Starts the LiveU watcher (once). Called from index.js after login. */
export function startLiveuMonitor(discordClient) {
  if (started) return;
  client = discordClient;
  if (!liveu.isConfigured()) {
    console.log('LIVEU_EMAIL / LIVEU_PASSWORD not set — LiveU monitoring disabled.');
    return;
  }
  started = true;
  tick();
  setInterval(tick, POLL_INTERVAL_MS);
}
