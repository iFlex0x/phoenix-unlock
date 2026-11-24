// @description Shows user badges from other Discord client mods on profiles
// @version 0.5.5
// @author iFlex0x, wolfieeeeeeee
// @warning Fetches badges from Equibadges (badges.equicord.org)

const API = "https://badges.equicord.org/users";
const TTL = 6 * 60 * 60 * 1000;
const RETRY_DELAY = 30 * 1000;
const BADGE_ID_BASE = 900_000;

type Badge = { uri: string; name: string; source: string };

const settings = phoenix.settings.define({
  showCustom: {
    type: "switch",
    title: "Badge source",
    description: "Show where community badges came from in Badge Directory",
    default: true,
  },
  showPrefix: {
    type: "switch",
    title: "Client mod as prefix",
    description: "Show the mod name before each badge",
    default: true,
  },
  badgeVault: {
    type: "switch",
    title: "BadgeVault badges",
    description: "Show BadgeVault badges, which any user can make",
    default: false,
  },
});

let users: Record<string, unknown> = {};
let loaded = false;
let refreshAt = 0;
let refreshing: Promise<void> | undefined;

const providerNames = new Map(Object.entries({
  aliucord: "Aliucord", equicord: "Equicord",
  nekocord: "Nekocord", raincord: "Raincord", replugged: "Replugged",
  reviewdb: "ReviewDB", vencord: "Vencord", enmity: "Enmity",
  velocity: "Velocity", aero: "Aero",
  goosemod: "GooseMod", vendroidenhanced: "Vendroid Enhanced", paicord: "Paicord",
  revenge: "Revenge", betterdiscord: "BetterDiscord", record: "ReCord",
  bunny: "Bunny",
}));

function toHex(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    out += text.charCodeAt(i).toString(16).padStart(2, "0");
  }
  return out;
}

// Phoenix caches badge details by id, so each image needs its own.
function badgeId(uri: string): number {
  let hash = 2166136261;
  for (let i = 0; i < uri.length; i++) {
    hash ^= uri.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return BADGE_ID_BASE + ((hash >>> 0) % 1_000_000_000);
}

// The runtime unwraps this URL and clamps the art to the static badge size.
function badgeUrl(uri: string, animated = false): string {
  return `https://cdn.discordapp.com/badge-icons/phx_u_${toHex(uri)}${animated ? ".gif" : ".png"}`;
}

async function userIdFromPath(path: string): Promise<string | null> {
  const m = path.match(/^\/users\/(@me|\d+)\/(?:profile|badges)(?:[?#]|$)/);
  if (!m) return null;
  return m[1] === "@me" ? ((await phoenix.discord.me())?.id ?? null) : m[1];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseBadges(entries: unknown): Badge[] {
  if (!Array.isArray(entries)) return [];

  const badges: Badge[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (!isRecord(entry) || typeof entry.mod !== "string" ||
      typeof entry.badge !== "string" || typeof entry.tooltip !== "string") continue;
    const mod = entry.mod.trim().toLowerCase();
    if (!mod || mod === "discord" || (mod === "badgevault" && !settings.badgeVault)) continue;
    const source = providerNames.get(mod) ?? entry.mod.trim();
    const uri = entry.badge.trim();
    const name = entry.tooltip.trim();
    if (!name || !/^https?:\/\/[^/\s]+/i.test(uri) || seen.has(uri)) continue;
    seen.add(uri);
    badges.push({ uri, name, source });
  }
  return badges;
}

async function refreshUsers(): Promise<void> {
  if (!refreshing) {
    refreshing = (async () => {
      const res = await phoenix.fetch(API);
      if (!res.ok) throw new Error(`Equibadges HTTP ${res.status}`);
      const body = res.json<unknown>();
      if (!isRecord(body) || !isRecord(body.users)) throw new Error("Invalid Equibadges response");
      if (!Object.keys(body.users).length) throw new Error("Empty Equibadges response");
      users = body.users;
      loaded = true;
      refreshAt = Date.now() + TTL;
    })()
      .catch(() => { refreshAt = Date.now() + RETRY_DELAY; })
      .finally(() => { refreshing = undefined; });
  }
  return refreshing;
}

async function badgesFor(userId: string): Promise<Badge[]> {
  if (Date.now() >= refreshAt) {
    const refresh = refreshUsers();
    // Serve the old map while a refresh runs: only the first load may wait,
    // so a profile hook stays under the loader's 4 second cutoff.
    if (!loaded) await refresh;
  }
  return parseBadges(users[userId]);
}

// Warm the map at plugin load so the first profile does not pay for the 1.9 MB
// download. A failure leaves `loaded` false and retries after RETRY_DELAY.
void refreshUsers();

function badgeLabel({ source, name }: Badge): string {
  return settings.showPrefix && !name.toLowerCase().startsWith(source.toLowerCase() + " ")
    ? `${source} ${name}`
    : name;
}

phoenix.discord.onResponse(
  { method: "GET", pathPrefix: "/users/", pathSuffix: "/profile" },
  async (res) => {
    if (res.status < 200 || res.status >= 300) return;
    const userId = await userIdFromPath(res.path);
    if (!userId) return;
    const data = res.json<Record<string, unknown>>();
    if (!data || typeof data !== "object") return;
    const extra = await badgesFor(userId);
    if (!extra.length) return;
    const existing = Array.isArray(data.badges) ? data.badges : [];
    const injected = extra.map((b) => ({
      id: String(badgeId(b.uri)),
      description: badgeLabel(b),
      icon: `phx_u_${toHex(b.uri)}`,
      simple_icon_url: b.uri,
    }));
    data.badges = [...injected, ...existing];
    return { body: data };
  }
);

phoenix.discord.onResponse(
  { method: "GET", pathPrefix: "/users/", pathSuffix: "/badges" },
  async (res) => {
    if (res.status < 200 || res.status >= 300) return;
    const userId = await userIdFromPath(res.path);
    if (!userId) return;
    const data = res.json<Record<string, unknown>>();
    if (!data || typeof data !== "object") return;
    const extra = await badgesFor(userId);
    if (!extra.length) return;
    const existing = Array.isArray(data.badges) ? data.badges : [];
    const injected = extra.map((b) => ({
      badge_id: badgeId(b.uri),
      name: badgeLabel(b),
      description: settings.showCustom ? `Badge from ${b.source}.` : "",
      ...(settings.showCustom ? { info_label: b.source } : {}),
      rarity: 5,
      simple_icon_url: badgeUrl(b.uri),
      simple_icon_raster_url: badgeUrl(b.uri),
      complex_icon_static_url: badgeUrl(b.uri),
      ...(/(\.gif|\.webp)(?:[?#]|$)/i.test(b.uri) ? { complex_icon_animated_url: badgeUrl(b.uri, true) } : {}),
      is_earnable: true,
      owned: true,
      hidden: false,
    }));
    data.badges = [...injected, ...existing];
    return { body: data };
  }
);
