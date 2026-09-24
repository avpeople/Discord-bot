import 'dotenv/config';
import { REST, Routes, SlashCommandBuilder, ChannelType } from 'discord.js';

const commands = [
  new SlashCommandBuilder()
    .setName('code')
    .setDescription('Manage interactive Claude Code sessions')
    .addSubcommand((sub) =>
      sub
        .setName('new')
        .setDescription('Start a new Claude Code session: pick a repo, get a private channel to chat in'),
    )
    .addSubcommand((sub) =>
      sub
        .setName('close')
        .setDescription('Close this session: push if needed, open a PR, and remove this channel'),
    )
    .addSubcommand((sub) =>
      sub
        .setName('set-picker-channel')
        .setDescription('Make a channel always show the repo picker (posts it there now)')
        .addChannelOption((opt) =>
          opt.setName('channel').setDescription('The channel to use as the permanent picker').setRequired(true),
        ),
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName('welcome')
    .setDescription('Manage the welcome panel and its role requests')
    .addSubcommand((sub) =>
      sub
        .setName('add-role')
        .setDescription('Add a role people can request from the welcome panel')
        .addRoleOption((opt) => opt.setName('role').setDescription('The role to make requestable').setRequired(true))
        .addStringOption((opt) =>
          opt.setName('label').setDescription('Button label (defaults to the role name)').setRequired(false),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('remove-role')
        .setDescription('Remove a role from the welcome panel')
        .addRoleOption((opt) => opt.setName('role').setDescription('The role to remove').setRequired(true)),
    )
    .addSubcommand((sub) =>
      sub
        .setName('set-approval-channel')
        .setDescription('Set where role requests get posted for approval')
        .addChannelOption((opt) =>
          opt.setName('channel').setDescription('The approval channel').setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('post')
        .setDescription('Post the welcome panel (with role-request buttons) in a channel')
        .addChannelOption((opt) =>
          opt.setName('channel').setDescription('Where to post the panel').setRequired(true),
        )
        .addStringOption((opt) =>
          opt.setName('title').setDescription('Embed title (optional, defaults to "Welcome to <server>!")').setRequired(false),
        )
        .addStringOption((opt) =>
          opt.setName('description').setDescription('Embed description (optional)').setRequired(false),
        ),
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName('voice')
    .setDescription('Bridge a Discord voice channel to a LiveKit channel (Coms server)')
    .addSubcommand((sub) =>
      sub
        .setName('join')
        .setDescription('Bridge a voice channel to a LiveKit channel')
        .addStringOption((opt) =>
          opt.setName('room').setDescription('The LiveKit channel id to bridge to').setRequired(true),
        )
        .addChannelOption((opt) =>
          opt
            .setName('channel')
            .setDescription('The Discord voice channel to bridge')
            .setRequired(true)
            .addChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('leave')
        .setDescription('Disconnect a voice channel from its LiveKit bridge')
        .addChannelOption((opt) =>
          opt
            .setName('channel')
            .setDescription('The bridged Discord voice channel')
            .setRequired(true)
            .addChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('status')
        .setDescription('Check whether a voice channel is currently bridged')
        .addChannelOption((opt) =>
          opt
            .setName('channel')
            .setDescription('The Discord voice channel to check')
            .setRequired(true)
            .addChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice),
        ),
    )
    .toJSON(),
];

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

async function main() {
  const clientId = process.env.DISCORD_CLIENT_ID;
  const guildId = process.env.DISCORD_GUILD_ID;

  const route = guildId
    ? Routes.applicationGuildCommands(clientId, guildId)
    : Routes.applicationCommands(clientId);

  console.log(`Registering ${commands.length} commands ${guildId ? `to guild ${guildId}` : 'globally'}...`);
  await rest.put(route, { body: commands });
  console.log('Done.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
