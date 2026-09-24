import { getLogChannel } from './log-channel-store.js';

let client = null;

/** Called once from index.js after the client logs in, so logEvent can send messages without threading a client reference through every call site. */
export function initLogChannel(discordClient) {
  client = discordClient;
}

/**
 * Sends one line to the guild's configured audit log channel, if any.
 * Silently no-ops if no log channel is set, the channel/guild can't be
 * fetched, or the bot lacks permission — logging is best-effort and must
 * never be the reason a real user-facing action fails.
 */
export async function logEvent(guildId, message) {
  if (!client || !guildId) return;
  const channelId = getLogChannel(guildId);
  if (!channelId) return;

  try {
    const channel = await client.channels.fetch(channelId);
    await channel.send(message.slice(0, 2000));
  } catch (err) {
    console.error('Failed to write to log channel:', err.message);
  }
}
