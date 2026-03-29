const {
  Client, GatewayIntentBits, REST, Routes,
  SlashCommandBuilder, EmbedBuilder,
} = require('discord.js');
const axios = require('axios');
const NodeCache = require('node-cache');

const DISCORD_TOKEN   = process.env.DISCORD_TOKEN;
const CLIENT_ID       = process.env.CLIENT_ID;
const HYPIXEL_API_KEY = process.env.HYPIXEL_API_KEY;

const cache          = new NodeCache({ stdTTL: 300 });
const client         = new Client({ intents: [GatewayIntentBits.Guilds] });
const lfgStore       = new Map();
const linkedAccounts = new Map();

const HAPI = () => ({ headers: { 'API-Key': HYPIXEL_API_KEY } });

// ─── API ──────────────────────────────────────────────────────────────────────

async function fetchMojang(username) {
  const k = 'mj_' + username.toLowerCase();
  if (cache.has(k)) return cache.get(k);
  const r = await axios.get('https://playerdb.co/api/player/minecraft/' + username);
  if (!r.data.success) throw new Error('Player **' + username + '** not found. Check the spelling.');
  const v = { id: r.data.data.player.raw_id, name: r.data.data.player.username };
  cache.set(k, v); return v;
}

async function fetchProfiles(uuid) {
  const k = 'pr_' + uuid;
  if (cache.has(k)) return cache.get(k);
  const r = await axios.get('https://api.hypixel.net/v2/skyblock/profiles?uuid=' + uuid, HAPI());
  const v = r.data.profiles || [];
  cache.set(k, v); return v;
}

async function fetchBazaar() {
  if (cache.has('bz')) return cache.get('bz');
  const r = await axios.get('https://api.hypixel.net/v2/skyblock/bazaar', HAPI());
  const v = r.data.products || {};
  cache.set('bz', v); return v;
}

async function fetchAH() {
  const r = await axios.get('https://api.hypixel.net/v2/skyblock/auctions?page=0', HAPI());
  return r.data;
}

async function fetchMayor() {
  if (cache.has('mayor')) return cache.get('mayor');
  const r = await axios.get('https://api.hypixel.net/v2/resources/skyblock/election', HAPI());
  cache.set('mayor', r.data); return r.data;
}

// SkyCrypt API — full networth breakdown (same source as SkyHelper)
async function fetchSkyCrypt(username) {
  const k = 'sc_' + username.toLowerCase();
  if (cache.has(k)) return cache.get(k);
  try {
    const r = await axios.get('https://sky.shiiyu.moe/api/v2/profile/' + username, { timeout: 10000 });
    cache.set(k, r.data);
    return r.data;
  } catch(e) {
    return null;
  }
}

function getActive(profiles) {
  if (!profiles || !profiles.length) return null;
  return profiles.find(p => p.selected) || profiles[0];
}
function getMember(profile, uuid) {
  return profile && profile.members ? profile.members[uuid] || null : null;
}

async function resolveUser(interaction) {
  const v = interaction.options.getString('username');
  if (v) return v;
  const l = linkedAccounts.get(interaction.user.id);
  if (l) return l;
  throw new Error('No username provided!\n\n**Fix:** Type `/link <username>` to link your Minecraft account, then you never need to type it again.\n**Or:** Add your username directly: `/skills username:YourName`');
}

// ─── FORMAT ───────────────────────────────────────────────────────────────────

function fmt(n) {
  if (!n || isNaN(n)) return '0';
  if (n >= 1e9) return (n/1e9).toFixed(2)+'B';
  if (n >= 1e6) return (n/1e6).toFixed(2)+'M';
  if (n >= 1e3) return (n/1e3).toFixed(1)+'K';
  return Math.round(n).toLocaleString();
}
function fmtFull(n) {
  if (!n || isNaN(n)) return '0';
  return Math.round(n).toLocaleString();
}

// ─── SKILL XP ────────────────────────────────────────────────────────────────

const SKILL_XP = [0,50,125,200,300,500,750,1000,1500,2000,3500,5000,7500,10000,15000,20000,30000,50000,75000,100000,200000,300000,400000,500000,600000,700000,800000,900000,1000000,1100000,1200000,1300000,1400000,1500000,1600000,1700000,1800000,1900000,2000000,2100000,2200000,2300000,2400000,2500000,2600000,2750000,2900000,3100000,3400000,3700000,4000000,4300000,4600000,5000000,5500000,6000000,6500000,7000000,7500000];
function skillLevel(xp, max) {
  max = max||60; let lvl=0,tot=0;
  for(let i=0;i<Math.min(max,SKILL_XP.length);i++){if(xp>=tot+SKILL_XP[i]){tot+=SKILL_XP[i];lvl=i;}else break;}
  return lvl;
}
function skillAvg(m) {
  const n=['farming','mining','combat','foraging','fishing','enchanting','alchemy','taming'];
  return n.reduce((s,k)=>s+skillLevel(m['experience_skill_'+k]||0),0)/n.length;
}

const SL_XP = {
  zombie:[0,5,15,200,1000,5000,20000,100000,400000,1000000],
  spider:[0,5,25,200,1000,5000,20000,100000,400000,1000000],
  wolf:[0,10,30,250,1500,5000,20000,100000,400000,1000000],
  enderman:[0,10,30,250,1500,5000,20000,100000,400000,1000000],
  blaze:[0,10,30,250,1500,5000,20000,100000,400000,1000000],
  vampire:[0,20,75,240,840,2400],
};
function slayerLvl(xp,type){const t=SL_XP[type]||[];let l=0;for(let i=0;i<t.length;i++){if(xp>=t[i])l=i;else break;}return l;}

const DG_XP=[0,50,75,110,160,230,330,470,670,950,1340,1890,2665,3760,5260,7380,10300,14400,20000,27600,38000,52500,71500,97000,132000,180000,243000,328000,445000,600000,800000,1065000,1410000,1900000,2500000,3300000,4300000,5600000,7200000,9200000,12000000,15000000,19000000,24000000,30000000,38000000,48000000,60000000,75000000,93000000];
function dungLvl(xp){let l=0,tot=0;for(let i=0;i<DG_XP.length;i++){if(xp>=tot+DG_XP[i]){tot+=DG_XP[i];l=i;}else break;}return l;}

// ─── ACCESSORIES ─────────────────────────────────────────────────────────────

const MP_MILESTONES = [
  { mp:100,  bonus:'+5 Strength, +5 Crit Damage'          },
  { mp:150,  bonus:'+1% Crit Chance'                       },
  { mp:200,  bonus:'+5 Intelligence, +5 Defense'           },
  { mp:250,  bonus:'+1% Crit Chance'                       },
  { mp:300,  bonus:'+5 Strength, +5 Crit Damage'          },
  { mp:400,  bonus:'+5 Speed, +5 Crit Chance'              },
  { mp:500,  bonus:'+10 Strength, +10 Crit Damage'         },
  { mp:650,  bonus:'+5 Speed, +5 Crit Chance'              },
  { mp:800,  bonus:'+10 Intelligence, +10 Defense'         },
  { mp:900,  bonus:'+5 Strength, +5 Crit Damage'          },
  { mp:1000, bonus:'+10 Strength, +15 Crit Damage, +2% CC' },
];

const ACC = [
  { name:'Speed Talisman',           tier:'Common',    mp:3,  cost:2000,     cat:'Speed',    desc:'+1% Speed' },
  { name:'Speed Ring',               tier:'Uncommon',  mp:5,  cost:5000,     cat:'Speed',    desc:'+2% Speed' },
  { name:'Speed Artifact',           tier:'Rare',      mp:8,  cost:25000,    cat:'Speed',    desc:'+3% Speed' },
  { name:'Candy Talisman',           tier:'Common',    mp:3,  cost:1000,     cat:'Utility',  desc:'+1 Strength' },
  { name:'Potion Affinity Talisman', tier:'Common',    mp:3,  cost:3000,     cat:'Utility',  desc:'Potions last longer' },
  { name:'Feather Talisman',         tier:'Common',    mp:3,  cost:2500,     cat:'Defense',  desc:'Reduce fall damage' },
  { name:'Feather Ring',             tier:'Uncommon',  mp:5,  cost:8000,     cat:'Defense',  desc:'Negate fall damage' },
  { name:'Feather Artifact',         tier:'Rare',      mp:8,  cost:40000,    cat:'Defense',  desc:'Immunity to fall damage' },
  { name:'Intimidation Talisman',    tier:'Common',    mp:3,  cost:4000,     cat:'Combat',   desc:'Weaker mobs less likely to attack' },
  { name:'Intimidation Ring',        tier:'Uncommon',  mp:5,  cost:15000,    cat:'Combat',   desc:'Mobs less likely to attack' },
  { name:'Intimidation Artifact',    tier:'Epic',      mp:12, cost:200000,   cat:'Combat',   desc:'Strong mobs less likely to attack' },
  { name:'Zombie Talisman',          tier:'Common',    mp:3,  cost:5000,     cat:'Combat',   desc:'+2 Strength vs Zombies' },
  { name:'Zombie Ring',              tier:'Uncommon',  mp:5,  cost:20000,    cat:'Combat',   desc:'+4 Strength vs Zombies' },
  { name:'Zombie Artifact',          tier:'Rare',      mp:8,  cost:80000,    cat:'Combat',   desc:'+6 Strength vs Zombies' },
  { name:'Spider Talisman',          tier:'Uncommon',  mp:5,  cost:10000,    cat:'Combat',   desc:'+2 Crit Damage vs Spiders' },
  { name:'Spider Ring',              tier:'Rare',      mp:8,  cost:50000,    cat:'Combat',   desc:'+4 Crit Damage vs Spiders' },
  { name:'Spider Artifact',          tier:'Epic',      mp:12, cost:250000,   cat:'Combat',   desc:'+6 Crit Damage vs Spiders' },
  { name:'Wolf Talisman',            tier:'Uncommon',  mp:5,  cost:10000,    cat:'Combat',   desc:'+2 Speed on Slayer quests' },
  { name:'Wolf Ring',                tier:'Rare',      mp:8,  cost:50000,    cat:'Combat',   desc:'+4 Speed on Slayer quests' },
  { name:'Wolf Artifact',            tier:'Epic',      mp:12, cost:300000,   cat:'Combat',   desc:'+6 Speed on Slayer quests' },
  { name:'Bat Talisman',             tier:'Common',    mp:3,  cost:1500,     cat:'Utility',  desc:'Attracts nearby bats' },
  { name:'Bat Ring',                 tier:'Uncommon',  mp:5,  cost:8000,     cat:'Utility',  desc:'Stronger bat attraction' },
  { name:'Bat Artifact',             tier:'Rare',      mp:8,  cost:40000,    cat:'Utility',  desc:'Area bat attraction' },
  { name:'Broken Piggy Bank',        tier:'Common',    mp:3,  cost:5000,     cat:'Utility',  desc:'Saves coins on death' },
  { name:'Cracked Piggy Bank',       tier:'Uncommon',  mp:5,  cost:20000,    cat:'Utility',  desc:'Saves more coins on death' },
  { name:'Piggy Bank',               tier:'Rare',      mp:8,  cost:100000,   cat:'Utility',  desc:'Saves most coins on death' },
  { name:'Magnetic Talisman',        tier:'Common',    mp:3,  cost:3000,     cat:'Utility',  desc:'Increased pickup range' },
  { name:'Vaccine Talisman',         tier:'Common',    mp:3,  cost:4000,     cat:'Utility',  desc:'Reduces poison duration' },
  { name:'Farmer Orb',               tier:'Uncommon',  mp:5,  cost:50000,    cat:'Farming',  desc:'Crops grow faster' },
  { name:'Mine Talisman',            tier:'Common',    mp:3,  cost:2000,     cat:'Mining',   desc:'Mining speed in mines' },
  { name:'Mine Ring',                tier:'Uncommon',  mp:5,  cost:8000,     cat:'Mining',   desc:'+5 Mining Speed' },
  { name:'Treasure Talisman',        tier:'Common',    mp:3,  cost:3000,     cat:'Fishing',  desc:'More fishing treasure' },
  { name:'Fishing Talisman',         tier:'Uncommon',  mp:5,  cost:5000,     cat:'Fishing',  desc:'+10 Fishing Speed' },
  { name:'Sea Creature Talisman',    tier:'Rare',      mp:8,  cost:30000,    cat:'Fishing',  desc:'Sea creature buffs' },
  { name:'Talisman of Coins',        tier:'Uncommon',  mp:5,  cost:15000,    cat:'Utility',  desc:'Coins from mobs' },
  { name:'Ender Artifact',           tier:'Epic',      mp:12, cost:300000,   cat:'Combat',   desc:'+25% damage on Endermen' },
  { name:'Lava Talisman',            tier:'Uncommon',  mp:5,  cost:10000,    cat:'Utility',  desc:'Fire immunity' },
  { name:'Ancient Rose',             tier:'Epic',      mp:12, cost:500000,   cat:'Combat',   desc:'+5% Magic damage' },
  { name:'Campfire Talisman',        tier:'Common',    mp:3,  cost:2000,     cat:'Utility',  desc:'+1 Defense' },
  { name:'Campfire Badge 5',         tier:'Uncommon',  mp:5,  cost:10000,    cat:'Utility',  desc:'+5 Defense' },
  { name:'Campfire Badge 10',        tier:'Rare',      mp:8,  cost:50000,    cat:'Utility',  desc:'+10 Defense' },
  { name:'Campfire Badge 15',        tier:'Epic',      mp:12, cost:200000,   cat:'Utility',  desc:'+15 Defense' },
  { name:'Campfire Badge 20',        tier:'Legendary', mp:16, cost:1000000,  cat:'Utility',  desc:'+20 Defense' },
  { name:'Wither Talisman',          tier:'Rare',      mp:8,  cost:75000,    cat:'Combat',   desc:'+5% damage vs Wither mobs' },
  { name:'Wither Ring',              tier:'Epic',      mp:12, cost:400000,   cat:'Combat',   desc:'+10% damage vs Wither mobs' },
  { name:'Wither Artifact',          tier:'Legendary', mp:16, cost:2000000,  cat:'Combat',   desc:'+15% damage vs Wither mobs' },
  { name:'Crit Talisman',            tier:'Rare',      mp:8,  cost:50000,    cat:'Combat',   desc:'+10 Crit Damage' },
  { name:'Crit Ring',                tier:'Epic',      mp:12, cost:250000,   cat:'Combat',   desc:'+15 Crit Damage' },
  { name:'Crit Artifact',            tier:'Legendary', mp:16, cost:2500000,  cat:'Combat',   desc:'+25 Crit Damage' },
  { name:'Haste Ring',               tier:'Common',    mp:3,  cost:5000,     cat:'Mining',   desc:'Haste I while mining' },
  { name:'Night Vision Charm',       tier:'Common',    mp:3,  cost:3000,     cat:'Utility',  desc:'Night vision in caves' },
  { name:'Experience Artifact',      tier:'Legendary', mp:16, cost:5000000,  cat:'Utility',  desc:'+25% XP from all sources' },
  { name:'Scarf Thesis',             tier:'Legendary', mp:16, cost:10000000, cat:'Dungeons', desc:'+5% dmg and def in dungeons' },
  { name:'Frozen Chicken',           tier:'Common',    mp:3,  cost:1000,     cat:'Utility',  desc:'Reduces ice damage' },
  { name:'Shaman Orb',               tier:'Uncommon',  mp:5,  cost:30000,    cat:'Utility',  desc:'Golem buff nearby' },
  { name:'Personal Deletor 4000',    tier:'Rare',      mp:8,  cost:200000,   cat:'Utility',  desc:'Auto-deletes junk items' },
  { name:'Personal Deletor 5000',    tier:'Epic',      mp:12, cost:1000000,  cat:'Utility',  desc:'Auto-deletes more junk' },
  { name:'Personal Deletor 6000',    tier:'Legendary', mp:16, cost:5000000,  cat:'Utility',  desc:'Auto-deletes most junk' },
  { name:'Beacon 1',                 tier:'Common',    mp:3,  cost:10000,    cat:'Utility',  desc:'+5 stats in beacon range' },
  { name:'Beacon 2',                 tier:'Uncommon',  mp:5,  cost:50000,    cat:'Utility',  desc:'+10 stats in beacon range' },
  { name:'Beacon 3',                 tier:'Rare',      mp:8,  cost:200000,   cat:'Utility',  desc:'+15 stats in beacon range' },
  { name:'Beacon 4',                 tier:'Epic',      mp:12, cost:1000000,  cat:'Utility',  desc:'+20 stats in beacon range' },
  { name:'Beacon 5',                 tier:'Legendary', mp:16, cost:5000000,  cat:'Utility',  desc:'+25 stats in beacon range' },
  { name:'Bait Ring',                tier:'Uncommon',  mp:5,  cost:8000,     cat:'Fishing',  desc:'+10% Sea Creature chance' },
  { name:'Shark Scale Ring',         tier:'Rare',      mp:8,  cost:40000,    cat:'Fishing',  desc:'+15% Sea Creature chance' },
  { name:'Shark Scale Artifact',     tier:'Epic',      mp:12, cost:200000,   cat:'Fishing',  desc:'+25% Sea Creature chance' },
  { name:'Dante Talisman',           tier:'Uncommon',  mp:5,  cost:20000,    cat:'Combat',   desc:'+2% damage in The End' },
  { name:'Dante Ring',               tier:'Rare',      mp:8,  cost:80000,    cat:'Combat',   desc:'+4% damage in The End' },
  { name:'Dante Artifact',           tier:'Epic',      mp:12, cost:400000,   cat:'Combat',   desc:'+6% damage in The End' },
  { name:'Crooked Artifact',         tier:'Legendary', mp:16, cost:3000000,  cat:'Combat',   desc:'+10% damage to all mobs' },
  { name:'Titanium Talisman',        tier:'Uncommon',  mp:5,  cost:15000,    cat:'Mining',   desc:'+5 Mining Speed in Dwarven Mines' },
  { name:'Titanium Ring',            tier:'Rare',      mp:8,  cost:60000,    cat:'Mining',   desc:'+10 Mining Speed in Dwarven Mines' },
  { name:'Titanium Artifact',        tier:'Epic',      mp:12, cost:300000,   cat:'Mining',   desc:'+15 Mining Speed in Dwarven Mines' },
];

// ─── KUUDRA DATA ──────────────────────────────────────────────────────────────

const TIERS = {
  basic:    { label:'Basic (T1)',    color:0x55FF55, minEHP:15000,  recCata:10,  setup:{ armor:'Any Crimson Armor (Hot quality fine)', weapon:'Midas Staff / Spirit Sceptre', pet:'Blaze Lvl 100 or Tiger', acc:'Full Talisman Bag (Common-Rare)', reforge:'Fierce Chest, Necrotic Helm, Bloody Legs/Boots', notes:'Easiest tier. 15k+ EHP and any crimson set.' }, profit:{ avgLoot:80000, keyCost:40000 }, guide:['**Phase 1:** Sprint to supplies, ignore minions.','**Phase 2:** Dump supplies, protect builders.','**Phase 3:** Ballista stuns Kuudra, DPS weak spot.','**Phase 4:** Open paid chest for loot.','**Tip:** Crimson Key required to open chest.'] },
  hot:      { label:'Hot (T2)',      color:0xFF5555, minEHP:30000,  recCata:15,  setup:{ armor:'Fine or Burning Crimson Armor (full set)', weapon:'Aurora Staff / Starred Midas', pet:'Blaze Lvl 100', acc:'Full Talisman Bag (up to Epic)', reforge:'Fierce Chest, Necrotic Helm, Bloody Legs/Boots', notes:'Aim 30k+ EHP. Swap Boots to Magma Lord if available.' }, profit:{ avgLoot:220000, keyCost:100000 }, guide:['**Phase 1:** Faster supply collection than Basic.','**Phase 2:** More minions spawn, one player guard.','**Phase 3:** Kuudra hits harder, dodge projectiles.','**Tip:** Mana potions help sustain staff usage.'] },
  burning:  { label:'Burning (T3)',  color:0xFF8800, minEHP:60000,  recCata:20,  setup:{ armor:'Burning Crimson Armor or better', weapon:'Aurora Staff / Starred Midas', pet:'Blaze Lvl 100 with Tier Boost', acc:'Full Talisman Bag (Epic+), Mana Flask', reforge:'Fierce Chest, Necrotic/Warped Helm, Bloody Legs/Boots', notes:'Need 60k+ EHP. Aim for 4M+ HP pool with pots.' }, profit:{ avgLoot:650000, keyCost:300000 }, guide:['**Phase 1:** Use Speed pot, collect supplies within 45s.','**Phase 2:** Protect builders aggressively.','**Phase 3:** Ballista needs 2 hits. Watch for waves.','**Tip:** Strength Pots and God Pot improve DPS.'] },
  fiery:    { label:'Fiery (T4)',    color:0xFF2200, minEHP:120000, recCata:25,  setup:{ armor:'Fiery Crimson Armor (all pieces)', weapon:'Infernal/Aurora Staff or Starred Midas', pet:'Blaze Lvl 100 Tier Boost or Black Cat Lvl 100', acc:'Full Talisman Bag (Legendary), Mana Flask', reforge:'Fierce Chest, Necrotic Helm, Bloody Legs/Boots', notes:'Need 120k+ EHP. Must use Overload 5 + God Pot.' }, profit:{ avgLoot:2200000, keyCost:1000000 }, guide:['**Phase 1:** Finish supply run under 40s.','**Phase 2:** Minion waves much stronger, tank/healer needed.','**Phase 3:** Ballista takes 3 hits. Kuudra does AoE.','**Tip:** Always use Overload + God Pot. Coordinate.'] },
  infernal: { label:'Infernal (T5)', color:0x8800FF, minEHP:300000, recCata:30,  setup:{ armor:'Infernal Crimson Armor (best quality)', weapon:'Infernal Staff Starred / Shadow Fury', pet:'Blaze Lvl 100 Tier Boost or Ender Dragon Lvl 100', acc:'Fully optimized Talisman Bag (Recombobulated + MP reforged)', reforge:'Fierce Chest, Necrotic Helm, Withered/Bloody Legs/Boots', notes:'Need 300k+ EHP. Overload 5, God Pot, Mana Flask, Adrenaline required.' }, profit:{ avgLoot:9000000, keyCost:4000000 }, guide:['**Phase 1:** Perfect supply run, under 35s.','**Phase 2:** Extremely strong minions, coordinate roles.','**Phase 3:** Ballista 4+ hits. Constant AoE. Do NOT facetank.','**Phase 4:** Infernal chests drop 10M+ items.','**Tip:** Best-in-slot required. One weak player can wipe team.'] },
};

// ─── COMMANDS ─────────────────────────────────────────────────────────────────

const TC = [
  { name:'Basic (T1)',   value:'basic'    },
  { name:'Hot (T2)',     value:'hot'      },
  { name:'Burning (T3)',value:'burning'  },
  { name:'Fiery (T4)',  value:'fiery'    },
  { name:'Infernal (T5)',value:'infernal'},
];
const uOpt = o => o.setName('username').setDescription('Minecraft username (skip if you used /link)').setRequired(false);

const commands = [
  new SlashCommandBuilder().setName('link').setDescription('Link your Minecraft account — do this first!')
    .addStringOption(o => o.setName('username').setDescription('Your Minecraft username').setRequired(true)),
  new SlashCommandBuilder().setName('unlink').setDescription('Unlink your Minecraft account'),
  new SlashCommandBuilder().setName('whoami').setDescription('Show your linked Minecraft account'),
  new SlashCommandBuilder().setName('stats').setDescription('View a player\'s Skyblock stats').addStringOption(uOpt),
  new SlashCommandBuilder().setName('networth').setDescription('Full SkyHelper-style networth breakdown').addStringOption(uOpt),
  new SlashCommandBuilder().setName('skills').setDescription('View a player\'s skill levels').addStringOption(uOpt),
  new SlashCommandBuilder().setName('slayer').setDescription('View a player\'s slayer boss levels').addStringOption(uOpt),
  new SlashCommandBuilder().setName('dungeons').setDescription('View a player\'s Catacombs stats').addStringOption(uOpt),
  new SlashCommandBuilder().setName('profile').setDescription('Show a player\'s profile list').addStringOption(uOpt),
  new SlashCommandBuilder().setName('compare').setDescription('Compare two players')
    .addStringOption(o => o.setName('player1').setDescription('First player').setRequired(true))
    .addStringOption(o => o.setName('player2').setDescription('Second player').setRequired(true)),
  new SlashCommandBuilder().setName('bazaar').setDescription('Check Bazaar prices')
    .addStringOption(o => o.setName('item').setDescription('Item ID e.g. ENCHANTED_IRON').setRequired(true)),
  new SlashCommandBuilder().setName('auction').setDescription('Search the Auction House')
    .addStringOption(o => o.setName('item').setDescription('Item name').setRequired(true)),
  new SlashCommandBuilder().setName('mayor').setDescription('View current Skyblock Mayor'),
  new SlashCommandBuilder().setName('help').setDescription('Show all bot commands'),

  new SlashCommandBuilder().setName('accessories').setDescription('Accessories / talisman tools')
    .addSubcommand(s => s.setName('budget')
      .setDescription('Plan accessories within your budget')
      .addIntegerOption(o => o.setName('budget').setDescription('Your coin budget').setRequired(true).setMinValue(1000))
      .addStringOption(o => o.setName('goal').setDescription('Build goal').setRequired(true).addChoices(
        { name:'Combat DPS',       value:'combat'    },
        { name:'Dungeons',         value:'dungeons'  },
        { name:'All-round',        value:'allround'  },
        { name:'Speed / QoL',      value:'speed'     },
        { name:'Mining / Farming', value:'gathering' },
      ))
      .addIntegerOption(o => o.setName('target_mp').setDescription('Target Magic Power (e.g. 300)').setMinValue(1).setMaxValue(1000))
      .addIntegerOption(o => o.setName('current_mp').setDescription('Your current Magic Power').setMinValue(0))
      .addStringOption(o => o.setName('tier_limit').setDescription('Max talisman tier').addChoices(
        { name:'Common only',     value:'Common'    },
        { name:'Up to Uncommon',  value:'Uncommon'  },
        { name:'Up to Rare',      value:'Rare'      },
        { name:'Up to Epic',      value:'Epic'      },
        { name:'Up to Legendary', value:'Legendary' },
      )))
    .addSubcommand(s => s.setName('milestones').setDescription('See all MP milestone bonuses'))
    .addSubcommand(s => s.setName('list')
      .setDescription('Browse accessories by category')
      .addStringOption(o => o.setName('category').setDescription('Category').addChoices(
        { name:'Combat',   value:'Combat'   },{ name:'Speed',    value:'Speed'    },
        { name:'Defense',  value:'Defense'  },{ name:'Dungeons', value:'Dungeons' },
        { name:'Utility',  value:'Utility'  },{ name:'Fishing',  value:'Fishing'  },
        { name:'Mining',   value:'Mining'   },{ name:'Farming',  value:'Farming'  },
      )))
    .addSubcommand(s => s.setName('upgrade')
      .setDescription('Best MP/coin picks within budget')
      .addIntegerOption(o => o.setName('budget').setDescription('Your coin budget').setRequired(true).setMinValue(1000))
      .addIntegerOption(o => o.setName('current_mp').setDescription('Your current MP').setMinValue(0))),

  new SlashCommandBuilder().setName('kuudra').setDescription('All Kuudra commands')
    .addSubcommand(s => s.setName('setup').setDescription('Best gear setup for a tier')
      .addStringOption(o => o.setName('tier').setDescription('Kuudra tier').setRequired(true).addChoices(...TC)))
    .addSubcommand(s => s.setName('profit').setDescription('Profit calculator')
      .addStringOption(o => o.setName('tier').setDescription('Kuudra tier').setRequired(true).addChoices(...TC))
      .addIntegerOption(o => o.setName('runs').setDescription('Number of runs').setMinValue(1).setMaxValue(10000)))
    .addSubcommand(s => s.setName('requirements').setDescription('Check if a player is ready for a tier')
      .addStringOption(o => o.setName('tier').setDescription('Kuudra tier').setRequired(true).addChoices(...TC))
      .addStringOption(o => o.setName('username').setDescription('Minecraft username (skip if linked)').setRequired(false)))
    .addSubcommand(s => s.setName('lfg').setDescription('Post a Looking-for-Group message')
      .addStringOption(o => o.setName('tier').setDescription('Kuudra tier').setRequired(true).addChoices(...TC))
      .addStringOption(o => o.setName('role').setDescription('Your role').setRequired(true).addChoices(
        { name:'Mage',   value:'Mage'    },{ name:'Berserk',value:'Berserk' },
        { name:'Tank',   value:'Tank'    },{ name:'Healer', value:'Healer'  },
        { name:'Archer', value:'Archer'  },
      ))
      .addStringOption(o => o.setName('note').setDescription('Extra info').setRequired(false)))
    .addSubcommand(s => s.setName('parties').setDescription('View active LFG parties')
      .addStringOption(o => o.setName('tier').setDescription('Filter by tier').addChoices(...TC, { name:'All Tiers',value:'all' })))
    .addSubcommand(s => s.setName('guide').setDescription('Phase-by-phase strategy guide')
      .addStringOption(o => o.setName('tier').setDescription('Tier guide').addChoices(...TC)))
    .addSubcommand(s => s.setName('tiers').setDescription('Overview of all Kuudra tiers')),

].map(c => c.toJSON());

// ─── REGISTER ────────────────────────────────────────────────────────────────

async function registerCommands() {
  const rest = new REST({ version:'10' }).setToken(DISCORD_TOKEN);
  try {
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
    console.log('Registered ' + commands.length + ' commands!');
  } catch(e) { console.error('Register failed:', e.message); }
}

client.once('ready', async () => {
  console.log('Logged in as ' + client.user.tag);
  client.user.setActivity('/help | Skyblock Bot', { type:3 });
  await registerCommands();
});

// ─── INTERACTIONS ─────────────────────────────────────────────────────────────

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;
  await interaction.deferReply();
  try {
    const cmd = interaction.commandName;
    const sub = interaction.options.getSubcommand(false);

    // /link
    if (cmd === 'link') {
      const mojang = await fetchMojang(interaction.options.getString('username'));
      linkedAccounts.set(interaction.user.id, mojang.name);
      return interaction.editReply({ embeds:[new EmbedBuilder()
        .setTitle('Account Linked!').setColor(0x00FF88)
        .setThumbnail('https://mc-heads.net/avatar/'+mojang.id)
        .setDescription('Linked to **'+mojang.name+'**!\nAll commands now work without typing your username.')
        .setTimestamp()] });
    }

    // /unlink
    if (cmd === 'unlink') {
      if (!linkedAccounts.has(interaction.user.id)) return interaction.editReply('No linked account found.');
      const old = linkedAccounts.get(interaction.user.id);
      linkedAccounts.delete(interaction.user.id);
      return interaction.editReply({ embeds:[new EmbedBuilder().setTitle('Account Unlinked').setColor(0xFF4444).setDescription('Unlinked **'+old+'**.').setTimestamp()] });
    }

    // /whoami
    if (cmd === 'whoami') {
      const l = linkedAccounts.get(interaction.user.id);
      if (!l) return interaction.editReply('No account linked. Use `/link <username>` first!');
      const mojang = await fetchMojang(l);
      return interaction.editReply({ embeds:[new EmbedBuilder().setTitle('Your Linked Account').setColor(0x00AAFF).setThumbnail('https://mc-heads.net/avatar/'+mojang.id).setDescription('Linked to **'+mojang.name+'**').setTimestamp()] });
    }

    // /stats
    if (cmd === 'stats') {
      const username = await resolveUser(interaction);
      const mojang   = await fetchMojang(username);
      const profiles = await fetchProfiles(mojang.id);
      const profile  = getActive(profiles);
      const member   = getMember(profile, mojang.id);
      if (!member) return interaction.editReply('No Skyblock data for **'+mojang.name+'**.');
      const purse=member.coin_purse||0, bank=profile.banking?.balance||0;
      const cataXP=member.dungeons?.dungeon_types?.catacombs?.experience||0;
      const sxp=Object.values(member.slayer_bosses||{}).reduce((s,v)=>s+(v.xp||0),0);
      return interaction.editReply({ embeds:[new EmbedBuilder()
        .setTitle(mojang.name+"'s Skyblock Stats").setColor(0x00AAFF)
        .setThumbnail('https://mc-heads.net/avatar/'+mojang.id)
        .addFields(
          { name:'Active Profile',  value:profile.cute_name||'Unknown',            inline:true },
          { name:'Skill Average',   value:skillAvg(member).toFixed(2),             inline:true },
          { name:'Catacombs Level', value:String(dungLvl(cataXP)),                inline:true },
          { name:'Purse',           value:fmt(purse),                              inline:true },
          { name:'Bank',            value:fmt(bank),                               inline:true },
          { name:'Total Slayer XP', value:fmt(sxp),                               inline:true },
          { name:'Deaths',          value:String(member.death_count||0),           inline:true },
          { name:'Fairy Souls',     value:String(member.fairy_souls_collected||0), inline:true },
          { name:'Total Profiles',  value:String(profiles.length),                 inline:true },
        ).setTimestamp()] });
    }

    // /networth — SkyHelper style using SkyCrypt API
    if (cmd === 'networth') {
      const username = await resolveUser(interaction);
      const mojang   = await fetchMojang(username);

      // Fetch from SkyCrypt for full breakdown
      const sc = await fetchSkyCrypt(mojang.name);

      // Also fetch Hypixel for coins
      const profiles = await fetchProfiles(mojang.id);
      const profile  = getActive(profiles);
      const member   = getMember(profile, mojang.id);
      const purse    = member ? (member.coin_purse || 0) : 0;
      const bank     = profile ? (profile.banking?.balance || 0) : 0;

      const embed = new EmbedBuilder()
        .setTitle(mojang.name+"'s Networth")
        .setColor(0xFFD700)
        .setThumbnail('https://mc-heads.net/avatar/'+mojang.id);

      if (sc) {
        // Find active profile data from SkyCrypt
        const profileNames = Object.keys(sc.profiles || {});
        let activeProfile = null;
        for (const name of profileNames) {
          if (sc.profiles[name].current) { activeProfile = sc.profiles[name]; break; }
        }
        if (!activeProfile && profileNames.length) activeProfile = sc.profiles[profileNames[0]];

        const nw = activeProfile?.data?.networth;
        if (nw) {
          const total   = nw.networth    || 0;
          const unsoul  = nw.unsoulbound || 0;

          embed.setDescription('**Total Networth: ' + fmt(total) + '**\n*(Unsoulbound: ' + fmt(unsoul) + ')*');

          // Category breakdown
          const cats = nw.categories || {};
          const fields = [
            ['armor',       'Armor'            ],
            ['equipment',   'Equipment'        ],
            ['wardrobe',    'Wardrobe'         ],
            ['inventory',   'Inventory'        ],
            ['ender_chest', 'Ender Chest'      ],
            ['accessories', 'Accessories'      ],
            ['storage',     'Storage'          ],
            ['pets',        'Pets'             ],
            ['fishing_bag', 'Fishing Bag'      ],
            ['potion_bag',  'Potion Bag'       ],
            ['museum',      'Museum'           ],
            ['sacks',       'Sacks'            ],
          ];

          const catLines = fields
            .filter(([k]) => cats[k] && cats[k].total > 0)
            .sort((a, b) => (cats[b[0]]?.total||0) - (cats[a[0]]?.total||0))
            .map(([k, label]) => '**'+label+':** '+fmt(cats[k].total));

          if (catLines.length) {
            // Split into two columns
            const half = Math.ceil(catLines.length / 2);
            embed.addFields(
              { name:'Breakdown', value: catLines.slice(0, half).join('\n') || '-', inline:true },
              { name:'\u200b',    value: catLines.slice(half).join('\n')    || '-', inline:true },
            );
          }

          embed.addFields(
            { name:'💵 Purse', value:fmt(purse), inline:true },
            { name:'🏦 Bank',  value:fmt(bank),  inline:true },
            { name:'💰 Coins', value:fmt(purse+bank), inline:true },
          );

          // Top items if available
          const items = nw.items || [];
          if (items.length) {
            const top5 = items.sort((a,b) => (b.price||0)-(a.price||0)).slice(0,5);
            const topLines = top5.map((it,i) => (i+1)+'. **'+it.name+'** — '+fmt(it.price));
            embed.addFields({ name:'💎 Top Items', value: topLines.join('\n'), inline:false });
          }

        } else {
          // SkyCrypt worked but no networth data
          embed.setDescription('**Liquid Coins: '+fmt(purse+bank)+'**\n\n> SkyCrypt loaded but networth data unavailable for this profile.\n> Check [sky.shiiyu.moe/stats/'+mojang.name+'](https://sky.shiiyu.moe/stats/'+mojang.name+') for full details.')
            .addFields(
              { name:'Purse', value:fmt(purse), inline:true },
              { name:'Bank',  value:fmt(bank),  inline:true },
            );
        }
      } else {
        // SkyCrypt unavailable — show coins only
        embed.setDescription('**Liquid Coins: '+fmt(purse+bank)+'**\n\n> Full item networth temporarily unavailable.\n> Check [sky.shiiyu.moe/stats/'+mojang.name+'](https://sky.shiiyu.moe/stats/'+mojang.name+') for complete breakdown.')
          .addFields(
            { name:'Purse', value:fmt(purse), inline:true },
            { name:'Bank',  value:fmt(bank),  inline:true },
          );
      }

      embed.setFooter({ text:'Powered by SkyCrypt (sky.shiiyu.moe) • Data cached 5 min' }).setTimestamp();
      return interaction.editReply({ embeds:[embed] });
    }

    // /skills
    if (cmd === 'skills') {
      const username = await resolveUser(interaction);
      const mojang   = await fetchMojang(username);
      const profiles = await fetchProfiles(mojang.id);
      const member   = getMember(getActive(profiles), mojang.id);
      if (!member) return interaction.editReply('No Skyblock data found for **'+mojang.name+'**.');
      const list=[['farming',60],['mining',60],['combat',60],['foraging',50],['fishing',50],['enchanting',60],['alchemy',50],['taming',50],['carpentry',50],['runecrafting',25]];
      const lines=list.map(([k,max])=>{
        const xp=member['experience_skill_'+k]||0, lvl=skillLevel(xp,max);
        const bar='█'.repeat(Math.round(lvl/max*10))+'░'.repeat(10-Math.round(lvl/max*10));
        return k.charAt(0).toUpperCase()+k.slice(1)+' — Lvl **'+lvl+'**/'+max+' `'+bar+'` '+fmt(xp)+' XP';
      });
      return interaction.editReply({ embeds:[new EmbedBuilder()
        .setTitle(mojang.name+"'s Skills").setColor(0x00FF88)
        .setThumbnail('https://mc-heads.net/avatar/'+mojang.id)
        .setDescription(lines.join('\n'))
        .addFields({ name:'Skill Average', value:skillAvg(member).toFixed(2), inline:false })
        .setTimestamp()] });
    }

    // /slayer
    if (cmd === 'slayer') {
      const username = await resolveUser(interaction);
      const mojang   = await fetchMojang(username);
      const member   = getMember(getActive(await fetchProfiles(mojang.id)), mojang.id);
      if (!member) return interaction.editReply('No Skyblock data found.');
      const bosses=[['zombie','Revenant Horror',9],['spider','Tarantula Broodfather',9],['wolf','Sven Packmaster',9],['enderman','Voidgloom Seraph',9],['blaze','Inferno Demonlord',9],['vampire','Riftstalker Bloodfiend',5]];
      const sl=member.slayer_bosses||{}; let totalXP=0;
      const lines=bosses.map(([k,name,max])=>{
        const xp=sl[k]?.xp||0; totalXP+=xp; const lvl=slayerLvl(xp,k);
        const bar='█'.repeat(Math.round(lvl/max*10))+'░'.repeat(10-Math.round(lvl/max*10));
        return '**'+name+'** — Lvl **'+lvl+'**/'+max+' `'+bar+'` '+fmt(xp)+' XP';
      });
      return interaction.editReply({ embeds:[new EmbedBuilder()
        .setTitle(mojang.name+"'s Slayer Levels").setColor(0xFF4444)
        .setThumbnail('https://mc-heads.net/avatar/'+mojang.id)
        .setDescription(lines.join('\n'))
        .addFields({ name:'Total Slayer XP', value:fmt(totalXP), inline:false })
        .setTimestamp()] });
    }

    // /dungeons
    if (cmd === 'dungeons') {
      const username = await resolveUser(interaction);
      const mojang   = await fetchMojang(username);
      const member   = getMember(getActive(await fetchProfiles(mojang.id)), mojang.id);
      if (!member) return interaction.editReply('No Skyblock data found.');
      const dg=member.dungeons||{}, ct=dg.dungeon_types?.catacombs||{};
      const cxp=ct.experience||0, total=Object.values(ct.tier_completions||{}).reduce((a,b)=>a+b,0);
      const cls=[['healer','Healer'],['mage','Mage'],['berserk','Berserk'],['archer','Archer'],['tank','Tank']];
      const clLines=cls.map(([k,n])=>'**'+n+'** — Lvl **'+dungLvl(dg.player_classes?.[k]?.experience||0)+'** ('+fmt(dg.player_classes?.[k]?.experience||0)+' XP)');
      return interaction.editReply({ embeds:[new EmbedBuilder()
        .setTitle(mojang.name+"'s Dungeons").setColor(0x8800AA)
        .setThumbnail('https://mc-heads.net/avatar/'+mojang.id)
        .addFields(
          { name:'Catacombs Level',   value:dungLvl(cxp)+' ('+fmt(cxp)+' XP)',          inline:true },
          { name:'Best Floor',        value:'Floor '+(ct.highest_tier_completed??'None'), inline:true },
          { name:'Total Completions', value:String(total),                                inline:true },
          { name:'Class Levels',      value:clLines.join('\n'),                           inline:false },
        ).setTimestamp()] });
    }

    // /profile
    if (cmd === 'profile') {
      const username = await resolveUser(interaction);
      const mojang   = await fetchMojang(username);
      const profiles = await fetchProfiles(mojang.id);
      if (!profiles?.length) return interaction.editReply('No profiles found.');
      const lines=profiles.map((p,i)=>{
        const m=getMember(p,mojang.id), avg=m?skillAvg(m).toFixed(1):'?';
        const cat=dungLvl(m?.dungeons?.dungeon_types?.catacombs?.experience||0);
        return (i+1)+'. **'+p.cute_name+'**'+(p.selected?' (Active)':'')+'\nSkill Avg: '+avg+' | Cata: '+cat;
      });
      return interaction.editReply({ embeds:[new EmbedBuilder()
        .setTitle(mojang.name+"'s Profiles").setColor(0x00CCFF)
        .setThumbnail('https://mc-heads.net/avatar/'+mojang.id)
        .setDescription(lines.join('\n\n')).setTimestamp()] });
    }

    // /compare
    if (cmd === 'compare') {
      const [m1,m2]=await Promise.all([fetchMojang(interaction.options.getString('player1')),fetchMojang(interaction.options.getString('player2'))]);
      const [p1,p2]=await Promise.all([fetchProfiles(m1.id),fetchProfiles(m2.id)]);
      const mm1=getMember(getActive(p1),m1.id), mm2=getMember(getActive(p2),m2.id);
      if (!mm1||!mm2) return interaction.editReply('Could not find data for one or both players.');
      const a1=skillAvg(mm1),a2=skillAvg(mm2);
      const c1=dungLvl(mm1.dungeons?.dungeon_types?.catacombs?.experience||0);
      const c2=dungLvl(mm2.dungeons?.dungeon_types?.catacombs?.experience||0);
      const s1=Object.values(mm1.slayer_bosses||{}).reduce((s,v)=>s+(v.xp||0),0);
      const s2=Object.values(mm2.slayer_bosses||{}).reduce((s,v)=>s+(v.xp||0),0);
      const w=(a,b)=>a>b?' WIN':a<b?' LOSS':' TIE';
      return interaction.editReply({ embeds:[new EmbedBuilder()
        .setTitle(m1.name+' vs '+m2.name).setColor(0xAA00FF)
        .addFields(
          { name:'Skill Average', value:m1.name+': **'+a1.toFixed(2)+'**'+w(a1,a2)+'\n'+m2.name+': **'+a2.toFixed(2)+'**', inline:true },
          { name:'Catacombs',     value:m1.name+': **'+c1+'**'+w(c1,c2)+'\n'+m2.name+': **'+c2+'**',                        inline:true },
          { name:'Slayer XP',     value:m1.name+': **'+fmt(s1)+'**'+w(s1,s2)+'\n'+m2.name+': **'+fmt(s2)+'**',              inline:true },
        ).setTimestamp()] });
    }

    // /bazaar
    if (cmd === 'bazaar') {
      const query=interaction.options.getString('item').toUpperCase().replace(/ /g,'_');
      const products=await fetchBazaar();
      const matches=Object.entries(products).filter(([id])=>id.includes(query)).slice(0,5);
      if (!matches.length) return interaction.editReply('No bazaar item matching `'+query+'`.');
      const embed=new EmbedBuilder().setTitle('Bazaar: '+query).setColor(0xFFAA00).setTimestamp();
      matches.forEach(([id,data])=>{
        const qs=data.quick_status||{};
        const buy=qs.buyPrice?.toFixed(1)||'N/A', sell=qs.sellPrice?.toFixed(1)||'N/A';
        const margin=(qs.buyPrice&&qs.sellPrice)?(qs.buyPrice-qs.sellPrice).toFixed(1):'N/A';
        embed.addFields({ name:id.replace(/_/g,' '), value:'Buy: **'+buy+'** | Sell: **'+sell+'** | Margin: **'+margin+'**\nBuy Vol: '+fmt(qs.buyVolume||0)+' | Sell Vol: '+fmt(qs.sellVolume||0), inline:false });
      });
      return interaction.editReply({ embeds:[embed] });
    }

    // /auction
    if (cmd === 'auction') {
      const query=interaction.options.getString('item').toLowerCase();
      const ahData=await fetchAH();
      if (!ahData.success) return interaction.editReply('Failed to fetch Auction House.');
      const matches=ahData.auctions.filter(a=>!a.claimed&&a.item_name.toLowerCase().includes(query)).sort((a,b)=>a.starting_bid-b.starting_bid).slice(0,8);
      if (!matches.length) return interaction.editReply('No active auctions for `'+query+'`.');
      const embed=new EmbedBuilder().setTitle('Auction House: '+query).setColor(0xAA5500).setFooter({ text:'Total: '+fmt(ahData.totalAuctions) }).setTimestamp();
      matches.forEach(a=>{ const ends=a.end?'<t:'+Math.floor(a.end/1000)+':R>':'Unknown'; embed.addFields({ name:a.item_name+' ['+a.tier+']', value:fmt(a.starting_bid)+' coins | '+(a.bin?'BIN':'Auction')+' | Ends: '+ends, inline:false }); });
      return interaction.editReply({ embeds:[embed] });
    }

    // /mayor
    if (cmd === 'mayor') {
      const data=await fetchMayor(), mayor=data?.mayor;
      if (!mayor) return interaction.editReply('Could not fetch mayor data.');
      const perks=(mayor.perks||[]).map(p=>'**'+p.name+'**\n'+p.description).join('\n\n')||'No perks';
      const embed=new EmbedBuilder().setTitle('Current Mayor: '+mayor.name).setColor(0x0055FF).addFields({ name:'Perks', value:perks, inline:false }).setTimestamp();
      if (data.current?.candidates?.length) {
        const cands=data.current.candidates.sort((a,b)=>b.votes-a.votes).map(c=>'**'+c.name+'** — '+fmt(c.votes)+' votes').join('\n');
        embed.addFields({ name:'Next Election', value:cands, inline:false });
      }
      return interaction.editReply({ embeds:[embed] });
    }

    // /help
    if (cmd === 'help') {
      return interaction.editReply({ embeds:[new EmbedBuilder()
        .setTitle('Hypixel Skyblock Bot — All Commands').setColor(0x00FFFF)
        .setDescription('> **Start here:** Type `/link <yourUsername>` first so you never need to type your name again!')
        .addFields(
          { name:'🔗 Linking',    value:'/link — Link MC account\n/unlink — Remove link\n/whoami — Show link', inline:true },
          { name:'📊 Stats',      value:'/stats\n/networth\n/skills\n/slayer\n/dungeons\n/profile\n/compare', inline:true },
          { name:'🏪 Economy',    value:'/bazaar\n/auction\n/mayor', inline:true },
          { name:'💍 Accessories', value:'/accessories budget\n/accessories milestones\n/accessories list\n/accessories upgrade', inline:false },
          { name:'🔥 Kuudra',     value:'/kuudra setup\n/kuudra profit\n/kuudra requirements\n/kuudra lfg\n/kuudra parties\n/kuudra guide\n/kuudra tiers', inline:false },
        ).setFooter({ text:'Hypixel Skyblock Bot' }).setTimestamp()] });
    }

    // /accessories
    if (cmd === 'accessories') {

      if (sub === 'budget') {
        const budget    = interaction.options.getInteger('budget');
        const goal      = interaction.options.getString('goal');
        const tierLimit = interaction.options.getString('tier_limit') || 'Legendary';
        const targetMP  = interaction.options.getInteger('target_mp') || null;
        const currentMP = interaction.options.getInteger('current_mp') || 0;
        const tOrder    = ['Common','Uncommon','Rare','Epic','Legendary'];
        const maxIdx    = tOrder.indexOf(tierLimit);
        const gCats     = { combat:['Combat'], dungeons:['Dungeons','Combat','Defense'], allround:['Combat','Defense','Utility','Speed'], speed:['Speed','Utility'], gathering:['Mining','Farming','Fishing','Utility'] };
        const wanted    = gCats[goal] || [];

        let sortedAcc = ACC.filter(a => tOrder.indexOf(a.tier) <= maxIdx)
          .map(a => ({ ...a, pri: wanted.includes(a.cat) ? 1 : 2, mppc: a.mp/a.cost }))
          .sort((a,b) => a.pri - b.pri || b.mppc - a.mppc);

        let rem = budget, gained = 0, spent = 0;
        const bought = [];
        const needMP = targetMP ? targetMP - currentMP : Infinity;

        for (const a of sortedAcc) {
          if (targetMP && gained >= needMP) break;
          if (rem >= a.cost) { bought.push(a); rem -= a.cost; gained += a.mp; spent += a.cost; }
        }

        if (!bought.length) return interaction.editReply('Budget of **'+fmt(budget)+'** is too low. Cheapest accessory is ~1,000 coins.');

        const reached = currentMP + gained;
        const reachedTarget = targetMP ? gained >= needMP : true;
        const hittable = MP_MILESTONES.filter(m => m.mp > currentMP && m.mp <= reached);
        const nextMs   = MP_MILESTONES.filter(m => m.mp > reached).slice(0, 3);

        const byCat = {};
        bought.forEach(a => { if (!byCat[a.cat]) byCat[a.cat] = []; byCat[a.cat].push(a); });

        const embed = new EmbedBuilder()
          .setTitle('Accessories Budget Plan').setColor(reachedTarget ? 0x00FF88 : 0xFFAA00)
          .setDescription(
            '**Budget:** '+fmt(budget)+' | **Goal:** '+goal+(targetMP?' | **Target:** '+targetMP+' MP':'')+'\n\n'+
            '✅ Buy **'+bought.length+'** accessories — **'+fmt(spent)+'** coins\n'+
            '✨ MP gain: **+'+gained+'**'+(currentMP?' ('+currentMP+' → **'+reached+'**)':'')+'\n'+
            '💰 Remaining: **'+fmt(rem)+'**'+
            (targetMP && !reachedTarget ? '\n⚠️ Could not fully reach **'+targetMP+' MP** within budget' : '')
          );

        if (hittable.length) embed.addFields({ name:'🎉 Milestones Unlocked', value: hittable.map(m=>'**'+m.mp+' MP** — '+m.bonus).join('\n'), inline:false });
        if (nextMs.length)   embed.addFields({ name:'🎯 Next Milestones', value: nextMs.map(m=>'**'+m.mp+' MP** (need +'+(m.mp-reached)+' more) — '+m.bonus).join('\n'), inline:false });

        const catEntries = Object.entries(byCat).slice(0, 4);
        catEntries.forEach(([cat, items]) => {
          const lines = items.slice(0, 5).map(a => '• **'+a.name+'** — '+fmt(a.cost)+' (+'+a.mp+' MP)').join('\n');
          embed.addFields({ name: cat+' ('+items.length+')', value: lines + (items.length > 5 ? '\n_+' + (items.length-5) + ' more_' : ''), inline: false });
        });

        embed.addFields({ name:'Tips', value:'• Reforge Warped Stone = best MP bonus\n• Recombobulate Legendary accessories\n• Use `/accessories milestones` to see all MP bonuses', inline:false }).setTimestamp();
        return interaction.editReply({ embeds:[embed] });
      }

      if (sub === 'milestones') {
        const total = ACC.reduce((s,a) => s+a.mp, 0);
        return interaction.editReply({ embeds:[new EmbedBuilder()
          .setTitle('✨ Magic Power Milestones').setColor(0xFFAA00)
          .setDescription('Each milestone gives permanent bonus stats.\nMax possible MP from all accessories: **'+total+' MP**\n\n'+MP_MILESTONES.map(m=>'**'+m.mp+' MP** — '+m.bonus).join('\n'))
          .addFields({ name:'How to gain MP fast', value:'• Buy more accessories (each adds MP)\n• Reforge **Warped Stone** for extra MP bonus\n• Recombobulate Legendary accessories\n• Use `/accessories budget` to plan upgrades', inline:false })
          .setTimestamp()] });
      }

      if (sub === 'list') {
        const cat = interaction.options.getString('category');
        const filtered = cat ? ACC.filter(a => a.cat === cat) : ACC.slice(0, 30);
        if (!filtered.length) return interaction.editReply('No accessories found.');
        const grouped = {};
        filtered.forEach(a => { if (!grouped[a.tier]) grouped[a.tier]=[]; grouped[a.tier].push(a); });
        const embed = new EmbedBuilder().setTitle('Accessories — '+(cat||'All')).setColor(0x00FFFF).setTimestamp();
        ['Common','Uncommon','Rare','Epic','Legendary'].forEach(tier => {
          if (!grouped[tier]) return;
          const lines = grouped[tier].map(a=>'• **'+a.name+'** — '+fmt(a.cost)+' | +'+a.mp+' MP | '+a.desc).join('\n');
          if (lines.length > 0) embed.addFields({ name: tier+' ('+grouped[tier].length+')', value: lines.slice(0,1000), inline:false });
        });
        return interaction.editReply({ embeds:[embed] });
      }

      if (sub === 'upgrade') {
        const budget    = interaction.options.getInteger('budget');
        const currentMP = interaction.options.getInteger('current_mp') || 0;
        const sorted    = [...ACC].sort((a,b) => b.mp/b.cost - a.mp/a.cost);
        let rem = budget, totalMP = 0;
        const bought = [];
        for (const a of sorted) { if (rem >= a.cost) { bought.push(a); rem -= a.cost; totalMP += a.mp; } }
        const reached  = currentMP + totalMP;
        const hittable = MP_MILESTONES.filter(m => m.mp > currentMP && m.mp <= reached);
        const next     = MP_MILESTONES.filter(m => m.mp > reached).slice(0, 3);
        const lines    = bought.slice(0,12).map((a,i)=>(i+1)+'. **'+a.name+'** ['+a.tier+'] — '+fmt(a.cost)+' | +'+a.mp+' MP').join('\n');

        const embed = new EmbedBuilder()
          .setTitle('Best MP/Coin Picks for '+fmt(budget)).setColor(0xAA00FF)
          .setDescription('✨ Total MP: **+'+totalMP+'**'+(currentMP?' ('+currentMP+' → **'+reached+'**)':'')+'\n💰 Spent: **'+fmt(budget-rem)+'** | Left: **'+fmt(rem)+'**\n📦 **'+bought.length+'** accessories')
          .addFields({ name:'Top Picks', value: lines || 'None found', inline:false });

        if (hittable.length) embed.addFields({ name:'🎉 Milestones Unlocked', value: hittable.map(m=>'**'+m.mp+' MP** — '+m.bonus).join('\n'), inline:false });
        if (next.length)     embed.addFields({ name:'🎯 Next Milestones', value: next.map(m=>'**'+m.mp+' MP** (need +'+(m.mp-reached)+' more) — '+m.bonus).join('\n'), inline:false });

        embed.addFields({ name:'Tips', value:'• Warped Stone reforge = best MP\n• Recombobulate Legendary for extra MP\n• `/accessories budget <coins> <goal>` for goal-based plan', inline:false }).setTimestamp();
        return interaction.editReply({ embeds:[embed] });
      }
    }

    // /kuudra
    if (cmd === 'kuudra') {

      if (sub === 'setup') {
        const d = TIERS[interaction.options.getString('tier')];
        return interaction.editReply({ embeds:[new EmbedBuilder()
          .setTitle('Kuudra '+d.label+' — Setup').setColor(d.color)
          .addFields(
            { name:'Armor',         value:d.setup.armor,        inline:false },
            { name:'Weapon',        value:d.setup.weapon,       inline:false },
            { name:'Pet',           value:d.setup.pet,          inline:true  },
            { name:'Accessories',   value:d.setup.acc,          inline:false },
            { name:'Reforges',      value:d.setup.reforge,      inline:false },
            { name:'Min EHP',       value:fmt(d.minEHP),        inline:true  },
            { name:'Rec Cata',      value:'Level '+d.recCata+'+',inline:true },
            { name:'Notes',         value:d.setup.notes,        inline:false },
          ).setTimestamp()] });
      }

      if (sub === 'profit') {
        const d=TIERS[interaction.options.getString('tier')], runs=interaction.options.getInteger('runs')||1;
        const loot=d.profit.avgLoot*runs, keys=d.profit.keyCost*runs, net=loot-keys;
        return interaction.editReply({ embeds:[new EmbedBuilder()
          .setTitle('Kuudra '+d.label+' — Profit').setColor(d.color)
          .addFields(
            { name:'Runs',       value:String(runs),             inline:true },
            { name:'Avg Loot',   value:fmt(d.profit.avgLoot),    inline:true },
            { name:'Key Cost',   value:fmt(d.profit.keyCost),    inline:true },
            { name:'Total Loot', value:fmt(loot),                inline:true },
            { name:'Total Keys', value:fmt(keys),                inline:true },
            { name:'Net Profit', value:'**'+fmt(net)+'** coins', inline:true },
            { name:'Est/Hour',   value:'~'+fmt(net*4)+' coins',  inline:false },
          ).setTimestamp()] });
      }

      if (sub === 'requirements') {
        const tier     = interaction.options.getString('tier');
        const d        = TIERS[tier];
        const username = await resolveUser(interaction);
        const mojang   = await fetchMojang(username);
        const member   = getMember(getActive(await fetchProfiles(mojang.id)), mojang.id);
        if (!member) return interaction.editReply('No Skyblock data found.');
        const hp=member.stats?.health||100, def=member.stats?.defense||0, ehp=Math.round(hp*(1+def/100));
        const cata=dungLvl(member.dungeons?.dungeon_types?.catacombs?.experience||0);
        const avg=skillAvg(member);
        const ok1=ehp>=d.minEHP, ok2=cata>=d.recCata, ok3=avg>=30, all=ok1&&ok2&&ok3;
        const t=v=>v?'✅ YES':'❌ NO';
        return interaction.editReply({ embeds:[new EmbedBuilder()
          .setTitle(mojang.name+' — '+d.label+' Readiness').setColor(all?0x00FF44:0xFF4400)
          .setThumbnail('https://mc-heads.net/avatar/'+mojang.id)
          .addFields(
            { name:'EHP (est.) — '+t(ok1),   value:fmt(ehp)+' / '+fmt(d.minEHP)+' required', inline:false },
            { name:'Catacombs — '+t(ok2),     value:cata+' / '+d.recCata+' recommended',       inline:true  },
            { name:'Skill Avg — '+t(ok3),     value:avg.toFixed(1)+' / 30 recommended',        inline:true  },
            { name:'Verdict', value:all?'✅ **READY for '+d.label+'!**':'❌ Not ready. Improve stats marked NO.', inline:false },
          ).setTimestamp()] });
      }

      if (sub === 'lfg') {
        const tier=interaction.options.getString('tier'), role=interaction.options.getString('role');
        const note=interaction.options.getString('note')||'No additional info', d=TIERS[tier], gid=interaction.guildId;
        if (!lfgStore.has(gid)) lfgStore.set(gid,[]);
        const list=lfgStore.get(gid).filter(e=>e.userId!==interaction.user.id);
        list.push({ userId:interaction.user.id, tag:interaction.user.tag, tier, role, note, ts:Date.now() });
        lfgStore.set(gid,list);
        return interaction.editReply({ embeds:[new EmbedBuilder()
          .setTitle('LFG — Kuudra '+d.label).setColor(d.color)
          .setDescription('<@'+interaction.user.id+'> is looking for a Kuudra group!')
          .addFields(
            { name:'Role', value:role,    inline:true },
            { name:'Tier', value:d.label, inline:true },
            { name:'Note', value:note,    inline:false },
          ).setFooter({ text:'Use /kuudra parties to list all. Expires 30 min.' }).setTimestamp()] });
      }

      if (sub === 'parties') {
        const tf=interaction.options.getString('tier')||'all', gid=interaction.guildId, now=Date.now();
        const fresh=(lfgStore.get(gid)||[]).filter(e=>now-e.ts<30*60000);
        lfgStore.set(gid,fresh);
        const filtered=tf==='all'?fresh:fresh.filter(e=>e.tier===tf);
        if (!filtered.length) return interaction.editReply('No active LFG parties. Post one with `/kuudra lfg`!');
        const embed=new EmbedBuilder().setTitle('Active LFG'+(tf!=='all'?' — '+TIERS[tf].label:' — All')).setColor(0xFF6600).setTimestamp();
        filtered.slice(0,10).forEach(e=>embed.addFields({ name:TIERS[e.tier].label+' — '+e.role, value:'<@'+e.userId+'> ('+e.tag+')\n'+e.note+'\n'+Math.round((now-e.ts)/60000)+'m ago', inline:false }));
        return interaction.editReply({ embeds:[embed] });
      }

      if (sub === 'guide') {
        const tier=interaction.options.getString('tier');
        if (tier) {
          const d=TIERS[tier];
          return interaction.editReply({ embeds:[new EmbedBuilder().setTitle('Kuudra '+d.label+' — Guide').setColor(d.color).setDescription(d.guide.join('\n\n')).setTimestamp()] });
        }
        return interaction.editReply({ embeds:[new EmbedBuilder()
          .setTitle('Kuudra — General Guide').setColor(0xFF6600)
          .addFields(
            { name:'Overview', value:'4-player co-op boss on Crimson Isle. 5 tiers: Basic to Infernal.', inline:false },
            { name:'Roles',    value:'Mage — Staff DPS\nBerserk — Melee\nArcher — Ranged\nTank — Absorption\nHealer — Support', inline:false },
            { name:'4 Phases', value:'1. Supply Run\n2. Build + Defend\n3. Ballista + Fight Kuudra\n4. Open Paid Chest', inline:false },
            { name:'Pro Tips', value:'Always open Paid Chest | Attribute Shards best drops\nGod Pots for Fiery+ | Coordinate roles', inline:false },
          ).setTimestamp()] });
      }

      if (sub === 'tiers') {
        const embed=new EmbedBuilder().setTitle('Kuudra — All Tiers').setColor(0xFF6600).setTimestamp();
        Object.entries(TIERS).forEach(([k,d])=>embed.addFields({ name:d.label, value:'Profit: **'+fmt(d.profit.avgLoot-d.profit.keyCost)+'**/run | Min EHP: **'+fmt(d.minEHP)+'** | Cata: **'+d.recCata+'+**', inline:false }));
        return interaction.editReply({ embeds:[embed] });
      }
    }

  } catch(err) {
    console.error('Error:', err.message);
    try { await interaction.editReply('❌ '+( err.message||'Unknown error')); } catch(_){}
  }
});

client.login(DISCORD_TOKEN);
