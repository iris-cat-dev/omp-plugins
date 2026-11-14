import React, { createContext, useContext, useState, type ReactNode } from "react";
import { Modal, Pressable, ScrollView, Text, TextInput, View, type TextInputProps } from "react-native";
import type { PluginTheme } from "@omp-desktop/plugin";
import { useTranslation } from "react-i18next";
import { i18n } from "./i18n";

export const ThemeContext = createContext<PluginTheme | null>(null);
export function useColors() {
  const theme = useContext(ThemeContext);
  if (!theme) throw new Error("Schedules controls require the host theme");
  return theme.colors;
}
export function useText() { return useTranslation(undefined, { i18n }).t; }
export function Button({ children, onPress, disabled, selected, danger, testID }: { children: string; onPress(): void; disabled?: boolean; selected?: boolean; danger?: boolean; testID?: string }) {
  const colors = useColors();
  return <Pressable accessibilityRole="button" accessibilityLabel={children} accessibilityState={{ disabled: !!disabled, selected: !!selected }} disabled={disabled} onPress={onPress} testID={testID} style={({ pressed }) => ({ minHeight: 38, justifyContent: "center", paddingHorizontal: 12, paddingVertical: 8, borderRadius: 7, borderWidth: 1, borderColor: danger ? colors.statusDanger : selected ? colors.accent : colors.foregroundMuted, backgroundColor: selected ? colors.accent : colors.surface0, opacity: disabled ? 0.45 : pressed ? 0.7 : 1 })}><Text style={{ color: selected ? colors.accentForeground : danger ? colors.statusDanger : colors.foreground, fontSize: 14, fontWeight: "500" }}>{children}</Text></Pressable>;
}
export function Field({ label, children }: { label: string; children: ReactNode }) {
  const colors = useColors();
  return <View style={{ gap: 7 }}><Text style={{ color: colors.foreground, fontSize: 14, fontWeight: "600" }}>{label}</Text>{children}</View>;
}
export function Input({ label, ...props }: TextInputProps & { label: string }) {
  const colors = useColors();
  return <Field label={label}><TextInput {...props} accessibilityLabel={label} placeholderTextColor={colors.foregroundMuted} style={[{ minHeight: 40, padding: 10, borderWidth: 1, borderColor: colors.foregroundMuted, borderRadius: 7, color: colors.foreground, backgroundColor: colors.surface0, fontSize: 14 }, props.multiline && { minHeight: 100, textAlignVertical: "top" }, props.style]} /></Field>;
}
export function Dialog({ title, children, onClose, testID }: { title: string; children: ReactNode; onClose(): void; testID?: string }) {
  const colors = useColors();
  const t = useText();
  return <Modal visible transparent animationType="fade" onRequestClose={onClose}><View style={{ flex: 1, justifyContent: "center", alignItems: "center", padding: 16, backgroundColor: "rgba(0,0,0,0.45)" }}><View accessibilityViewIsModal testID={testID} style={{ width: "100%", maxWidth: 740, maxHeight: "94%", borderRadius: 12, backgroundColor: colors.surface0, borderWidth: 1, borderColor: colors.foregroundMuted }}><View style={{ padding: 18, flexDirection: "row", gap: 12, alignItems: "center", justifyContent: "space-between" }}><Text accessibilityRole="header" style={{ flex: 1, fontSize: 20, fontWeight: "600", color: colors.foreground }}>{title}</Text><Button onPress={onClose}>{t("close")}</Button></View>{children}</View></View></Modal>;
}
export interface SelectOption { value: string; label: string; description?: string; testID?: string; disabled?: boolean }
export function Select({ label, value, display, options, onChange, disabled, testID, searchable = true }: { label: string; value: string | null; display?: string; options: readonly SelectOption[]; onChange(value: string): void; disabled?: boolean; testID?: string; searchable?: boolean }) {
  const colors = useColors();
  const t = useText();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const selected = options.find(option => option.value === value);
  const visible = options.filter(option => `${option.label} ${option.description ?? ""} ${option.value}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  return <Field label={label}><Button disabled={disabled} testID={testID} onPress={() => { setQuery(""); setOpen(true); }}>{display ?? selected?.label ?? "—"}</Button>{open ? <Dialog title={label} onClose={() => setOpen(false)}><ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: 18, gap: 8 }}>{searchable ? <Input label={t("search")} value={query} onChangeText={setQuery} autoFocus /> : null}{visible.map(option => <View key={option.value} style={{ gap: 3 }}><Button disabled={option.disabled} selected={option.value === value} testID={option.testID} onPress={() => { onChange(option.value); setOpen(false); }}>{option.label}</Button>{option.description ? <Text style={{ color: colors.foregroundMuted }}>{option.description}</Text> : null}</View>)}{!visible.length ? <Text style={{ color: colors.foregroundMuted }}>{t("noOptions")}</Text> : null}</ScrollView></Dialog> : null}</Field>;
}
export function ErrorText({ children }: { children: string }) { const colors = useColors(); return <Text accessibilityRole="alert" selectable style={{ color: colors.statusDanger, fontSize: 14 }}>{children}</Text>; }
