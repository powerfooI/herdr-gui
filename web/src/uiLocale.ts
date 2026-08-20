// Keep application-generated dates, times, and relative labels in English even
// when the browser or operating system uses another locale.
export const UI_LOCALE = "en-US";

const relativeTimeFormatter = new Intl.RelativeTimeFormat(UI_LOCALE, {
  numeric: "auto",
});

export function formatUiRelativeTime(
  value: number,
  unit: Intl.RelativeTimeFormatUnit,
) {
  return relativeTimeFormatter.format(value, unit);
}
