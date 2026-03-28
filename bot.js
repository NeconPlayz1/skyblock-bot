const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder,
} = require('discord.js');
const axios = require('axios');
const NodeCache = require('node-cache');

const DISCORD_TOKEN   = process.env.DISCORD_TOKEN;
const CLIENT_ID       = process.env.CLIENT_ID;
const HYPIXEL_API_KEY = process.env.HYPIXEL_API_KEY;

const cache = new NodeCache({ stdTTL: 300 });
const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const lfgStore = new Map();

// ─── API HELPERS ──────────────────────────────────────────────────────────────

async function fetchMojang(username) {
  const key = 'mojang_' + username.toLowerCase();
  if (cache.has(key)) return cache.get(key);
  const res = await axios.get('https://playerdb.co/api/player/minecraft/' + username);
  if (!res.data.success) throw new Error('Player not found');
  const result = { id: res.data.data.player.raw_id, name: res.data.data.player.username };
  cache.set(key, result);
  return result;
}

async function fetchProfiles(uuid) {
  const key = 'profiles_' + uuid;
  if (cache.has(key)) return cache.get(key);
  const res = await axios.get('https://api.hypixel.net/skyblock/profiles?uuid=' + uuid + '&key=' + HYPIXEL_API_KEY);
  const val = res.data.profiles || [];
  cache.set(key, val);
  return val;
}

async function fetchBazaar() {
  if (cache.has('bazaar')) return cache.get('bazaar');
  const res = await axios.get('https://api.hypixel.net/skyblock/bazaar?key=' + HYPIXEL_API_KEY);
  const val = res.data.products || {};
  cache.set('bazaar', val);
  return val;
}

async function fetchAH() {
  const res = await axios.get('https://api.hypixel.net/skyblock/auctions?page=0&key=' + HYPIXEL_API_KEY);
  return res.data;
}

async function fetchMayor() {
  if (cache.has('mayor')) return cache.get('mayor');
  const res = await axios.get('https://api.hypixel.net/resources/skyblock/election?key=' + HYPIXEL_API_KEY);
  cache.set('mayor', res.data);
  return res.data;
}

function getActiveProfile(profiles, uuid) {
  if (!profiles || !profiles.length) return null;
  return profiles.find(p => p.selected) || profiles[0];
}

function getMember(profile, uuid) {
  if (!profile || !profile.members) return null;
  return profile.members[uuid] || null;
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function fmt(n) {
  if (n == null || isNaN(n)) return '0';
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return Math.round(n).toLocaleString();
}

const SKILL_XP = [0,50,125,200,300,500,750,1000,1500,2000,3500,5000,7500,10000,15000,20000,30000,50000,75000,100000,200000,300000,400000,500000,600000,700000,800000,900000,1000000,1100000,1200000,1300000,1400000,1500000,1600000,1700000,1800000,1900000,2000000,2100000,2200000,2300000,2400000,2500000,2600000,2750000,2900000,3100000,3400000,3700000,4000000,4300000,4600000,5000000,5500000,6000000,6500000,7000000,7500000];

function skillLevel(xp, max) {
  max = max || 60;
  let lvl = 0, total = 0;
  for (let i = 0; i < Math.min(max, SKILL_XP.length); i++) {
    if (xp >= total + SKILL_XP[i]) { total += SKILL_XP[i]; lvl = i; } else break;
  }
  return lvl;
}

function skillAvg(member) {
  const names = ['farming','mining','combat','foraging','fishing','enchanting','alchemy','taming'];
  return names.reduce((s, n) => s + skillLevel(member['experience_skill_' + n] || 0), 0) / names.length;
}

const SLAYER_XP = {
  zombie:[0,5,15,200,1000,5000,20000,100000,400000,1000000],
  spider:[0,5,25,200,1000,5000,20000,100000,400000,1000000],
  wolf:[0,10,30,250,1500,5000,20000,100000,400000,1000000],
  enderman:[0,10,30,250,1500,5000,20000,100000,400000,1000000],
  blaze:[0,10,30,250,1500,5000,20000,100000,400000,1000000],
  vampire:[0,20,75,240,840,2400],
};

function slayerLevel(xp, type) {
  const t = SLAYER_XP[type] || [];
  let lvl = 0;
  for (let i = 0; i < t.length; i++) { if (xp >= t[i]) lvl = i; else break; }
  return lvl;
}

const DUNG_XP = [0,50,75,110,160,230,330,470,670,950,1340,1890,2665,3760,5260,7380,10300,14400,20000,27600,38000,52500,71500,97000,132000,180000,243000,328000,445000,600000,800000,1065000,1410000,1900000,2500000,3300000,4300000,5600000,7200000,9200000,12000000,15000000,19000000,24000000,30000000,38000000,48000000,60000000,75000000,93000000];

function dungLevel(xp) {
  let lvl = 0, total = 0;
  for (let i = 0; i < DUNG_XP.length; i++) {
    if (xp >= total + DUNG_XP[i]) { total += DUNG_XP[i]; lvl = i; } else break;
  }
  return lvl;
}

// ─── KUUDRA DATA ──────────────────────────────────────────────────────────────

const TIERS = {
  basic:    { label:'Basic (T1)',    color:0x55FF55, minEHP:15000,  recCata:10, setup:{armor:'Any Crimson Armor (Hot quality fine)',          weapon:'Midas Staff / Spirit Sceptre',      pet:'Blaze Lvl 100 or Tiger',               acc:'Full Talisman Bag (Common-Rare)',       reforge:'Fierce Chest, Necrotic Helm, Bloody Legs/Boots', notes:'Easiest tier. 15k+ EHP and any crimson set is fine.'},         profit:{avgLoot:80000,    keyCost:40000},    guide:['**Phase 1 - Supply Run:** Sprint to supplies, ignore minions.','**Phase 2 - Build:** Dump supplies, protect builders.','**Phase 3 - Fight:** Ballista stuns Kuudra, DPS his weak spot.','**Phase 4 - Chest:** Open paid chest for best loot.','**Tip:** Crimson Key required to open chest.'] },
  hot:      { label:'Hot (T2)',      color:0xFF5555, minEHP:30000,  recCata:15, setup:{armor:'Fine or Burning Crimson Armor (full set)',      weapon:'Aurora Staff / Starred Midas',      pet:'Blaze Lvl 100',                        acc:'Full Talisman Bag (up to Epic)',        reforge:'Fierce Chest, Necrotic Helm, Bloody Legs/Boots', notes:'Aim 30k+ EHP. Swap Boots to Magma Lord if available.'},        profit:{avgLoot:220000,   keyCost:100000},   guide:['**Phase 1:** Faster supply collection than Basic.','**Phase 2:** More minions spawn, one player guard.','**Phase 3:** Kuudra hits harder, dodge projectiles.','**Tip:** Mana potions help sustain staff usage.'] },
  burning:  { label:'Burning (T3)',  color:0xFF8800, minEHP:60000,  recCata:20, setup:{armor:'Burning Crimson Armor or better',               weapon:'Aurora Staff / Starred Midas',      pet:'Blaze Lvl 100 with Tier Boost',        acc:'Full Talisman Bag (Epic+), Mana Flask', reforge:'Fierce Chest, Necrotic/Warped Helm, Bloody Legs/Boots', notes:'Need 60k+ EHP. Aim for 4M+ HP pool with pots.'},            profit:{avgLoot:650000,   keyCost:300000},   guide:['**Phase 1:** Use Speed pot, collect supplies within 45s.','**Phase 2:** Protect builders aggressively.','**Phase 3:** Ballista needs 2 hits. Watch for waves.','**Tip:** Strength Pots and God Pot improve DPS.'] },
  fiery:    { label:'Fiery (T4)',    color:0xFF2200, minEHP:120000, recCata:25, setup:{armor:'Fiery Crimson Armor (all pieces)',              weapon:'Infernal/Aurora Staff or Starred Midas', pet:'Blaze Lvl 100 Tier Boost or Black Cat Lvl 100', acc:'Full Talisman Bag (Legendary), Mana Flask', reforge:'Fierce Chest, Necrotic Helm, Bloody Legs/Boots', notes:'Need 120k+ EHP. Must use Overload 5 + God Pot.'},    profit:{avgLoot:2200000,  keyCost:1000000},  guide:['**Phase 1:** Finish supply run under 40s.','**Phase 2:** Minion waves much stronger, tank/healer needed.','**Phase 3:** Ballista takes 3 hits. Kuudra does AoE.','**Tip:** Always use Overload + God Pot. Coordinate.'] },
  infernal: { label:'Infernal (T5)', color:0x8800FF, minEHP:300000, recCata:30, setup:{armor:'Infernal Crimson Armor (best quality)',         weapon:'Infernal Staff Starred / Shadow Fury', pet:'Blaze Lvl 100 Tier Boost or Ender Dragon Lvl 100', acc:'Fully optimized Talisman Bag (Recombobulated + MP reforged)', reforge:'Fierce Chest, Necrotic Helm, Withered/Bloody Legs/Boots', notes:'Need 300k+ EHP. Overload 5, God Pot, Mana Flask, Adrenaline required.'}, profit:{avgLoot:9000000, keyCost:4000000}, guide:['**Phase 1:** Perfect supply run, under 35s.','**Phase 2:** Extremely strong minions, coordinate roles.','**Phase 3:** Ballista 4+ hits. Constant AoE. Do NOT facetank.','**Phase 4:** Infernal chests drop 10M+ items.','**Tip:** Best-in-slot required. One weak player can wipe team.'] },
};

// ─── COMMANDS ─────────────────────────────────────────────────────────────────

const tierChoices = [
  { name: 'Basic (T1)',    value: 'basic'    },
  { name: 'Hot (T2)',      value: 'hot'      },
  { name: 'Burning (T3)', value: 'burning'  },
  { name: 'Fiery (T4)',   value: 'fiery'    },
  { name: 'Infernal (T5)',value: 'infernal' },
];

const str = (n, d, r) => new SlashCommandBuilder().setName(n).setDescription(d)
  .addStringOption(o => o.setName('username').setDescription('Minecraft username').setRequired(r !== false));

const commands = [
  str('stats',    'View a player\'s general Skyblock stats').toJSON(),
  str('networth', 'Check a player\'s liquid coin networth').toJSON(),
  str('skills',   'View a player\'s skill levels').toJSON(),
  str('slayer',   'View a player\'s slayer boss levels').toJSON(),
  str('dungeons', 'View a player\'s Catacombs stats').toJSON(),
  str('profile',  'Show a player\'s profile list').toJSON(),
  new SlashCommandBuilder().setName('bazaar').setDescription('Check Bazaar prices for an item')
    .addStringOption(o => o.setName('item').setDescription('Item ID e.g. ENCHANTED_IRON').setRequired(true)).toJSON(),
  new SlashCommandBuilder().setName('auction').setDescription('Search the Auction House')
    .addStringOption(o => o.setName('item').setDescription('Item name to search').setRequired(true)).toJSON(),
  new SlashCommandBuilder().setName('mayor').setDescription('View current Skyblock Mayor').toJSON(),
  new SlashCommandBuilder().setName('compare').setDescription('Compare two players stats')
    .addStringOption(o => o.setName('player1').setDescription('First player').setRequired(true))
    .addStringOption(o => o.setName('player2').setDescription('Second player').setRequired(true)).toJSON(),
  new SlashCommandBuilder().setName('help').setDescription('Show all bot commands').toJSON(),
  new SlashCommandBuilder().setName('kuudra').setDescription('All Kuudra commands')
    .addSubcommand(s => s.setName('setup').setDescription('Best gear setup for a tier')
      .addStringOption(o => o.setName('tier').setDescription('Kuudra tier').setRequired(true).addChoices(...tierChoices)))
    .addSubcommand(s => s.setName('profit').setDescription('Profit calculator')
      .addStringOption(o => o.setName('tier').setDescription('Kuudra tier').setRequired(true).addChoices(...tierChoices))
      .addIntegerOption(o => o.setName('runs').setDescription('Number of runs').setMinValue(1).setMaxValue(10000)))
    .addSubcommand(s => s.setName('requirements').setDescription('Check if player is ready for a tier')
      .addStringOption(o => o.setName('username').setDescription('Minecraft username').setRequired(true))
      .addStringOption(o => o.setName('tier').setDescription('Kuudra tier').setRequired(true).addChoices(...tierChoices)))
    .addSubcommand(s => s.setName('lfg').setDescription('Post a Looking-for-Group message')
      .addStringOption(o => o.setName('tier').setDescription('Kuudra tier').setRequired(true).addChoices(...tierChoices))
      .addStringOption(o => o.setName('role').setDescription('Your role').setRequired(true).addChoices(
        { name:'Mage', value:'Mage' },{ name:'Berserk', value:'Berserk' },
        { name:'Tank', value:'Tank' },{ name:'Healer',  value:'Healer'  },{ name:'Archer', value:'Archer' }
      ))
      .addStringOption(o => o.setName('note').setDescription('Optional extra info')))
    .addSubcommand(s => s.setName('parties').setDescription('View active LFG parties')
      .addStringOption(o => o.setName('tier').setDescription('Filter by tier').addChoices(...tierChoices, { name:'All Tiers', value:'all' })))
    .addSubcommand(s => s.setName('guide').setDescription('Phase-by-phase strategy guide')
      .addStringOption(o => o.setName('tier').setDescription('Specific tier guide').addChoices(...tierChoices)))
    .addSubcommand(s => s.setName('tiers').setDescription('Overview of all Kuudra tiers'))
    .toJSON(),
];

// ─── REGISTER ─────────────────────────────────────────────────────────────────

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
  try {
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
    console.log('Registered ' + commands.length + ' slash commands!');
  } catch (err) {
    console.error('Failed to register commands:', err.message);
  }
}

client.once('ready', async () => {
  console.log('Logged in as ' + client.user.tag);
  client.user.setActivity('/help | Skyblock Bot', { type: 3 });
  await registerCommands();
});

// ─── INTERACTIONS ─────────────────────────────────────────────────────────────

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;
  await interaction.deferReply();

  try {
    const cmd = interaction.commandName;
    const sub = interaction.options.getSubcommand(false);

    // ── /stats ──────────────────────────────────────────────────────────────
    if (cmd === 'stats') {
      const mojang   = await fetchMojang(interaction.options.getString('username'));
      const profiles = await fetchProfiles(mojang.id);
      const profile  = getActiveProfile(profiles, mojang.id);
      const member   = getMember(profile, mojang.id);
      if (!member) return interaction.editReply('No Skyblock data found.');

      const purse   = member.coin_purse || 0;
      const bank    = profile.banking?.balance || 0;
      const cataXP  = member.dungeons?.dungeon_types?.catacombs?.experience || 0;
      const slayers = member.slayer_bosses || {};
      const sxp     = Object.values(slayers).reduce((s, v) => s + (v.xp || 0), 0);

      return interaction.editReply({ embeds: [new EmbedBuilder()
        .setTitle(mojang.name + "'s Skyblock Stats").setColor(0x00AAFF)
        .setThumbnail('https://mc-heads.net/avatar/' + mojang.id)
        .addFields(
          { name:'Active Profile',  value: profile.cute_name || 'Unknown',    inline:true },
          { name:'Skill Average',   value: skillAvg(member).toFixed(2),       inline:true },
          { name:'Catacombs Level', value: String(dungLevel(cataXP)),         inline:true },
          { name:'Purse',           value: fmt(purse),                        inline:true },
          { name:'Bank',            value: fmt(bank),                         inline:true },
          { name:'Total Slayer XP', value: fmt(sxp),                         inline:true },
          { name:'Deaths',          value: String(member.death_count || 0),   inline:true },
          { name:'Fairy Souls',     value: String(member.fairy_souls_collected || 0), inline:true },
          { name:'Total Profiles',  value: String(profiles.length),           inline:true },
        ).setTimestamp()] });
    }

    // ── /networth ────────────────────────────────────────────────────────────
    if (cmd === 'networth') {
      const mojang   = await fetchMojang(interaction.options.getString('username'));
      const profiles = await fetchProfiles(mojang.id);
      const profile  = getActiveProfile(profiles, mojang.id);
      const member   = getMember(profile, mojang.id);
      if (!member) return interaction.editReply('No Skyblock data found.');
      const purse = member.coin_purse || 0;
      const bank  = profile.banking?.balance || 0;
      return interaction.editReply({ embeds: [new EmbedBuilder()
        .setTitle(mojang.name + "'s Networth").setColor(0xFFD700)
        .setThumbnail('https://mc-heads.net/avatar/' + mojang.id)
        .setDescription('Showing liquid coin wealth. For full item networth check sky.shiiyu.moe')
        .addFields(
          { name:'Purse', value:fmt(purse), inline:true },
          { name:'Bank',  value:fmt(bank),  inline:true },
          { name:'Total Liquid', value:fmt(purse + bank), inline:true },
        ).setTimestamp()] });
    }

    // ── /skills ──────────────────────────────────────────────────────────────
    if (cmd === 'skills') {
      const mojang   = await fetchMojang(interaction.options.getString('username'));
      const profiles = await fetchProfiles(mojang.id);
      const member   = getMember(getActiveProfile(profiles, mojang.id), mojang.id);
      if (!member) return interaction.editReply('No Skyblock data found.');
      const list = [
        ['farming',60],['mining',60],['combat',60],['foraging',50],['fishing',50],
        ['enchanting',60],['alchemy',50],['taming',50],['carpentry',50],['runecrafting',25],
      ];
      const lines = list.map(([k, max]) => {
        const xp = member['experience_skill_' + k] || 0;
        const lvl = skillLevel(xp, max);
        const bar = '█'.repeat(Math.round(lvl/max*10)) + '░'.repeat(10 - Math.round(lvl/max*10));
        return k.charAt(0).toUpperCase() + k.slice(1) + ' — Lvl **' + lvl + '**/' + max + ' `' + bar + '` ' + fmt(xp) + ' XP';
      });
      return interaction.editReply({ embeds: [new EmbedBuilder()
        .setTitle(mojang.name + "'s Skills").setColor(0x00FF88)
        .setThumbnail('https://mc-heads.net/avatar/' + mojang.id)
        .setDescription(lines.join('\n'))
        .addFields({ name:'Skill Average', value: skillAvg(member).toFixed(2), inline:false })
        .setTimestamp()] });
    }

    // ── /slayer ──────────────────────────────────────────────────────────────
    if (cmd === 'slayer') {
      const mojang   = await fetchMojang(interaction.options.getString('username'));
      const profiles = await fetchProfiles(mojang.id);
      const member   = getMember(getActiveProfile(profiles, mojang.id), mojang.id);
      if (!member) return interaction.editReply('No Skyblock data found.');
      const bosses = [
        ['zombie','Revenant Horror',9],['spider','Tarantula Broodfather',9],
        ['wolf','Sven Packmaster',9],['enderman','Voidgloom Seraph',9],
        ['blaze','Inferno Demonlord',9],['vampire','Riftstalker Bloodfiend',5],
      ];
      const slayers = member.slayer_bosses || {};
      let totalXP = 0;
      const lines = bosses.map(([k, name, max]) => {
        const xp = slayers[k]?.xp || 0; totalXP += xp;
        const lvl = slayerLevel(xp, k);
        const bar = '█'.repeat(Math.round(lvl/max*10)) + '░'.repeat(10 - Math.round(lvl/max*10));
        return '**' + name + '** — Lvl **' + lvl + '**/' + max + ' `' + bar + '` ' + fmt(xp) + ' XP';
      });
      return interaction.editReply({ embeds: [new EmbedBuilder()
        .setTitle(mojang.name + "'s Slayer Levels").setColor(0xFF4444)
        .setThumbnail('https://mc-heads.net/avatar/' + mojang.id)
        .setDescription(lines.join('\n'))
        .addFields({ name:'Total Slayer XP', value:fmt(totalXP), inline:false })
        .setTimestamp()] });
    }

    // ── /dungeons ────────────────────────────────────────────────────────────
    if (cmd === 'dungeons') {
      const mojang   = await fetchMojang(interaction.options.getString('username'));
      const profiles = await fetchProfiles(mojang.id);
      const member   = getMember(getActiveProfile(profiles, mojang.id), mojang.id);
      if (!member) return interaction.editReply('No Skyblock data found.');
      const dung    = member.dungeons || {};
      const cata    = dung.dungeon_types?.catacombs || {};
      const cataXP  = cata.experience || 0;
      const total   = Object.values(cata.tier_completions || {}).reduce((a, b) => a + b, 0);
      const classes = [['healer','Healer'],['mage','Mage'],['berserk','Berserk'],['archer','Archer'],['tank','Tank']];
      const classLines = classes.map(([k, n]) => {
        const xp  = dung.player_classes?.[k]?.experience || 0;
        return '**' + n + '** — Lvl **' + dungLevel(xp) + '** (' + fmt(xp) + ' XP)';
      });
      return interaction.editReply({ embeds: [new EmbedBuilder()
        .setTitle(mojang.name + "'s Dungeons").setColor(0x8800AA)
        .setThumbnail('https://mc-heads.net/avatar/' + mojang.id)
        .addFields(
          { name:'Catacombs Level',   value: dungLevel(cataXP) + ' (' + fmt(cataXP) + ' XP)', inline:true },
          { name:'Best Floor',        value: 'Floor ' + (cata.highest_tier_completed ?? 'None'), inline:true },
          { name:'Total Completions', value: String(total), inline:true },
          { name:'Class Levels',      value: classLines.join('\n'), inline:false },
        ).setTimestamp()] });
    }

    // ── /bazaar ──────────────────────────────────────────────────────────────
    if (cmd === 'bazaar') {
      const query    = interaction.options.getString('item').toUpperCase().replace(/ /g, '_');
      const products = await fetchBazaar();
      const matches  = Object.entries(products).filter(([id]) => id.includes(query)).slice(0, 5);
      if (!matches.length) return interaction.editReply('No bazaar item matching ' + query);
      const embed = new EmbedBuilder().setTitle('Bazaar: ' + query).setColor(0xFFAA00).setTimestamp();
      matches.forEach(([id, data]) => {
        const qs = data.quick_status || {};
        const buy  = qs.buyPrice?.toFixed(1)  || 'N/A';
        const sell = qs.sellPrice?.toFixed(1) || 'N/A';
        const margin = (qs.buyPrice && qs.sellPrice) ? (qs.buyPrice - qs.sellPrice).toFixed(1) : 'N/A';
        embed.addFields({ name: id.replace(/_/g,' '), value:'Buy: **' + buy + '** | Sell: **' + sell + '** | Margin: **' + margin + '**\nBuy Vol: ' + fmt(qs.buyVolume||0) + ' | Sell Vol: ' + fmt(qs.sellVolume||0), inline:false });
      });
      return interaction.editReply({ embeds: [embed] });
    }

    // ── /auction ─────────────────────────────────────────────────────────────
    if (cmd === 'auction') {
      const query  = interaction.options.getString('item').toLowerCase();
      const ahData = await fetchAH();
      if (!ahData.success) return interaction.editReply('Failed to fetch Auction House.');
      const matches = ahData.auctions
        .filter(a => !a.claimed && a.item_name.toLowerCase().includes(query))
        .sort((a, b) => a.starting_bid - b.starting_bid)
        .slice(0, 8);
      if (!matches.length) return interaction.editReply('No active auctions found for ' + query);
      const embed = new EmbedBuilder().setTitle('Auction House: ' + query).setColor(0xAA5500)
        .setFooter({ text: 'Total auctions: ' + fmt(ahData.totalAuctions) }).setTimestamp();
      matches.forEach(a => {
        const ends = a.end ? '<t:' + Math.floor(a.end/1000) + ':R>' : 'Unknown';
        embed.addFields({ name: a.item_name + ' [' + a.tier + ']', value: fmt(a.starting_bid) + ' coins | ' + (a.bin ? 'BIN' : 'Auction') + ' | Ends: ' + ends, inline:false });
      });
      return interaction.editReply({ embeds: [embed] });
    }

    // ── /mayor ───────────────────────────────────────────────────────────────
    if (cmd === 'mayor') {
      const data  = await fetchMayor();
      const mayor = data?.mayor;
      if (!mayor) return interaction.editReply('Could not fetch mayor data.');
      const perks = (mayor.perks || []).map(p => '**' + p.name + '**\n' + p.description).join('\n\n') || 'No perks';
      const embed = new EmbedBuilder().setTitle('Current Mayor: ' + mayor.name).setColor(0x0055FF)
        .addFields({ name:'Perks', value:perks, inline:false }).setTimestamp();
      if (data.current?.candidates?.length) {
        const cands = data.current.candidates.sort((a,b) => b.votes - a.votes)
          .map(c => '**' + c.name + '** — ' + fmt(c.votes) + ' votes').join('\n');
        embed.addFields({ name:'Next Election Candidates', value:cands, inline:false });
      }
      return interaction.editReply({ embeds: [embed] });
    }

    // ── /profile ─────────────────────────────────────────────────────────────
    if (cmd === 'profile') {
      const mojang   = await fetchMojang(interaction.options.getString('username'));
      const profiles = await fetchProfiles(mojang.id);
      if (!profiles?.length) return interaction.editReply('No profiles found.');
      const lines = profiles.map((p, i) => {
        const m   = getMember(p, mojang.id);
        const avg = m ? skillAvg(m).toFixed(1) : '?';
        const cat = dungLevel(m?.dungeons?.dungeon_types?.catacombs?.experience || 0);
        return (i+1) + '. **' + p.cute_name + '**' + (p.selected ? ' (Active)' : '') + '\nSkill Avg: ' + avg + ' | Cata: ' + cat;
      });
      return interaction.editReply({ embeds: [new EmbedBuilder()
        .setTitle(mojang.name + "'s Profiles").setColor(0x00CCFF)
        .setThumbnail('https://mc-heads.net/avatar/' + mojang.id)
        .setDescription(lines.join('\n\n')).setTimestamp()] });
    }

    // ── /compare ─────────────────────────────────────────────────────────────
    if (cmd === 'compare') {
      const [m1, m2]   = await Promise.all([fetchMojang(interaction.options.getString('player1')), fetchMojang(interaction.options.getString('player2'))]);
      const [p1, p2]   = await Promise.all([fetchProfiles(m1.id), fetchProfiles(m2.id)]);
      const mem1       = getMember(getActiveProfile(p1, m1.id), m1.id);
      const mem2       = getMember(getActiveProfile(p2, m2.id), m2.id);
      if (!mem1 || !mem2) return interaction.editReply('Could not find data for one or both players.');
      const avg1 = skillAvg(mem1), avg2 = skillAvg(mem2);
      const cat1 = dungLevel(mem1.dungeons?.dungeon_types?.catacombs?.experience || 0);
      const cat2 = dungLevel(mem2.dungeons?.dungeon_types?.catacombs?.experience || 0);
      const sx1  = Object.values(mem1.slayer_bosses||{}).reduce((s,v)=>s+(v.xp||0),0);
      const sx2  = Object.values(mem2.slayer_bosses||{}).reduce((s,v)=>s+(v.xp||0),0);
      const w = (a,b) => a>b ? ' WIN' : a<b ? ' LOSS' : ' TIE';
      return interaction.editReply({ embeds: [new EmbedBuilder()
        .setTitle(m1.name + ' vs ' + m2.name).setColor(0xAA00FF)
        .addFields(
          { name:'Skill Average', value: m1.name+': **'+avg1.toFixed(2)+'**'+w(avg1,avg2)+'\n'+m2.name+': **'+avg2.toFixed(2)+'**', inline:true },
          { name:'Catacombs',     value: m1.name+': **'+cat1+'**'+w(cat1,cat2)+'\n'+m2.name+': **'+cat2+'**',                        inline:true },
          { name:'Slayer XP',     value: m1.name+': **'+fmt(sx1)+'**'+w(sx1,sx2)+'\n'+m2.name+': **'+fmt(sx2)+'**',                  inline:true },
        ).setTimestamp()] });
    }

    // ── /help ────────────────────────────────────────────────────────────────
    if (cmd === 'help') {
      return interaction.editReply({ embeds: [new EmbedBuilder()
        .setTitle('Hypixel Skyblock Bot — All Commands').setColor(0x00FFFF)
        .addFields(
          { name:'Player Stats', value:'/stats\n/networth\n/skills\n/slayer\n/dungeons\n/profile\n/compare', inline:true },
          { name:'Economy',      value:'/bazaar\n/auction', inline:true },
          { name:'World',        value:'/mayor', inline:true },
          { name:'Kuudra',       value:'/kuudra setup\n/kuudra profit\n/kuudra requirements\n/kuudra lfg\n/kuudra parties\n/kuudra guide\n/kuudra tiers', inline:false },
        ).setFooter({ text:'Hypixel Skyblock Bot' }).setTimestamp()] });
    }

    // ── /kuudra ──────────────────────────────────────────────────────────────
    if (cmd === 'kuudra') {

      if (sub === 'setup') {
        const d = TIERS[interaction.options.getString('tier')];
        return interaction.editReply({ embeds: [new EmbedBuilder()
          .setTitle('Kuudra ' + d.label + ' — Recommended Setup').setColor(d.color)
          .addFields(
            { name:'Armor',            value:d.setup.armor,   inline:false },
            { name:'Weapon',           value:d.setup.weapon,  inline:false },
            { name:'Pet',              value:d.setup.pet,     inline:true  },
            { name:'Accessories',      value:d.setup.acc,     inline:false },
            { name:'Reforges',         value:d.setup.reforge, inline:false },
            { name:'Min EHP',          value:fmt(d.minEHP),   inline:true  },
            { name:'Rec Cata Level',   value:'Level ' + d.recCata + '+', inline:true },
            { name:'Notes',            value:d.setup.notes,   inline:false },
          ).setTimestamp()] });
      }

      if (sub === 'profit') {
        const d    = TIERS[interaction.options.getString('tier')];
        const runs = interaction.options.getInteger('runs') || 1;
        const loot = d.profit.avgLoot * runs;
        const keys = d.profit.keyCost * runs;
        const net  = loot - keys;
        return interaction.editReply({ embeds: [new EmbedBuilder()
          .setTitle('Kuudra ' + d.label + ' — Profit').setColor(d.color)
          .addFields(
            { name:'Runs',        value:String(runs),      inline:true },
            { name:'Avg Loot/Run',value:fmt(d.profit.avgLoot), inline:true },
            { name:'Key Cost/Run',value:fmt(d.profit.keyCost), inline:true },
            { name:'Total Loot',  value:fmt(loot), inline:true },
            { name:'Total Keys',  value:fmt(keys), inline:true },
            { name:'Net Profit',  value:'**'+fmt(net)+'** coins', inline:true },
            { name:'Est/Hour',    value:'~'+fmt(net*4)+' coins', inline:false },
          ).setTimestamp()] });
      }

      if (sub === 'requirements') {
        const d      = TIERS[interaction.options.getString('tier')];
        const mojang = await fetchMojang(interaction.options.getString('username'));
        const member = getMember(getActiveProfile(await fetchProfiles(mojang.id), mojang.id), mojang.id);
        if (!member) return interaction.editReply('No Skyblock data found.');
        const hp     = member.stats?.health  || 100;
        const def    = member.stats?.defense || 0;
        const ehp    = Math.round(hp * (1 + def/100));
        const cata   = dungLevel(member.dungeons?.dungeon_types?.catacombs?.experience || 0);
        const avg    = skillAvg(member);
        const ok1    = ehp  >= d.minEHP, ok2 = cata >= d.recCata, ok3 = avg >= 30;
        const all    = ok1 && ok2 && ok3;
        const t = v => v ? 'YES' : 'NO';
        return interaction.editReply({ embeds: [new EmbedBuilder()
          .setTitle(mojang.name + ' — ' + d.label + ' Readiness').setColor(all ? 0x00FF44 : 0xFF4400)
          .setThumbnail('https://mc-heads.net/avatar/' + mojang.id)
          .addFields(
            { name:'EHP (est.) — '+t(ok1),      value:fmt(ehp)+' / '+fmt(d.minEHP)+' required',  inline:false },
            { name:'Catacombs — '+t(ok2),        value:cata+' / '+d.recCata+' recommended',        inline:true  },
            { name:'Skill Average — '+t(ok3),    value:avg.toFixed(1)+' / 30 recommended',         inline:true  },
            { name:'Verdict', value: all ? mojang.name+' is READY for '+d.label+'!' : 'Not fully ready. Improve stats marked NO.', inline:false },
          ).setTimestamp()] });
      }

      if (sub === 'lfg') {
        const tier = interaction.options.getString('tier');
        const role = interaction.options.getString('role');
        const note = interaction.options.getString('note') || 'No additional info';
        const d    = TIERS[tier];
        const gid  = interaction.guildId;
        if (!lfgStore.has(gid)) lfgStore.set(gid, []);
        const list = lfgStore.get(gid).filter(e => e.userId !== interaction.user.id);
        list.push({ userId:interaction.user.id, tag:interaction.user.tag, tier, role, note, ts:Date.now() });
        lfgStore.set(gid, list);
        return interaction.editReply({ embeds: [new EmbedBuilder()
          .setTitle('LFG — Kuudra ' + d.label).setColor(d.color)
          .setDescription('<@' + interaction.user.id + '> is looking for a Kuudra group!')
          .addFields(
            { name:'Role', value:role,    inline:true },
            { name:'Tier', value:d.label, inline:true },
            { name:'Note', value:note,    inline:false },
          ).setFooter({ text:'Use /kuudra parties to see all LFG. Expires in 30 min.' }).setTimestamp()] });
      }

      if (sub === 'parties') {
        const tf   = interaction.options.getString('tier') || 'all';
        const gid  = interaction.guildId;
        const now  = Date.now();
        const fresh = (lfgStore.get(gid)||[]).filter(e => now - e.ts < 30*60000);
        lfgStore.set(gid, fresh);
        const filtered = tf === 'all' ? fresh : fresh.filter(e => e.tier === tf);
        if (!filtered.length) return interaction.editReply('No active LFG parties. Post one with /kuudra lfg!');
        const embed = new EmbedBuilder()
          .setTitle('Active LFG Parties' + (tf !== 'all' ? ' — ' + TIERS[tf].label : ' — All Tiers'))
          .setColor(0xFF6600).setTimestamp();
        filtered.slice(0,10).forEach(e => {
          embed.addFields({ name: TIERS[e.tier].label+' — '+e.role, value:'<@'+e.userId+'> ('+e.tag+')\n'+e.note+'\n'+Math.round((now-e.ts)/60000)+'m ago', inline:false });
        });
        return interaction.editReply({ embeds: [embed] });
      }

      if (sub === 'guide') {
        const tier = interaction.options.getString('tier');
        if (tier) {
          const d = TIERS[tier];
          return interaction.editReply({ embeds: [new EmbedBuilder()
            .setTitle('Kuudra ' + d.label + ' — Guide').setColor(d.color)
            .setDescription(d.guide.join('\n\n')).setTimestamp()] });
        }
        return interaction.editReply({ embeds: [new EmbedBuilder()
          .setTitle('Kuudra — General Guide').setColor(0xFF6600)
          .addFields(
            { name:'Overview',  value:'4-player co-op boss on Crimson Isle. 5 tiers: Basic to Infernal.', inline:false },
            { name:'Roles',     value:'Mage — Staff DPS\nBerserk — Melee DPS\nArcher — Ranged DPS\nTank — Absorbs damage\nHealer — Support', inline:false },
            { name:'4 Phases',  value:'1. Supply Run\n2. Build + Defend\n3. Ballista + Fight Kuudra\n4. Open Paid Chest', inline:false },
            { name:'Pro Tips',  value:'Always open the Paid Chest\nAttribute Shards are best drops\nUse God Potions for Fiery+\nCoordinate roles before starting', inline:false },
          ).setTimestamp()] });
      }

      if (sub === 'tiers') {
        const embed = new EmbedBuilder().setTitle('Kuudra — All Tiers Overview').setColor(0xFF6600).setTimestamp();
        Object.entries(TIERS).forEach(([k, d]) => {
          embed.addFields({ name:d.label, value:'Avg Profit: **'+fmt(d.profit.avgLoot-d.profit.keyCost)+'**/run | Min EHP: **'+fmt(d.minEHP)+'** | Rec Cata: **'+d.recCata+'+**', inline:false });
        });
        return interaction.editReply({ embeds: [embed] });
      }
    }

  } catch (err) {
    console.error('Error:', err.message);
    try {
      await interaction.editReply('Error: ' + (err.message || 'Unknown error') + '\nMake sure the player exists and your HYPIXEL_API_KEY is valid.');
    } catch (_) {}
  }
});

client.login(DISCORD_TOKEN);
