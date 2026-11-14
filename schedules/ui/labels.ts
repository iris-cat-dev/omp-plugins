import { i18n } from "./i18n";

export function formatThinkingOptionLabel(option: { id: string; label?: string | null }): string {
  const compactId = option.id.replace(/[\s_-]+/g, "").toLowerCase();
  if (["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(compactId)) return i18n.t(`thinking.${compactId}`);
  const label = (option.label ?? option.id).replace(/[_-]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").trim();
  return label.charAt(0).toUpperCase() + label.slice(1).toLowerCase();
}
