// Device-local preferences, stored in the backend's settings table.
import { api } from "./api";

export const DEFAULT_ACCENT = { light: "#b8862f", dark: "#d27a26" };

export const prefs = $state({
  theme: "system" as "light" | "dark" | "system",
  accentLight: DEFAULT_ACCENT.light,
  accentDark: DEFAULT_ACCENT.dark,
  vim: false,
  markers: [] as string[], // ids of enabled MarkerSets; the BCE/AD divide is always shown
  welcomed: false,
  loaded: false,
});

const media = typeof window !== "undefined" ? window.matchMedia("(prefers-color-scheme: dark)") : null;
let systemDark = $state(media?.matches ?? false);
media?.addEventListener("change", (e) => (systemDark = e.matches));

export const isDark = () => (prefs.theme === "system" ? systemDark : prefs.theme === "dark");

export async function loadPrefs() {
  const s = await api.getSettings();
  prefs.theme = (s.theme as typeof prefs.theme) ?? "system";
  prefs.accentLight = s.accent_light || DEFAULT_ACCENT.light;
  prefs.accentDark = s.accent_dark || DEFAULT_ACCENT.dark;
  prefs.vim = s.vim === "1";
  prefs.markers = s.markers ? s.markers.split(",") : [];
  prefs.welcomed = s.welcomed === "1";
  prefs.loaded = true;
}

const KEYS = { theme: "theme", accentLight: "accent_light", accentDark: "accent_dark", vim: "vim", markers: "markers", welcomed: "welcomed" } as const;

export function setPref<K extends keyof typeof KEYS>(key: K, value: (typeof prefs)[K]) {
  (prefs as any)[key] = value;
  const stored = typeof value === "boolean" ? (value ? "1" : "0") : Array.isArray(value) ? value.join(",") : String(value);
  void api.setSetting(KEYS[key], stored);
}
