// @description Badges from other client mods, shown on profiles and in the badge directory
// @version 0.5.3
// @author iFlex0x, wolfieeeeeeee
// @warning Downloads the public badge directory from Equibadges (badges.equicord.org)

const API = "https://badges.equicord.org/users";
const TTL = 60 * 60 * 1000;
const RETRY_DELAY = 30 * 1000;
const BADGE_ID_BASE = 900_000;

type Badge = { uri: string; name: string; source: string; rarity: number };

const settings = phoenix.settings.define({
  showCustom: {
    type: "switch",
    title: "Custom badges",
    description: "Show where community badges came from in Badge Directory",
    default: true,
  },
  showPrefix: {
    type: "switch",
    title: "Client mod as prefix",
    description: "Show the mod name before each badge",
    default: true,
  },
});

let users: Record<string, unknown> = {};
let refreshAt = 0;
let pending: Promise<void> | undefined;

const providerNames = new Map(Object.entries({
  aliucord: "Aliucord", equicord: "Equicord",
  nekocord: "Nekocord", raincord: "Raincord", replugged: "Replugged",
  reviewdb: "ReviewDB", vencord: "Vencord", enmity: "Enmity",
  velocity: "Velocity", aero: "Aero",
}));
let selfId: string | null = null;

if (phoenix.gateway.ready) {
  phoenix.on(phoenix.gateway.ready as Phoenix.Sig<{ user?: { id?: string } }>, (payload) => {
    if (payload?.user?.id) selfId = payload.user.id;
  });
}

async function resolveSelfId(): Promise<string | null> {
  if (selfId) return selfId;
  try {
    const res = await phoenix.discord.get("/users/@me");
    if (res.ok) {
      const me = res.json<{ id?: string }>();
      if (me?.id) selfId = me.id;
    }
  } catch {}
  return selfId;
}

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
  return m[1] === "@me" ? resolveSelfId() : m[1];
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
    if (!mod || mod === "discord" || mod === "badgevault") continue;
    const source = providerNames.get(mod) ?? entry.mod.trim();
    const uri = entry.badge.trim();
    const name = entry.tooltip.trim();
    if (!name || !/^https?:\/\/[^/\s]+/i.test(uri) || seen.has(uri)) continue;
    seen.add(uri);
    const rarity = typeof entry.rarity === "number" && Number.isInteger(entry.rarity)
      && entry.rarity >= 1 && entry.rarity <= 5 ? entry.rarity : 5;
    badges.push({ uri, name, source, rarity });
  }
  return badges;
}

async function refreshUsers(): Promise<void> {
  const res = await phoenix.fetch(API);
  if (!res.ok) throw new Error(`Equibadges HTTP ${res.status}`);
  const body = res.json<unknown>();
  if (!isRecord(body) || !isRecord(body.users)) throw new Error("Invalid Equibadges response");
  users = body.users;
  refreshAt = Date.now() + TTL;
}

async function badgesFor(userId: string): Promise<Badge[]> {
  if (Date.now() >= refreshAt) {
    pending ??= refreshUsers()
      .catch(() => { refreshAt = Date.now() + RETRY_DELAY; })
      .finally(() => { pending = undefined; });
    await pending;
  }
  return parseBadges(users[userId]);
}

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
      rarity: b.rarity,
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
