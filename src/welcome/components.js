import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';

const REQUEST_PREFIX = 'welcome:request:';
const APPROVE_PREFIX = 'welcome:approve:';
const DENY_PREFIX = 'welcome:deny:';

export function isRequestButton(customId) {
  return customId.startsWith(REQUEST_PREFIX);
}
export function isApproveButton(customId) {
  return customId.startsWith(APPROVE_PREFIX);
}
export function isDenyButton(customId) {
  return customId.startsWith(DENY_PREFIX);
}

export function roleIdFromRequestButton(customId) {
  return customId.slice(REQUEST_PREFIX.length);
}

/**
 * Decodes an approve/deny button's customId back into {roleId, userId} —
 * both are Discord snowflakes, joined with a colon since neither can
 * contain one.
 */
export function decodeDecisionButton(customId, prefix) {
  const [roleId, userId] = customId.slice(prefix.length).split(':');
  return { roleId, userId };
}

/**
 * The welcome panel's buttons: one per configured role, up to Discord's
 * 25-button (5 rows x 5) cap. Each button's customId carries the role id
 * directly — well within the 100-char limit, no lookup table needed.
 */
export function buildWelcomePanelRows(roles) {
  const rows = [];
  for (let i = 0; i < roles.length && i < 25; i += 5) {
    const row = new ActionRowBuilder();
    for (const role of roles.slice(i, i + 5)) {
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(`${REQUEST_PREFIX}${role.roleId}`)
          .setLabel(role.label.slice(0, 80))
          .setStyle(ButtonStyle.Primary),
      );
    }
    rows.push(row);
  }
  return rows;
}

/** The Approve / Deny row posted in the approval channel for one request. */
export function buildApprovalRow(roleId, userId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${APPROVE_PREFIX}${roleId}:${userId}`)
      .setLabel('Approve')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`${DENY_PREFIX}${roleId}:${userId}`)
      .setLabel('Deny')
      .setStyle(ButtonStyle.Danger),
  );
}

export { APPROVE_PREFIX, DENY_PREFIX };
