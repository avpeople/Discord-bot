import { config } from '../config.js';
import { readJsonFile, writeJsonFile } from '../json-store.js';

/**
 * Per-guild persistent picker channel config: which channel always shows
 * the repo picker, and the id of the picker message itself (so it can be
 * edited back to the plain picker after a temporary confirmation, and
 * found again after a restart without re-posting a duplicate).
 */
const DEFAULT_STATE = {}; // { [guildId]: { channelId, messageId } }

function load() {
  return readJsonFile(config.pickerChannelStatePath, DEFAULT_STATE);
}

function save(state) {
  writeJsonFile(config.pickerChannelStatePath, state);
}

export function getPickerChannel(guildId) {
  const state = load();
  return state[guildId] ?? null;
}

export function setPickerChannel(guildId, channelId, messageId) {
  const state = load();
  state[guildId] = { channelId, messageId };
  save(state);
}
