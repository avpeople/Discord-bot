import { ActionRowBuilder, StringSelectMenuBuilder } from 'discord.js';
import { listAccessibleRepos } from '../github.js';

export const REPO_SELECT_ID = 'claude-session:repo-select';

/**
 * Builds the reply for `/code new`: a dropdown of repos the GitHub token
 * can access. Discord select menus cap at 25 options, so beyond that we
 * just show the first 25 and tell the user to narrow their token's repo
 * list if they need one further down.
 */
export async function buildRepoPickerReply() {
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
    .setCustomId(REPO_SELECT_ID)
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
    components: [row],
  };
}
