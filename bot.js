const {
  Client, GatewayIntentBits, REST, Routes,
  SlashCommandBuilder, EmbedBuilder, AttachmentBuilder,
} = require("discord.js");
const axios = require("axios");
const NodeCache = require("node-cache");
const nbt = require("prismarine-nbt");
const zlib = require("zlib");
const { promisify } = require("util");
const gunzip = promisify(zlib.gunzip);
let createCanvas, loadImage;
try {
  const canvas = require("@napi-rs/canvas");
  createCanvas = canvas.createCanvas;
  loadImage = canvas.loadImage;
  console.log("[CANVAS] Loaded successfully");
} catch(e) {
  console.log("[CANVAS] Not available, using embed fallback:", e.message);
}

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const HYPIXEL_API_KEY = process.env.HYPIXEL_API_KEY;

const cache = new NodeCache({ stdTTL: 300 });
const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const lfgStore = new Map();
const linkedAccounts = new Map();
const HAPI = () => ({ headers: { "API-Key": HYPIXEL_API_KEY } });

async function fetchMojang(u) {
  const k = "mj_" + u.toLowerCase(); if (cache.has(k)) return cache.get(k);
  const r = await axios.get("https://playerdb.co/api/player/minecraft/" + u, { timeout: 8000 });
  if (!r.data.success) throw new Error("Player **" + u + "** not found.");
  const v = { id: r.data.data.player.raw_id, name: r.data.data.player.username };
  cache.set(k, v); return v;
}
async function fetchProfiles(uuid) {
  const k = "pr_" + uuid; if (cache.has(k)) return cache.get(k);
  const r = await axios.get("https://api.hypixel.net/v2/skyblock/profiles?uuid=" + uuid, HAPI());
  if (!r.data.success) throw new Error("Hypixel API error! In Minecraft type /api new and update HYPIXEL_API_KEY in Railway Variables.");
  const v = r.data.profiles || []; cache.set(k, v); return v;
}
async function fetchBazaar() {
  if (cache.has("bz")) return cache.get("bz");
  const r = await axios.get("https://api.hypixel.net/v2/skyblock/bazaar", HAPI());
  const v = r.data.products || {}; cache.set("bz", v); return v;
}
async function fetchAH() {
  const r = await axios.get("https://api.hypixel.net/v2/skyblock/auctions?page=0", HAPI()); return r.data;
}
async function fetchMayor() {
  if (cache.has("mayor")) return cache.get("mayor");
  const r = await axios.get("https://api.hypixel.net/v2/resources/skyblock/election", HAPI());
  cache.set("mayor", r.data); return r.data;
}
async function fetchPrices() {
  if (cache.has("prices")) return cache.get("prices");
  const prices = {};
  try {
    const r = await axios.get("https://moulberry.codes/lowestbin.json", { timeout: 8000 });
    for (const [id, p] of Object.entries(r.data || {})) prices[id] = p;
    console.log("[PRICE] Moulberry:", Object.keys(prices).length);
  } catch(e) { console.log("[PRICE] Moulberry failed:", e.message); }
  try {
    const bz = await fetchBazaar();
    for (const [id, d] of Object.entries(bz)) {
      const p = Math.max(d.quick_status?.sellPrice || 0, (d.quick_status?.buyPrice || 0) * 0.9);
      if (p > 0) prices[id] = Math.max(prices[id] || 0, p);
    }
  } catch(e) {}
  cache.set("prices", prices); return prices;
}
function getPrice(prices, id) { if (!id) return 0; return prices[id] || prices[id.toUpperCase()] || 0; }

function stripColor(s) { return (s || "").replace(/\u00a7./g, "").trim(); }
async function parseItems(b64) {
  if (!b64) return [];
  try {
    const { parsed } = await nbt.parse(await gunzip(Buffer.from(b64, "base64")));
    const list = parsed?.value?.i?.value?.value || [];
    return list.map(item => {
      if (!item || item.id == null) return null;
      const tag = item.tag?.value, ea = tag?.ExtraAttributes?.value, id = ea?.id?.value;
      if (!id) return null;
      return {
        id, name: stripColor(tag?.display?.value?.Name?.value) || id,
        count: item.Count?.value || 1,
        stars: Math.max(ea?.upgrade_level?.value || 0, ea?.dungeon_item_level?.value || 0),
        enchCount: Object.keys(ea?.enchantments?.value || {}).length,
        reforge: ea?.modifier?.value || "",
        hpb: ea?.hot_potato_count?.value || 0,
        recomb: (ea?.rarity_upgrades?.value || 0) > 0,
      };
    }).filter(Boolean);
  } catch(e) { return []; }
}

async function calcNetworth(member, profile) {
  const k = "nw_" + (profile?.profile_id || "x");
  if (cache.has(k)) return cache.get(k);
  const prices = await fetchPrices();
  const purse = member.coin_purse || member.currencies?.coin_purse || 0;
  const bank = profile?.banking?.balance || 0;
  const essTypes = ["WITHER","DIAMOND","DRAGON","SPIDER","UNDEAD","CRIMSON","ICE","GOLD"];
  let essVal = 0;
  for (const t of essTypes) essVal += ((member.essence || {})[t]?.current || 0) * (prices["ESSENCE_" + t] || 150);

  function getData(keys) {
    for (const key of keys) {
      const v2 = member?.inventory?.[key]; if (v2?.data) return v2.data; if (typeof v2 === "string") return v2;
      const v1 = member?.[key]; if (v1?.data) return v1.data; if (v1?.inv_data) return v1.inv_data; if (typeof v1 === "string") return v1;
    }
    return null;
  }
  const sections = [
    { label: "Armor",       keys: ["armor_contents", "inv_armor"] },
    { label: "Items",       keys: ["inv_contents", "bag_contents"] },
    { label: "Accessories", keys: ["talisman_bag", "acc_bag"] },
    { label: "Ender Chest", keys: ["ender_chest_contents", "ender_chest"] },
    { label: "Wardrobe",    keys: ["wardrobe_contents", "wardrobe"] },
    { label: "Fishing Bag", keys: ["fishing_bag"] },
    { label: "Quiver",      keys: ["quiver"] },
  ];
  const categories = []; let totalItems = 0;
  for (const { label, keys } of sections) {
    const data = getData(keys); if (!data) continue;
    const items = await parseItems(data);
    const valued = items.map(it => {
      let base = getPrice(prices, it.id); if (base <= 0) return { ...it, price: 0 };
      let mult = 1.0;
      if (it.stars >= 1 && it.stars <= 5) mult = 1 + it.stars * 0.35;
      if (it.stars >= 6 && it.stars <= 10) mult = 2.75 + (it.stars - 5) * 0.5;
      const price = (base * mult + (it.hpb || 0) * 2000000 + (base > 5000000 ? (it.enchCount || 0) * 500000 : 0) + (it.recomb ? 10000000 : 0)) * (it.count || 1);
      return { ...it, price };
    }).filter(it => it.price > 0).sort((a, b) => b.price - a.price);
    const total = valued.reduce((s, it) => s + it.price, 0);
    if (total <= 0) continue;
    totalItems += total;
    categories.push({ label, total, items: valued.slice(0, 5) });
  }
  const pets = member.pets_data?.pets || member.pets || [];
  let petTotal = 0; const petValued = [];
  for (const pet of pets) {
    const p = getPrice(prices, "PET_" + (pet.type || "").toUpperCase());
    if (p > 0) { petTotal += p; petValued.push({ id: "PET_" + pet.type, name: pet.type + " (Lvl " + (pet.level || "?") + ")", price: p, stars: 0, recomb: false }); }
  }
  if (petTotal > 0) { totalItems += petTotal; categories.push({ label: "Pets", total: petTotal, items: petValued.sort((a, b) => b.price - a.price).slice(0, 5) }); }
  let bpTotal = 0;
  for (const bp of Object.values(member?.inventory?.backpack_contents || member?.backpack_contents || {})) {
    for (const it of await parseItems(bp?.data || (typeof bp === "string" ? bp : null))) bpTotal += getPrice(prices, it.id) * it.count;
  }
  if (bpTotal > 0) { totalItems += bpTotal; categories.push({ label: "Storage", total: bpTotal, items: [] }); }
  categories.sort((a, b) => b.total - a.total);
  const total = purse + bank + essVal + totalItems;
  const result = { total, purse, bank, essVal, totalItems, categories };
  cache.set(k, result); return result;
}

function getActive(p) { return p?.find(x => x.selected) || p?.[0] || null; }
function getMember(p, uuid) { return p?.members?.[uuid] || null; }
async function resolveUser(i) {
  const v = i.options.getString("username"); if (v) return v;
  const l = linkedAccounts.get(i.user.id); if (l) return l;
  throw new Error("No username! Use /link <username> to link your account.");
}
function fmt(n) {
  if (!n || isNaN(n)) return "0";
  if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return Math.round(n).toLocaleString();
}

const SKX = [0,50,125,200,300,500,750,1000,1500,2000,3500,5000,7500,10000,15000,20000,30000,50000,75000,100000,200000,300000,400000,500000,600000,700000,800000,900000,1000000,1100000,1200000,1300000,1400000,1500000,1600000,1700000,1800000,1900000,2000000,2100000,2200000,2300000,2400000,2500000,2600000,2750000,2900000,3100000,3400000,3700000,4000000,4300000,4600000,5000000,5500000,6000000,6500000,7000000,7500000];
function skillLvl(xp, max) { max = max || 60; let l = 0, t = 0; for (let i = 0; i < Math.min(max, SKX.length); i++) { if (xp >= t + SKX[i]) { t += SKX[i]; l = i; } else break; } return l; }
function getSkillXP(m, name) { return m["experience_skill_" + name] || m?.player_data?.experience?.["SKILL_" + name.toUpperCase()] || 0; }
function skillAvg(m) { return ["farming","mining","combat","foraging","fishing","enchanting","alchemy","taming"].reduce((s, k) => s + skillLvl(getSkillXP(m, k)), 0) / 8; }
function skillsOff(m) { return ["farming","mining","combat"].every(k => getSkillXP(m, k) === 0); }

const SLX = { zombie:[0,5,15,200,1000,5000,20000,100000,400000,1000000], spider:[0,5,25,200,1000,5000,20000,100000,400000,1000000], wolf:[0,10,30,250,1500,5000,20000,100000,400000,1000000], enderman:[0,10,30,250,1500,5000,20000,100000,400000,1000000], blaze:[0,10,30,250,1500,5000,20000,100000,400000,1000000], vampire:[0,20,75,240,840,2400] };
function slayerLvl(xp, type) { const t = SLX[type] || []; let l = 0; for (let i = 0; i < t.length; i++) { if (xp >= t[i]) l = i; else break; } return l; }
function getSlayers(m) { return m?.slayer_bosses || m?.slayer?.slayer_bosses || {}; }

const DGX = [0,50,75,110,160,230,330,470,670,950,1340,1890,2665,3760,5260,7380,10300,14400,20000,27600,38000,52500,71500,97000,132000,180000,243000,328000,445000,600000,800000,1065000,1410000,1900000,2500000,3300000,4300000,5600000,7200000,9200000,12000000,15000000,19000000,24000000,30000000,38000000,48000000,60000000,75000000,93000000];
function dungLvl(xp) { let l = 0, t = 0; for (let i = 0; i < DGX.length; i++) { if (xp >= t + DGX[i]) { t += DGX[i]; l = i; } else break; } return l; }

function iEmoji(id) {
  id = (id || "").toUpperCase();
  if (["HYPERION","ASTRAEA","SCYLLA","VALKYRIE","SHADOW_FURY"].includes(id)) return "\u2694\uFE0F";
  if (id === "TERMINATOR" || id.includes("_BOW") || id.includes("SHORTBOW")) return "\uD83C\uDFF9";
  if (id.includes("_STAFF") || id.includes("WAND") || id.includes("SCEPTRE") || id.includes("HELLFIRE_ROD")) return "\uD83E\uDE84";
  if (id.includes("_HELMET") || id.includes("_HOOD") || id.includes("_HAT")) return "\uD83E\uDEF3";
  if (id.includes("_CHESTPLATE")) return "\uD83D\uDEE1\uFE0F";
  if (id.includes("_LEGGINGS") || id.includes("_PANTS")) return "\uD83D\uDC56";
  if (id.includes("_BOOTS")) return "\uD83D\uDC62";
  if (id.includes("_SWORD") || id.includes("BLADE") || id.includes("KATANA") || id.includes("CLEAVER")) return "\u2694\uFE0F";
  if (id.includes("_AXE")) return "\uD83E\uDE93";
  if (id.includes("PICKAXE") || id.includes("DRILL")) return "\u26CF\uFE0F";
  if (id.includes("FISHING_ROD") || (id.includes("_ROD") && !id.includes("HELLFIRE"))) return "\uD83C\uDFA3";
  if (id.includes("_HOE")) return "\uD83C\uDF31";
  if (id.includes("POWER_ORB") || id.includes("_ORB")) return "\uD83D\uDD2E";
  if (id.startsWith("PET_")) return "\uD83D\uDC3E";
  if (id.includes("TALISMAN") || id.includes("_RING") || id.includes("ARTIFACT") || id.includes("RELIC")) return "\uD83D\uDC8D";
  if (id.includes("BOOK") || id.includes("TOME")) return "\uD83D\uDCDA";
  return "\uD83D\uDD37";
}
function fmtS(s) { if (!s) return ""; return " " + "\u272B".repeat(Math.min(s, 5)) + "\u2605".repeat(Math.max(0, s - 5)); }


/* ── CANVAS IMAGE GENERATOR ─────────────────────────────────────────────── */

// Register fonts after canvas loads
function setupFonts() {
  if (!createCanvas) return;
  try {
    const { registerFont } = require("@napi-rs/canvas");
    // DejaVu fonts installed via nixpacks.toml
    const paths = [
      "/run/current-system/sw/share/fonts/truetype/dejavu/DejaVuSans.ttf",
      "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
      "/usr/share/fonts/dejavu/DejaVuSans.ttf",
      "/nix/store",
    ];
    let loaded = false;
    for (const p of paths) {
      try {
        const fs = require("fs");
        if (fs.existsSync(p) && p.endsWith(".ttf")) {
          registerFont(p, { family: "DejaVu" });
          console.log("[FONT] Loaded:", p);
          loaded = true;
          break;
        }
      } catch(e) {}
    }
    // Try glob search
    if (!loaded) {
      const { execSync } = require("child_process");
      try {
        const found = execSync("find /nix /usr/share/fonts -name 'DejaVuSans.ttf' 2>/dev/null | head -1").toString().trim();
        if (found) {
          registerFont(found, { family: "DejaVu" });
          console.log("[FONT] Found via search:", found);
        }
      } catch(e) { console.log("[FONT] Search failed:", e.message); }
    }
  } catch(e) { console.log("[FONT] Setup failed:", e.message); }
}

setTimeout(setupFonts, 100);



function fmtPrice(n) {
  if (!n || isNaN(n)) return "0";
  if (n >= 1e9) return (n/1e9).toFixed(2)+"B";
  if (n >= 1e6) return (n/1e6).toFixed(2)+"M";
  if (n >= 1e3) return (n/1e3).toFixed(1)+"K";
  return Math.round(n).toLocaleString();
}

// Item color by category (like Minecraft rarity colors)
function itemColor(id) {
  id = (id||"").toUpperCase();
  if (id.includes("HYPERION")||id.includes("ASTRAEA")||id.includes("SCYLLA")||id.includes("VALKYRIE")||id.includes("SHADOW_FURY")) return "#FF55FF"; // MYTHIC
  if (id.includes("TERMINATOR")||id.includes("_STAFF")||id.includes("HELLFIRE_ROD")) return "#FF55FF";
  if (id.includes("INFERNAL_")) return "#FF5555"; // LEGENDARY-ish
  if (id.includes("FIERY_")||id.includes("BURNING_")) return "#FF8800";
  if (id.includes("_CHESTPLATE")||id.includes("_HELMET")||id.includes("_LEGGINGS")||id.includes("_BOOTS")) return "#5555FF"; // armor
  if (id.includes("_SWORD")||id.includes("BLADE")||id.includes("KATANA")) return "#55FFFF";
  if (id.includes("_BOW")||id.includes("SHORTBOW")) return "#55FF55";
  if (id.startsWith("PET_")) return "#FFAA00";
  if (id.includes("TALISMAN")||id.includes("_RING")||id.includes("ARTIFACT")) return "#AA00AA";
  return "#AAAAAA";
}

// Draw rounded rectangle
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x+r,y); ctx.lineTo(x+w-r,y); ctx.arcTo(x+w,y,x+w,y+r,r);
  ctx.lineTo(x+w,y+h-r); ctx.arcTo(x+w,y+h,x+w-r,y+h,r);
  ctx.lineTo(x+r,y+h); ctx.arcTo(x,y+h,x,y+h-r,r);
  ctx.lineTo(x,y+r); ctx.arcTo(x,y,x+r,y,r);
  ctx.closePath(); ctx.fill();
}

async function generateNetworthImage(mojang, profileName, nw, essVal, essLines) {
  const W = 700;
  const PAD = 14;
  const ITEM_H = 38;
  const ICON = 28;
  const COL_W = Math.floor((W - PAD * 3) / 2);
  const HEADER_H = 145;
  const FONT = "DejaVu, Arial, sans-serif";

  // Calculate column heights
  let lH = 0, rH = 0;
  const lCats = [], rCats = [];
  for (const cat of nw.categories) {
    const h = 32 + (Math.min(cat.items.length, 5) * ITEM_H) + 10;
    if (lH <= rH) { lCats.push(cat); lH += h; }
    else { rCats.push(cat); rH += h; }
  }
  const bodyH = Math.max(lH, rH, 100);
  const H = HEADER_H + bodyH + PAD + 20;

  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d");

  // ── BACKGROUND ──
  ctx.fillStyle = "#111122";
  ctx.fillRect(0, 0, W, H);

  // Header bg
  const hg = ctx.createLinearGradient(0, 0, W, HEADER_H);
  hg.addColorStop(0, "#1c1c3a"); hg.addColorStop(1, "#111122");
  ctx.fillStyle = hg; ctx.fillRect(0, 0, W, HEADER_H);

  // Accent bar
  ctx.fillStyle = "#55AAFF"; ctx.fillRect(0, 0, 4, HEADER_H);

  // ── PLAYER HEAD ──
  try {
    const headImg = await loadImage("https://mc-heads.net/avatar/" + mojang.id + "/48");
    // Clip circle
    ctx.save();
    ctx.beginPath(); ctx.arc(PAD+24, PAD+24, 24, 0, Math.PI*2); ctx.clip();
    ctx.drawImage(headImg, PAD, PAD, 48, 48);
    ctx.restore();
  } catch(e) {
    ctx.fillStyle = "#334455"; ctx.fillRect(PAD, PAD, 48, 48);
  }

  // ── PLAYER NAME ──
  ctx.fillStyle = "#55AAFF";
  ctx.font = "bold 17px " + FONT;
  ctx.fillText(mojang.name + "'s Networth", PAD+58, PAD+20);

  ctx.fillStyle = "#7788aa";
  ctx.font = "13px " + FONT;
  ctx.fillText("Profile: " + profileName, PAD+58, PAD+38);

  // ── TOTAL NW ──
  ctx.fillStyle = "#FFD700";
  ctx.font = "bold 30px " + FONT;
  ctx.fillText(fmtPrice(nw.total), PAD, PAD+90);

  ctx.fillStyle = "#666688";
  ctx.font = "12px " + FONT;
  ctx.fillText("(" + nw.total.toLocaleString() + ")", PAD, PAD+108);

  // ── COINS ROW ──
  const coins = [
    {label:"Purse", val:fmtPrice(nw.purse), color:"#FFD700"},
    {label:"Bank",  val:fmtPrice(nw.bank),  color:"#88AAFF"},
    {label:"Essence", val:essVal>0?fmtPrice(essVal):"0", color:"#AA88FF"},
  ];
  let coinX = PAD;
  for (const c of coins) {
    ctx.fillStyle = "#555577"; ctx.font = "11px " + FONT;
    ctx.fillText(c.label, coinX, PAD+128);
    ctx.fillStyle = c.color; ctx.font = "bold 13px " + FONT;
    ctx.fillText(c.val, coinX, PAD+143);
    coinX += 170;
  }

  // ── DIVIDER ──
  ctx.fillStyle = "#2a2a44"; ctx.fillRect(0, HEADER_H, W, 2);

  // ── DRAW CATEGORY COLUMN ──
  async function drawCol(cats, xOff) {
    let y = HEADER_H + PAD;
    for (const cat of cats) {
      // Category header pill
      ctx.fillStyle = "#1e1e40";
      roundRect(ctx, xOff, y, COL_W, 28, 6);

      ctx.fillStyle = "#ffffff"; ctx.font = "bold 13px " + FONT;
      ctx.fillText(cat.label, xOff+10, y+19);

      ctx.fillStyle = "#FFD700"; ctx.font = "bold 12px " + FONT;
      const tw = ctx.measureText(fmtPrice(cat.total)).width;
      ctx.fillText(fmtPrice(cat.total), xOff+COL_W-tw-8, y+19);

      y += 34;

      for (const it of cat.items.slice(0,5)) {
        // Row bg
        ctx.fillStyle = "rgba(255,255,255,0.025)";
        roundRect(ctx, xOff, y, COL_W, ITEM_H-2, 4);

        // Colored item icon (Minecraft-style colored square)
        const ic = itemColor(it.id);
        ctx.fillStyle = ic+"33"; // transparent bg
        ctx.fillRect(xOff+4, y+4, ICON, ICON);
        ctx.fillStyle = ic;
        ctx.fillRect(xOff+4, y+4, 3, ICON); // left color bar

        // Item icon initial letter
        ctx.fillStyle = ic; ctx.font = "bold 11px " + FONT;
        ctx.fillText(it.name.charAt(0), xOff+12, y+20);

        // Item name
        ctx.fillStyle = "#ddeeff"; ctx.font = "12px " + FONT;
        const maxW = COL_W - ICON - 75;
        let nameStr = it.name;
        if (it.stars) {
          const s1 = it.stars > 5 ? 5 : it.stars;
          const s2 = it.stars > 5 ? it.stars-5 : 0;
          nameStr += " " + "✫".repeat(s1) + "★".repeat(s2);
        }
        while (ctx.measureText(nameStr).width > maxW && nameStr.length > 5) nameStr = nameStr.slice(0,-4)+"...";
        ctx.fillText(nameStr, xOff+ICON+8, y+19);

        // Price
        ctx.fillStyle = "#FFD700"; ctx.font = "bold 11px " + FONT;
        const ps = fmtPrice(it.price);
        const pw = ctx.measureText(ps).width;
        ctx.fillText(ps, xOff+COL_W-pw-5, y+19);

        y += ITEM_H;
      }
      y += 10;
    }
  }

  await drawCol(lCats, PAD);
  await drawCol(rCats, PAD+COL_W+PAD);

  // ── FOOTER ──
  ctx.fillStyle = "#333355"; ctx.font = "10px " + FONT;
  ctx.fillText("Prices: Moulberry BIN + Bazaar  |  Stars & enchants estimated", PAD, H-6);

  return canvas.toBuffer("image/png");
}

const MPMS = [{mp:100,b:"+5 Str, +5 CD"},{mp:150,b:"+1% CC"},{mp:200,b:"+5 Int, +5 Def"},{mp:250,b:"+1% CC"},{mp:300,b:"+5 Str, +5 CD"},{mp:400,b:"+5 Spd, +5 CC"},{mp:500,b:"+10 Str, +10 CD"},{mp:650,b:"+5 Spd, +5 CC"},{mp:800,b:"+10 Int, +10 Def"},{mp:900,b:"+5 Str, +5 CD"},{mp:1000,b:"+10 Str, +15 CD, +2% CC"}];
const ACC = [
  {name:"Speed Talisman",tier:"Common",mp:3,cost:2000,cat:"Speed"},{name:"Speed Ring",tier:"Uncommon",mp:5,cost:5000,cat:"Speed"},{name:"Speed Artifact",tier:"Rare",mp:8,cost:25000,cat:"Speed"},
  {name:"Candy Talisman",tier:"Common",mp:3,cost:1000,cat:"Utility"},{name:"Potion Affinity Talisman",tier:"Common",mp:3,cost:3000,cat:"Utility"},
  {name:"Feather Talisman",tier:"Common",mp:3,cost:2500,cat:"Defense"},{name:"Feather Ring",tier:"Uncommon",mp:5,cost:8000,cat:"Defense"},{name:"Feather Artifact",tier:"Rare",mp:8,cost:40000,cat:"Defense"},
  {name:"Intimidation Talisman",tier:"Common",mp:3,cost:4000,cat:"Combat"},{name:"Intimidation Ring",tier:"Uncommon",mp:5,cost:15000,cat:"Combat"},{name:"Intimidation Artifact",tier:"Epic",mp:12,cost:200000,cat:"Combat"},
  {name:"Zombie Talisman",tier:"Common",mp:3,cost:5000,cat:"Combat"},{name:"Zombie Ring",tier:"Uncommon",mp:5,cost:20000,cat:"Combat"},{name:"Zombie Artifact",tier:"Rare",mp:8,cost:80000,cat:"Combat"},
  {name:"Spider Talisman",tier:"Uncommon",mp:5,cost:10000,cat:"Combat"},{name:"Spider Ring",tier:"Rare",mp:8,cost:50000,cat:"Combat"},{name:"Spider Artifact",tier:"Epic",mp:12,cost:250000,cat:"Combat"},
  {name:"Wolf Talisman",tier:"Uncommon",mp:5,cost:10000,cat:"Combat"},{name:"Wolf Ring",tier:"Rare",mp:8,cost:50000,cat:"Combat"},{name:"Wolf Artifact",tier:"Epic",mp:12,cost:300000,cat:"Combat"},
  {name:"Wither Talisman",tier:"Rare",mp:8,cost:75000,cat:"Combat"},{name:"Wither Ring",tier:"Epic",mp:12,cost:400000,cat:"Combat"},{name:"Wither Artifact",tier:"Legendary",mp:16,cost:2000000,cat:"Combat"},
  {name:"Crit Talisman",tier:"Rare",mp:8,cost:50000,cat:"Combat"},{name:"Crit Ring",tier:"Epic",mp:12,cost:250000,cat:"Combat"},{name:"Crit Artifact",tier:"Legendary",mp:16,cost:2500000,cat:"Combat"},
  {name:"Campfire Talisman",tier:"Common",mp:3,cost:2000,cat:"Utility"},{name:"Campfire Badge 5",tier:"Uncommon",mp:5,cost:10000,cat:"Utility"},{name:"Campfire Badge 10",tier:"Rare",mp:8,cost:50000,cat:"Utility"},{name:"Campfire Badge 15",tier:"Epic",mp:12,cost:200000,cat:"Utility"},{name:"Campfire Badge 20",tier:"Legendary",mp:16,cost:1000000,cat:"Utility"},
  {name:"Experience Artifact",tier:"Legendary",mp:16,cost:5000000,cat:"Utility"},{name:"Scarf Thesis",tier:"Legendary",mp:16,cost:10000000,cat:"Dungeons"},
  {name:"Beacon 1",tier:"Common",mp:3,cost:10000,cat:"Utility"},{name:"Beacon 2",tier:"Uncommon",mp:5,cost:50000,cat:"Utility"},{name:"Beacon 3",tier:"Rare",mp:8,cost:200000,cat:"Utility"},{name:"Beacon 4",tier:"Epic",mp:12,cost:1000000,cat:"Utility"},{name:"Beacon 5",tier:"Legendary",mp:16,cost:5000000,cat:"Utility"},
  {name:"Mine Talisman",tier:"Common",mp:3,cost:2000,cat:"Mining"},{name:"Mine Ring",tier:"Uncommon",mp:5,cost:8000,cat:"Mining"},{name:"Haste Ring",tier:"Common",mp:3,cost:5000,cat:"Mining"},
  {name:"Fishing Talisman",tier:"Uncommon",mp:5,cost:5000,cat:"Fishing"},{name:"Sea Creature Talisman",tier:"Rare",mp:8,cost:30000,cat:"Fishing"},
  {name:"Lava Talisman",tier:"Uncommon",mp:5,cost:10000,cat:"Utility"},{name:"Ancient Rose",tier:"Epic",mp:12,cost:500000,cat:"Combat"},
];
const TIERS = {
  basic:    {label:"Basic (T1)",   color:0x55FF55,minEHP:15000, recCata:10, setup:{armor:"Any Crimson Armor",weapon:"Midas Staff / Spirit Sceptre",pet:"Blaze Lvl 100 or Tiger",acc:"Full Talisman Bag (Common-Rare)",reforge:"Fierce Chest, Necrotic Helm, Bloody Legs/Boots",notes:"Easiest tier. 15k+ EHP."},profit:{avgLoot:80000,keyCost:40000},guide:["**Phase 1:** Sprint to supplies.","**Phase 2:** Dump supplies, protect builders.","**Phase 3:** Ballista stuns Kuudra, DPS weak spot.","**Phase 4:** Open paid chest."]},
  hot:      {label:"Hot (T2)",     color:0xFF5555,minEHP:30000, recCata:15, setup:{armor:"Fine or Burning Crimson Armor",weapon:"Aurora Staff / Starred Midas",pet:"Blaze Lvl 100",acc:"Full Talisman Bag (up to Epic)",reforge:"Fierce Chest, Necrotic Helm, Bloody Legs/Boots",notes:"Aim 30k+ EHP."},profit:{avgLoot:220000,keyCost:100000},guide:["**Phase 1:** Faster supply collection.","**Phase 2:** More minions, one player guard.","**Phase 3:** Dodge projectiles."]},
  burning:  {label:"Burning (T3)", color:0xFF8800,minEHP:60000, recCata:20, setup:{armor:"Burning Crimson Armor or better",weapon:"Aurora Staff / Starred Midas",pet:"Blaze Lvl 100 with Tier Boost",acc:"Full Talisman Bag (Epic+), Mana Flask",reforge:"Fierce Chest, Necrotic/Warped Helm, Bloody Legs/Boots",notes:"Need 60k+ EHP."},profit:{avgLoot:650000,keyCost:300000},guide:["**Phase 1:** Speed pot, supplies in 45s.","**Phase 2:** Protect builders aggressively.","**Phase 3:** Ballista needs 2 hits."]},
  fiery:    {label:"Fiery (T4)",   color:0xFF2200,minEHP:120000,recCata:25, setup:{armor:"Fiery Crimson Armor (all pieces)",weapon:"Infernal/Aurora Staff",pet:"Blaze Lvl 100 Tier Boost or Black Cat Lvl 100",acc:"Full Talisman Bag (Legendary), Mana Flask",reforge:"Fierce Chest, Necrotic Helm, Bloody Legs/Boots",notes:"Need 120k+ EHP. Overload 5 + God Pot."},profit:{avgLoot:2200000,keyCost:1000000},guide:["**Phase 1:** Supply run under 40s.","**Phase 2:** Minion waves, tank/healer needed.","**Phase 3:** Ballista 3 hits."]},
  infernal: {label:"Infernal (T5)",color:0x8800FF,minEHP:300000,recCata:30, setup:{armor:"Infernal Crimson Armor (best quality)",weapon:"Infernal Staff Starred / Shadow Fury",pet:"Blaze Lvl 100 Tier Boost or Ender Dragon Lvl 100",acc:"Fully optimized Talisman Bag (Recombobulated + MP reforged)",reforge:"Fierce Chest, Necrotic Helm, Withered/Bloody Legs/Boots",notes:"Need 300k+ EHP. Overload 5, God Pot, Mana Flask."},profit:{avgLoot:9000000,keyCost:4000000},guide:["**Phase 1:** Perfect run under 35s.","**Phase 2:** Extreme minions, coordinate roles.","**Phase 3:** Ballista 4+ hits, constant AoE.","**Phase 4:** Infernal chests drop 10M+ items."]},
};
const TC = [{name:"Basic (T1)",value:"basic"},{name:"Hot (T2)",value:"hot"},{name:"Burning (T3)",value:"burning"},{name:"Fiery (T4)",value:"fiery"},{name:"Infernal (T5)",value:"infernal"}];
const uOpt = o => o.setName("username").setDescription("Minecraft username (skip if you used /link)").setRequired(false);

const commands = [
  new SlashCommandBuilder().setName("link").setDescription("Link your Minecraft account").addStringOption(o => o.setName("username").setDescription("Your Minecraft username").setRequired(true)),
  new SlashCommandBuilder().setName("unlink").setDescription("Unlink your Minecraft account"),
  new SlashCommandBuilder().setName("whoami").setDescription("Show your linked account"),
  new SlashCommandBuilder().setName("stats").setDescription("Full Skyblock stats overview").addStringOption(uOpt),
  new SlashCommandBuilder().setName("networth").setDescription("Full networth with item breakdown — Sky Miner style").addStringOption(uOpt),
  new SlashCommandBuilder().setName("skills").setDescription("View skill levels with XP bars").addStringOption(uOpt),
  new SlashCommandBuilder().setName("slayer").setDescription("View slayer boss levels with kill counts").addStringOption(uOpt),
  new SlashCommandBuilder().setName("dungeons").setDescription("View Catacombs stats and class levels").addStringOption(uOpt),
  new SlashCommandBuilder().setName("profile").setDescription("Show all profiles with stats").addStringOption(uOpt),
  new SlashCommandBuilder().setName("compare").setDescription("Compare two players side by side")
    .addStringOption(o => o.setName("player1").setDescription("First player").setRequired(true))
    .addStringOption(o => o.setName("player2").setDescription("Second player").setRequired(true)),
  new SlashCommandBuilder().setName("bazaar").setDescription("Check Bazaar buy/sell prices").addStringOption(o => o.setName("item").setDescription("Item ID e.g. ENCHANTED_IRON").setRequired(true)),
  new SlashCommandBuilder().setName("auction").setDescription("Search Auction House").addStringOption(o => o.setName("item").setDescription("Item name").setRequired(true)),
  new SlashCommandBuilder().setName("mayor").setDescription("View current Skyblock Mayor"),
  new SlashCommandBuilder().setName("help").setDescription("Show all commands"),
  new SlashCommandBuilder().setName("accessories").setDescription("Accessories / talisman tools")
    .addSubcommand(s => s.setName("budget").setDescription("Plan accessories within your budget")
      .addIntegerOption(o => o.setName("budget").setDescription("Your coin budget").setRequired(true).setMinValue(1000))
      .addStringOption(o => o.setName("goal").setDescription("Build goal").setRequired(true).addChoices({name:"Combat DPS",value:"combat"},{name:"Dungeons",value:"dungeons"},{name:"All-round",value:"allround"},{name:"Speed / QoL",value:"speed"},{name:"Mining / Farming",value:"gathering"}))
      .addIntegerOption(o => o.setName("target_mp").setDescription("Target Magic Power").setMinValue(1).setMaxValue(1000))
      .addIntegerOption(o => o.setName("current_mp").setDescription("Your current Magic Power").setMinValue(0))
      .addStringOption(o => o.setName("tier_limit").setDescription("Max talisman tier").addChoices({name:"Common only",value:"Common"},{name:"Up to Uncommon",value:"Uncommon"},{name:"Up to Rare",value:"Rare"},{name:"Up to Epic",value:"Epic"},{name:"Up to Legendary",value:"Legendary"})))
    .addSubcommand(s => s.setName("milestones").setDescription("See all MP milestone bonuses"))
    .addSubcommand(s => s.setName("upgrade").setDescription("Best MP/coin picks within budget")
      .addIntegerOption(o => o.setName("budget").setDescription("Your coin budget").setRequired(true).setMinValue(1000))
      .addIntegerOption(o => o.setName("current_mp").setDescription("Your current MP").setMinValue(0))),
  new SlashCommandBuilder().setName("kuudra").setDescription("All Kuudra commands")
    .addSubcommand(s => s.setName("stats").setDescription("Full Kuudra Gang style stats").addStringOption(o => o.setName("username").setDescription("Minecraft username").setRequired(false)))
    .addSubcommand(s => s.setName("setup").setDescription("Best gear setup for a tier").addStringOption(o => o.setName("tier").setDescription("Kuudra tier").setRequired(true).addChoices(...TC)))
    .addSubcommand(s => s.setName("profit").setDescription("Profit calculator").addStringOption(o => o.setName("tier").setDescription("Kuudra tier").setRequired(true).addChoices(...TC)).addIntegerOption(o => o.setName("runs").setDescription("Number of runs").setMinValue(1).setMaxValue(10000)))
    .addSubcommand(s => s.setName("requirements").setDescription("Check if player is ready for a tier").addStringOption(o => o.setName("tier").setDescription("Kuudra tier").setRequired(true).addChoices(...TC)).addStringOption(o => o.setName("username").setDescription("Minecraft username").setRequired(false)))
    .addSubcommand(s => s.setName("lfg").setDescription("Post LFG message").addStringOption(o => o.setName("tier").setDescription("Kuudra tier").setRequired(true).addChoices(...TC)).addStringOption(o => o.setName("role").setDescription("Your role").setRequired(true).addChoices({name:"Mage",value:"Mage"},{name:"Berserk",value:"Berserk"},{name:"Tank",value:"Tank"},{name:"Healer",value:"Healer"},{name:"Archer",value:"Archer"})).addStringOption(o => o.setName("note").setDescription("Extra info").setRequired(false)))
    .addSubcommand(s => s.setName("parties").setDescription("View active LFG parties").addStringOption(o => o.setName("tier").setDescription("Filter by tier").addChoices(...TC, {name:"All Tiers",value:"all"})))
    .addSubcommand(s => s.setName("guide").setDescription("Phase-by-phase strategy guide").addStringOption(o => o.setName("tier").setDescription("Tier guide").addChoices(...TC)))
    .addSubcommand(s => s.setName("tiers").setDescription("Overview of all Kuudra tiers")),
].map(c => c.toJSON());

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);
  try { await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands }); console.log("Registered " + commands.length + " commands!"); }
  catch(e) { console.error("Register failed:", e.message); }
}
client.once("ready", async () => {
  console.log("Logged in as " + client.user.tag);
  client.user.setActivity("/help | Skyblock Bot", { type: 3 });
  await registerCommands();
});

client.on("interactionCreate", async interaction => {
  if (!interaction.isChatInputCommand()) return;
  await interaction.deferReply();
  try {
    const cmd = interaction.commandName;
    const sub = interaction.options.getSubcommand(false);

    if (cmd === "link") {
      const m = await fetchMojang(interaction.options.getString("username"));
      linkedAccounts.set(interaction.user.id, m.name);
      return interaction.editReply({ embeds: [new EmbedBuilder().setTitle("Account Linked!").setColor(0x00FF88).setThumbnail("https://mc-heads.net/avatar/" + m.id).setDescription("Linked to **" + m.name + "**!\nAll commands now work without typing your username.").setTimestamp()] });
    }
    if (cmd === "unlink") {
      if (!linkedAccounts.has(interaction.user.id)) return interaction.editReply("No linked account found.");
      const old = linkedAccounts.get(interaction.user.id); linkedAccounts.delete(interaction.user.id);
      return interaction.editReply({ embeds: [new EmbedBuilder().setTitle("Account Unlinked").setColor(0xFF4444).setDescription("Unlinked **" + old + "**.").setTimestamp()] });
    }
    if (cmd === "whoami") {
      const l = linkedAccounts.get(interaction.user.id);
      if (!l) return interaction.editReply("No account linked. Use /link <username> first!");
      const m = await fetchMojang(l);
      return interaction.editReply({ embeds: [new EmbedBuilder().setTitle("Your Linked Account").setColor(0x00AAFF).setThumbnail("https://mc-heads.net/avatar/" + m.id).setDescription("Linked to **" + m.name + "**").setTimestamp()] });
    }

    if (cmd === "stats") {
      const username = await resolveUser(interaction);
      const mojang = await fetchMojang(username);
      const profiles = await fetchProfiles(mojang.id);
      const profile = getActive(profiles);
      const member = getMember(profile, mojang.id);
      if (!member) return interaction.editReply("No Skyblock data for **" + mojang.name + "**.");
      const purse = member.coin_purse || member.currencies?.coin_purse || 0;
      const bank = profile.banking?.balance || 0;
      const deaths = member.death_count || member.player_stats?.deaths?.total || 0;
      const fairy = member.fairy_souls_collected || member.player_data?.fairy_souls || 0;
      const cataXP = member.dungeons?.dungeon_types?.catacombs?.experience || 0;
      const sl = getSlayers(member);
      const sxp = Object.values(sl).reduce((s, v) => s + (v.xp || 0), 0);
      const apiOff = skillsOff(member);
      const kuudra = member.nether_island_player_data?.kuudra_completed_tiers || {};
      const kTotal = (kuudra.none||0)+(kuudra.hot||0)+(kuudra.burning||0)+(kuudra.fiery||0)+(kuudra.infernal||0);
      const mp = member.accessory_bag_storage?.highest_magical_power || 0;
      return interaction.editReply({ embeds: [new EmbedBuilder()
        .setTitle(mojang.name + "'s Skyblock Stats").setColor(0x00AAFF)
        .setThumbnail("https://mc-heads.net/avatar/" + mojang.id)
        .addFields(
          {name:"Profile",value:profile.cute_name||"Unknown",inline:true},
          {name:"Skill Average",value:apiOff?"API Off":skillAvg(member).toFixed(2),inline:true},
          {name:"Catacombs",value:"Lvl "+dungLvl(cataXP),inline:true},
          {name:"Purse",value:fmt(purse),inline:true},
          {name:"Bank",value:fmt(bank),inline:true},
          {name:"Slayer XP",value:fmt(sxp),inline:true},
          {name:"Deaths",value:String(deaths),inline:true},
          {name:"Fairy Souls",value:String(fairy),inline:true},
          {name:"Magical Power",value:mp>0?String(mp):"N/A",inline:true},
          {name:"Kuudra Runs",value:String(kTotal)+" total ("+(kuudra.infernal||0)+" Infernal)",inline:true},
          {name:"Mages Rep",value:fmt(member.nether_island_player_data?.mages_reputation||0),inline:true},
          {name:"Barbarians Rep",value:fmt(member.nether_island_player_data?.barbarians_reputation||0),inline:true},
        )
        .setFooter({text:apiOff?"Skills API off - enable in Hypixel /api settings":"Hypixel Skyblock Bot"})
        .setTimestamp()] });
    }

    if (cmd === "networth") {
      const username = await resolveUser(interaction);
      const mojang   = await fetchMojang(username);
      const profiles = await fetchProfiles(mojang.id);
      const profile  = getActive(profiles);
      const member   = getMember(profile, mojang.id);
      if (!member) return interaction.editReply("No Skyblock data for **" + mojang.name + "**.");

      const profileName = profile?.cute_name || "Unknown";
      const nw = await calcNetworth(member, profile);

      // Essence
      const essTypes = ["WITHER","DIAMOND","DRAGON","SPIDER","UNDEAD","CRIMSON","ICE","GOLD"];
      const ess = member.essence || {};
      let essVal = 0; const essLines = [];
      for (const t of essTypes) {
        const amt = ess[t]?.current || 0;
        if (amt > 0) { essVal += amt * 150; essLines.push(t.charAt(0)+t.slice(1).toLowerCase()+": "+amt.toLocaleString()); }
      }

      // Try canvas image first
      if (createCanvas && loadImage) {
        try {
          const imgBuf = await generateNetworthImage(mojang, profileName, nw, essVal, essLines);
          const attach = new AttachmentBuilder(imgBuf, { name: "networth.png" });
          return interaction.editReply({ content: "**" + mojang.name + "'s Networth** — **" + fmt(nw.total) + "**", files: [attach] });
        } catch(imgErr) {
          console.error("[NW IMAGE]", imgErr.message);
        }
      }

      // Fallback embed
      const headerLines = [
        "Networth: **" + nw.total.toLocaleString() + " (" + fmt(nw.total) + ")**",
        "",
        "\uD83D\uDCB0 **Purse**", fmt(nw.purse),
        "",
        "\uD83C\uDFE6 **Bank**", fmt(nw.bank),
      ];
      if (essVal > 0) {
        headerLines.push("", "\u26AB **Essence**", fmt(essVal) + (essLines.length ? " (" + essLines.slice(0,3).join(", ") + (essLines.length>3?" +more":"") + ")" : ""));
      }
      const embed = new EmbedBuilder()
        .setTitle(mojang.name + "'s Networth on " + profileName)
        .setColor(0x55AAFF).setThumbnail("https://mc-heads.net/avatar/" + mojang.id)
        .setDescription(headerLines.join("\n"))
        .setFooter({text:"Prices: Moulberry BIN + Bazaar | Stars & enchants estimated"})
        .setTimestamp();
      for (const cat of nw.categories) {
        if (!cat.total || cat.total <= 0) continue;
        const lines = (cat.items||[]).map(it => {
          const stars = it.stars ? " " + "\u272B".repeat(Math.min(it.stars,5)) + "\u2605".repeat(Math.max(0,it.stars-5)) : "";
          const rc = it.recomb ? " \uD83E\uDDF1" : "";
          const p = it.price>=1e9?(it.price/1e9).toFixed(2)+"B":it.price>=1e6?(it.price/1e6).toFixed(2)+"M":it.price>=1e3?(it.price/1e3).toFixed(1)+"K":Math.round(it.price).toLocaleString();
          return iEmoji(it.id)+" "+it.name+stars+rc+" **("+p+")**";
        });
        let val = lines.join("\n") || fmt(cat.total);
        if (val.length > 1024) val = val.slice(0,1021)+"...";
        embed.addFields({name:"**"+cat.label+" ("+fmt(cat.total)+")**", value:val, inline:false});
      }
      return interaction.editReply({embeds:[embed]});
    }
    if (cmd === "skills") {
      const username = await resolveUser(interaction);
      const mojang = await fetchMojang(username);
      const member = getMember(getActive(await fetchProfiles(mojang.id)), mojang.id);
      if (!member) return interaction.editReply("No Skyblock data for **" + mojang.name + "**.");
      if (skillsOff(member)) return interaction.editReply({embeds:[new EmbedBuilder().setTitle(mojang.name+"'s Skills - API Disabled").setColor(0xFF8800).setThumbnail("https://mc-heads.net/avatar/"+mojang.id).setDescription("**Skills API is turned off.**\n\nFix: Join Hypixel -> type /api -> enable **Skills API**").setTimestamp()]});
      const list = [["farming",60],["mining",60],["combat",60],["foraging",50],["fishing",50],["enchanting",60],["alchemy",50],["taming",50],["carpentry",50],["runecrafting",25]];
      const lines = list.map(([k,max]) => {
        const xp = getSkillXP(member,k), lvl = skillLvl(xp,max);
        const bar = "\u2588".repeat(Math.round(lvl/max*10)) + "\u2591".repeat(10-Math.round(lvl/max*10));
        return k.charAt(0).toUpperCase()+k.slice(1)+" - Lvl **"+lvl+"**/"+max+" `"+bar+"` "+fmt(xp)+" XP";
      });
      return interaction.editReply({embeds:[new EmbedBuilder().setTitle(mojang.name+"'s Skills").setColor(0x00FF88).setThumbnail("https://mc-heads.net/avatar/"+mojang.id).setDescription(lines.join("\n")).addFields({name:"Skill Average",value:skillAvg(member).toFixed(2),inline:false}).setTimestamp()]});
    }

    if (cmd === "slayer") {
      const username = await resolveUser(interaction);
      const mojang = await fetchMojang(username);
      const member = getMember(getActive(await fetchProfiles(mojang.id)), mojang.id);
      if (!member) return interaction.editReply("No Skyblock data found.");
      const sl = getSlayers(member);
      const bosses = [{key:"zombie",name:"Revenant Horror",max:9},{key:"spider",name:"Tarantula Broodfather",max:9},{key:"wolf",name:"Sven Packmaster",max:9},{key:"enderman",name:"Voidgloom Seraph",max:9},{key:"blaze",name:"Inferno Demonlord",max:9},{key:"vampire",name:"Riftstalker Bloodfiend",max:5}];
      let totalXP = 0;
      const lines = bosses.map(({key,name,max}) => {
        const bd=sl[key]||{},xp=bd.xp||0; totalXP+=xp;
        const lvl=slayerLvl(xp,key);
        const bar="\u2588".repeat(Math.round(lvl/max*10))+"\u2591".repeat(10-Math.round(lvl/max*10));
        const kills=[0,1,2,3,4].slice(0,max).map(i=>"T"+(i+1)+": "+(bd["boss_kills_tier_"+i]||0)).filter(s=>!s.endsWith(": 0")).join(" | ");
        return "**"+name+"** - Lvl **"+lvl+"**/"+max+" `"+bar+"` "+fmt(xp)+" XP"+(kills?"\n  "+kills:"");
      });
      return interaction.editReply({embeds:[new EmbedBuilder().setTitle(mojang.name+"'s Slayer Levels").setColor(0xFF4444).setThumbnail("https://mc-heads.net/avatar/"+mojang.id).setDescription(lines.join("\n\n")).addFields({name:"Total Slayer XP",value:fmt(totalXP),inline:false}).setTimestamp()]});
    }

    if (cmd === "dungeons") {
      const username = await resolveUser(interaction);
      const mojang = await fetchMojang(username);
      const member = getMember(getActive(await fetchProfiles(mojang.id)), mojang.id);
      if (!member) return interaction.editReply("No Skyblock data found.");
      const dg=member.dungeons||{},ct=dg.dungeon_types?.catacombs||{};
      const cxp=ct.experience||0,total=Object.values(ct.tier_completions||{}).reduce((a,b)=>a+b,0);
      const cls=[["healer","Healer"],["mage","Mage"],["berserk","Berserk"],["archer","Archer"],["tank","Tank"]];
      const clLines=cls.map(([k,n])=>"**"+n+"** - Lvl **"+dungLvl(dg.player_classes?.[k]?.experience||0)+"** ("+fmt(dg.player_classes?.[k]?.experience||0)+" XP)");
      return interaction.editReply({embeds:[new EmbedBuilder().setTitle(mojang.name+"'s Dungeons").setColor(0x8800AA).setThumbnail("https://mc-heads.net/avatar/"+mojang.id).addFields({name:"Catacombs Level",value:dungLvl(cxp)+" ("+fmt(cxp)+" XP)",inline:true},{name:"Best Floor",value:"Floor "+(ct.highest_tier_completed??"None"),inline:true},{name:"Total Completions",value:String(total),inline:true},{name:"Class Levels",value:clLines.join("\n"),inline:false}).setTimestamp()]});
    }

    if (cmd === "profile") {
      const username = await resolveUser(interaction);
      const mojang = await fetchMojang(username);
      const profiles = await fetchProfiles(mojang.id);
      if (!profiles?.length) return interaction.editReply("No profiles found.");
      const lines = profiles.map((p,i)=>{const m=getMember(p,mojang.id),ao=m?skillsOff(m):true,avg=m&&!ao?skillAvg(m).toFixed(1):"API Off",cat=dungLvl(m?.dungeons?.dungeon_types?.catacombs?.experience||0);return (i+1)+". **"+p.cute_name+"**"+(p.selected?" (Active)":"")+"\nSkill Avg: "+avg+" | Cata: "+cat;});
      return interaction.editReply({embeds:[new EmbedBuilder().setTitle(mojang.name+"'s Profiles").setColor(0x00CCFF).setThumbnail("https://mc-heads.net/avatar/"+mojang.id).setDescription(lines.join("\n\n")).setTimestamp()]});
    }

    if (cmd === "compare") {
      const [m1,m2]=await Promise.all([fetchMojang(interaction.options.getString("player1")),fetchMojang(interaction.options.getString("player2"))]);
      const [p1,p2]=await Promise.all([fetchProfiles(m1.id),fetchProfiles(m2.id)]);
      const mm1=getMember(getActive(p1),m1.id),mm2=getMember(getActive(p2),m2.id);
      if(!mm1||!mm2)return interaction.editReply("Could not find data for one or both players.");
      const ao1=skillsOff(mm1),ao2=skillsOff(mm2),a1=ao1?0:skillAvg(mm1),a2=ao2?0:skillAvg(mm2);
      const c1=dungLvl(mm1.dungeons?.dungeon_types?.catacombs?.experience||0),c2=dungLvl(mm2.dungeons?.dungeon_types?.catacombs?.experience||0);
      const s1=Object.values(getSlayers(mm1)).reduce((s,v)=>s+(v.xp||0),0),s2=Object.values(getSlayers(mm2)).reduce((s,v)=>s+(v.xp||0),0);
      const w=(a,b)=>a>b?" WIN":a<b?" LOSS":" TIE";
      return interaction.editReply({embeds:[new EmbedBuilder().setTitle(m1.name+" vs "+m2.name).setColor(0xAA00FF).addFields({name:"Skill Average",value:m1.name+": **"+(ao1?"API Off":a1.toFixed(2))+"**"+(ao1?"":w(a1,a2))+"\n"+m2.name+": **"+(ao2?"API Off":a2.toFixed(2))+"**",inline:true},{name:"Catacombs",value:m1.name+": **"+c1+"**"+w(c1,c2)+"\n"+m2.name+": **"+c2+"**",inline:true},{name:"Slayer XP",value:m1.name+": **"+fmt(s1)+"**"+w(s1,s2)+"\n"+m2.name+": **"+fmt(s2)+"**",inline:true}).setTimestamp()]});
    }

    if (cmd === "bazaar") {
      const query=interaction.options.getString("item").toUpperCase().replace(/ /g,"_");
      const products=await fetchBazaar();
      const matches=Object.entries(products).filter(([id])=>id.includes(query)).slice(0,5);
      if(!matches.length)return interaction.editReply("No bazaar item matching `"+query+"`.");
      const embed=new EmbedBuilder().setTitle("Bazaar: "+query).setColor(0xFFAA00).setTimestamp();
      matches.forEach(([id,data])=>{const qs=data.quick_status||{},buy=qs.buyPrice?.toFixed(1)||"N/A",sell=qs.sellPrice?.toFixed(1)||"N/A",margin=(qs.buyPrice&&qs.sellPrice)?(qs.buyPrice-qs.sellPrice).toFixed(1):"N/A";embed.addFields({name:id.replace(/_/g," "),value:"Buy: **"+buy+"** | Sell: **"+sell+"** | Margin: **"+margin+"**\nBuy Vol: "+fmt(qs.buyVolume||0)+" | Sell Vol: "+fmt(qs.sellVolume||0),inline:false});});
      return interaction.editReply({embeds:[embed]});
    }

    if (cmd === "auction") {
      const query=interaction.options.getString("item").toLowerCase();
      const ahData=await fetchAH();
      if(!ahData.success)return interaction.editReply("Failed to fetch Auction House.");
      const matches=ahData.auctions.filter(a=>!a.claimed&&a.item_name.toLowerCase().includes(query)).sort((a,b)=>a.starting_bid-b.starting_bid).slice(0,8);
      if(!matches.length)return interaction.editReply("No auctions for `"+query+"`.");
      const embed=new EmbedBuilder().setTitle("Auction House: "+query).setColor(0xAA5500).setFooter({text:"Total: "+fmt(ahData.totalAuctions)}).setTimestamp();
      matches.forEach(a=>{const ends=a.end?"<t:"+Math.floor(a.end/1000)+":R>":"Unknown";embed.addFields({name:a.item_name+" ["+a.tier+"]",value:fmt(a.starting_bid)+" coins | "+(a.bin?"BIN":"Auction")+" | Ends: "+ends,inline:false});});
      return interaction.editReply({embeds:[embed]});
    }

    if (cmd === "mayor") {
      const data=await fetchMayor(),mayor=data?.mayor;
      if(!mayor)return interaction.editReply("Could not fetch mayor data.");
      const perks=(mayor.perks||[]).map(p=>"**"+p.name+"**\n"+p.description).join("\n\n")||"No perks";
      const embed=new EmbedBuilder().setTitle("Current Mayor: "+mayor.name).setColor(0x0055FF).addFields({name:"Perks",value:perks,inline:false}).setTimestamp();
      if(data.current?.candidates?.length){const cands=data.current.candidates.sort((a,b)=>b.votes-a.votes).map(c=>"**"+c.name+"** - "+fmt(c.votes)+" votes").join("\n");embed.addFields({name:"Next Election",value:cands,inline:false});}
      return interaction.editReply({embeds:[embed]});
    }

    if (cmd === "help") {
      return interaction.editReply({embeds:[new EmbedBuilder().setTitle("Hypixel Skyblock Bot - All Commands").setColor(0x00FFFF)
        .setDescription("> Type /link <yourIGN> once - then all commands work without typing your name!")
        .addFields(
          {name:"Linking",value:"/link\n/unlink\n/whoami",inline:true},
          {name:"Stats",value:"/stats\n/networth\n/skills\n/slayer\n/dungeons\n/profile\n/compare",inline:true},
          {name:"Economy",value:"/bazaar\n/auction\n/mayor",inline:true},
          {name:"Accessories",value:"/accessories budget\n/accessories milestones\n/accessories upgrade",inline:false},
          {name:"Kuudra",value:"/kuudra stats\n/kuudra setup\n/kuudra profit\n/kuudra requirements\n/kuudra lfg\n/kuudra parties\n/kuudra guide\n/kuudra tiers",inline:false},
        ).setFooter({text:"Hypixel Skyblock Bot"}).setTimestamp()]});
    }

    if (cmd === "accessories") {
      if (sub === "budget") {
        const budget=interaction.options.getInteger("budget"),goal=interaction.options.getString("goal"),tierLimit=interaction.options.getString("tier_limit")||"Legendary",targetMP=interaction.options.getInteger("target_mp")||null,currentMP=interaction.options.getInteger("current_mp")||0;
        const tOrd=["Common","Uncommon","Rare","Epic","Legendary"],maxIdx=tOrd.indexOf(tierLimit);
        const gCats={combat:["Combat"],dungeons:["Dungeons","Combat","Defense"],allround:["Combat","Defense","Utility","Speed"],speed:["Speed","Utility"],gathering:["Mining","Farming","Fishing","Utility"]},wanted=gCats[goal]||[];
        const sorted=ACC.filter(a=>tOrd.indexOf(a.tier)<=maxIdx).map(a=>({...a,pri:wanted.includes(a.cat)?1:2,mppc:a.mp/a.cost})).sort((a,b)=>a.pri-b.pri||b.mppc-a.mppc);
        let rem=budget,gained=0,spent=0;const bought=[],needMP=targetMP?targetMP-currentMP:Infinity;
        for(const a of sorted){if(targetMP&&gained>=needMP)break;if(rem>=a.cost){bought.push(a);rem-=a.cost;gained+=a.mp;spent+=a.cost;}}
        if(!bought.length)return interaction.editReply("Budget too low. Cheapest accessory is ~1,000 coins.");
        const reached=currentMP+gained,reachedTarget=targetMP?gained>=needMP:true;
        const hittable=MPMS.filter(m=>m.mp>currentMP&&m.mp<=reached),nextMs=MPMS.filter(m=>m.mp>reached).slice(0,3);
        const byCat={};bought.forEach(a=>{if(!byCat[a.cat])byCat[a.cat]=[];byCat[a.cat].push(a);});
        const embed=new EmbedBuilder().setTitle("Accessories Budget Plan").setColor(reachedTarget?0x00FF88:0xFFAA00)
          .setDescription("**Budget:** "+fmt(budget)+" | **Goal:** "+goal+(targetMP?" | **Target:** "+targetMP+" MP":"")+"\n\nBuy **"+bought.length+"** accessories - **"+fmt(spent)+"**\nMP gain: **+"+gained+"**"+(currentMP?" ("+currentMP+" -> **"+reached+"**)":"")+"\nRemaining: **"+fmt(rem)+"**"+(targetMP&&!reachedTarget?"\nCannot fully reach **"+targetMP+" MP** within budget.":""));
        if(hittable.length)embed.addFields({name:"Milestones Unlocked",value:hittable.map(m=>"**"+m.mp+" MP** - "+m.b).join("\n"),inline:false});
        if(nextMs.length)embed.addFields({name:"Next Milestones",value:nextMs.map(m=>"**"+m.mp+" MP** (need +"+(m.mp-reached)+") - "+m.b).join("\n"),inline:false});
        Object.entries(byCat).slice(0,4).forEach(([cat,items])=>{embed.addFields({name:cat+" ("+items.length+")",value:items.slice(0,5).map(a=>"- **"+a.name+"** - "+fmt(a.cost)+" (+"+a.mp+" MP)").join("\n")+(items.length>5?"\n+"+(items.length-5)+" more":""),inline:false});});
        embed.addFields({name:"Tips",value:"- Warped Stone reforge = best MP\n- Recombobulate Legendary accessories",inline:false}).setTimestamp();
        return interaction.editReply({embeds:[embed]});
      }
      if(sub==="milestones"){
        return interaction.editReply({embeds:[new EmbedBuilder().setTitle("Magic Power Milestones").setColor(0xFFAA00).setDescription("Max possible MP: **"+ACC.reduce((s,a)=>s+a.mp,0)+" MP**\n\n"+MPMS.map(m=>"**"+m.mp+" MP** - "+m.b).join("\n")).addFields({name:"How to gain MP",value:"- Buy more accessories\n- Reforge Warped Stone\n- Recombobulate Legendary",inline:false}).setTimestamp()]});
      }
      if(sub==="upgrade"){
        const budget=interaction.options.getInteger("budget"),currentMP=interaction.options.getInteger("current_mp")||0;
        const sorted=[...ACC].sort((a,b)=>(b.mp/b.cost)-(a.mp/a.cost));
        let rem=budget,totalMP=0;const bought=[];
        for(const a of sorted){if(rem>=a.cost){bought.push(a);rem-=a.cost;totalMP+=a.mp;}}
        const reached=currentMP+totalMP,hittable=MPMS.filter(m=>m.mp>currentMP&&m.mp<=reached),next=MPMS.filter(m=>m.mp>reached).slice(0,3);
        const embed=new EmbedBuilder().setTitle("Best MP/Coin for "+fmt(budget)).setColor(0xAA00FF).setDescription("MP gain: **+"+totalMP+"**"+(currentMP?" ("+currentMP+" -> **"+reached+"**)":"")+"\nSpent: **"+fmt(budget-rem)+"** | Left: **"+fmt(rem)+"**").addFields({name:"Top Picks",value:bought.slice(0,12).map((a,i)=>(i+1)+". **"+a.name+"** ["+a.tier+"] - "+fmt(a.cost)+" | +"+a.mp+" MP").join("\n")||"None",inline:false});
        if(hittable.length)embed.addFields({name:"Milestones Unlocked",value:hittable.map(m=>"**"+m.mp+" MP** - "+m.b).join("\n"),inline:false});
        if(next.length)embed.addFields({name:"Next Milestones",value:next.map(m=>"**"+m.mp+" MP** (need +"+(m.mp-reached)+") - "+m.b).join("\n"),inline:false});
        embed.addFields({name:"Tips",value:"- Warped Stone = best MP reforge",inline:false}).setTimestamp();
        return interaction.editReply({embeds:[embed]});
      }
    }

    if (cmd === "kuudra") {
      if(sub==="stats"){
        const username=await resolveUser(interaction),mojang=await fetchMojang(username),profiles=await fetchProfiles(mojang.id),profile=getActive(profiles),member=getMember(profile,mojang.id);
        if(!member)return interaction.editReply("No Skyblock data for **"+mojang.name+"**.");
        const pn=profile?.cute_name||"Unknown",kuudra=member.nether_island_player_data?.kuudra_completed_tiers||{};
        const basic=kuudra.none||0,hot=kuudra.hot||0,burning=kuudra.burning||0,fiery=kuudra.fiery||0,infernal=kuudra.infernal||0;
        const magesR=member.nether_island_player_data?.mages_reputation||0,barbR=member.nether_island_player_data?.barbarians_reputation||0;
        const mp=member.accessory_bag_storage?.highest_magical_power||0,cataXP=member.dungeons?.dungeon_types?.catacombs?.experience||0,apiOff=skillsOff(member);
        const sl=getSlayers(member),purse=member.coin_purse||member.currencies?.coin_purse||0,bank=profile.banking?.balance||0;
        return interaction.editReply({embeds:[new EmbedBuilder().setTitle("Kuudra Stats - "+mojang.name+" on "+pn).setColor(0xFF6600).setThumbnail("https://mc-heads.net/avatar/"+mojang.id)
          .addFields(
            {name:"Kuudra Completions ("+(basic+hot+burning+fiery+infernal)+" total)",value:"Basic: **"+basic+"** | Hot: **"+hot+"** | Burning: **"+burning+"**\nFiery: **"+fiery+"** | Infernal: **"+infernal+"**",inline:false},
            {name:"Reputation",value:"Mages: **"+fmt(magesR)+"**\nBarbarians: **"+fmt(barbR)+"**",inline:true},
            {name:"Magical Power",value:mp>0?"**"+mp+"**":"N/A",inline:true},
            {name:"Skills",value:"Cata: **"+dungLvl(cataXP)+"** | Combat: **"+(apiOff?"?":skillLvl(getSkillXP(member,"combat")))+"** | Avg: **"+(apiOff?"?":skillAvg(member).toFixed(1))+"**",inline:false},
            {name:"Slayer Levels",value:"Rev **"+slayerLvl(sl.zombie?.xp||0,"zombie")+"** | Tara **"+slayerLvl(sl.spider?.xp||0,"spider")+"** | Sven **"+slayerLvl(sl.wolf?.xp||0,"wolf")+"**\nEnder **"+slayerLvl(sl.enderman?.xp||0,"enderman")+"** | Blaze **"+slayerLvl(sl.blaze?.xp||0,"blaze")+"** | Vamp **"+slayerLvl(sl.vampire?.xp||0,"vampire")+"**",inline:false},
            {name:"Coins",value:"Purse: **"+fmt(purse)+"** | Bank: **"+fmt(bank)+"**",inline:false},
          ).setFooter({text:apiOff?"Skills API disabled":"Hypixel Skyblock Bot"}).setTimestamp()]});
      }
      if(sub==="setup"){const d=TIERS[interaction.options.getString("tier")];return interaction.editReply({embeds:[new EmbedBuilder().setTitle("Kuudra "+d.label+" - Setup").setColor(d.color).addFields({name:"Armor",value:d.setup.armor,inline:false},{name:"Weapon",value:d.setup.weapon,inline:false},{name:"Pet",value:d.setup.pet,inline:true},{name:"Accessories",value:d.setup.acc,inline:false},{name:"Reforges",value:d.setup.reforge,inline:false},{name:"Min EHP",value:fmt(d.minEHP),inline:true},{name:"Rec Cata",value:"Level "+d.recCata+"+",inline:true},{name:"Notes",value:d.setup.notes,inline:false}).setTimestamp()]});}
      if(sub==="profit"){const d=TIERS[interaction.options.getString("tier")],runs=interaction.options.getInteger("runs")||1,loot=d.profit.avgLoot*runs,keys=d.profit.keyCost*runs,net=loot-keys;return interaction.editReply({embeds:[new EmbedBuilder().setTitle("Kuudra "+d.label+" - Profit").setColor(d.color).addFields({name:"Runs",value:String(runs),inline:true},{name:"Avg Loot",value:fmt(d.profit.avgLoot),inline:true},{name:"Key Cost",value:fmt(d.profit.keyCost),inline:true},{name:"Total Loot",value:fmt(loot),inline:true},{name:"Total Keys",value:fmt(keys),inline:true},{name:"Net Profit",value:"**"+fmt(net)+"** coins",inline:true},{name:"Est/Hour",value:"~"+fmt(net*4)+" coins",inline:false}).setTimestamp()]});}
      if(sub==="requirements"){
        const tier=interaction.options.getString("tier"),d=TIERS[tier],username=await resolveUser(interaction),mojang=await fetchMojang(username),member=getMember(getActive(await fetchProfiles(mojang.id)),mojang.id);
        if(!member)return interaction.editReply("No Skyblock data found.");
        const hp=member.stats?.health||100,def=member.stats?.defense||0,ehp=Math.round(hp*(1+def/100)),cata=dungLvl(member.dungeons?.dungeon_types?.catacombs?.experience||0),avg=skillsOff(member)?0:skillAvg(member);
        const ok1=ehp>=d.minEHP,ok2=cata>=d.recCata,ok3=avg>=30,all=ok1&&ok2&&ok3,t=v=>v?"YES":"NO";
        return interaction.editReply({embeds:[new EmbedBuilder().setTitle(mojang.name+" - "+d.label+" Readiness").setColor(all?0x00FF44:0xFF4400).setThumbnail("https://mc-heads.net/avatar/"+mojang.id).addFields({name:"EHP (est.) - "+t(ok1),value:fmt(ehp)+" / "+fmt(d.minEHP)+" required",inline:false},{name:"Catacombs - "+t(ok2),value:cata+" / "+d.recCata+" recommended",inline:true},{name:"Skill Avg - "+t(ok3),value:(skillsOff(member)?"API Off":avg.toFixed(1))+" / 30 recommended",inline:true},{name:"Verdict",value:all?"READY for "+d.label+"!":"Not ready. Improve stats marked NO.",inline:false}).setTimestamp()]});
      }
      if(sub==="lfg"){
        const tier=interaction.options.getString("tier"),role=interaction.options.getString("role"),note=interaction.options.getString("note")||"No additional info",d=TIERS[tier],gid=interaction.guildId;
        if(!lfgStore.has(gid))lfgStore.set(gid,[]);
        const list=lfgStore.get(gid).filter(e=>e.userId!==interaction.user.id);
        list.push({userId:interaction.user.id,tag:interaction.user.tag,tier,role,note,ts:Date.now()});lfgStore.set(gid,list);
        return interaction.editReply({embeds:[new EmbedBuilder().setTitle("LFG - Kuudra "+d.label).setColor(d.color).setDescription("<@"+interaction.user.id+"> is looking for a Kuudra group!").addFields({name:"Role",value:role,inline:true},{name:"Tier",value:d.label,inline:true},{name:"Note",value:note,inline:false}).setFooter({text:"Use /kuudra parties to see all. Expires 30 min."}).setTimestamp()]});
      }
      if(sub==="parties"){
        const tf=interaction.options.getString("tier")||"all",gid=interaction.guildId,now=Date.now();
        const fresh=(lfgStore.get(gid)||[]).filter(e=>now-e.ts<30*60000);lfgStore.set(gid,fresh);
        const filtered=tf==="all"?fresh:fresh.filter(e=>e.tier===tf);
        if(!filtered.length)return interaction.editReply("No active LFG parties. Post one with /kuudra lfg!");
        const embed=new EmbedBuilder().setTitle("Active LFG"+(tf!=="all"?" - "+TIERS[tf].label:" - All")).setColor(0xFF6600).setTimestamp();
        filtered.slice(0,10).forEach(e=>embed.addFields({name:TIERS[e.tier].label+" - "+e.role,value:"<@"+e.userId+"> ("+e.tag+")\n"+e.note+"\n"+Math.round((now-e.ts)/60000)+"m ago",inline:false}));
        return interaction.editReply({embeds:[embed]});
      }
      if(sub==="guide"){
        const tier=interaction.options.getString("tier");
        if(tier){const d=TIERS[tier];return interaction.editReply({embeds:[new EmbedBuilder().setTitle("Kuudra "+d.label+" - Guide").setColor(d.color).setDescription(d.guide.join("\n\n")).setTimestamp()]});}
        return interaction.editReply({embeds:[new EmbedBuilder().setTitle("Kuudra - General Guide").setColor(0xFF6600).addFields({name:"Overview",value:"4-player co-op boss on Crimson Isle. 5 tiers: Basic to Infernal.",inline:false},{name:"Roles",value:"Mage - Staff DPS\nBerserk - Melee\nArcher - Ranged\nTank - Absorption\nHealer - Support",inline:false},{name:"4 Phases",value:"1. Supply Run\n2. Build + Defend\n3. Ballista + Fight Kuudra\n4. Open Paid Chest",inline:false},{name:"Pro Tips",value:"Always open Paid Chest | Attribute Shards best drops\nGod Pots for Fiery+ | Coordinate roles",inline:false}).setTimestamp()]});
      }
      if(sub==="tiers"){
        const embed=new EmbedBuilder().setTitle("Kuudra - All Tiers").setColor(0xFF6600).setTimestamp();
        Object.entries(TIERS).forEach(([k,d])=>embed.addFields({name:d.label,value:"Profit: **"+fmt(d.profit.avgLoot-d.profit.keyCost)+"**/run | Min EHP: **"+fmt(d.minEHP)+"** | Cata: **"+d.recCata+"+**",inline:false}));
        return interaction.editReply({embeds:[embed]});
      }
    }

  } catch(err) {
    console.error("Error in /" + interaction.commandName + ":", err.message);
    try { await interaction.editReply("Error: " + (err.message || "Unknown error")); } catch(_) {}
  }
});

client.login(DISCORD_TOKEN);
