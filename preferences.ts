import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface Preferences {
  [key: string]: string;
}

const PREFS_DIR = join(__dirname, "preferences");
const PREFS_FILE = join(PREFS_DIR, "preferences.json");

function ensureDir(): void {
  if (!existsSync(PREFS_DIR)) {
    mkdirSync(PREFS_DIR, { recursive: true });
  }
}

export function loadPreferences(): Preferences {
  try {
    ensureDir();
    if (existsSync(PREFS_FILE)) {
      return JSON.parse(readFileSync(PREFS_FILE, "utf8"));
    }
  } catch {
    // ignore
  }
  return {};
}

export function savePreference(key: string, value: string): void {
  ensureDir();
  const prefs = loadPreferences();
  prefs[key] = value;
  writeFileSync(PREFS_FILE, JSON.stringify(prefs, null, 2));
}

export function getPreference(key: string): string | null {
  const prefs = loadPreferences();
  return prefs[key] || null;
}

// ── Domain categorization ──────────────────────────────────────────────────────

const TRIGGER_WORDS: Record<string, string[]> = {
  play: ["music_platform"],
  listen: ["music_platform"],
  music: ["music_platform"],
  song: ["music_platform"],
  video: ["video_platform"],
  watch: ["video_platform"],
  search: ["search_engine"],
  find: ["search_engine", "shop_store"],
  google: ["search_engine"],
  buy: ["shop_store"],
  order: ["shop_store"],
  shop: ["shop_store"],
  purchase: ["shop_store"],
  amazon: ["shop_store"],
  ebay: ["shop_store"],
};

const PLATFORM_MAP: Record<string, string> = {
  youtube: "youtube",
  "youtube music": "youtube music",
  yt: "youtube",
  spotify: "spotify",
  soundcloud: "soundcloud",
  google: "google",
  duckduckgo: "duckduckgo",
  bing: "bing",
  brave: "brave",
  amazon: "amazon",
  ebay: "ebay",
  walmart: "walmart",
  aliexpress: "aliexpress",
  twitter: "twitter",
  "x.com": "x",
  reddit: "reddit",
  instagram: "instagram",
  tiktok: "tiktok",
};

const PLATFORM_PREFIXES = ["on ", "via ", "using ", "through ", "with ", "from "];

// ── Implicit learning from task text ───────────────────────────────────────────

export function learnFromTask(task: string): boolean {
  const lower = task.toLowerCase();
  let learned = false;
  const allKeys = Object.keys(TRIGGER_WORDS);
  const allPlatforms = Object.keys(PLATFORM_MAP);

  for (const prefix of PLATFORM_PREFIXES) {
    for (const plat of allPlatforms) {
      const pattern = prefix + plat;
      if (lower.includes(pattern)) {
        const keys = new Set<string>();
        for (const [word, domains] of Object.entries(TRIGGER_WORDS)) {
          if (lower.includes(word) || word === plat) {
            for (const d of domains) keys.add(d);
          }
        }
        if (keys.size === 0 && plat) {
          keys.add(plat + "_preference");
        }
        for (const k of keys) {
          savePreference(k, PLATFORM_MAP[plat]);
          learned = true;
        }
      }
    }
  }

  return learned;
}

// ── Build prompt injection ─────────────────────────────────────────────────────

export function buildPreferencesPrompt(prefs: Preferences): string {
  const entries = Object.entries(prefs);
  if (entries.length === 0) return "";

  const lines = entries.map(([k, v]) => {
    const label = k
      .replace(/_/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase());
    return `- ${label}: ${v}`;
  });

  return (
    "\n\nKNOW USER PREFERENCES (learned from past interactions):\n" +
    lines.join("\n") +
    "\n\nRespect these preferences automatically. The user has chosen these platforms in the past. Use them without asking unless the user specifies otherwise in the current task."
  );
}

// ── Clear all preferences ──────────────────────────────────────────────────────

export function clearPreferences(): void {
  try {
    ensureDir();
    writeFileSync(PREFS_FILE, "{}");
  } catch {
    // ignore
  }
}
