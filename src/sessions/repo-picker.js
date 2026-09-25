import { ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder } from 'discord.js';
import { listAccessibleRepos } from '../github.js';
import { SESSIONS_STATUS_BUTTON_ID, COOLIFY_STATUS_BUTTON_ID } from './reply.js';

export const REPO_SELECT_ID = 'claude-session:repo-select';
// Distinct id for the persistent picker channel's select menu (see
// channel-picker.js) — a different customId lets index.js route the two
// flows differently (ephemeral one-off reply vs. an always-visible message
// that repost itself after each pick).
export const PERSISTENT_REPO_SELECT_ID = 'claude-session:repo-select-persistent';

/**
 * Builds the repo-picker message content: a dropdown of repos the GitHub
 * token can access. Discord select menus cap at 25 options, so beyond that
 * we just show the first 25 and tell the user to narrow their token's repo
 * list if they need one further down. `selectId` lets callers choose which
 * customId the menu uses (ephemeral `/code new` vs. the persistent picker
 * channel), since the resulting interaction needs to be routed differently.
 */
export async function buildRepoPickerReply(selectId = REPO_SELECT_ID) {
  const repos = await listAccessibleRepos();

  if (repos.length === 0) {
    return {
      content:
        "The GitHub token isn't scoped to any repos yet. Add some under " +
        'Settings → Developer settings → Fine-grained tokens on GitHub, then try again.',
    };
  }

  const shown = repos.slice(0, 25);
  const menu = new StringSelectMenuBuilder()
    .setCustomId(selectId)
    .setPlaceholder('Choose a repo to start a Claude Code session')
    .addOptions(
      shown.map((r) => ({
        label: r.fullName.slice(0, 100),
        value: r.fullName,
      })),
    );

  const row = new ActionRowBuilder().addComponents(menu);
  const truncatedNote =
    repos.length > 25
      ? `\n(Showing the first 25 of ${repos.length} accessible repos — narrow the GitHub token's repo list to see others.)`
      : '';

  return {
    content: `Pick a repo to start a session:${truncatedNote}`,
    components: [row, buildStatusButtonsRow()],
  };
}

/**
 * Open Sessions and Server Status buttons under the picker. Server Status
 * always shows — if Coolify isn't configured, clicking it says which
 * setting is missing (see handleCoolifyStatus), which is easier to spot
 * than a button that silently isn't there.
 */
function buildStatusButtonsRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(SESSIONS_STATUS_BUTTON_ID).setLabel('Open Sessions').setEmoji('📋').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(COOLIFY_STATUS_BUTTON_ID).setLabel('Server Status').setEmoji('🖥️').setStyle(ButtonStyle.Secondary),
  );
}
