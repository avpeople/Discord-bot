import { config } from '../config.js';
import { readJsonFile, writeJsonFile } from '../json-store.js';

/**
 * Per-guild site editor config: which channel edits are typed into. Kept
 * in memory after the first read, since it's checked on every message.
 */
let state = null; // { [guildId]: { channelId } }

function load() {
  state ??= readJsonFile(config.siteStatePath, {});
  return state;
}

export function getSiteChannelId(guildId) {
  return load()[guildId]?.channelId ?? null;
}

export function setSiteChannelId(guildId, channelId) {
  load()[guildId] = { channelId };
  writeJsonFile(config.siteStatePath, state);
}
