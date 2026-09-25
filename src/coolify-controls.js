import { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } from 'discord.js';
import * as coolify from './coolify.js';
import { decorateResources, describeResource, isStopped, STATUS_DIVIDER } from './coolify-view.js';
import { hasAccess } from './sessions/handlers.js';
import { logEvent } from './log-channel.js';

/**
 * Per-app controls, opened by picking an app from Server Status's dropdown
 * (all private to whoever's using them): 📜 Logs, 🔄 Restart, 🚀 Redeploy
 * and ⏹️ Stop / ▶️ Start. Restart, Redeploy, Stop and Start ask to confirm
 * first, then follow the resulting Coolify deployment in the same message.
 *
 * customIds: coolify:app:<uuid> (show app), coolify:logs:<uuid>,
 * coolify:ask:<action>:<uuid> (confirm prompt), coolify:do:<action>:<uuid>.
 */
export const APP_VIEW_PREFIX = 'coolify:app:';
export const LOGS_PREFIX = 'coolify:logs:';
export const ASK_PREFIX = 'coolify:ask:';
export const DO_PREFIX = 'coolify:do:';

const LOG_LINES = 30;
const FOLLOW_INTERVAL_MS = 5_000;
// Interaction replies can only be edited for 15 minutes, so stop following before then.
const FOLLOW_TIMEOUT_MS = 13 * 60 * 1000;

const ACTIONS = {
  restart: {
    emoji: '🔄',
    verb: 'Restart',
    doing: 'Restarting',
    explain: 'Restarts its containers with the current version. It will be briefly unavailable.',
  },
  redeploy: {
    emoji: '🚀',
    verb: 'Redeploy',
    doing: 'Redeploying',
    explain: 'Pulls the latest code from its branch, rebuilds and redeploys it. Takes a few minutes.',
  },
  stop: {
    emoji: '⏹️',
    verb: 'Stop',
    doing: 'Stopping',
    explain: 'Stops it completely — it will be **down** until someone starts it again.',
  },
  start: {
    emoji: '▶️',
    verb: 'Start',
    doing: 'Starting',
    explain: 'Starts it again.',
  },
};

// Coolify injects the running app's own uuid into its containers — used to
// warn before someone stops or restarts the bot from inside itself.
const SELF_UUID = process.env.COOLIFY_RESOURCE_UUID || null;

function noAccess(interaction) {
  return interaction.reply({ content: "You don't have permission to use this.", flags: MessageFlags.Ephemeral });
}

async function findApp(uuid) {
  const app = decorateResources(await coolify.listResources()).find((r) => r.uuid === uuid);
  if (!app) throw new Error("That app isn't in Coolify any more.");
  return app;
}

function backRow(uuid) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`${APP_VIEW_PREFIX}${uuid}`).setLabel('Back to app').setEmoji('⬅️').setStyle(ButtonStyle.Secondary),
  );
}

/** The app's status card with its control buttons. */
function appView(app) {
  const stopped = isStopped(app.status);
  const controls = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`${LOGS_PREFIX}${app.uuid}`).setLabel('Logs').setEmoji('📜').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`${ASK_PREFIX}restart:${app.uuid}`).setLabel('Restart').setEmoji('🔄').setStyle(ButtonStyle.Primary).setDisabled(stopped),
    new ButtonBuilder().setCustomId(`${ASK_PREFIX}redeploy:${app.uuid}`).setLabel('Redeploy').setEmoji('🚀').setStyle(ButtonStyle.Primary),
    stopped
      ? new ButtonBuilder().setCustomId(`${ASK_PREFIX}start:${app.uuid}`).setLabel('Start').setEmoji('▶️').setStyle(ButtonStyle.Success)
      : new ButtonBuilder().setCustomId(`${ASK_PREFIX}stop:${app.uuid}`).setLabel('Stop').setEmoji('⏹️').setStyle(ButtonStyle.Danger),
  );
  const refresh = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`${APP_VIEW_PREFIX}${app.uuid}`).setLabel('Refresh').setEmoji('🔄').setStyle(ButtonStyle.Secondary),
  );
  return {
    content: `${STATUS_DIVIDER}\n${describeResource(app)}\n${STATUS_DIVIDER}\n-# Updated <t:${Math.floor(Date.now() / 1000)}:R>`,
    components: [controls, refresh],
    allowedMentions: { parse: [] },
  };
}

/** Picked from Server Status's dropdown, or Back/Refresh — shows the app's card and controls. */
export async function handleAppView(interaction) {
  if (!hasAccess(interaction)) return noAccess(interaction);
  const uuid = interaction.isStringSelectMenu() ? interaction.values[0] : interaction.customId.slice(APP_VIEW_PREFIX.length);

  // From the Server Status dropdown: open the app in a new private message so the list stays put.
  if (interaction.isStringSelectMenu()) await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  else await interaction.deferUpdate();
  try {
    await interaction.editReply(appView(await findApp(uuid)));
  } catch (err) {
    await interaction.editReply({ content: `❌ ${err.message}`, components: [] });
  }
}

/** 📜 Logs — the app's last lines of container output. */
export async function handleLogs(interaction) {
  if (!hasAccess(interaction)) return noAccess(interaction);
  const uuid = interaction.customId.slice(LOGS_PREFIX.length);
  await interaction.deferUpdate();
  try {
    const [app, logs] = await Promise.all([findApp(uuid), coolify.getApplicationLogs(uuid, LOG_LINES)]);
    // Keep the newest lines if it's too long for one message; neutralise ``` so the code block can't break.
    const body = (logs || '(no log output)').replace(/```/g, "'''").slice(-1700);
    await interaction.editReply({
      content: `📜 **${app.plainLabel}** — last ${LOG_LINES} lines\n\`\`\`\n${body}\n\`\`\``,
      components: [
        new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`${LOGS_PREFIX}${uuid}`).setLabel('Refresh Logs').setEmoji('🔄').setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId(`${APP_VIEW_PREFIX}${uuid}`).setLabel('Back to app').setEmoji('⬅️').setStyle(ButtonStyle.Secondary),
        ),
      ],
    });
  } catch (err) {
    await interaction.editReply({ content: `❌ Couldn't get logs: ${err.message}`, components: [backRow(uuid)] });
  }
}

/** Restart / Redeploy / Stop / Start — asks to confirm first. */
export async function handleAsk(interaction) {
  if (!hasAccess(interaction)) return noAccess(interaction);
  const [kind, uuid] = interaction.customId.slice(ASK_PREFIX.length).split(':');
  const action = ACTIONS[kind];
  await interaction.deferUpdate();
  try {
    const app = await findApp(uuid);
    const selfWarning =
      uuid === SELF_UUID && (kind === 'stop' || kind === 'restart' || kind === 'redeploy')
        ? '\n⚠️ **This is this bot.** It will go offline' + (kind === 'stop' ? ' and can only be started again from Coolify.' : ' for a bit, and this message will stop updating.')
        : '';
    await interaction.editReply({
      content: `${action.emoji} **${action.verb} ${app.plainLabel}?**\n${action.explain}${selfWarning}`,
      components: [
        new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`${DO_PREFIX}${kind}:${uuid}`)
            .setLabel(`Yes, ${action.verb.toLowerCase()}`)
            .setStyle(kind === 'stop' ? ButtonStyle.Danger : ButtonStyle.Primary),
          new ButtonBuilder().setCustomId(`${APP_VIEW_PREFIX}${uuid}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary),
        ),
      ],
    });
  } catch (err) {
    await interaction.editReply({ content: `❌ ${err.message}`, components: [backRow(uuid)] });
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Confirmed — runs the action, then follows the deployment Coolify queued for it (if any) in the same message. */
export async function handleDo(interaction) {
  if (!hasAccess(interaction)) return noAccess(interaction);
  const [kind, uuid] = interaction.customId.slice(DO_PREFIX.length).split(':');
  const action = ACTIONS[kind];
  await interaction.deferUpdate();

  let app;
  try {
    app = await findApp(uuid);
    await interaction.editReply({ content: `${action.emoji} ${action.doing} **${app.plainLabel}**...`, components: [] });
    const deploymentUuid = await coolify.controlApplication(uuid, kind);
    logEvent(interaction.guildId, `${action.emoji} ${interaction.user} ran **${action.verb}** on **${app.plainLabel}** from Server Status.`);

    if (!deploymentUuid) {
      await interaction.editReply({
        content: `${action.emoji} ${action.verb} requested for **${app.plainLabel}**. Coolify is working on it — Refresh in a moment.`,
        components: [backRow(uuid)],
      });
      return;
    }

    const startedAt = Date.now();
    let status = 'queued';
    while (!coolify.DONE_STATUSES.has(status) && Date.now() - startedAt < FOLLOW_TIMEOUT_MS) {
      await interaction
        .editReply({ content: `${action.emoji} ${action.doing} **${app.plainLabel}** — ${status === 'in_progress' ? '🔨 in progress' : '🕐 queued'}...` })
        .catch(() => {});
      await sleep(FOLLOW_INTERVAL_MS);
      status = (await coolify.getDeploymentStatus(deploymentUuid)) ?? status;
    }

    const took = Math.round((Date.now() - startedAt) / 1000);
    const result = {
      finished: `✅ ${action.verb} of **${app.plainLabel}** finished (took ${took >= 60 ? `${Math.floor(took / 60)}m ${took % 60}s` : `${took}s`}).`,
      failed: `❌ ${action.verb} of **${app.plainLabel}** failed — check its Logs, or the deployment log in Coolify.`,
      'cancelled-by-user': `⚪ ${action.verb} of **${app.plainLabel}** was cancelled in Coolify.`,
    }[status] ?? `⏳ ${action.verb} of **${app.plainLabel}** is still going — check back with Refresh.`;
    await interaction.editReply({ content: result, components: [backRow(uuid)] });
    if (status === 'failed') logEvent(interaction.guildId, `❌ ${action.verb} of **${app.plainLabel}** failed.`);
  } catch (err) {
    console.error(`[coolify] ${kind} failed:`, err);
    await interaction.editReply({ content: `❌ ${action.verb} failed: ${err.message}`.slice(0, 2000), components: [backRow(uuid)] }).catch(() => {});
  }
}

/** Routes every coolify:* control interaction except the Server Status button itself. */
export async function handleCoolifyControl(interaction) {
  const id = interaction.customId;
  if (interaction.isStringSelectMenu() || id.startsWith(APP_VIEW_PREFIX)) return handleAppView(interaction);
  if (id.startsWith(LOGS_PREFIX)) return handleLogs(interaction);
  if (id.startsWith(ASK_PREFIX)) return handleAsk(interaction);
  if (id.startsWith(DO_PREFIX)) return handleDo(interaction);
}
