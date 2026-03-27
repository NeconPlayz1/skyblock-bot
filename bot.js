const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder,
  Collection,
} = require('discord.js');
const axios = require('axios');
const NodeCache = require('node-cache');

// ─── ENV ──────────────────────────────────────────────────────────────────────
const DISCORD_TOKEN  = process.env.DISCORD_TOKEN;
const CLIENT_ID      = process.env.CLIENT_ID;
const HYPIXEL_API_KEY = process.env.HYPIXEL_API_KEY;

// ─── CACHE (5 min TTL) ────────────────────────────────────────────────────────
const cache = new NodeCache({ stdTTL: 300 });

// ─── CLIENT ───────────────────────────────────────────────────────────────────
const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

// ─── IN-MEMORY LFG STORE ─────────────────────────────────────────────────────
// Map<guildId, Array<{userId, tag, tier, role, note, ts}>>
const lfgStore = new Map();

// ═══════════════════════════════════════════════════════════════════════════════
//  HYPIXEL / MOJANG API HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

async function fetchMojang(username) {
  const key = `mojang_${username.toLowerCase()}`;
  if (cache.has(key)) return cache.get(key);
  const { data } = await axios.get(
    `https://api.mojang.com/users/profiles/minecraft/${username}`
  );
  cache.set(key, data);
  return data; // { id, name }
}

async function fetchProfiles(uuid) {
  const key = `profiles_${uuid}`;
  if (cache.has(key)) return cache.get(key);
  const { data } = await axios.get(
    `https://api.hypixel.net/skyblock/profiles?uuid=${uuid}&key=${HYPIXEL_API_KEY}`
  );
  cache.set(key, data.profiles || []);
  return data.profiles || [];
}

async function fetchBazaar() {
  if (cache.has('bazaar')) return cache.get('bazaar');
  const { data } = await axios.get(
    `https://api.hypixel.net/skyblock/bazaar?key=${HYPIXEL_API_KEY}`
  );
  cache.set('bazaar', data.products || {});
  return data.products || {};
}

async function fetchAH(page = 0) {
  const { data } = await axios.get(
    `https://api.hypixel.net/skyblock/auctions?page=${page}&key=${HYPIXEL_API_KEY}`
  );
  return data;
}

async function fetchMayor() {
  if (cache.has('mayor')) return cache.get('mayor');
  const { data } = await axios.get(
    `https://api.hypixel.net/resources/skyblock/election?key=${HYPIXEL_API_KEY}`
  );
  cache.set('mayor', data);
  return data;
}

// ─── Profile helpers ──────────────────────────────────────────────────────────
function getActiveProfile(profiles, uuid) {
  if (!profiles?.length) return null;
  return profiles.find((p) => p.selected) || profiles[0];
}
function getMember(profile, uuid) {
  return profile?.members?.[uuid] || null;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  MATH / FORMAT HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

function fmt(n) {
  if (n == null || isNaN(n)) return '0';
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return Math.round(n).toLocaleString();
}

// ── Skill XP table ─────────────────────────────────────────────────────────
const SKILL_XP = [
  0, 50, 125, 200, 300, 500, 750, 1000, 1500, 2000, 3500, 5000, 7500, 10000,
  15000, 20000, 30000, 50000, 75000, 100000, 200000, 300000, 400000, 500000,
  600000, 700000, 800000, 900000, 1000000, 1100000, 1200000, 1300000, 1400000,
  1500000, 1600000, 1700000, 1800000, 1900000, 2000000, 2100000, 2200000,
  2300000, 2400000, 2500000, 2600000, 2750000, 2900000, 3100000, 3400000,
  3700000, 4000000, 4300000, 4600000, 5000000, 5500000, 6000000, 6500000,
  7000000, 7500000,
];

function skillLevel(xp, max = 60) {
  let lvl = 0, total = 0;
  for (let i = 0; i < Math.min(max, SKILL_XP.length); i++) {
    if (xp >= total + SKILL_XP[i]) { total += SKILL_XP[i]; lvl = i; }
    else break;
  }
  return lvl;
}

function skillAvg(member) {
  const names = ['farming','mining','combat','foraging','fishing','enchanting','alchemy','taming'];
  let sum = 0;
  for (const s of names) sum += skillLevel(member[`experience_skill_${s}`] || 0);
  return sum / names.length;
}

// ── Slayer XP ──────────────────────────────────────────────────────────────
const SLAYER_XP = {
  zombie:   [0, 5, 15, 200, 1000, 5000, 20000, 100000, 400000, 1000000],
  spider:   [0, 5, 25, 200, 1000, 5000, 20000, 100000, 400000, 1000000],
  wolf:     [0, 10, 30, 250, 1500, 5000, 20000, 100000, 400000, 1000000],
  enderman: [0, 10, 30, 250, 1500, 5000, 20000, 100000, 400000, 1000000],
  blaze:    [0, 10, 30, 250, 1500, 5000, 20000, 100000, 400000, 1000000],
  vampire:  [0, 20, 75, 240, 840, 2400],
};
function slayerLevel(xp, type) {
  const t = SLAYER_XP[type] || [];
  let lvl = 0;
  for (let i = 0; i < t.length; i++) { if (xp >= t[i]) lvl = i; else break; }
  return lvl;
}

// ── Dungeon XP ─────────────────────────────────────────────────────────────
const DUNG_XP = [
  0, 50, 75, 110, 160, 230, 330, 470, 670, 950, 1340, 1890, 2665, 3760, 5260,
  7380, 10300, 14400, 20000, 27600, 38000, 52500, 71500, 97000, 132000, 180000,
  243000, 328000, 445000, 600000, 800000, 1065000, 1410000, 1900000, 2500000,
  3300000, 4300000, 5600000, 7200000, 9200000, 12000000, 15000000, 19000000,
  24000000, 30000000, 38000000, 48000000, 60000000, 75000000, 93000000,
];
function dungLevel(xp) {
  let lvl = 0, total = 0;
  for (let i = 0; i < DUNG_XP.length; i++) {
    if (xp >= total + DUNG_XP[i]) { total += DUNG_XP[i]; lvl = i; }
    else break;
  }
  return lvl;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  KUUDRA DATA
// ═══════════════════════════════════════════════════════════════════════════════

const TIERS = {
  basic: {
    label: 'Basic (T1)', color: 0x55FF55, minEHP: 15000, recCata: 10,
    setup: {
      armor:   'Any Crimson Armor set (even Hot quality is fine)',
      weapon:  'Midas Staff / Spirit Sceptre / Aurora Staff',
      pet:     'Blaze Pet Lvl 100 (or Tiger)',
      acc:     'Full Talisman Bag (Common → Rare reforged)',
      reforge: 'Fierce (Chest), Necrotic (Helm), Bloody (Legs/Boots)',
      notes:   'Basic is the easiest tier. Just get 15k+ EHP and any crimson set.',
    },
    profit: { avgLoot: 80_000, keyCost: 40_000 },
    guide: [
      '**Phase 1 – Supply Run:** Sprint to supplies, ignore minions.',
      '**Phase 2 – Build:** Dump supplies quickly, protect builders.',
      '**Phase 3 – Fight:** Ballista stuns Kuudra, then DPS his weak spot.',
      '**Phase 4 – Chest:** Open paid chest for best loot.',
      '**Tip:** Crimson Key required to open chest.',
    ],
  },
  hot: {
    label: 'Hot (T2)', color: 0xFF5555, minEHP: 30000, recCata: 15,
    setup: {
      armor:   'Fine or Burning Crimson Armor (full set)',
      weapon:  'Aurora Staff / Starred Midas Staff',
      pet:     'Blaze Pet Lvl 100',
      acc:     'Full Talisman Bag (up to Epic reforged)',
      reforge: 'Fierce (Chest), Necrotic (Helm), Bloody (Legs/Boots)',
      notes:   'Aim for 30k+ EHP. Swap Boots to Magma Lord if available.',
    },
    profit: { avgLoot: 220_000, keyCost: 100_000 },
    guide: [
      '**Phase 1:** Faster supply collection needed vs Basic.',
      '**Phase 2:** More minions spawn — one player should guard.',
      '**Phase 3:** Kuudra hits harder, dodge his projectiles.',
      '**Tip:** Mana potions help sustain staff usage throughout the run.',
    ],
  },
  burning: {
    label: 'Burning (T3)', color: 0xFF8800, minEHP: 60000, recCata: 20,
    setup: {
      armor:   'Burning Crimson Armor or better',
      weapon:  'Aurora Staff / Starred Midas Staff',
      pet:     'Blaze Pet Lvl 100 with Tier Boost',
      acc:     'Full Talisman Bag (Epic+), Mana Flask',
      reforge: 'Fierce (Chest), Necrotic/Warped (Helm), Bloody (Legs/Boots)',
      notes:   'Need 60k+ EHP. Aim for 4M+ HP pool with pots.',
    },
    profit: { avgLoot: 650_000, keyCost: 300_000 },
    guide: [
      '**Phase 1:** Use Speed pot, collect all supplies within 45s.',
      '**Phase 2:** Protect builders aggressively, DPS minions hard.',
      '**Phase 3:** Ballista needs 2 hits at this tier. Watch for waves.',
      '**Tip:** Strength Pots and God Pot significantly improve DPS.',
    ],
  },
  fiery: {
    label: 'Fiery (T4)', color: 0xFF2200, minEHP: 120000, recCata: 25,
    setup: {
      armor:   'Fiery Crimson Armor (all pieces)',
      weapon:  'Infernal/Aurora Staff or Starred Midas',
      pet:     'Blaze Lvl 100 (Tier Boost) or Black Cat Lvl 100',
      acc:     'Full Talisman Bag (all Legendary), Mana Flask',
      reforge: 'Fierce (Chest), Necrotic (Helm), Bloody (Legs/Boots)',
      notes:   'Need 120k+ EHP. Must use Overload 5 + God Pot.',
    },
    profit: { avgLoot: 2_200_000, keyCost: 1_000_000 },
    guide: [
      '**Phase 1:** Must finish supply run in under 40s.',
      '**Phase 2:** Minion waves are much stronger — tank/healer needed.',
      '**Phase 3:** Ballista takes 3 hits. Kuudra does AoE damage.',
      '**Tip:** Always use Overload + God Pot. Coordinate with team.',
    ],
  },
  infernal: {
    label: 'Infernal (T5)', color: 0x8800FF, minEHP: 300000, recCata: 30,
    setup: {
      armor:   'Infernal Crimson Armor (all pieces, best quality)',
      weapon:  'Infernal Staff (Starred) / Shadow Fury for tank',
      pet:     'Blaze Lvl 100 (Tier Boost) or Ender Dragon Lvl 100',
      acc:     'Fully optimized Talisman Bag (Recombobulated + MP reforged)',
      reforge: 'Fierce (Chest), Necrotic (Helm), Withered/Bloody (Legs/Boots)',
      notes:   'Need 300k+ EHP. Overload 5, God Pot, Mana Flask, Adrenaline required.',
    },
    profit: { avgLoot: 9_000_000, keyCost: 4_000_000 },
    guide: [
      '**Phase 1:** Perfect supply run needed — under 35s.',
      '**Phase 2:** Extremely strong minions — coordinate roles tightly.',
      '**Phase 3:** Ballista takes 4+ hits. Constant Kuudra AoE. Do NOT facetank.',
      '**Phase 4:** Infernal chests can drop 10M+ items (Attribute Shards, Crimson Armor pieces).',
      '**Tip:** Best-in-slot setup required. Even one player under-geared can wipe the team.',
    ],
  },
};

// ═══════════════════════════════════════════════════════════════════════════════
//  SLASH COMMANDS DEFINITIONS
// ═══════════════════════════════════════════════════════════════════════════════

const tierChoices = [
  { name: 'Basic  (T1)', value: 'basic' },
  { name: 'Hot    (T2)', value: 'hot' },
  { name: 'Burning(T3)', value: 'burning' },
  { name: 'Fiery  (T4)', value: 'fiery' },
  { name: 'Infernal(T5)', value: 'infernal' },
];

const commands = [
  // ── /stats ──────────────────────────────────────────────────────────────
  new SlashCommandBuilder()
    .setName('stats')
    .setDescription('📊 View a player\'s general Skyblock stats')
    .addStringOption(o =>
      o.setName('username').setDescription('Minecraft username').setRequired(true)
    ),

  // ── /networth ───────────────────────────────────────────────────────────
  new SlashCommandBuilder()
    .setName('networth')
    .setDescription('💰 Check a player\'s estimated networth')
    .addStringOption(o =>
      o.setName('username').setDescription('Minecraft username').setRequired(true)
    ),

  // ── /skills ─────────────────────────────────────────────────────────────
  new SlashCommandBuilder()
    .setName('skills')
    .setDescription('📚 View a player\'s skill levels and XP progress')
    .addStringOption(o =>
      o.setName('username').setDescription('Minecraft username').setRequired(true)
    ),

  // ── /slayer ─────────────────────────────────────────────────────────────
  new SlashCommandBuilder()
    .setName('slayer')
    .setDescription('⚔️ View a player\'s slayer boss levels')
    .addStringOption(o =>
      o.setName('username').setDescription('Minecraft username').setRequired(true)
    ),

  // ── /dungeons ───────────────────────────────────────────────────────────
  new SlashCommandBuilder()
    .setName('dungeons')
    .setDescription('🏰 View a player\'s Catacombs & dungeon class levels')
    .addStringOption(o =>
      o.setName('username').setDescription('Minecraft username').setRequired(true)
    ),

  // ── /bazaar ─────────────────────────────────────────────────────────────
  new SlashCommandBuilder()
    .setName('bazaar')
    .setDescription('🏪 Check Bazaar buy/sell prices for an item')
    .addStringOption(o =>
      o.setName('item').setDescription('Item name or partial ID (e.g. ENCHANTED_IRON)').setRequired(true)
    ),

  // ── /auction ────────────────────────────────────────────────────────────
  new SlashCommandBuilder()
    .setName('auction')
    .setDescription('🔨 Search the Auction House for an item')
    .addStringOption(o =>
      o.setName('item').setDescription('Item name to search').setRequired(true)
    ),

  // ── /mayor ──────────────────────────────────────────────────────────────
  new SlashCommandBuilder()
    .setName('mayor')
    .setDescription('🏛️ View the current Skyblock Mayor and their perks'),

  // ── /profile ────────────────────────────────────────────────────────────
  new SlashCommandBuilder()
    .setName('profile')
    .setDescription('🗂️ Show a player\'s profile list and details')
    .addStringOption(o =>
      o.setName('username').setDescription('Minecraft username').setRequired(true)
    ),

  // ── /compare ────────────────────────────────────────────────────────────
  new SlashCommandBuilder()
    .setName('compare')
    .setDescription('⚖️ Compare two players\' skill averages and stats')
    .addStringOption(o =>
      o.setName('player1').setDescription('First player').setRequired(true)
    )
    .addStringOption(o =>
      o.setName('player2').setDescription('Second player').setRequired(true)
    ),

  // ── /help ───────────────────────────────────────────────────────────────
  new SlashCommandBuilder()
    .setName('help')
    .setDescription('📖 Show all available bot commands'),

  // ── /kuudra ─────────────────────────────────────────────────────────────
  new SlashCommandBuilder()
    .setName('kuudra')
    .setDescription('🔥 All Kuudra-related commands')

    .addSubcommand(sub =>
      sub.setName('setup')
        .setDescription('🛡️ Best gear setup for a Kuudra tier')
        .addStringOption(o =>
          o.setName('tier').setDescription('Kuudra tier').setRequired(true).addChoices(...tierChoices)
        )
    )

    .addSubcommand(sub =>
      sub.setName('profit')
        .setDescription('💰 Profit calculator for a Kuudra tier')
        .addStringOption(o =>
          o.setName('tier').setDescription('Kuudra tier').setRequired(true).addChoices(...tierChoices)
        )
        .addIntegerOption(o =>
          o.setName('runs').setDescription('Number of runs (default 1)').setMinValue(1).setMaxValue(10000)
        )
    )

    .addSubcommand(sub =>
      sub.setName('requirements')
        .setDescription('🔍 Check if a player meets requirements for a tier')
        .addStringOption(o =>
          o.setName('username').setDescription('Minecraft username').setRequired(true)
        )
        .addStringOption(o =>
          o.setName('tier').setDescription('Kuudra tier').setRequired(true).addChoices(...tierChoices)
        )
    )

    .addSubcommand(sub =>
      sub.setName('lfg')
        .setDescription('📢 Post a Looking-for-Group message')
        .addStringOption(o =>
          o.setName('tier').setDescription('Kuudra tier').setRequired(true).addChoices(...tierChoices)
        )
        .addStringOption(o =>
          o.setName('role')
            .setDescription('Your role')
            .setRequired(true)
            .addChoices(
              { name: '🔥 Mage',    value: '🔥 Mage' },
              { name: '⚔️ Berserk', value: '⚔️ Berserk' },
              { name: '🛡️ Tank',    value: '🛡️ Tank' },
              { name: '💚 Healer',  value: '💚 Healer' },
              { name: '🏹 Archer',  value: '🏹 Archer' },
            )
        )
        .addStringOption(o =>
          o.setName('note').setDescription('Optional extra info (IGN, EHP, etc.)')
        )
    )

    .addSubcommand(sub =>
      sub.setName('parties')
        .setDescription('📋 View active LFG parties')
        .addStringOption(o =>
          o.setName('tier')
            .setDescription('Filter by tier (leave empty for all)')
            .addChoices(...tierChoices, { name: 'All Tiers', value: 'all' })
        )
    )

    .addSubcommand(sub =>
      sub.setName('guide')
        .setDescription('📖 Kuudra tips, phases, and strategy')
        .addStringOption(o =>
          o.setName('tier').setDescription('Specific tier guide (leave empty for general)').addChoices(...tierChoices)
        )
    )

    .addSubcommand(sub =>
      sub.setName('tiers')
        .setDescription('📊 Overview of all Kuudra tiers and their profit/requirements')
    ),

].map(c => c.toJSON());

// ═══════════════════════════════════════════════════════════════════════════════
//  REGISTER COMMANDS
// ═══════════════════════════════════════════════════════════════════════════════

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
  console.log('📡 Registering slash commands globally...');
  try {
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
    console.log(`✅ Registered ${commands.length} slash commands!`);
  } catch (err) {
    console.error('❌ Failed to register commands:', err.message);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  READY
// ═══════════════════════════════════════════════════════════════════════════════

client.once('ready', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  client.user.setActivity('/help | Skyblock Bot', { type: 3 }); // WATCHING
  await registerCommands();
});

// ═══════════════════════════════════════════════════════════════════════════════
//  INTERACTION HANDLER
// ═══════════════════════════════════════════════════════════════════════════════

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  await interaction.deferReply();

  try {
    const cmd = interaction.commandName;
    const sub = interaction.options.getSubcommand(false);

    // ───────────────────────────────────────────────────────────────────────
    //  /stats
    // ───────────────────────────────────────────────────────────────────────
    if (cmd === 'stats') {
      const username = interaction.options.getString('username');
      const mojang   = await fetchMojang(username);
      const uuid     = mojang.id;
      const profiles = await fetchProfiles(uuid);
      const profile  = getActiveProfile(profiles, uuid);
      const member   = getMember(profile, uuid);
      if (!member) return interaction.editReply('❌ No Skyblock data found for this player.');

      const avg      = skillAvg(member).toFixed(2);
      const purse    = member.coin_purse || 0;
      const bank     = profile?.banking?.balance || 0;
      const deaths   = member.death_count || 0;
      const fairy    = member.fairy_souls_collected || 0;

      const cataXP   = member.dungeons?.dungeon_types?.catacombs?.experience || 0;
      const cataLvl  = dungLevel(cataXP);
      const slayers  = member.slayer_bosses || {};
      const totalSlayerXP = Object.values(slayers).reduce((s, v) => s + (v.xp || 0), 0);

      const embed = new EmbedBuilder()
        .setTitle(`📊 ${mojang.name}'s Skyblock Stats`)
        .setColor(0x00AAFF)
        .setThumbnail(`https://mc-heads.net/avatar/${uuid}`)
        .addFields(
          { name: '🏝️ Active Profile',    value: profile.cute_name || 'Unknown', inline: true },
          { name: '📚 Skill Average',     value: avg,                            inline: true },
          { name: '🏰 Catacombs Level',   value: `${cataLvl}`,                  inline: true },
          { name: '💵 Purse',             value: fmt(purse),                    inline: true },
          { name: '🏦 Bank',              value: fmt(bank),                     inline: true },
          { name: '⚔️ Total Slayer XP',   value: fmt(totalSlayerXP),            inline: true },
          { name: '💀 Deaths',            value: `${deaths}`,                   inline: true },
          { name: '🧚 Fairy Souls',       value: `${fairy}`,                    inline: true },
          { name: '📦 Total Profiles',    value: `${profiles.length}`,          inline: true },
        )
        .setFooter({ text: 'Hypixel Skyblock Bot • Data may be cached up to 5 min' })
        .setTimestamp();

      return interaction.editReply({ embeds: [embed] });
    }

    // ───────────────────────────────────────────────────────────────────────
    //  /networth
    // ───────────────────────────────────────────────────────────────────────
    if (cmd === 'networth') {
      const username = interaction.options.getString('username');
      const mojang   = await fetchMojang(username);
      const uuid     = mojang.id;
      const profiles = await fetchProfiles(uuid);
      const profile  = getActiveProfile(profiles, uuid);
      const member   = getMember(profile, uuid);
      if (!member) return interaction.editReply('❌ No Skyblock data found.');

      const purse = member.coin_purse || 0;
      const bank  = profile?.banking?.balance || 0;
      const coins = purse + bank;

      const embed = new EmbedBuilder()
        .setTitle(`💰 ${mojang.name}'s Networth`)
        .setColor(0xFFD700)
        .setThumbnail(`https://mc-heads.net/avatar/${uuid}`)
        .setDescription(
          '> ⚠️ Item networth requires full NBT parsing (not available via public API).\n' +
          '> For precise networth, check [sky.shiiyu.moe](https://sky.shiiyu.moe) or SkyHelper.\n' +
          '> Below shows your **liquid coin wealth**.'
        )
        .addFields(
          { name: '💵 Purse',              value: fmt(purse), inline: true },
          { name: '🏦 Bank',               value: fmt(bank),  inline: true },
          { name: '💎 Total Liquid Coins', value: `**${fmt(coins)}**`, inline: false },
        )
        .setFooter({ text: 'Hypixel Skyblock Bot' })
        .setTimestamp();

      return interaction.editReply({ embeds: [embed] });
    }

    // ───────────────────────────────────────────────────────────────────────
    //  /skills
    // ───────────────────────────────────────────────────────────────────────
    if (cmd === 'skills') {
      const username = interaction.options.getString('username');
      const mojang   = await fetchMojang(username);
      const uuid     = mojang.id;
      const profiles = await fetchProfiles(uuid);
      const profile  = getActiveProfile(profiles, uuid);
      const member   = getMember(profile, uuid);
      if (!member) return interaction.editReply('❌ No Skyblock data found.');

      const skillNames = [
        { key: 'farming',    emoji: '🌾', max: 60 },
        { key: 'mining',     emoji: '⛏️',  max: 60 },
        { key: 'combat',     emoji: '⚔️',  max: 60 },
        { key: 'foraging',   emoji: '🌲', max: 50 },
        { key: 'fishing',    emoji: '🎣', max: 50 },
        { key: 'enchanting', emoji: '✨', max: 60 },
        { key: 'alchemy',    emoji: '⚗️',  max: 50 },
        { key: 'carpentry',  emoji: '🔨', max: 50 },
        { key: 'taming',     emoji: '🐾', max: 50 },
        { key: 'runecrafting', emoji: '🔮', max: 25 },
      ];

      const lines = skillNames.map(({ key, emoji, max }) => {
        const xp  = member[`experience_skill_${key}`] || 0;
        const lvl = skillLevel(xp, max);
        const bar = '█'.repeat(Math.round(lvl / max * 10)) + '░'.repeat(10 - Math.round(lvl / max * 10));
        return `${emoji} **${key.charAt(0).toUpperCase() + key.slice(1)}** — Lvl **${lvl}**/${max} \`${bar}\` ${fmt(xp)} XP`;
      });

      const avg = skillAvg(member).toFixed(2);

      const embed = new EmbedBuilder()
        .setTitle(`📚 ${mojang.name}'s Skills`)
        .setColor(0x00FF88)
        .setThumbnail(`https://mc-heads.net/avatar/${uuid}`)
        .setDescription(lines.join('\n'))
        .addFields({ name: '⭐ Skill Average', value: avg, inline: false })
        .setTimestamp();

      return interaction.editReply({ embeds: [embed] });
    }

    // ───────────────────────────────────────────────────────────────────────
    //  /slayer
    // ───────────────────────────────────────────────────────────────────────
    if (cmd === 'slayer') {
      const username = interaction.options.getString('username');
      const mojang   = await fetchMojang(username);
      const uuid     = mojang.id;
      const profiles = await fetchProfiles(uuid);
      const profile  = getActiveProfile(profiles, uuid);
      const member   = getMember(profile, uuid);
      if (!member) return interaction.editReply('❌ No Skyblock data found.');

      const bosses = [
        { key: 'zombie',   emoji: '🧟', name: 'Revenant Horror',   maxLvl: 9 },
        { key: 'spider',   emoji: '🕷️',  name: 'Tarantula Broodfather', maxLvl: 9 },
        { key: 'wolf',     emoji: '🐺', name: 'Sven Packmaster',   maxLvl: 9 },
        { key: 'enderman', emoji: '👁️',  name: 'Voidgloom Seraph', maxLvl: 9 },
        { key: 'blaze',    emoji: '🔥', name: 'Inferno Demonlord', maxLvl: 9 },
        { key: 'vampire',  emoji: '🧛', name: 'Riftstalker Bloodfiend', maxLvl: 5 },
      ];

      const slayers = member.slayer_bosses || {};
      let totalXP = 0;
      const lines = bosses.map(({ key, emoji, name, maxLvl }) => {
        const xp  = slayers[key]?.xp || 0;
        const lvl = slayerLevel(xp, key);
        totalXP  += xp;
        const bar = '█'.repeat(Math.round(lvl / maxLvl * 10)) + '░'.repeat(10 - Math.round(lvl / maxLvl * 10));
        return `${emoji} **${name}** — Lvl **${lvl}**/${maxLvl} \`${bar}\` ${fmt(xp)} XP`;
      });

      const embed = new EmbedBuilder()
        .setTitle(`⚔️ ${mojang.name}'s Slayer Levels`)
        .setColor(0xFF4444)
        .setThumbnail(`https://mc-heads.net/avatar/${uuid}`)
        .setDescription(lines.join('\n'))
        .addFields({ name: '📊 Total Slayer XP', value: fmt(totalXP), inline: false })
        .setTimestamp();

      return interaction.editReply({ embeds: [embed] });
    }

    // ───────────────────────────────────────────────────────────────────────
    //  /dungeons
    // ───────────────────────────────────────────────────────────────────────
    if (cmd === 'dungeons') {
      const username = interaction.options.getString('username');
      const mojang   = await fetchMojang(username);
      const uuid     = mojang.id;
      const profiles = await fetchProfiles(uuid);
      const profile  = getActiveProfile(profiles, uuid);
      const member   = getMember(profile, uuid);
      if (!member) return interaction.editReply('❌ No Skyblock data found.');

      const dung    = member.dungeons || {};
      const cata    = dung.dungeon_types?.catacombs || {};
      const cataXP  = cata.experience || 0;
      const cataLvl = dungLevel(cataXP);

      const bestFloor = cata.highest_tier_completed != null ? cata.highest_tier_completed : 'None';
      const total     = Object.values(cata.tier_completions || {}).reduce((a, b) => a + b, 0);

      const classes = ['healer', 'mage', 'berserk', 'archer', 'tank'];
      const classLines = classes.map(cls => {
        const xp  = dung.player_classes?.[cls]?.experience || 0;
        const lvl = dungLevel(xp);
        const emoji = { healer: '💚', mage: '🔥', berserk: '⚔️', archer: '🏹', tank: '🛡️' }[cls];
        return `${emoji} **${cls.charAt(0).toUpperCase() + cls.slice(1)}** — Lvl **${lvl}** (${fmt(xp)} XP)`;
      });

      const embed = new EmbedBuilder()
        .setTitle(`🏰 ${mojang.name}'s Dungeons Stats`)
        .setColor(0x8800AA)
        .setThumbnail(`https://mc-heads.net/avatar/${uuid}`)
        .addFields(
          { name: '🏆 Catacombs Level',   value: `**${cataLvl}** (${fmt(cataXP)} XP)`, inline: true },
          { name: '🔝 Best Floor',         value: `Floor ${bestFloor}`,                  inline: true },
          { name: '🔁 Total Completions', value: `${total}`,                             inline: true },
          { name: '🎭 Class Levels',       value: classLines.join('\n'),                 inline: false },
        )
        .setTimestamp();

      return interaction.editReply({ embeds: [embed] });
    }

    // ───────────────────────────────────────────────────────────────────────
    //  /bazaar
    // ───────────────────────────────────────────────────────────────────────
    if (cmd === 'bazaar') {
      const query    = interaction.options.getString('item').toUpperCase().replace(/ /g, '_');
      const products = await fetchBazaar();

      const matches = Object.entries(products)
        .filter(([id]) => id.includes(query))
        .slice(0, 6);

      if (!matches.length)
        return interaction.editReply(`❌ No bazaar item matching \`${query}\`. Try the full item ID, e.g. \`ENCHANTED_IRON\`.`);

      const embed = new EmbedBuilder()
        .setTitle(`🏪 Bazaar Search: ${query}`)
        .setColor(0xFFAA00)
        .setTimestamp();

      for (const [id, data] of matches) {
        const qs         = data.quick_status || {};
        const buyPrice   = qs.buyPrice?.toFixed(1)  || 'N/A';
        const sellPrice  = qs.sellPrice?.toFixed(1) || 'N/A';
        const buyVol     = fmt(qs.buyVolume  || 0);
        const sellVol    = fmt(qs.sellVolume || 0);
        const margin     = qs.buyPrice && qs.sellPrice
          ? `+${(qs.buyPrice - qs.sellPrice).toFixed(1)}`
          : 'N/A';

        embed.addFields({
          name: id.replace(/_/g, ' '),
          value: [
            `💰 Buy: **${buyPrice}** | Sell: **${sellPrice}** | Margin: **${margin}**`,
            `📦 Buy Vol: ${buyVol} | Sell Vol: ${sellVol}`,
          ].join('\n'),
          inline: false,
        });
      }

      return interaction.editReply({ embeds: [embed] });
    }

    // ───────────────────────────────────────────────────────────────────────
    //  /auction
    // ───────────────────────────────────────────────────────────────────────
    if (cmd === 'auction') {
      const query = interaction.options.getString('item').toLowerCase();
      const ahData = await fetchAH(0);

      if (!ahData.success) return interaction.editReply('❌ Failed to fetch Auction House data.');

      const matches = ahData.auctions
        .filter(a => !a.claimed && a.item_name.toLowerCase().includes(query))
        .sort((a, b) => a.starting_bid - b.starting_bid)
        .slice(0, 8);

      if (!matches.length)
        return interaction.editReply(`❌ No active auctions found for \`${query}\`. Try a shorter/different name.`);

      const embed = new EmbedBuilder()
        .setTitle(`🔨 Auction House: ${query}`)
        .setColor(0xAA5500)
        .setFooter({ text: `Page 1 results only. Total auctions: ${fmt(ahData.totalAuctions)}` })
        .setTimestamp();

      for (const a of matches) {
        const type = a.bin ? '🟢 BIN' : '📊 Auction';
        const ends = a.end ? `<t:${Math.floor(a.end / 1000)}:R>` : 'Unknown';
        embed.addFields({
          name: `${a.item_name} [${a.tier}]`,
          value: `💰 **${fmt(a.starting_bid)}** coins | ${type}\n⏰ Ends: ${ends}`,
          inline: false,
        });
      }

      return interaction.editReply({ embeds: [embed] });
    }

    // ───────────────────────────────────────────────────────────────────────
    //  /mayor
    // ───────────────────────────────────────────────────────────────────────
    if (cmd === 'mayor') {
      const data  = await fetchMayor();
      const mayor = data?.mayor;
      if (!mayor) return interaction.editReply('❌ Could not fetch mayor data.');

      const perks = (mayor.perks || [])
        .map(p => `**${p.name}**\n${p.description}`)
        .join('\n\n') || 'No perks';

      const embed = new EmbedBuilder()
        .setTitle(`🏛️ Current Mayor: ${mayor.name}`)
        .setColor(0x0055FF)
        .addFields({ name: '✨ Perks', value: perks, inline: false });

      const election = data?.current;
      if (election?.candidates?.length) {
        const cands = election.candidates
          .sort((a, b) => b.votes - a.votes)
          .map(c => `**${c.name}** — ${fmt(c.votes)} votes`)
          .join('\n');
        embed.addFields({ name: '🗳️ Next Election Candidates', value: cands, inline: false });
      }

      embed.setTimestamp();
      return interaction.editReply({ embeds: [embed] });
    }

    // ───────────────────────────────────────────────────────────────────────
    //  /profile
    // ───────────────────────────────────────────────────────────────────────
    if (cmd === 'profile') {
      const username = interaction.options.getString('username');
      const mojang   = await fetchMojang(username);
      const uuid     = mojang.id;
      const profiles = await fetchProfiles(uuid);
      if (!profiles?.length) return interaction.editReply('❌ No profiles found.');

      const lines = profiles.map((p, i) => {
        const m      = getMember(p, uuid);
        const cataXP = m?.dungeons?.dungeon_types?.catacombs?.experience || 0;
        const cata   = dungLevel(cataXP);
        const avg    = m ? skillAvg(m).toFixed(1) : '?';
        const sel    = p.selected ? ' ✅ **Active**' : '';
        return `**${i + 1}. ${p.cute_name}**${sel}\n  Skill Avg: ${avg} | Cata: ${cata}`;
      });

      const embed = new EmbedBuilder()
        .setTitle(`🗂️ ${mojang.name}'s Profiles`)
        .setColor(0x00CCFF)
        .setThumbnail(`https://mc-heads.net/avatar/${uuid}`)
        .setDescription(lines.join('\n\n'))
        .setTimestamp();

      return interaction.editReply({ embeds: [embed] });
    }

    // ───────────────────────────────────────────────────────────────────────
    //  /compare
    // ───────────────────────────────────────────────────────────────────────
    if (cmd === 'compare') {
      const u1 = interaction.options.getString('player1');
      const u2 = interaction.options.getString('player2');

      const [m1, m2] = await Promise.all([fetchMojang(u1), fetchMojang(u2)]);
      const [p1, p2] = await Promise.all([fetchProfiles(m1.id), fetchProfiles(m2.id)]);

      const prof1 = getActiveProfile(p1, m1.id);
      const prof2 = getActiveProfile(p2, m2.id);
      const mem1  = getMember(prof1, m1.id);
      const mem2  = getMember(prof2, m2.id);

      if (!mem1 || !mem2) return interaction.editReply('❌ Could not find data for one or both players.');

      const avg1   = skillAvg(mem1);
      const avg2   = skillAvg(mem2);
      const cata1  = dungLevel(mem1.dungeons?.dungeon_types?.catacombs?.experience || 0);
      const cata2  = dungLevel(mem2.dungeons?.dungeon_types?.catacombs?.experience || 0);
      const sxp1   = Object.values(mem1.slayer_bosses || {}).reduce((s, v) => s + (v.xp || 0), 0);
      const sxp2   = Object.values(mem2.slayer_bosses || {}).reduce((s, v) => s + (v.xp || 0), 0);

      const better = (a, b) => a > b ? '🏆' : a < b ? '💔' : '🤝';

      const embed = new EmbedBuilder()
        .setTitle(`⚖️ ${m1.name} vs ${m2.name}`)
        .setColor(0xAA00FF)
        .addFields(
          { name: '📚 Skill Average', value: `${m1.name}: **${avg1.toFixed(2)}** ${better(avg1, avg2)}\n${m2.name}: **${avg2.toFixed(2)}**`, inline: true },
          { name: '🏰 Catacombs',     value: `${m1.name}: **${cata1}** ${better(cata1, cata2)}\n${m2.name}: **${cata2}**`,               inline: true },
          { name: '⚔️ Slayer XP',    value: `${m1.name}: **${fmt(sxp1)}** ${better(sxp1, sxp2)}\n${m2.name}: **${fmt(sxp2)}**`,         inline: true },
        )
        .setTimestamp();

      return interaction.editReply({ embeds: [embed] });
    }

    // ───────────────────────────────────────────────────────────────────────
    //  /help
    // ───────────────────────────────────────────────────────────────────────
    if (cmd === 'help') {
      const embed = new EmbedBuilder()
        .setTitle('📖 Hypixel Skyblock Bot — All Commands')
        .setColor(0x00FFFF)
        .addFields(
          {
            name: '📊 Player Stats',
            value: [
              '`/stats <user>` — General Skyblock overview',
              '`/networth <user>` — Liquid coin networth',
              '`/skills <user>` — All skill levels & XP',
              '`/slayer <user>` — All slayer boss levels',
              '`/dungeons <user>` — Catacombs & class levels',
              '`/profile <user>` — All profiles list',
              '`/compare <user1> <user2>` — Side-by-side comparison',
            ].join('\n'),
            inline: false,
          },
          {
            name: '🏪 Economy',
            value: [
              '`/bazaar <item>` — Buy/sell prices & margin',
              '`/auction <item>` — Search Auction House (BIN & Auction)',
            ].join('\n'),
            inline: false,
          },
          {
            name: '🏛️ World',
            value: '`/mayor` — Current mayor & election candidates',
            inline: false,
          },
          {
            name: '🔥 Kuudra',
            value: [
              '`/kuudra setup <tier>` — Best gear setup per tier',
              '`/kuudra profit <tier> [runs]` — Profit calculator',
              '`/kuudra requirements <user> <tier>` — Readiness check',
              '`/kuudra lfg <tier> <role> [note]` — Post Looking-for-Group',
              '`/kuudra parties [tier]` — View active LFG posts',
              '`/kuudra guide [tier]` — Phase-by-phase strategy guide',
              '`/kuudra tiers` — All tiers overview at a glance',
            ].join('\n'),
            inline: false,
          },
        )
        .setFooter({ text: 'Hypixel Skyblock Bot • Powered by api.hypixel.net' })
        .setTimestamp();

      return interaction.editReply({ embeds: [embed] });
    }

    // ───────────────────────────────────────────────────────────────────────
    //  /kuudra *
    // ───────────────────────────────────────────────────────────────────────
    if (cmd === 'kuudra') {

      // ── /kuudra setup ───────────────────────────────────────────────────
      if (sub === 'setup') {
        const tier = interaction.options.getString('tier');
        const d    = TIERS[tier];
        const s    = d.setup;

        const embed = new EmbedBuilder()
          .setTitle(`🔥 Kuudra ${d.label} — Recommended Setup`)
          .setColor(d.color)
          .addFields(
            { name: '🛡️ Armor',              value: s.armor,              inline: false },
            { name: '⚔️ Weapon',             value: s.weapon,             inline: false },
            { name: '🐾 Pet',                value: s.pet,                inline: true  },
            { name: '💍 Accessories',        value: s.acc,                inline: false },
            { name: '🔧 Reforges',           value: s.reforge,            inline: false },
            { name: '📊 Minimum EHP',        value: fmt(d.minEHP),        inline: true  },
            { name: '🏰 Recommended Cata',   value: `Level ${d.recCata}+`, inline: true  },
            { name: '📋 Notes',              value: s.notes,              inline: false },
          )
          .setFooter({ text: 'Use /kuudra guide <tier> for phase-by-phase strategy' })
          .setTimestamp();

        return interaction.editReply({ embeds: [embed] });
      }

      // ── /kuudra profit ──────────────────────────────────────────────────
      if (sub === 'profit') {
        const tier = interaction.options.getString('tier');
        const runs = interaction.options.getInteger('runs') || 1;
        const d    = TIERS[tier];
        const p    = d.profit;

        const lootTotal   = p.avgLoot  * runs;
        const keyTotal    = p.keyCost  * runs;
        const trueProfit  = lootTotal  - keyTotal;
        const perHour     = Math.round(trueProfit * 4); // ~4 runs/hour rough avg

        const embed = new EmbedBuilder()
          .setTitle(`💰 Kuudra ${d.label} — Profit Calculator`)
          .setColor(d.color)
          .addFields(
            { name: '🔢 Runs',           value: `${runs}`,            inline: true  },
            { name: '💎 Avg Loot/Run',   value: fmt(p.avgLoot),       inline: true  },
            { name: '🔑 Key Cost/Run',   value: fmt(p.keyCost),       inline: true  },
            { name: '📦 Total Loot',     value: fmt(lootTotal),       inline: true  },
            { name: '🔑 Total Keys',     value: fmt(keyTotal),        inline: true  },
            { name: '✅ Net Profit',     value: `**${fmt(trueProfit)}** coins`, inline: true  },
            { name: '⏱️ Est. Per Hour',  value: `~${fmt(perHour)} coins`, inline: false },
          )
          .setDescription('> ⚠️ These are estimates based on average market prices. Infernal chests can yield 10M+ items.\n> Actual profit heavily depends on your drops.')
          .setFooter({ text: 'Use /kuudra setup <tier> to check gear requirements' })
          .setTimestamp();

        return interaction.editReply({ embeds: [embed] });
      }

      // ── /kuudra requirements ────────────────────────────────────────────
      if (sub === 'requirements') {
        const username = interaction.options.getString('username');
        const tier     = interaction.options.getString('tier');
        const d        = TIERS[tier];

        const mojang   = await fetchMojang(username);
        const uuid     = mojang.id;
        const profiles = await fetchProfiles(uuid);
        const profile  = getActiveProfile(profiles, uuid);
        const member   = getMember(profile, uuid);
        if (!member) return interaction.editReply('❌ No Skyblock data found.');

        // Estimated EHP (simplified — real EHP needs item data)
        const hp      = member.stats?.health  ?? 100;
        const def     = member.stats?.defense ?? 0;
        const ehp     = Math.round(hp * (1 + def / 100));

        const cataXP  = member.dungeons?.dungeon_types?.catacombs?.experience || 0;
        const cataLvl = dungLevel(cataXP);
        const avg     = skillAvg(member);

        const meetsEHP   = ehp     >= d.minEHP;
        const meetsCata  = cataLvl >= d.recCata;
        const meetsSkill = avg     >= 30;
        const overall    = meetsEHP && meetsCata && meetsSkill;

        const tick = (v) => v ? '✅' : '❌';

        const embed = new EmbedBuilder()
          .setTitle(`🔍 ${mojang.name} — ${d.label} Readiness Check`)
          .setColor(overall ? 0x00FF44 : 0xFF4400)
          .setThumbnail(`https://mc-heads.net/avatar/${uuid}`)
          .addFields(
            { name: `🛡️ EHP (est.) ${tick(meetsEHP)}`,         value: `${fmt(ehp)} / ${fmt(d.minEHP)} required`,       inline: false },
            { name: `🏰 Catacombs Level ${tick(meetsCata)}`,    value: `${cataLvl} / ${d.recCata} recommended`,         inline: true  },
            { name: `📚 Skill Average ${tick(meetsSkill)}`,     value: `${avg.toFixed(1)} / 30 recommended`,            inline: true  },
            {
              name: '📋 Verdict',
              value: overall
                ? `✅ **${mojang.name} is ready for ${d.label}!**`
                : `❌ **Not fully ready.** Improve stats marked ❌ first.`,
              inline: false,
            },
          )
          .setFooter({ text: '⚠️ EHP is estimated. Actual EHP depends on armor — use SkyHelper for precise values.' })
          .setTimestamp();

        return interaction.editReply({ embeds: [embed] });
      }

      // ── /kuudra lfg ─────────────────────────────────────────────────────
      if (sub === 'lfg') {
        const tier  = interaction.options.getString('tier');
        const role  = interaction.options.getString('role');
        const note  = interaction.options.getString('note') || 'No additional info';
        const d     = TIERS[tier];
        const gid   = interaction.guildId;

        if (!lfgStore.has(gid)) lfgStore.set(gid, []);
        const list = lfgStore.get(gid).filter(e => e.userId !== interaction.user.id);
        list.push({ userId: interaction.user.id, tag: interaction.user.tag, tier, role, note, ts: Date.now() });
        lfgStore.set(gid, list);

        const embed = new EmbedBuilder()
          .setTitle(`🔥 LFG — Kuudra ${d.label}`)
          .setColor(d.color)
          .setDescription(`<@${interaction.user.id}> is looking for a Kuudra group!`)
          .addFields(
            { name: '🎭 Role',  value: role,   inline: true },
            { name: '🔥 Tier',  value: d.label, inline: true },
            { name: '📋 Note', value: note,    inline: false },
          )
          .setFooter({ text: 'DM or react to invite! Use /kuudra parties to list all LFG. Posts expire in 30 min.' })
          .setTimestamp();

        return interaction.editReply({ embeds: [embed] });
      }

      // ── /kuudra parties ─────────────────────────────────────────────────
      if (sub === 'parties') {
        const tierFilter = interaction.options.getString('tier') || 'all';
        const gid        = interaction.guildId;
        const now        = Date.now();

        // Purge old entries (>30 min)
        const fresh = (lfgStore.get(gid) || []).filter(e => now - e.ts < 30 * 60_000);
        lfgStore.set(gid, fresh);

        const filtered = tierFilter === 'all' ? fresh : fresh.filter(e => e.tier === tierFilter);

        if (!filtered.length) {
          return interaction.editReply(
            `❌ No active LFG parties${tierFilter !== 'all' ? ` for **${TIERS[tierFilter]?.label}**` : ''}.\nBe the first with \`/kuudra lfg\`!`
          );
        }

        const embed = new EmbedBuilder()
          .setTitle(`🔥 Active LFG Parties${tierFilter !== 'all' ? ` — ${TIERS[tierFilter]?.label}` : ' — All Tiers'}`)
          .setColor(0xFF6600)
          .setTimestamp();

        for (const e of filtered.slice(0, 10)) {
          const ago = Math.round((now - e.ts) / 60_000);
          embed.addFields({
            name: `${TIERS[e.tier].label} — ${e.role}`,
            value: `<@${e.userId}> (${e.tag})\n📋 ${e.note}\n🕐 ${ago}m ago`,
            inline: false,
          });
        }

        return interaction.editReply({ embeds: [embed] });
      }

      // ── /kuudra guide ───────────────────────────────────────────────────
      if (sub === 'guide') {
        const tier = interaction.options.getString('tier');

        if (tier) {
          const d = TIERS[tier];
          const embed = new EmbedBuilder()
            .setTitle(`📖 Kuudra ${d.label} — Strategy Guide`)
            .setColor(d.color)
            .setDescription(d.guide.join('\n\n'))
            .addFields(
              { name: '⚙️ Full Gear Setup',    value: `\`/kuudra setup ${tier}\``,   inline: true },
              { name: '💰 Profit Calculator',  value: `\`/kuudra profit ${tier}\``,  inline: true },
            )
            .setTimestamp();

          return interaction.editReply({ embeds: [embed] });
        }

        // General guide
        const embed = new EmbedBuilder()
          .setTitle('📖 Kuudra — General Guide')
          .setColor(0xFF6600)
          .addFields(
            {
              name: '🗺️ Overview',
              value: 'Kuudra is a 4-player co-op boss on Crimson Isle. There are **5 tiers**: Basic → Hot → Burning → Fiery → **Infernal**. Higher tiers = better loot and more profit.',
              inline: false,
            },
            {
              name: '🎭 Roles',
              value: '🔥 **Mage** — Highest staff DPS\n⚔️ **Berserk** — Melee DPS\n🏹 **Archer** — Ranged DPS\n🛡️ **Tank** — Absorbs damage\n💚 **Healer** — Team healing & support',
              inline: false,
            },
            {
              name: '🔑 Keys',
              value: 'You need a **Kuudra Key** matching the tier to open the chest. Craft or buy from Bazaar.',
              inline: false,
            },
            {
              name: '⚡ 4 Phases',
              value: '**1.** Supply Run — collect 4 supplies fast\n**2.** Build — dump supplies, defend builders\n**3.** Fight — ballista stuns Kuudra, DPS his weak spot\n**4.** Chest — open paid chest for loot',
              inline: false,
            },
            {
              name: '💡 Pro Tips',
              value: '• Always open the **Paid Chest** (free chest barely has value)\n• Attribute Shards are the best drops\n• Use **God Potions** for Fiery and above\n• Coordinate roles before the run starts\n• Infernal is the only tier worth mass-running for profit',
              inline: false,
            },
            {
              name: '📊 Quick Commands',
              value: '`/kuudra tiers` — Tier overview\n`/kuudra setup <tier>` — Gear guide\n`/kuudra profit <tier>` — Profit estimate\n`/kuudra requirements <user> <tier>` — Readiness',
              inline: false,
            },
          )
          .setTimestamp();

        return interaction.editReply({ embeds: [embed] });
      }

      // ── /kuudra tiers ───────────────────────────────────────────────────
      if (sub === 'tiers') {
        const embed = new EmbedBuilder()
          .setTitle('🔥 Kuudra — All Tiers Overview')
          .setColor(0xFF6600)
          .setTimestamp();

        for (const [key, d] of Object.entries(TIERS)) {
          embed.addFields({
            name: d.label,
            value: [
              `💰 Avg Profit: **${fmt(d.profit.avgLoot - d.profit.keyCost)}** / run`,
              `🛡️ Min EHP: **${fmt(d.minEHP)}**`,
              `🏰 Rec Cata: **${d.recCata}+**`,
              `\`/kuudra setup ${key}\``,
            ].join(' | '),
            inline: false,
          });
        }

        return interaction.editReply({ embeds: [embed] });
      }
    }

  } catch (err) {
    console.error('❌ Error handling interaction:', err);
    const msg = err?.response?.data?.cause || err?.response?.data?.message || err.message || 'Unknown error';
    try {
      await interaction.editReply(`❌ **Error:** ${msg}\n\nIf this keeps happening, check that your \`HYPIXEL_API_KEY\` is valid.`);
    } catch (_) {}
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
//  START
// ═══════════════════════════════════════════════════════════════════════════════
client.login(DISCORD_TOKEN);
