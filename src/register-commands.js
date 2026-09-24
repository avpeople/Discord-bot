import 'dotenv/config';
import { REST, Routes, SlashCommandBuilder } from 'discord.js';

const commands = [
  new SlashCommandBuilder()
    .setName('code')
    .setDescription('Run Claude Code against a GitHub repo and open a PR with the changes')
    .addStringOption((opt) =>
      opt
        .setName('repo')
        .setDescription('owner/name of the GitHub repo')
        .setRequired(true),
    )
    .addStringOption((opt) =>
      opt
        .setName('prompt')
        .setDescription('What should Claude change or do in this repo?')
        .setRequired(true),
    )
    .addStringOption((opt) =>
      opt
        .setName('base')
        .setDescription('Base branch to branch off / PR into (default: repo default branch)')
        .setRequired(false),
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
