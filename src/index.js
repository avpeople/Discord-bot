import { Client, GatewayIntentBits, MessageFlags } from 'discord.js';
import { config } from './config.js';
import { runCodeJob } from './job.js';

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// Simple in-memory guard against overlapping jobs per channel; Claude Code
// jobs are heavy (git + subprocess), so we don't want two running in the
// same channel at once. Fine for a single-container deployment.
const runningInChannel = new Set();

function hasAccess(interaction) {
  const member = interaction.member;
  if (!member || !member.roles) return false;
  const roles = member.roles.cache ?? member.roles;
  return roles.has ? roles.has(config.discord.allowedRoleId) : roles.includes(config.discord.allowedRoleId);
}

client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== 'code') return;

  if (!hasAccess(interaction)) {
    await interaction.reply({
      content: "You don't have permission to use this command.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (runningInChannel.has(interaction.channelId)) {
    await interaction.reply({
      content: '⏳ A Claude Code job is already running in this channel. Wait for it to finish.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const repoSlug = interaction.options.getString('repo', true);
  const prompt = interaction.options.getString('prompt', true);
  const base = interaction.options.getString('base') || undefined;

  await interaction.deferReply();
  runningInChannel.add(interaction.channelId);

  let lastEdit = Promise.resolve();
  const onProgress = (text) => {
    lastEdit = lastEdit.then(() => interaction.editReply(text)).catch((err) => {
      console.error('Failed to edit reply:', err);
    });
  };

  try {
    const outcome = await runCodeJob({ repoSlug, prompt, base, onProgress });
    await lastEdit;

    if (!outcome.pushed) {
      await interaction.editReply(
        `✅ Claude Code ran on \`${repoSlug}\` but made no changes to commit.\n\n${outcome.summary ?? ''}`.slice(0, 2000),
      );
    } else {
      await interaction.editReply(
        `✅ Done! Opened **${outcome.pr.html_url}**\n\n${outcome.summary ?? ''}`.slice(0, 2000),
      );
    }
  } catch (err) {
    console.error(err);
    await lastEdit;
    await interaction.editReply(`❌ Job failed: ${err.message}`.slice(0, 2000));
  } finally {
    runningInChannel.delete(interaction.channelId);
  }
});

client.login(config.discord.token);
