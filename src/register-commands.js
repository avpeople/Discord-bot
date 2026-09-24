import 'dotenv/config';
import { REST, Routes, SlashCommandBuilder } from 'discord.js';

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
