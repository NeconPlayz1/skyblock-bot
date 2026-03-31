const {
  Client, GatewayIntentBits, REST, Routes,
  SlashCommandBuilder, EmbedBuilder,
} = require("discord.js");
const axios     = require("axios");
const NodeCache = require("node-cache");
const nbt       = require("prismarine-nbt");
const zlib      = require("zlib");
const { promisify } = require("util");
const gunzip    = promisify(zlib.gunzip);

const DISCORD_TOKEN   = process.env.DISCORD_TOKEN;
const CLIENT_ID       = process.env.CLIENT_ID;
const HYPIXEL_API_KEY = process.env.HYPIXEL_API_KEY;

const cache          = new NodeCache({ stdTTL: 300 });
const client         = new Client({ intents: [GatewayIntentBits.Guilds] });
const lfgStore       = new Map();
const linkedAccounts = new Map();

const HAPI = () => ({ headers: { "API-Key": HYPIXEL_API_KEY } });

/* ─── API ───────────────────────────────────────────────────────────────── */

async function fetchMojang(username) {
  const k = "mj_" + username.toLowerCase();
  if (cache.has(k)) return cache.get(k);
  const r = await axios.get("https://playerdb.co/api/player/minecraft/" + username, { timeout: 8000 });
  if (!r.data.success) throw new Error("Player **" + username + "** not found.");
  const v = { id: r.data.data.player.raw_id, name: r.data.data.player.username };
  cache.set(k, v); return v;
}

async function fetchProfiles(uuid) {
  const k = "pr_" + uuid;
  if (cache.has(k)) return cache.get(k);
  const r = await axios.get("https://api.hypixel.net/v2/skyblock/profiles?uuid=" + uuid, HAPI());
  const v = r.data.profiles || [];
  cache.set(k, v); return v;
}

async function fetchBazaar() {
  if (cache.has("bz")) return cache.get("bz");
  const r = await axios.get("https://api.hypixel.net/v2/skyblock/bazaar", HAPI());
  const v = r.data.products || {};
  cache.set("bz", v); return v;
}

async function fetchAH() {
  const r = await axios.get("https://api.hypixel.net/v2/skyblock/auctions?page=0", HAPI());
  return r.data;
}

async function fetchMayor() {
  if (cache.has("mayor")) return cache.get("mayor");
  const r = await axios.get("https://api.hypixel.net/v2/resources/skyblock/election", HAPI());
  cache.set("mayor", r.data); return r.data;
}

function getActive(profiles) {
  if (!profiles || !profiles.length) return null;
  return profiles.find(p => p.selected) || profiles[0];
}
function getMember(profile, uuid) {
  return (profile && profile.members) ? profile.members[uuid] || null : null;
}
async function resolveUser(interaction) {
  const v = interaction.options.getString("username");
  if (v) return v;
  const l = linkedAccounts.get(interaction.user.id);
  if (l) return l;
  throw new Error("No username! Use `/link <username>` once to link your account.");
}

/* ─── NBT PARSER ────────────────────────────────────────────────────────── */

function stripColor(str) {
  return (str || "").replace(/\u00a7./g, "").trim();
}

async function parseNBTItems(b64data) {
  if (!b64data) return [];
  try {
    const buf      = Buffer.from(b64data, "base64");
    const unzipped = await gunzip(buf);
    const result   = await nbt.parse(unzipped);
    const parsed   = result.parsed || result;
    const root     = parsed?.value;
    const rawItems = root?.i?.value?.value || [];
    const out = [];
    for (const item of rawItems) {
      if (!item || item.id == null) continue;
      const tag  = item.tag?.value;
      const ea   = tag?.ExtraAttributes?.value;
      const sbId = ea?.id?.value;
      if (!sbId) continue;
      const rawName = tag?.display?.value?.Name?.value || "";
      const name    = stripColor(rawName) || sbId;
      const count   = item.Count?.value || 1;
      out.push({ id: sbId, name, count });
    }
    return out;
  } catch (e) {
    return [];
  }
}

async function fetchPrices() {
  if (cache.has("prices")) return cache.get("prices");
  const prices = {};

  // Moulberry lowest BIN — best for AH items, public API no auth needed
  try {
    const r = await axios.get("https://moulberry.codes/lowestbin.json", { timeout: 8000 });
    for (const [id, price] of Object.entries(r.data || {})) {
      prices[id] = price;
    }
    console.log("[PRICE] Moulberry:", Object.keys(prices).length, "items");
  } catch(e) { console.log("[PRICE] Moulberry failed:", e.message); }

  // Bazaar prices
  try {
    const bz = await fetchBazaar();
    for (const [id, data] of Object.entries(bz)) {
      const sell = data.quick_status?.sellPrice || 0;
      const buy  = data.quick_status?.buyPrice  || 0;
      const p    = Math.max(sell, buy * 0.9);
      if (p > 0 && (!prices[id] || p > prices[id])) prices[id] = p;
    }
    console.log("[PRICE] Bazaar done");
  } catch(e) { console.log("[PRICE] Bazaar failed:", e.message); }

  cache.set("prices", prices);
  return prices;
}

function getItemPrice(prices, id) {
  if (!id) return 0;
  return prices[id] || prices[id.toUpperCase()] || 0;
}

async function calcNetworth(member, profile) {
  const k = "nw_" + (profile?.profile_id || "x");
  if (cache.has(k)) return cache.get(k);

  const prices = await fetchPrices();
  const purse  = member.coin_purse || member.currencies?.coin_purse || 0;
  const bank   = profile?.banking?.balance || 0;

  // Essence value
  const essTypes = ["WITHER","DIAMOND","DRAGON","SPIDER","UNDEAD","CRIMSON","ICE","GOLD"];
  const essence  = member.essence || {};
  let essVal = 0;
  for (const t of essTypes) {
    essVal += (essence[t]?.current || 0) * (prices["ESSENCE_"+t] || 150);
  }

  // Inventory sections — try all known API paths
  const sections = [
    { keys:["armor_contents","inventory_armor_contents"],  label:"Armor"       },
    { keys:["inv_contents","inventory_contents"],          label:"Items"        },
    { keys:["talisman_bag","accessory_bag_storage"],       label:"Accessories"  },
    { keys:["ender_chest_contents"],                       label:"Ender Chest"  },
    { keys:["wardrobe_contents"],                          label:"Wardrobe"     },
    { keys:["fishing_bag"],                                label:"Fishing Bag"  },
    { keys:["quiver"],                                     label:"Quiver"       },
  ];

  const categories = [];
  let totalItems = 0;

  for (const { keys, label } of sections) {
    let data = null;
    for (const key of keys) {
      const v = member[key];
      if (!v) continue;
      data = v.data || v.inv_data || (typeof v === "string" ? v : null);
      if (data) break;
    }
    if (!data) continue;

    const items  = await parseNBTItems(data);
    const valued = items
      .map(it => ({ ...it, price: getItemPrice(prices, it.id) * (it.count || 1) }))
      .filter(it => it.price > 0)
      .sort((a, b) => b.price - a.price);

    const catTotal = valued.reduce((s, it) => s + it.price, 0);
    if (catTotal <= 0) continue;

    totalItems += catTotal;
    categories.push({ label, total: catTotal, items: valued.slice(0, 5) });
  }

  // Pets
  const pets     = member.pets_data?.pets || member.pets || [];
  let petTotal   = 0;
  const petItems = [];
  for (const pet of pets) {
    const pid    = "PET_" + (pet.type || "").toUpperCase();
    const pPrice = prices[pid] || 0;
    if (pPrice > 0) {
      petTotal += pPrice;
      petItems.push({ name: pet.type + " (Lvl " + (pet.level || "?") + ")", price: pPrice });
    }
  }
  if (petTotal > 0) {
    totalItems += petTotal;
    categories.push({ label:"Pets", total:petTotal, items:petItems.sort((a,b)=>b.price-a.price).slice(0,5) });
  }

  // Backpacks/Storage
  const bps = member.backpack_contents || {};
  let bpTotal = 0;
  for (const bp of Object.values(bps)) {
    const items = await parseNBTItems(bp?.data);
    for (const it of items) bpTotal += getItemPrice(prices, it.id) * (it.count || 1);
  }
  if (bpTotal > 0) {
    totalItems += bpTotal;
    categories.push({ label:"Storage", total:bpTotal, items:[] });
  }

  categories.sort((a, b) => b.total - a.total);

  const total  = purse + bank + essVal + totalItems;
  const result = { total, purse, bank, essVal, totalItems, categories };
  cache.set(k, result);
  return result;
}

/* ─── HELPERS ───────────────────────────────────────────────────────────── */

function fmt(n) {
  if (n == null || isNaN(n) || n === 0) return "0";
  if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return Math.round(n).toLocaleString();
}

/* ─── SKILL ─────────────────────────────────────────────────────────────── */

const SKILL_XP = [0,50,125,200,300,500,750,1000,1500,2000,3500,5000,7500,10000,15000,20000,30000,50000,75000,100000,200000,300000,400000,500000,600000,700000,800000,900000,1000000,1100000,1200000,1300000,1400000,1500000,1600000,1700000,1800000,1900000,2000000,2100000,2200000,2300000,2400000,2500000,2600000,2750000,2900000,3100000,3400000,3700000,4000000,4300000,4600000,5000000,5500000,6000000,6500000,7000000,7500000];

function skillLevel(xp, max) {
  max = max || 60; let lvl = 0, tot = 0;
  for (let i = 0; i < Math.min(max, SKILL_XP.length); i++) {
    if (xp >= tot + SKILL_XP[i]) { tot += SKILL_XP[i]; lvl = i; } else break;
  }
  return lvl;
}
function getSkillXP(member, skillName) {
  const v1 = member["experience_skill_" + skillName];
  if (v1 && v1 > 0) return v1;
  const v2 = member?.player_data?.experience?.["SKILL_" + skillName.toUpperCase()];
  if (v2 && v2 > 0) return v2;
  return 0;
}
function skillAvg(member) {
  const names = ["farming","mining","combat","foraging","fishing","enchanting","alchemy","taming"];
  return names.reduce((s, k) => s + skillLevel(getSkillXP(member, k)), 0) / names.length;
}
function skillsDisabled(member) {
  return ["farming","mining","combat"].every(k => getSkillXP(member, k) === 0);
}

/* ─── SLAYER ────────────────────────────────────────────────────────────── */

const SL_XP = {
  zombie:[0,5,15,200,1000,5000,20000,100000,400000,1000000],
  spider:[0,5,25,200,1000,5000,20000,100000,400000,1000000],
  wolf:[0,10,30,250,1500,5000,20000,100000,400000,1000000],
  enderman:[0,10,30,250,1500,5000,20000,100000,400000,1000000],
  blaze:[0,10,30,250,1500,5000,20000,100000,400000,1000000],
  vampire:[0,20,75,240,840,2400],
};
function slayerLvl(xp, type) {
  const t = SL_XP[type] || []; let l = 0;
  for (let i = 0; i < t.length; i++) { if (xp >= t[i]) l = i; else break; }
  return l;
}
function getSlayerBosses(member) {
  if (member?.slayer_bosses) return member.slayer_bosses;
  if (member?.slayer?.slayer_bosses) return member.slayer.slayer_bosses;
  return {};
}

/* ─── DUNGEONS ──────────────────────────────────────────────────────────── */

const DG_XP = [0,50,75,110,160,230,330,470,670,950,1340,1890,2665,3760,5260,7380,10300,14400,20000,27600,38000,52500,71500,97000,132000,180000,243000,328000,445000,600000,800000,1065000,1410000,1900000,2500000,3300000,4300000,5600000,7200000,9200000,12000000,15000000,19000000,24000000,30000000,38000000,48000000,60000000,75000000,93000000];
function dungLvl(xp) {
  let l = 0, tot = 0;
  for (let i = 0; i < DG_XP.length; i++) { if (xp >= tot + DG_XP[i]) { tot += DG_XP[i]; l = i; } else break; }
  return l;
}

/* ─── ACCESSORIES ───────────────────────────────────────────────────────── */

const MP_MILESTONES = [
  { mp:100, bonus:"+5 Strength, +5 Crit Damage" }, { mp:150, bonus:"+1% Crit Chance" },
  { mp:200, bonus:"+5 Intelligence, +5 Defense" }, { mp:250, bonus:"+1% Crit Chance" },
  { mp:300, bonus:"+5 Strength, +5 Crit Damage" }, { mp:400, bonus:"+5 Speed, +5 Crit Chance" },
  { mp:500, bonus:"+10 Strength, +10 Crit Damage" }, { mp:650, bonus:"+5 Speed, +5 Crit Chance" },
  { mp:800, bonus:"+10 Intelligence, +10 Defense" }, { mp:900, bonus:"+5 Strength, +5 Crit Damage" },
  { mp:1000, bonus:"+10 Strength, +15 Crit Damage, +2% CC" },
];

const ACC = [
  { name:"Speed Talisman",           tier:"Common",    mp:3,  cost:2000,     cat:"Speed"   },
  { name:"Speed Ring",               tier:"Uncommon",  mp:5,  cost:5000,     cat:"Speed"   },
  { name:"Speed Artifact",           tier:"Rare",      mp:8,  cost:25000,    cat:"Speed"   },
  { name:"Candy Talisman",           tier:"Common",    mp:3,  cost:1000,     cat:"Utility" },
  { name:"Potion Affinity Talisman", tier:"Common",    mp:3,  cost:3000,     cat:"Utility" },
  { name:"Feather Talisman",         tier:"Common",    mp:3,  cost:2500,     cat:"Defense" },
  { name:"Feather Ring",             tier:"Uncommon",  mp:5,  cost:8000,     cat:"Defense" },
  { name:"Feather Artifact",         tier:"Rare",      mp:8,  cost:40000,    cat:"Defense" },
  { name:"Intimidation Talisman",    tier:"Common",    mp:3,  cost:4000,     cat:"Combat"  },
  { name:"Intimidation Ring",        tier:"Uncommon",  mp:5,  cost:15000,    cat:"Combat"  },
  { name:"Intimidation Artifact",    tier:"Epic",      mp:12, cost:200000,   cat:"Combat"  },
  { name:"Zombie Talisman",          tier:"Common",    mp:3,  cost:5000,     cat:"Combat"  },
  { name:"Zombie Ring",              tier:"Uncommon",  mp:5,  cost:20000,    cat:"Combat"  },
  { name:"Zombie Artifact",          tier:"Rare",      mp:8,  cost:80000,    cat:"Combat"  },
  { name:"Spider Talisman",          tier:"Uncommon",  mp:5,  cost:10000,    cat:"Combat"  },
  { name:"Spider Ring",              tier:"Rare",      mp:8,  cost:50000,    cat:"Combat"  },
  { name:"Spider Artifact",          tier:"Epic",      mp:12, cost:250000,   cat:"Combat"  },
  { name:"Wolf Talisman",            tier:"Uncommon",  mp:5,  cost:10000,    cat:"Combat"  },
  { name:"Wolf Ring",                tier:"Rare",      mp:8,  cost:50000,    cat:"Combat"  },
  { name:"Wolf Artifact",            tier:"Epic",      mp:12, cost:300000,   cat:"Combat"  },
  { name:"Wither Talisman",          tier:"Rare",      mp:8,  cost:75000,    cat:"Combat"  },
  { name:"Wither Ring",              tier:"Epic",      mp:12, cost:400000,   cat:"Combat"  },
  { name:"Wither Artifact",          tier:"Legendary", mp:16, cost:2000000,  cat:"Combat"  },
  { name:"Crit Talisman",            tier:"Rare",      mp:8,  cost:50000,    cat:"Combat"  },
  { name:"Crit Ring",                tier:"Epic",      mp:12, cost:250000,   cat:"Combat"  },
  { name:"Crit Artifact",            tier:"Legendary", mp:16, cost:2500000,  cat:"Combat"  },
  { name:"Campfire Talisman",        tier:"Common",    mp:3,  cost:2000,     cat:"Utility" },
  { name:"Campfire Badge 5",         tier:"Uncommon",  mp:5,  cost:10000,    cat:"Utility" },
  { name:"Campfire Badge 10",        tier:"Rare",      mp:8,  cost:50000,    cat:"Utility" },
  { name:"Campfire Badge 15",        tier:"Epic",      mp:12, cost:200000,   cat:"Utility" },
  { name:"Campfire Badge 20",        tier:"Legendary", mp:16, cost:1000000,  cat:"Utility" },
  { name:"Experience Artifact",      tier:"Legendary", mp:16, cost:5000000,  cat:"Utility" },
  { name:"Scarf Thesis",             tier:"Legendary", mp:16, cost:10000000, cat:"Dungeons"},
  { name:"Frozen Chicken",           tier:"Common",    mp:3,  cost:1000,     cat:"Utility" },
  { name:"Haste Ring",               tier:"Common",    mp:3,  cost:5000,     cat:"Mining"  },
  { name:"Beacon 1",                 tier:"Common",    mp:3,  cost:10000,    cat:"Utility" },
  { name:"Beacon 2",                 tier:"Uncommon",  mp:5,  cost:50000,    cat:"Utility" },
  { name:"Beacon 3",                 tier:"Rare",      mp:8,  cost:200000,   cat:"Utility" },
  { name:"Beacon 4",                 tier:"Epic",      mp:12, cost:1000000,  cat:"Utility" },
  { name:"Beacon 5",                 tier:"Legendary", mp:16, cost:5000000,  cat:"Utility" },
];

/* ─── KUUDRA ────────────────────────────────────────────────────────────── */

const TIERS = {
  basic:    { label:"Basic (T1)",    color:0x55FF55, minEHP:15000,  recCata:10,  setup:{ armor:"Any Crimson Armor (Hot quality fine)", weapon:"Midas Staff / Spirit Sceptre", pet:"Blaze Lvl 100 or Tiger", acc:"Full Talisman Bag (Common-Rare)", reforge:"Fierce Chest, Necrotic Helm, Bloody Legs/Boots", notes:"Easiest tier. 15k+ EHP and any crimson set." }, profit:{ avgLoot:80000,   keyCost:40000   }, guide:["**Phase 1:** Sprint to supplies, ignore minions.","**Phase 2:** Dump supplies, protect builders.","**Phase 3:** Ballista stuns Kuudra, DPS weak spot.","**Phase 4:** Open paid chest.","**Tip:** Crimson Key required."] },
  hot:      { label:"Hot (T2)",      color:0xFF5555, minEHP:30000,  recCata:15,  setup:{ armor:"Fine or Burning Crimson Armor (full set)", weapon:"Aurora Staff / Starred Midas", pet:"Blaze Lvl 100", acc:"Full Talisman Bag (up to Epic)", reforge:"Fierce Chest, Necrotic Helm, Bloody Legs/Boots", notes:"Aim 30k+ EHP. Swap Boots to Magma Lord if available." }, profit:{ avgLoot:220000,  keyCost:100000  }, guide:["**Phase 1:** Faster supply collection.","**Phase 2:** More minions, one player guard.","**Phase 3:** Kuudra hits harder, dodge.","**Tip:** Mana potions help."] },
  burning:  { label:"Burning (T3)",  color:0xFF8800, minEHP:60000,  recCata:20,  setup:{ armor:"Burning Crimson Armor or better", weapon:"Aurora Staff / Starred Midas", pet:"Blaze Lvl 100 with Tier Boost", acc:"Full Talisman Bag (Epic+), Mana Flask", reforge:"Fierce Chest, Necrotic/Warped Helm, Bloody Legs/Boots", notes:"Need 60k+ EHP. 4M+ HP pool with pots." }, profit:{ avgLoot:650000,  keyCost:300000  }, guide:["**Phase 1:** Speed pot, supplies in 45s.","**Phase 2:** Protect builders aggressively.","**Phase 3:** Ballista needs 2 hits.","**Tip:** God Pot improves DPS."] },
  fiery:    { label:"Fiery (T4)",    color:0xFF2200, minEHP:120000, recCata:25,  setup:{ armor:"Fiery Crimson Armor (all pieces)", weapon:"Infernal/Aurora Staff or Starred Midas", pet:"Blaze Lvl 100 Tier Boost or Black Cat Lvl 100", acc:"Full Talisman Bag (Legendary), Mana Flask", reforge:"Fierce Chest, Necrotic Helm, Bloody Legs/Boots", notes:"Need 120k+ EHP. Overload 5 + God Pot required." }, profit:{ avgLoot:2200000, keyCost:1000000 }, guide:["**Phase 1:** Supply run under 40s.","**Phase 2:** Minion waves, tank/healer needed.","**Phase 3:** Ballista 3 hits, Kuudra AoE.","**Tip:** God Pot mandatory."] },
  infernal: { label:"Infernal (T5)", color:0x8800FF, minEHP:300000, recCata:30,  setup:{ armor:"Infernal Crimson Armor (best quality)", weapon:"Infernal Staff Starred / Shadow Fury", pet:"Blaze Lvl 100 Tier Boost or Ender Dragon Lvl 100", acc:"Fully optimized Talisman Bag (Recombobulated + MP reforged)", reforge:"Fierce Chest, Necrotic Helm, Withered/Bloody Legs/Boots", notes:"Need 300k+ EHP. Overload 5, God Pot, Mana Flask, Adrenaline." }, profit:{ avgLoot:9000000, keyCost:4000000 }, guide:["**Phase 1:** Perfect run under 35s.","**Phase 2:** Extreme minions, coordinate roles.","**Phase 3:** Ballista 4+ hits, constant AoE.","**Phase 4:** Infernal chests drop 10M+ items.","**Tip:** BIS required. One weak player wipes team."] },
};

/* ─── COMMANDS ──────────────────────────────────────────────────────────── */

const TC = [
  { name:"Basic (T1)",   value:"basic"    }, { name:"Hot (T2)",    value:"hot"     },
  { name:"Burning (T3)", value:"burning"  }, { name:"Fiery (T4)",  value:"fiery"   },
  { name:"Infernal (T5)",value:"infernal" },
];
const uOpt = o => o.setName("username").setDescription("Minecraft username (skip if you used /link)").setRequired(false);

const commands = [
  new SlashCommandBuilder().setName("link").setDescription("Link your Minecraft account — do this first!")
    .addStringOption(o => o.setName("username").setDescription("Your Minecraft username").setRequired(true)),
  new SlashCommandBuilder().setName("unlink").setDescription("Unlink your Minecraft account"),
  new SlashCommandBuilder().setName("whoami").setDescription("Show your linked account"),
  new SlashCommandBuilder().setName("stats").setDescription("View a player's Skyblock overview").addStringOption(uOpt),
  new SlashCommandBuilder().setName("networth").setDescription("Full Sky Miner style networth with real item prices").addStringOption(uOpt),
  new SlashCommandBuilder().setName("skills").setDescription("View skill levels").addStringOption(uOpt),
  new SlashCommandBuilder().setName("slayer").setDescription("View slayer boss levels with kill counts").addStringOption(uOpt),
  new SlashCommandBuilder().setName("dungeons").setDescription("View Catacombs stats").addStringOption(uOpt),
  new SlashCommandBuilder().setName("profile").setDescription("Show profile list").addStringOption(uOpt),
  new SlashCommandBuilder().setName("compare").setDescription("Compare two players")
    .addStringOption(o => o.setName("player1").setDescription("First player").setRequired(true))
    .addStringOption(o => o.setName("player2").setDescription("Second player").setRequired(true)),
  new SlashCommandBuilder().setName("bazaar").setDescription("Check Bazaar prices")
    .addStringOption(o => o.setName("item").setDescription("Item ID e.g. ENCHANTED_IRON").setRequired(true)),
  new SlashCommandBuilder().setName("auction").setDescription("Search Auction House")
    .addStringOption(o => o.setName("item").setDescription("Item name").setRequired(true)),
  new SlashCommandBuilder().setName("mayor").setDescription("View current Mayor"),
  new SlashCommandBuilder().setName("help").setDescription("Show all commands"),
  new SlashCommandBuilder().setName("accessories").setDescription("Accessories / talisman tools")
    .addSubcommand(s => s.setName("budget").setDescription("Plan accessories within your budget")
      .addIntegerOption(o => o.setName("budget").setDescription("Your coin budget").setRequired(true).setMinValue(1000))
      .addStringOption(o => o.setName("goal").setDescription("Build goal").setRequired(true).addChoices(
        { name:"Combat DPS", value:"combat" }, { name:"Dungeons", value:"dungeons" },
        { name:"All-round", value:"allround" }, { name:"Speed / QoL", value:"speed" },
        { name:"Mining / Farming", value:"gathering" }))
      .addIntegerOption(o => o.setName("target_mp").setDescription("Target Magic Power").setMinValue(1).setMaxValue(1000))
      .addIntegerOption(o => o.setName("current_mp").setDescription("Your current Magic Power").setMinValue(0))
      .addStringOption(o => o.setName("tier_limit").setDescription("Max talisman tier").addChoices(
        { name:"Common only", value:"Common" }, { name:"Up to Uncommon", value:"Uncommon" },
        { name:"Up to Rare", value:"Rare" }, { name:"Up to Epic", value:"Epic" },
        { name:"Up to Legendary", value:"Legendary" })))
    .addSubcommand(s => s.setName("milestones").setDescription("See all MP milestone bonuses"))
    .addSubcommand(s => s.setName("list").setDescription("Browse accessories by category")
      .addStringOption(o => o.setName("category").setDescription("Category").addChoices(
        { name:"Combat", value:"Combat" }, { name:"Speed", value:"Speed" },
        { name:"Defense", value:"Defense" }, { name:"Dungeons", value:"Dungeons" },
        { name:"Utility", value:"Utility" }, { name:"Mining", value:"Mining" })))
    .addSubcommand(s => s.setName("upgrade").setDescription("Best MP/coin picks within budget")
      .addIntegerOption(o => o.setName("budget").setDescription("Your coin budget").setRequired(true).setMinValue(1000))
      .addIntegerOption(o => o.setName("current_mp").setDescription("Your current MP").setMinValue(0))),
  new SlashCommandBuilder().setName("kuudra").setDescription("All Kuudra commands")
    .addSubcommand(s => s.setName("stats").setDescription("Full Kuudra Gang style player stats")
      .addStringOption(o => o.setName("username").setDescription("Minecraft username (skip if linked)").setRequired(false)))
    .addSubcommand(s => s.setName("setup").setDescription("Best gear setup for a tier")
      .addStringOption(o => o.setName("tier").setDescription("Kuudra tier").setRequired(true).addChoices(...TC)))
    .addSubcommand(s => s.setName("profit").setDescription("Profit calculator")
      .addStringOption(o => o.setName("tier").setDescription("Kuudra tier").setRequired(true).addChoices(...TC))
      .addIntegerOption(o => o.setName("runs").setDescription("Number of runs").setMinValue(1).setMaxValue(10000)))
    .addSubcommand(s => s.setName("requirements").setDescription("Check if player is ready for a tier")
      .addStringOption(o => o.setName("tier").setDescription("Kuudra tier").setRequired(true).addChoices(...TC))
      .addStringOption(o => o.setName("username").setDescription("Minecraft username (skip if linked)").setRequired(false)))
    .addSubcommand(s => s.setName("lfg").setDescription("Post a Looking-for-Group message")
      .addStringOption(o => o.setName("tier").setDescription("Kuudra tier").setRequired(true).addChoices(...TC))
      .addStringOption(o => o.setName("role").setDescription("Your role").setRequired(true).addChoices(
        { name:"Mage", value:"Mage" }, { name:"Berserk", value:"Berserk" },
        { name:"Tank", value:"Tank" }, { name:"Healer", value:"Healer" }, { name:"Archer", value:"Archer" }))
      .addStringOption(o => o.setName("note").setDescription("Extra info").setRequired(false)))
    .addSubcommand(s => s.setName("parties").setDescription("View active LFG parties")
      .addStringOption(o => o.setName("tier").setDescription("Filter by tier").addChoices(...TC, { name:"All Tiers", value:"all" })))
    .addSubcommand(s => s.setName("guide").setDescription("Phase-by-phase strategy guide")
      .addStringOption(o => o.setName("tier").setDescription("Tier guide").addChoices(...TC)))
    .addSubcommand(s => s.setName("tiers").setDescription("Overview of all Kuudra tiers")),
].map(c => c.toJSON());

/* ─── REGISTER ──────────────────────────────────────────────────────────── */

async function registerCommands() {
  const rest = new REST({ version:"10" }).setToken(DISCORD_TOKEN);
  try {
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
    console.log("Registered " + commands.length + " commands!");
  } catch (e) { console.error("Register failed:", e.message); }
}

client.once("ready", async () => {
  console.log("Logged in as " + client.user.tag);
  client.user.setActivity("/help | Skyblock Bot", { type:3 });
  await registerCommands();
});

/* ─── INTERACTIONS ──────────────────────────────────────────────────────── */

client.on("interactionCreate", async interaction => {
  if (!interaction.isChatInputCommand()) return;
  await interaction.deferReply();
  try {
    const cmd = interaction.commandName;
    const sub = interaction.options.getSubcommand(false);

    if (cmd === "link") {
      const mojang = await fetchMojang(interaction.options.getString("username"));
      linkedAccounts.set(interaction.user.id, mojang.name);
      return interaction.editReply({ embeds:[new EmbedBuilder().setTitle("Account Linked!").setColor(0x00FF88).setThumbnail("https://mc-heads.net/avatar/"+mojang.id).setDescription("Linked to **"+mojang.name+"**!\nAll commands now work without typing your username.").setTimestamp()] });
    }

    if (cmd === "unlink") {
      if (!linkedAccounts.has(interaction.user.id)) return interaction.editReply("No linked account found.");
      const old = linkedAccounts.get(interaction.user.id); linkedAccounts.delete(interaction.user.id);
      return interaction.editReply({ embeds:[new EmbedBuilder().setTitle("Account Unlinked").setColor(0xFF4444).setDescription("Unlinked **"+old+"**.").setTimestamp()] });
    }

    if (cmd === "whoami") {
      const l = linkedAccounts.get(interaction.user.id);
      if (!l) return interaction.editReply("No account linked. Use `/link <username>` first!");
      const mojang = await fetchMojang(l);
      return interaction.editReply({ embeds:[new EmbedBuilder().setTitle("Your Linked Account").setColor(0x00AAFF).setThumbnail("https://mc-heads.net/avatar/"+mojang.id).setDescription("Linked to **"+mojang.name+"**").setTimestamp()] });
    }

    if (cmd === "stats") {
      const username = await resolveUser(interaction);
      const mojang   = await fetchMojang(username);
      const profiles = await fetchProfiles(mojang.id);
      const profile  = getActive(profiles);
      const member   = getMember(profile, mojang.id);
      if (!member) return interaction.editReply("No Skyblock data for **"+mojang.name+"**.");

      // v2 API has different paths for some fields — try all known paths
      const purse  = member.coin_purse
                  || member.currencies?.coin_purse
                  || 0;
      const bank   = profile.banking?.balance
                  || member.profile?.bank_account
                  || 0;
      const deaths = member.death_count
                  || member.player_stats?.deaths?.total
                  || member.stats?.deaths
                  || 0;
      const fairy  = member.fairy_souls_collected
                  || member.player_data?.fairy_souls
                  || 0;
      const cataXP = member.dungeons?.dungeon_types?.catacombs?.experience || 0;
      const sl     = getSlayerBosses(member);
      const sxp    = Object.values(sl).reduce((s,v) => s+(v.xp||0), 0);
      const apiOff = skillsDisabled(member);

      // Kuudra completions
      const kuudra  = member.nether_island_player_data?.kuudra_completed_tiers || {};
      const kTotal  = (kuudra.none||0)+(kuudra.hot||0)+(kuudra.burning||0)+(kuudra.fiery||0)+(kuudra.infernal||0);
      const kInfernal = kuudra.infernal || 0;

      return interaction.editReply({ embeds:[new EmbedBuilder()
        .setTitle(mojang.name+"'s Skyblock Stats").setColor(0x00AAFF)
        .setThumbnail("https://mc-heads.net/avatar/"+mojang.id)
        .addFields(
          { name:"Active Profile",   value:profile.cute_name||"Unknown",                 inline:true },
          { name:"Skill Average",    value:apiOff?"API Off":skillAvg(member).toFixed(2), inline:true },
          { name:"Catacombs Level",  value:String(dungLvl(cataXP)),                     inline:true },
          { name:"Purse",            value:fmt(purse),                                   inline:true },
          { name:"Bank",             value:fmt(bank),                                    inline:true },
          { name:"Total Slayer XP",  value:fmt(sxp),                                    inline:true },
          { name:"Deaths",           value:String(deaths),                               inline:true },
          { name:"Fairy Souls",      value:String(fairy),                                inline:true },
          { name:"Profiles",         value:String(profiles.length),                      inline:true },
          { name:"Kuudra Runs",      value:String(kTotal)+" total ("+kInfernal+" Infernal)", inline:true },
          { name:"Mages Rep",        value:fmt(member.nether_island_player_data?.mages_reputation||0), inline:true },
          { name:"Barbarians Rep",   value:fmt(member.nether_island_player_data?.barbarians_reputation||0), inline:true },
        )
        .setFooter({ text:apiOff?"Skills API disabled — enable in Hypixel /api settings":"Hypixel Skyblock Bot" })
        .setTimestamp()] });
    }

    /* /networth — Sky Miner style with real NBT item parsing */
    if (cmd === "networth") {
      const username    = await resolveUser(interaction);
      const mojang      = await fetchMojang(username);
      const profiles    = await fetchProfiles(mojang.id);
      const profile     = getActive(profiles);
      const member      = getMember(profile, mojang.id);
      if (!member) return interaction.editReply("No Skyblock data for **" + mojang.name + "**.");

      const profileName = profile?.cute_name || "Unknown";
      const purse       = member.coin_purse || member.currencies?.coin_purse || 0;
      const bank        = profile?.banking?.balance || 0;

      // Essence value
      const prices      = await fetchPrices();
      const essTypes    = ["WITHER","DIAMOND","DRAGON","SPIDER","UNDEAD","CRIMSON","ICE","GOLD"];
      const essence     = member.essence || {};
      let   essenceVal  = 0;
      const essLines    = [];
      for (const t of essTypes) {
        const amt = essence[t]?.current || 0;
        if (!amt) continue;
        essenceVal += amt * (prices["ESSENCE_"+t] || 150);
        essLines.push(t.charAt(0) + t.slice(1).toLowerCase() + ": " + amt.toLocaleString());
      }

      const nw = await calcNetworth(member, profile);

      // Title description — Sky Miner header
      const descParts = [
        "**Networth: " + nw.total.toLocaleString() + " (" + fmt(nw.total) + ")**",
        "",
        "**Purse:** " + fmt(purse),
        "**Bank:** " + fmt(bank),
      ];
      if (essenceVal > 0) {
        descParts.push("**Essence:** " + fmt(essenceVal));
      }

      const embed = new EmbedBuilder()
        .setTitle(mojang.name + "'s Networth on " + profileName)
        .setColor(0x55AAFF)
        .setThumbnail("https://mc-heads.net/avatar/" + mojang.id)
        .setDescription(descParts.join("\n"))
        .setFooter({ text: "Prices: Bazaar + AH | prismarine-nbt" })
        .setTimestamp();

      // Category fields — Sky Miner item list style
      if (nw.categories.length > 0) {
        for (const cat of nw.categories) {
          if (!cat.total || cat.total <= 0) continue;
          const itemLines = (cat.items || []).map(it => {
            return "\u2022 " + it.name + " (" + fmt(it.price) + ")";
          });
          let fieldVal = "**" + fmt(cat.total) + "**";
          if (itemLines.length > 0) fieldVal += "\n" + itemLines.join("\n");
          if (fieldVal.length > 1024) fieldVal = fieldVal.slice(0, 1021) + "...";
          embed.addFields({ name: cat.label + " (" + fmt(cat.total) + ")", value: fieldVal, inline: false });
        }
      } else {
        embed.addFields({
          name: "Item Breakdown",
          value: "Could not parse inventory items.\nFull details: sky.shiiyu.moe/stats/" + mojang.name,
          inline: false,
        });
      }

      return interaction.editReply({ embeds: [embed] });
    }

        if (cmd === "skills") {
      const username = await resolveUser(interaction);
      const mojang   = await fetchMojang(username);
      const member   = getMember(getActive(await fetchProfiles(mojang.id)), mojang.id);
      if (!member) return interaction.editReply("No Skyblock data for **"+mojang.name+"**.");
      if (skillsDisabled(member)) {
        return interaction.editReply({ embeds:[new EmbedBuilder().setTitle(mojang.name+"'s Skills \u2014 API Disabled").setColor(0xFF8800).setThumbnail("https://mc-heads.net/avatar/"+mojang.id).setDescription("**"+mojang.name+" has their Skills API turned off.**\n\nTo fix: Join Hypixel \u2192 type `/api` \u2192 enable **Skills API**").setTimestamp()] });
      }
      const list=[["farming",60],["mining",60],["combat",60],["foraging",50],["fishing",50],["enchanting",60],["alchemy",50],["taming",50],["carpentry",50],["runecrafting",25]];
      const lines=list.map(([k,max])=>{ const xp=getSkillXP(member,k),lvl=skillLevel(xp,max); const bar="\u2588".repeat(Math.round(lvl/max*10))+"\u2591".repeat(10-Math.round(lvl/max*10)); return k.charAt(0).toUpperCase()+k.slice(1)+" \u2014 Lvl **"+lvl+"**/"+max+" `"+bar+"` "+fmt(xp)+" XP"; });
      return interaction.editReply({ embeds:[new EmbedBuilder().setTitle(mojang.name+"'s Skills").setColor(0x00FF88).setThumbnail("https://mc-heads.net/avatar/"+mojang.id).setDescription(lines.join("\n")).addFields({ name:"Skill Average", value:skillAvg(member).toFixed(2), inline:false }).setTimestamp()] });
    }

    if (cmd === "slayer") {
      const username = await resolveUser(interaction);
      const mojang   = await fetchMojang(username);
      const member   = getMember(getActive(await fetchProfiles(mojang.id)), mojang.id);
      if (!member) return interaction.editReply("No Skyblock data found.");
      const sl=getSlayerBosses(member);
      const bosses=[{ key:"zombie",name:"Revenant Horror",maxLvl:9 },{ key:"spider",name:"Tarantula Broodfather",maxLvl:9 },{ key:"wolf",name:"Sven Packmaster",maxLvl:9 },{ key:"enderman",name:"Voidgloom Seraph",maxLvl:9 },{ key:"blaze",name:"Inferno Demonlord",maxLvl:9 },{ key:"vampire",name:"Riftstalker Bloodfiend",maxLvl:5 }];
      let totalXP=0;
      const lines=bosses.map(({ key,name,maxLvl })=>{ const bd=sl[key]||{},xp=bd.xp||0; totalXP+=xp; const lvl=slayerLvl(xp,key); const bar="\u2588".repeat(Math.round(lvl/maxLvl*10))+"\u2591".repeat(10-Math.round(lvl/maxLvl*10)); const kills=[bd.boss_kills_tier_0||0,bd.boss_kills_tier_1||0,bd.boss_kills_tier_2||0,bd.boss_kills_tier_3||0,bd.boss_kills_tier_4||0].slice(0,maxLvl).map((k,i)=>"T"+(i+1)+": "+k).filter(s=>!s.endsWith(": 0")).join(" | "); return "**"+name+"** \u2014 Lvl **"+lvl+"**/"+maxLvl+" `"+bar+"` "+fmt(xp)+" XP"+(kills?"\n  "+kills:""); });
      return interaction.editReply({ embeds:[new EmbedBuilder().setTitle(mojang.name+"'s Slayer Levels").setColor(0xFF4444).setThumbnail("https://mc-heads.net/avatar/"+mojang.id).setDescription(lines.join("\n\n")).addFields({ name:"Total Slayer XP", value:fmt(totalXP), inline:false }).setTimestamp()] });
    }

    if (cmd === "dungeons") {
      const username = await resolveUser(interaction);
      const mojang   = await fetchMojang(username);
      const member   = getMember(getActive(await fetchProfiles(mojang.id)), mojang.id);
      if (!member) return interaction.editReply("No Skyblock data found.");
      const dg=member.dungeons||{},ct=dg.dungeon_types?.catacombs||{};
      const cxp=ct.experience||0,total=Object.values(ct.tier_completions||{}).reduce((a,b)=>a+b,0);
      const cls=[["healer","Healer"],["mage","Mage"],["berserk","Berserk"],["archer","Archer"],["tank","Tank"]];
      const clLines=cls.map(([k,n])=>"**"+n+"** \u2014 Lvl **"+dungLvl(dg.player_classes?.[k]?.experience||0)+"** ("+fmt(dg.player_classes?.[k]?.experience||0)+" XP)");
      return interaction.editReply({ embeds:[new EmbedBuilder().setTitle(mojang.name+"'s Dungeons").setColor(0x8800AA).setThumbnail("https://mc-heads.net/avatar/"+mojang.id).addFields({ name:"Catacombs Level",value:dungLvl(cxp)+" ("+fmt(cxp)+" XP)",inline:true },{ name:"Best Floor",value:"Floor "+(ct.highest_tier_completed??"None"),inline:true },{ name:"Total Completions",value:String(total),inline:true },{ name:"Class Levels",value:clLines.join("\n"),inline:false }).setTimestamp()] });
    }

    if (cmd === "profile") {
      const username = await resolveUser(interaction);
      const mojang   = await fetchMojang(username);
      const profiles = await fetchProfiles(mojang.id);
      if (!profiles?.length) return interaction.editReply("No profiles found.");
      const lines=profiles.map((p,i)=>{ const m=getMember(p,mojang.id),apiOff=m?skillsDisabled(m):true,avg=m&&!apiOff?skillAvg(m).toFixed(1):"API Off",cat=dungLvl(m?.dungeons?.dungeon_types?.catacombs?.experience||0); return (i+1)+". **"+p.cute_name+"**"+(p.selected?" (Active)":"")+"\nSkill Avg: "+avg+" | Cata: "+cat; });
      return interaction.editReply({ embeds:[new EmbedBuilder().setTitle(mojang.name+"'s Profiles").setColor(0x00CCFF).setThumbnail("https://mc-heads.net/avatar/"+mojang.id).setDescription(lines.join("\n\n")).setTimestamp()] });
    }

    if (cmd === "compare") {
      const [m1,m2]=await Promise.all([fetchMojang(interaction.options.getString("player1")),fetchMojang(interaction.options.getString("player2"))]);
      const [p1,p2]=await Promise.all([fetchProfiles(m1.id),fetchProfiles(m2.id)]);
      const mm1=getMember(getActive(p1),m1.id),mm2=getMember(getActive(p2),m2.id);
      if (!mm1||!mm2) return interaction.editReply("Could not find data for one or both players.");
      const api1=skillsDisabled(mm1),api2=skillsDisabled(mm2),a1=api1?0:skillAvg(mm1),a2=api2?0:skillAvg(mm2);
      const c1=dungLvl(mm1.dungeons?.dungeon_types?.catacombs?.experience||0),c2=dungLvl(mm2.dungeons?.dungeon_types?.catacombs?.experience||0);
      const sl1=getSlayerBosses(mm1),sl2=getSlayerBosses(mm2);
      const s1=Object.values(sl1).reduce((s,v)=>s+(v.xp||0),0),s2=Object.values(sl2).reduce((s,v)=>s+(v.xp||0),0);
      const w=(a,b)=>a>b?" WIN":a<b?" LOSS":" TIE";
      return interaction.editReply({ embeds:[new EmbedBuilder().setTitle(m1.name+" vs "+m2.name).setColor(0xAA00FF).addFields({ name:"Skill Average",value:m1.name+": **"+(api1?"API Off":a1.toFixed(2))+"**"+(api1?"":w(a1,a2))+"\n"+m2.name+": **"+(api2?"API Off":a2.toFixed(2))+"**",inline:true },{ name:"Catacombs",value:m1.name+": **"+c1+"**"+w(c1,c2)+"\n"+m2.name+": **"+c2+"**",inline:true },{ name:"Slayer XP",value:m1.name+": **"+fmt(s1)+"**"+w(s1,s2)+"\n"+m2.name+": **"+fmt(s2)+"**",inline:true }).setTimestamp()] });
    }

    if (cmd === "bazaar") {
      const query=interaction.options.getString("item").toUpperCase().replace(/ /g,"_");
      const products=await fetchBazaar();
      const matches=Object.entries(products).filter(([id])=>id.includes(query)).slice(0,5);
      if (!matches.length) return interaction.editReply("No bazaar item matching `"+query+"`.");
      const embed=new EmbedBuilder().setTitle("Bazaar: "+query).setColor(0xFFAA00).setTimestamp();
      matches.forEach(([id,data])=>{ const qs=data.quick_status||{},buy=qs.buyPrice?.toFixed(1)||"N/A",sell=qs.sellPrice?.toFixed(1)||"N/A",margin=(qs.buyPrice&&qs.sellPrice)?(qs.buyPrice-qs.sellPrice).toFixed(1):"N/A"; embed.addFields({ name:id.replace(/_/g," "),value:"Buy: **"+buy+"** | Sell: **"+sell+"** | Margin: **"+margin+"**\nBuy Vol: "+fmt(qs.buyVolume||0)+" | Sell Vol: "+fmt(qs.sellVolume||0),inline:false }); });
      return interaction.editReply({ embeds:[embed] });
    }

    if (cmd === "auction") {
      const query=interaction.options.getString("item").toLowerCase();
      const ahData=await fetchAH();
      if (!ahData.success) return interaction.editReply("Failed to fetch Auction House.");
      const matches=ahData.auctions.filter(a=>!a.claimed&&a.item_name.toLowerCase().includes(query)).sort((a,b)=>a.starting_bid-b.starting_bid).slice(0,8);
      if (!matches.length) return interaction.editReply("No auctions for `"+query+"`.");
      const embed=new EmbedBuilder().setTitle("Auction House: "+query).setColor(0xAA5500).setFooter({ text:"Total: "+fmt(ahData.totalAuctions) }).setTimestamp();
      matches.forEach(a=>{ const ends=a.end?"<t:"+Math.floor(a.end/1000)+":R>":"Unknown"; embed.addFields({ name:a.item_name+" ["+a.tier+"]",value:fmt(a.starting_bid)+" coins | "+(a.bin?"BIN":"Auction")+" | Ends: "+ends,inline:false }); });
      return interaction.editReply({ embeds:[embed] });
    }

    if (cmd === "mayor") {
      const data=await fetchMayor(),mayor=data?.mayor;
      if (!mayor) return interaction.editReply("Could not fetch mayor data.");
      const perks=(mayor.perks||[]).map(p=>"**"+p.name+"**\n"+p.description).join("\n\n")||"No perks";
      const embed=new EmbedBuilder().setTitle("Current Mayor: "+mayor.name).setColor(0x0055FF).addFields({ name:"Perks",value:perks,inline:false }).setTimestamp();
      if (data.current?.candidates?.length) { const cands=data.current.candidates.sort((a,b)=>b.votes-a.votes).map(c=>"**"+c.name+"** \u2014 "+fmt(c.votes)+" votes").join("\n"); embed.addFields({ name:"Next Election",value:cands,inline:false }); }
      return interaction.editReply({ embeds:[embed] });
    }

    if (cmd === "help") {
      return interaction.editReply({ embeds:[new EmbedBuilder().setTitle("Hypixel Skyblock Bot \u2014 All Commands").setColor(0x00FFFF)
        .setDescription("> **Start here:** Type `/link <yourIGN>` once \u2014 then all commands work without typing your name!")
        .addFields(
          { name:"Linking",     value:"/link\n/unlink\n/whoami",                                                                        inline:true },
          { name:"Stats",       value:"/stats\n/networth\n/skills\n/slayer\n/dungeons\n/profile\n/compare",                            inline:true },
          { name:"Economy",     value:"/bazaar\n/auction\n/mayor",                                                                      inline:true },
          { name:"Accessories", value:"/accessories budget\n/accessories milestones\n/accessories list\n/accessories upgrade",         inline:false },
          { name:"Kuudra",      value:"/kuudra stats\n/kuudra setup\n/kuudra profit\n/kuudra requirements\n/kuudra lfg\n/kuudra parties\n/kuudra guide\n/kuudra tiers", inline:false },
        ).setFooter({ text:"Hypixel Skyblock Bot" }).setTimestamp()] });
    }

    if (cmd === "accessories") {
      if (sub === "budget") {
        const budget=interaction.options.getInteger("budget"),goal=interaction.options.getString("goal"),tierLimit=interaction.options.getString("tier_limit")||"Legendary",targetMP=interaction.options.getInteger("target_mp")||null,currentMP=interaction.options.getInteger("current_mp")||0;
        const tOrder=["Common","Uncommon","Rare","Epic","Legendary"],maxIdx=tOrder.indexOf(tierLimit);
        const gCats={ combat:["Combat"],dungeons:["Dungeons","Combat","Defense"],allround:["Combat","Defense","Utility","Speed"],speed:["Speed","Utility"],gathering:["Mining","Farming","Fishing","Utility"] },wanted=gCats[goal]||[];
        const sortedAcc=ACC.filter(a=>tOrder.indexOf(a.tier)<=maxIdx).map(a=>({ ...a,pri:wanted.includes(a.cat)?1:2,mppc:a.mp/a.cost })).sort((a,b)=>a.pri-b.pri||b.mppc-a.mppc);
        let rem=budget,gained=0,spent=0; const bought=[],needMP=targetMP?targetMP-currentMP:Infinity;
        for (const a of sortedAcc) { if (targetMP&&gained>=needMP) break; if (rem>=a.cost) { bought.push(a);rem-=a.cost;gained+=a.mp;spent+=a.cost; } }
        if (!bought.length) return interaction.editReply("Budget of **"+fmt(budget)+"** is too low. Cheapest is ~1,000 coins.");
        const reached=currentMP+gained,reachedTarget=targetMP?gained>=needMP:true;
        const hittable=MP_MILESTONES.filter(m=>m.mp>currentMP&&m.mp<=reached),nextMs=MP_MILESTONES.filter(m=>m.mp>reached).slice(0,3);
        const byCat={};
        bought.forEach(a=>{ if (!byCat[a.cat]) byCat[a.cat]=[]; byCat[a.cat].push(a); });
        const embed=new EmbedBuilder().setTitle("Accessories Budget Plan").setColor(reachedTarget?0x00FF88:0xFFAA00)
          .setDescription("**Budget:** "+fmt(budget)+" | **Goal:** "+goal+(targetMP?" | **Target:** "+targetMP+" MP":"")+"\n\nBuy **"+bought.length+"** accessories \u2014 **"+fmt(spent)+"** coins\nMP gain: **+"+gained+"**"+(currentMP?" ("+currentMP+" \u2192 **"+reached+"**)":"")+"\nRemaining: **"+fmt(rem)+"**"+(targetMP&&!reachedTarget?"\nCannot fully reach **"+targetMP+" MP** within budget.":""));
        if (hittable.length) embed.addFields({ name:"Milestones Unlocked",value:hittable.map(m=>"**"+m.mp+" MP** \u2014 "+m.bonus).join("\n"),inline:false });
        if (nextMs.length)   embed.addFields({ name:"Next Milestones",    value:nextMs.map(m=>"**"+m.mp+" MP** (need +"+(m.mp-reached)+") \u2014 "+m.bonus).join("\n"),inline:false });
        Object.entries(byCat).slice(0,4).forEach(([cat,items])=>{ const lines=items.slice(0,5).map(a=>"- **"+a.name+"** \u2014 "+fmt(a.cost)+" (+"+a.mp+" MP)").join("\n"); embed.addFields({ name:cat+" ("+items.length+")",value:lines+(items.length>5?"\n+"+(items.length-5)+" more":""),inline:false }); });
        embed.addFields({ name:"Tips",value:"- Warped Stone reforge = best MP\n- Recombobulate Legendary accessories",inline:false }).setTimestamp();
        return interaction.editReply({ embeds:[embed] });
      }
      if (sub === "milestones") {
        return interaction.editReply({ embeds:[new EmbedBuilder().setTitle("Magic Power Milestones").setColor(0xFFAA00).setDescription("Max possible MP: **"+ACC.reduce((s,a)=>s+a.mp,0)+" MP**\n\n"+MP_MILESTONES.map(m=>"**"+m.mp+" MP** \u2014 "+m.bonus).join("\n")).addFields({ name:"How to gain MP",value:"- Buy more accessories\n- Reforge Warped Stone\n- Recombobulate Legendary",inline:false }).setTimestamp()] });
      }
      if (sub === "list") {
        const cat=interaction.options.getString("category"),filtered=cat?ACC.filter(a=>a.cat===cat):ACC.slice(0,25);
        if (!filtered.length) return interaction.editReply("No accessories found.");
        const grouped={};
        filtered.forEach(a=>{ if (!grouped[a.tier]) grouped[a.tier]=[]; grouped[a.tier].push(a); });
        const embed=new EmbedBuilder().setTitle("Accessories \u2014 "+(cat||"All")).setColor(0x00FFFF).setTimestamp();
        ["Common","Uncommon","Rare","Epic","Legendary"].forEach(tier=>{ if (!grouped[tier]||!grouped[tier].length) return; embed.addFields({ name:tier+" ("+grouped[tier].length+")",value:grouped[tier].map(a=>"- **"+a.name+"** \u2014 "+fmt(a.cost)+" | +"+a.mp+" MP").join("\n").slice(0,1000),inline:false }); });
        return interaction.editReply({ embeds:[embed] });
      }
      if (sub === "upgrade") {
        const budget=interaction.options.getInteger("budget"),currentMP=interaction.options.getInteger("current_mp")||0;
        const sorted=[...ACC].sort((a,b)=>(b.mp/b.cost)-(a.mp/a.cost));
        let rem=budget,totalMP=0; const bought=[];
        for (const a of sorted) { if (rem>=a.cost) { bought.push(a);rem-=a.cost;totalMP+=a.mp; } }
        const reached=currentMP+totalMP,hittable=MP_MILESTONES.filter(m=>m.mp>currentMP&&m.mp<=reached),next=MP_MILESTONES.filter(m=>m.mp>reached).slice(0,3);
        const embed=new EmbedBuilder().setTitle("Best MP/Coin Picks for "+fmt(budget)).setColor(0xAA00FF).setDescription("MP gain: **+"+totalMP+"**"+(currentMP?" ("+currentMP+" \u2192 **"+reached+"**)":"")+"\nSpent: **"+fmt(budget-rem)+"** | Left: **"+fmt(rem)+"**\n"+bought.length+" accessories").addFields({ name:"Top Picks",value:bought.slice(0,12).map((a,i)=>(i+1)+". **"+a.name+"** ["+a.tier+"] \u2014 "+fmt(a.cost)+" | +"+a.mp+" MP").join("\n")||"None",inline:false });
        if (hittable.length) embed.addFields({ name:"Milestones Unlocked",value:hittable.map(m=>"**"+m.mp+" MP** \u2014 "+m.bonus).join("\n"),inline:false });
        if (next.length) embed.addFields({ name:"Next Milestones",value:next.map(m=>"**"+m.mp+" MP** (need +"+(m.mp-reached)+") \u2014 "+m.bonus).join("\n"),inline:false });
        embed.addFields({ name:"Tips",value:"- Warped Stone = best MP reforge\n- Recombobulate Legendary",inline:false }).setTimestamp();
        return interaction.editReply({ embeds:[embed] });
      }
    }

    if (cmd === "kuudra") {
      if (sub === "stats") {
        const username=await resolveUser(interaction),mojang=await fetchMojang(username),profiles=await fetchProfiles(mojang.id),profile=getActive(profiles),member=getMember(profile,mojang.id);
        if (!member) return interaction.editReply("No Skyblock data for **"+mojang.name+"**.");
        const pn=profile?.cute_name||"Unknown",kuudra=member.nether_island_player_data?.kuudra_completed_tiers||{};
        const basic=kuudra.none||0,hot=kuudra.hot||0,burning=kuudra.burning||0,fiery=kuudra.fiery||0,infernal=kuudra.infernal||0,totalRuns=basic+hot+burning+fiery+infernal;
        const magesRep=member.nether_island_player_data?.mages_reputation||0,barbsRep=member.nether_island_player_data?.barbarians_reputation||0;
        const mp=member.accessory_bag_storage?.highest_magical_power||0,cataXP=member.dungeons?.dungeon_types?.catacombs?.experience||0,cataLvl=dungLvl(cataXP),apiOff=skillsDisabled(member);
        const sl=getSlayerBosses(member),purse=member.coin_purse||0,bank=profile.banking?.balance||0;
        return interaction.editReply({ embeds:[new EmbedBuilder().setTitle("Kuudra Stats \u2014 "+mojang.name+" on "+pn).setColor(0xFF6600).setThumbnail("https://mc-heads.net/avatar/"+mojang.id)
          .addFields(
            { name:"Kuudra Completions ("+totalRuns+" total)",value:"Basic: **"+basic+"** | Hot: **"+hot+"** | Burning: **"+burning+"**\nFiery: **"+fiery+"** | Infernal: **"+infernal+"**",inline:false },
            { name:"Reputation",value:"Mages: **"+fmt(magesRep)+"**\nBarbarians: **"+fmt(barbsRep)+"**",inline:true },
            { name:"Magical Power",value:mp>0?"**"+mp+"**":"N/A \u2014 check in-game",inline:true },
            { name:"Skills",value:"Cata: **"+cataLvl+"** | Combat: **"+(apiOff?"?":skillLevel(getSkillXP(member,"combat")))+"** | Skill Avg: **"+(apiOff?"?":skillAvg(member).toFixed(1))+"**",inline:false },
            { name:"Slayer Levels",value:"Rev **"+slayerLvl(sl.zombie?.xp||0,"zombie")+"** | Tara **"+slayerLvl(sl.spider?.xp||0,"spider")+"** | Sven **"+slayerLvl(sl.wolf?.xp||0,"wolf")+"**\nEnder **"+slayerLvl(sl.enderman?.xp||0,"enderman")+"** | Blaze **"+slayerLvl(sl.blaze?.xp||0,"blaze")+"** | Vamp **"+slayerLvl(sl.vampire?.xp||0,"vampire")+"**",inline:false },
            { name:"Coins",value:"Purse: **"+fmt(purse)+"** | Bank: **"+fmt(bank)+"**",inline:false },
          ).setFooter({ text:apiOff?"Skills API disabled":"Hypixel Skyblock Bot" }).setTimestamp()] });
      }
      if (sub === "setup") {
        const d=TIERS[interaction.options.getString("tier")];
        return interaction.editReply({ embeds:[new EmbedBuilder().setTitle("Kuudra "+d.label+" \u2014 Setup").setColor(d.color).addFields({ name:"Armor",value:d.setup.armor,inline:false },{ name:"Weapon",value:d.setup.weapon,inline:false },{ name:"Pet",value:d.setup.pet,inline:true },{ name:"Accessories",value:d.setup.acc,inline:false },{ name:"Reforges",value:d.setup.reforge,inline:false },{ name:"Min EHP",value:fmt(d.minEHP),inline:true },{ name:"Rec Cata",value:"Level "+d.recCata+"+",inline:true },{ name:"Notes",value:d.setup.notes,inline:false }).setTimestamp()] });
      }
      if (sub === "profit") {
        const d=TIERS[interaction.options.getString("tier")],runs=interaction.options.getInteger("runs")||1,loot=d.profit.avgLoot*runs,keys=d.profit.keyCost*runs,net=loot-keys;
        return interaction.editReply({ embeds:[new EmbedBuilder().setTitle("Kuudra "+d.label+" \u2014 Profit").setColor(d.color).addFields({ name:"Runs",value:String(runs),inline:true },{ name:"Avg Loot",value:fmt(d.profit.avgLoot),inline:true },{ name:"Key Cost",value:fmt(d.profit.keyCost),inline:true },{ name:"Total Loot",value:fmt(loot),inline:true },{ name:"Total Keys",value:fmt(keys),inline:true },{ name:"Net Profit",value:"**"+fmt(net)+"** coins",inline:true },{ name:"Est/Hour",value:"~"+fmt(net*4)+" coins",inline:false }).setTimestamp()] });
      }
      if (sub === "requirements") {
        const tier=interaction.options.getString("tier"),d=TIERS[tier],username=await resolveUser(interaction),mojang=await fetchMojang(username),member=getMember(getActive(await fetchProfiles(mojang.id)),mojang.id);
        if (!member) return interaction.editReply("No Skyblock data found.");
        const hp=member.stats?.health||100,def=member.stats?.defense||0,ehp=Math.round(hp*(1+def/100)),cata=dungLvl(member.dungeons?.dungeon_types?.catacombs?.experience||0),avg=skillsDisabled(member)?0:skillAvg(member);
        const ok1=ehp>=d.minEHP,ok2=cata>=d.recCata,ok3=avg>=30,all=ok1&&ok2&&ok3,t=v=>v?"YES":"NO";
        return interaction.editReply({ embeds:[new EmbedBuilder().setTitle(mojang.name+" \u2014 "+d.label+" Readiness").setColor(all?0x00FF44:0xFF4400).setThumbnail("https://mc-heads.net/avatar/"+mojang.id).addFields({ name:"EHP (est.) \u2014 "+t(ok1),value:fmt(ehp)+" / "+fmt(d.minEHP)+" required",inline:false },{ name:"Catacombs \u2014 "+t(ok2),value:cata+" / "+d.recCata+" recommended",inline:true },{ name:"Skill Avg \u2014 "+t(ok3),value:(skillsDisabled(member)?"API Off":avg.toFixed(1))+" / 30 recommended",inline:true },{ name:"Verdict",value:all?"READY for "+d.label+"!":"Not ready. Improve stats marked NO.",inline:false }).setTimestamp()] });
      }
      if (sub === "lfg") {
        const tier=interaction.options.getString("tier"),role=interaction.options.getString("role"),note=interaction.options.getString("note")||"No additional info",d=TIERS[tier],gid=interaction.guildId;
        if (!lfgStore.has(gid)) lfgStore.set(gid,[]);
        const list=lfgStore.get(gid).filter(e=>e.userId!==interaction.user.id);
        list.push({ userId:interaction.user.id,tag:interaction.user.tag,tier,role,note,ts:Date.now() });
        lfgStore.set(gid,list);
        return interaction.editReply({ embeds:[new EmbedBuilder().setTitle("LFG \u2014 Kuudra "+d.label).setColor(d.color).setDescription("<@"+interaction.user.id+"> is looking for a Kuudra group!").addFields({ name:"Role",value:role,inline:true },{ name:"Tier",value:d.label,inline:true },{ name:"Note",value:note,inline:false }).setFooter({ text:"Use /kuudra parties to see all. Expires 30 min." }).setTimestamp()] });
      }
      if (sub === "parties") {
        const tf=interaction.options.getString("tier")||"all",gid=interaction.guildId,now=Date.now();
        const fresh=(lfgStore.get(gid)||[]).filter(e=>now-e.ts<30*60000); lfgStore.set(gid,fresh);
        const filtered=tf==="all"?fresh:fresh.filter(e=>e.tier===tf);
        if (!filtered.length) return interaction.editReply("No active LFG parties. Post one with /kuudra lfg!");
        const embed=new EmbedBuilder().setTitle("Active LFG"+(tf!=="all"?" \u2014 "+TIERS[tf].label:" \u2014 All")).setColor(0xFF6600).setTimestamp();
        filtered.slice(0,10).forEach(e=>embed.addFields({ name:TIERS[e.tier].label+" \u2014 "+e.role,value:"<@"+e.userId+"> ("+e.tag+")\n"+e.note+"\n"+Math.round((now-e.ts)/60000)+"m ago",inline:false }));
        return interaction.editReply({ embeds:[embed] });
      }
      if (sub === "guide") {
        const tier=interaction.options.getString("tier");
        if (tier) { const d=TIERS[tier]; return interaction.editReply({ embeds:[new EmbedBuilder().setTitle("Kuudra "+d.label+" \u2014 Guide").setColor(d.color).setDescription(d.guide.join("\n\n")).setTimestamp()] }); }
        return interaction.editReply({ embeds:[new EmbedBuilder().setTitle("Kuudra \u2014 General Guide").setColor(0xFF6600).addFields({ name:"Overview",value:"4-player co-op boss on Crimson Isle. 5 tiers: Basic to Infernal.",inline:false },{ name:"Roles",value:"Mage \u2014 Staff DPS\nBerserk \u2014 Melee\nArcher \u2014 Ranged\nTank \u2014 Absorption\nHealer \u2014 Support",inline:false },{ name:"4 Phases",value:"1. Supply Run\n2. Build + Defend\n3. Ballista + Fight Kuudra\n4. Open Paid Chest",inline:false },{ name:"Pro Tips",value:"Always open Paid Chest | Attribute Shards best drops\nGod Pots for Fiery+ | Coordinate roles",inline:false }).setTimestamp()] });
      }
      if (sub === "tiers") {
        const embed=new EmbedBuilder().setTitle("Kuudra \u2014 All Tiers").setColor(0xFF6600).setTimestamp();
        Object.entries(TIERS).forEach(([k,d])=>embed.addFields({ name:d.label,value:"Profit: **"+fmt(d.profit.avgLoot-d.profit.keyCost)+"**/run | Min EHP: **"+fmt(d.minEHP)+"** | Cata: **"+d.recCata+"+**",inline:false }));
        return interaction.editReply({ embeds:[embed] });
      }
    }

  } catch (err) {
    console.error("Error in /"+interaction.commandName+":", err.message);
    try { await interaction.editReply("Error: "+(err.message||"Unknown error")); } catch(_) {}
  }
});

client.login(DISCORD_TOKEN);
