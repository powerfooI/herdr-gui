export const ACCENT_OPTIONS = [
  { value: "neutral", label: "Default" },
  { value: "blue", label: "Blue" },
  { value: "teal", label: "Teal" },
  { value: "green", label: "Green" },
  { value: "amber", label: "Amber" },
  { value: "rose", label: "Rose" },
  { value: "violet", label: "Violet" },
] as const;

export type AccentColor = (typeof ACCENT_OPTIONS)[number]["value"];

export function normalizeAccentColor(value: string | null): AccentColor {
  return ACCENT_OPTIONS.some((option) => option.value === value)
    ? (value as AccentColor)
    : "neutral";
}

export const THEME_OPTIONS = [
  { value: "dark", label: "Dark" },
  { value: "light", label: "Light" },
  { value: "system", label: "System" },
] as const;

export type ThemePreference = (typeof THEME_OPTIONS)[number]["value"];
export type ResolvedTheme = "dark" | "light";

export function normalizeThemePreference(
  value: string | null,
): ThemePreference {
  return value === "light" || value === "dark" || value === "system"
    ? value
    : "dark";
}

export function resolveSystemTheme(
  media: Pick<MediaQueryList, "matches">,
): ResolvedTheme {
  return media.matches ? "light" : "dark";
}

export const SYSTEM_THEME_QUERY = "(prefers-color-scheme: light)";
