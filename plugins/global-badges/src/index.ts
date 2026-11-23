// @description Badges from other client mods, shown on profiles and in the badge directory
// @version 0.4.1
// @author iFlex0x
// @warning Sends viewed user IDs to third-party servers (api.domi-btnr.dev, badges.vencord.dev)

const API = "https://api.domi-btnr.dev/clientmodbadges";
const DONORS = "https://badges.vencord.dev/badges.json";
const TTL = 15 * 60 * 1000;
const DONOR_TTL = 30 * 60 * 1000;
const CACHE_CAP = 64;
const BADGE_ID_BASE = 900_000;

type RawBadge = string | { name: string; badge: string };
type Badges = Record<string, RawBadge[]>;
type Donor = { tooltip?: string; badge: string };
type ShownBadge = { uri: string; label: string; description: string; source: string };

const settings = phoenix.settings.define({
  showPrefix: {
    type: "switch",
    title: "Client mod as prefix",
    description: "Show the mod name before each badge",
    default: true,
  },
  showCustom: {
    type: "switch",
    title: "Custom badges",
    description: "Show badges a mod defines itself",
    default: true,
  },
});

const FULL_NAMES: Record<string, string> = { hunter: "Bug Hunter", early: "Early User" };

// vencord redesigned this in oct 2026; the clientmod api still serves the old art
const VENCORD_CONTRIBUTOR = "https://cdn.discordapp.com/emojis/1562267648857997356.webp?size=128";

// Cache raw API responses so toggling settings takes effect on the next profile open.
const rawCache = new Map<string, { at: number; body: Badges }>();
let donors: { at: number; byUser: Record<string, Donor[]> } | null = null;
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

// Badge ids must be unique per badge, not per list position: Phoenix caches
// badge details by id, so index-based ids made every first badge show the
// first badge the client had ever seen.
function badgeId(uri: string): number {
  let hash = 2166136261;
  for (let i = 0; i < uri.length; i++) {
    hash ^= uri.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return BADGE_ID_BASE + ((hash >>> 0) % 1_000_000_000);
}

// Route directory icons through the loader's badge-icon unwrap so the runtime
// can size injected badge art before Phoenix draws it.
function badgeUrl(uri: string, animated = false): string {
  return `https://cdn.discordapp.com/badge-icons/phx_u_${toHex(uri)}${animated ? ".gif" : ".png"}`;
}

async function userIdFromPath(path: string): Promise<string | null> {
  const m = path.match(/^\/users\/(@me|\d+)\/(?:profile|badges)(?:[?#]|$)/);
  if (!m) return null;
  return m[1] === "@me" ? resolveSelfId() : m[1];
}

function badgeOf(mod: string, badge: RawBadge): ShownBadge | null {
  if (typeof badge !== "string") {
    if (!settings.showCustom) return null;
    const name = badge?.name?.trim();
    const uri = badge?.badge?.trim();
    if (!name || !uri) return null;
    return { uri, label: name, description: `Custom badge from ${mod}.`, source: mod };
  }

  const slug = badge.replace(mod, "").trim().split(" ")[0];
  if (!slug) return null;

  const clean = (FULL_NAMES[badge] ?? badge).replace(mod, "").trim();
  if (!clean) return null;

  const name = clean.charAt(0).toUpperCase() + clean.slice(1);
  return {
    uri:
      mod === "Vencord" && slug.toLowerCase() === "contributor"
        ? VENCORD_CONTRIBUTOR
        : `${API}/badges/${mod}/${slug}`,
    label: settings.showPrefix ? `${mod} ${name}` : name,
    description:
      slug.toLowerCase() === "contributor"
        ? `For contributing to ${mod}.`
        : `${mod} badge.`,
    source: mod,
  };
}

async function donorBadgesFor(userId: string): Promise<ShownBadge[]> {
  if (!donors || Date.now() - donors.at >= DONOR_TTL) {
    try {
      const res = await phoenix.fetch(DONORS);
      donors = { at: Date.now(), byUser: res.ok ? res.json<Record<string, Donor[]>>() : {} };
    } catch {
      donors = { at: Date.now(), byUser: {} };
    }
  }

  const list = donors.byUser?.[userId];
  if (!Array.isArray(list)) return [];
  const out: ShownBadge[] = [];
  for (const one of list) {
    const uri = one?.badge?.trim();
    if (!uri) continue;
    out.push({
      uri,
      label: one.tooltip?.trim() || "Vencord Donor",
      description: "A badge for supporting Vencord.",
      source: "Vencord Donor",
    });
  }
  return out;
}

async function badgesFor(userId: string): Promise<ShownBadge[]> {
  let body: Badges;
  const hit = rawCache.get(userId);
  if (hit && Date.now() - hit.at < TTL) {
    body = hit.body;
  } else {
    body = {};
    try {
      const res = await phoenix.fetch(`${API}/users/${userId}`);
      if (res.ok) body = res.json<Badges>() ?? {};
    } catch {
      body = {};
    }
    if (rawCache.size >= CACHE_CAP) rawCache.clear();
    rawCache.set(userId, { at: Date.now(), body });
  }

  const badges = await donorBadgesFor(userId);
  for (const [mod, list] of Object.entries(body)) {
    if (!Array.isArray(list)) continue;
    for (const badge of list) {
      const one = badgeOf(mod, badge);
      if (one) badges.push(one);
    }
  }

  const seen = new Set<string>();
  return badges.filter((one) => {
    if (seen.has(one.uri)) return false;
    seen.add(one.uri);
    return true;
  });
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
      description: b.label,
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
      name: b.label,
      description: b.description,
      info_label: b.source,
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
