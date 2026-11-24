import React, { createContext, useContext, useEffect, useRef, useState, type ComponentType, type ReactNode } from 'react';
import {
  Modal,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
  type StyleProp,
  type TextInputProps,
  type ViewStyle,
} from 'react-native';
import { AlertTriangle, ChevronDown, ChevronUp, Info, X } from 'lucide-react-native';
import type { QQPalette } from './palette.ts';

export const PaletteContext = createContext<QQPalette | null>(null);

export function usePalette(): QQPalette {
  const palette = useContext(PaletteContext);
  if (!palette) throw new Error('QQ UI components must render inside PaletteContext');
  return palette;
}

export type IconComponent = ComponentType<{ size?: number; color?: string }>;

export function SectionCard({
  title,
  subtitle,
  trailing,
  children,
  testID,
}: {
  title: string;
  subtitle?: string;
  trailing?: ReactNode;
  children: ReactNode;
  testID?: string;
}) {
  const p = usePalette();
  return (
    <View style={{ gap: 8 }} testID={testID}>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          paddingHorizontal: 2,
        }}
      >
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={{ fontSize: 13, fontWeight: '600', color: p.foregroundMuted }}>{title}</Text>
          {subtitle ? <Text style={{ fontSize: 12, color: p.foregroundExtraMuted }}>{subtitle}</Text> : null}
        </View>
        {trailing}
      </View>
      <View
        style={{
          backgroundColor: p.surface1,
          borderRadius: 10,
          borderWidth: 1,
          borderColor: p.border,
          overflow: 'hidden',
        }}
      >
        {children}
      </View>
    </View>
  );
}

export function SettingRow({
  title,
  hint,
  badge,
  bordered = false,
  stacked = false,
  children,
  testID,
}: {
  title: string;
  hint?: string;
  badge?: ReactNode;
  bordered?: boolean;
  stacked?: boolean;
  children?: ReactNode;
  testID?: string;
}) {
  const p = usePalette();
  return (
    <View
      testID={testID}
      style={{
        flexDirection: stacked ? 'column' : 'row',
        alignItems: stacked ? 'stretch' : 'center',
        justifyContent: 'space-between',
        gap: stacked ? 10 : 16,
        paddingHorizontal: 16,
        paddingVertical: 13,
        ...(bordered ? { borderTopWidth: 1, borderTopColor: p.border } : null),
      }}
    >
      <View style={stacked ? { gap: 3 } : { flex: 1, minWidth: 140, gap: 3 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <Text style={{ fontSize: 14, fontWeight: '500', color: p.foreground }}>{title}</Text>
          {badge}
        </View>
        {hint ? <Text style={{ fontSize: 12, lineHeight: 17, color: p.foregroundMuted }}>{hint}</Text> : null}
      </View>
      {children}
    </View>
  );
}

export function SwitchControl({
  value,
  onValueChange,
  disabled = false,
  accessibilityLabel,
  testID,
}: {
  value: boolean;
  onValueChange: (next: boolean) => void;
  disabled?: boolean;
  accessibilityLabel: string;
  testID?: string;
}) {
  const p = usePalette();
  return (
    <Pressable
      testID={testID}
      accessibilityRole="switch"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ checked: value, disabled }}
      aria-checked={value}
      disabled={disabled}
      onPress={() => onValueChange(!value)}
      hitSlop={6}
      style={{
        width: 42,
        height: 24,
        borderRadius: 12,
        padding: 2,
        justifyContent: 'center',
        alignItems: value ? 'flex-end' : 'flex-start',
        backgroundColor: value ? p.accent : p.surface3,
        opacity: disabled ? 0.5 : 1,
      }}
    >
      <View
        style={{
          width: 20,
          height: 20,
          borderRadius: 10,
          backgroundColor: value ? p.accentForeground : '#ffffff',
          shadowColor: 'rgba(0, 0, 0, 0.28)',
          shadowOffset: { width: 0, height: 1 },
          shadowRadius: 2,
          shadowOpacity: 1,
        }}
      />
    </Pressable>
  );
}

export type ButtonVariant = 'primary' | 'secondary' | 'outline' | 'ghost' | 'danger' | 'dangerOutline';

export function ActionButton({
  label,
  onPress,
  variant = 'secondary',
  size = 'sm',
  disabled = false,
  icon: Icon,
  testID,
  accessibilityLabel,
  style,
}: {
  label?: string;
  onPress: () => void;
  variant?: ButtonVariant;
  size?: 'xs' | 'sm' | 'md';
  disabled?: boolean;
  icon?: IconComponent;
  testID?: string;
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
}) {
  const p = usePalette();
  const [hovered, setHovered] = useState(false);
  const bg =
    variant === 'primary'
      ? p.accent
      : variant === 'secondary'
        ? hovered
          ? p.surface3
          : p.surface2
        : variant === 'danger'
          ? p.destructive
          : variant === 'ghost' && hovered
            ? p.surface2
            : variant === 'outline' && hovered
              ? p.surface2
              : 'transparent';
  const borderColor =
    variant === 'primary'
      ? p.accent
      : variant === 'danger'
        ? p.destructive
        : variant === 'dangerOutline'
          ? p.statusDanger
          : variant === 'outline' || variant === 'secondary'
            ? p.borderAccent
            : 'transparent';
  const textColor =
    variant === 'primary'
      ? p.accentForeground
      : variant === 'danger'
        ? p.destructiveForeground
        : variant === 'dangerOutline'
          ? p.statusDanger
          : variant === 'ghost' && !hovered
            ? p.foregroundMuted
            : p.foreground;
  const paddingHorizontal = size === 'xs' ? 8 : size === 'sm' ? 12 : 14;
  const minHeight = size === 'xs' ? 28 : size === 'sm' ? 32 : 36;
  const fontSize = size === 'xs' ? 12 : 13;
  const iconSize = size === 'xs' ? 13 : 14;
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      style={({ pressed }) => [
        {
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 6,
          minHeight,
          paddingHorizontal,
          paddingVertical: size === 'xs' ? 4 : 6,
          borderRadius: 7,
          borderWidth: 1,
          borderColor,
          backgroundColor: bg,
          opacity: disabled ? 0.45 : pressed ? 0.8 : 1,
        },
        style,
      ]}
    >
      {Icon ? <Icon size={iconSize} color={textColor} /> : null}
      {label ? (
        <Text numberOfLines={1} style={{ fontSize, fontWeight: '500', color: textColor }}>
          {label}
        </Text>
      ) : null}
    </Pressable>
  );
}

export interface SegmentedOption<T extends string> {
  readonly value: T;
  readonly label: string;
  readonly badge?: string | number;
  readonly icon?: IconComponent;
  readonly disabled?: boolean;
  readonly testID?: string;
}

export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  disabled = false,
  fullWidth = false,
  testID,
}: {
  options: readonly SegmentedOption<T>[];
  value: T;
  onChange: (next: T) => void;
  disabled?: boolean;
  fullWidth?: boolean;
  testID?: string;
}) {
  const p = usePalette();
  return (
    <View
      testID={testID}
      style={{
        flexDirection: 'row',
        flexWrap: fullWidth ? 'wrap' : 'nowrap',
        alignItems: 'center',
        gap: 3,
        padding: 3,
        borderRadius: 9,
        backgroundColor: p.surface2,
        borderWidth: 1,
        borderColor: p.border,
        alignSelf: fullWidth ? 'stretch' : 'flex-start',
      }}
    >
      {options.map(option => {
        const selected = option.value === value;
        const itemDisabled = disabled || option.disabled;
        const Icon = option.icon;
        return (
          <Pressable
            key={option.value}
            testID={option.testID}
            accessibilityRole="button"
            accessibilityState={{ selected, disabled: itemDisabled }}
            aria-selected={selected}
            disabled={itemDisabled}
            onPress={() => {
              if (!itemDisabled && option.value !== value) onChange(option.value);
            }}
            style={({ pressed }) => ({
              flex: fullWidth ? 1 : undefined,
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 6,
              paddingHorizontal: 11,
              paddingVertical: 6,
              minHeight: 30,
              borderRadius: 6,
              backgroundColor: selected ? p.surface0 : 'transparent',
              borderWidth: 1,
              borderColor: selected ? p.borderAccent : 'transparent',
              opacity: itemDisabled ? 0.45 : pressed ? 0.8 : 1,
            })}
          >
            {Icon ? <Icon size={14} color={selected ? p.foreground : p.foregroundMuted} /> : null}
            <Text
              numberOfLines={1}
              style={{
                fontSize: 13,
                fontWeight: selected ? '600' : '400',
                color: selected ? p.foreground : p.foregroundMuted,
              }}
            >
              {option.label}
            </Text>
            {option.badge !== undefined ? (
              <View
                style={{
                  paddingHorizontal: 5,
                  paddingVertical: 1,
                  borderRadius: 10,
                  backgroundColor: selected ? p.surface2 : p.surface3,
                }}
              >
                <Text style={{ fontSize: 11, fontWeight: '500', color: p.foregroundMuted }}>
                  {String(option.badge)}
                </Text>
              </View>
            ) : null}
          </Pressable>
        );
      })}
    </View>
  );
}

export function Badge({
  label,
  tone = 'neutral',
  mono = false,
}: {
  label: string;
  tone?: 'neutral' | 'accent' | 'success' | 'warning' | 'danger';
  mono?: boolean;
}) {
  const p = usePalette();
  const color =
    tone === 'accent'
      ? p.accent
      : tone === 'success'
        ? p.statusSuccess
        : tone === 'warning'
          ? p.statusWarning
          : tone === 'danger'
            ? p.statusDanger
            : p.foregroundMuted;
  return (
    <View
      style={{
        paddingHorizontal: 7,
        paddingVertical: 2,
        borderRadius: 6,
        borderWidth: 1,
        borderColor: tone === 'neutral' ? p.borderAccent : color,
        backgroundColor: p.surface0,
      }}
    >
      <Text
        numberOfLines={1}
        style={{
          fontSize: 11,
          fontWeight: '500',
          color,
          ...(mono ? { fontFamily: p.monoFont } : null),
        }}
      >
        {label}
      </Text>
    </View>
  );
}

export function StatusPill({
  label,
  tone,
  testID,
}: {
  label: string;
  tone: 'ready' | 'connecting' | 'waiting' | 'failed' | 'disabled';
  testID?: string;
}) {
  const p = usePalette();
  const dotColor =
    tone === 'ready'
      ? p.dotSuccess
      : tone === 'connecting'
        ? p.dotRunning
        : tone === 'waiting'
          ? p.dotWarning
          : tone === 'failed'
            ? p.dotDanger
            : p.foregroundExtraMuted;
  const textColor = tone === 'failed' ? p.statusDanger : p.foreground;
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 7,
        paddingHorizontal: 10,
        paddingVertical: 4,
        borderRadius: 999,
        backgroundColor: p.surface2,
        borderWidth: 1,
        borderColor: tone === 'failed' ? p.statusDanger : p.border,
      }}
    >
      <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: dotColor }} />
      <Text testID={testID} style={{ fontSize: 12, fontWeight: '500', color: textColor }}>
        {label}
      </Text>
    </View>
  );
}

export function InlineBanner({
  tone = 'info',
  message,
  action,
  role,
}: {
  tone?: 'info' | 'warning' | 'danger';
  message: string;
  action?: ReactNode;
  role?: 'alert';
}) {
  const p = usePalette();
  const color = tone === 'danger' ? p.statusDanger : tone === 'warning' ? p.statusWarning : p.foregroundMuted;
  const Icon = tone === 'info' ? Info : AlertTriangle;
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
        flexWrap: 'wrap',
        paddingHorizontal: 13,
        paddingVertical: 10,
        borderRadius: 8,
        backgroundColor: p.surface2,
        borderWidth: 1,
        borderColor: tone === 'info' ? p.border : color,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 8, flex: 1, minWidth: 180 }}>
        <View style={{ marginTop: 1 }}>
          <Icon size={15} color={color} />
        </View>
        <Text
          accessibilityRole={role}
          style={{
            flex: 1,
            fontSize: 12,
            lineHeight: 18,
            color: tone === 'danger' ? p.statusDanger : p.foreground,
          }}
        >
          {message}
        </Text>
      </View>
      {action}
    </View>
  );
}

export function TextField({
  label,
  hint,
  error,
  mono = false,
  compact = false,
  suffix,
  style,
  ...inputProps
}: TextInputProps & {
  label?: string;
  hint?: string;
  error?: string | null;
  mono?: boolean;
  compact?: boolean;
  suffix?: string;
}) {
  const p = usePalette();
  const [focused, setFocused] = useState(false);
  return (
    <View style={{ gap: 5 }}>
      {label ? <Text style={{ fontSize: 13, fontWeight: '500', color: p.foreground }}>{label}</Text> : null}
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <TextInput
          {...inputProps}
          placeholderTextColor={p.foregroundExtraMuted}
          onFocus={event => {
            setFocused(true);
            inputProps.onFocus?.(event);
          }}
          onBlur={event => {
            setFocused(false);
            inputProps.onBlur?.(event);
          }}
          style={[
            {
              flex: 1,
              minHeight: inputProps.multiline ? 88 : compact ? 32 : 36,
              paddingHorizontal: 11,
              paddingVertical: inputProps.multiline ? 9 : 6,
              borderRadius: 7,
              borderWidth: 1,
              borderColor: error ? p.statusDanger : focused ? p.accent : p.borderAccent,
              backgroundColor: p.surface0,
              color: p.foreground,
              fontSize: 13,
              ...(mono ? { fontFamily: p.monoFont } : null),
              ...(inputProps.multiline ? { textAlignVertical: 'top' as const } : null),
              ...(inputProps.editable === false ? { opacity: 0.6 } : null),
            },
            style,
          ]}
        />
        {suffix ? <Text style={{ fontSize: 12, color: p.foregroundMuted }}>{suffix}</Text> : null}
      </View>
      {error ? (
        <Text accessibilityRole="alert" style={{ fontSize: 12, color: p.statusDanger }}>
          {error}
        </Text>
      ) : hint ? (
        <Text style={{ fontSize: 12, lineHeight: 16, color: p.foregroundMuted }}>{hint}</Text>
      ) : null}
    </View>
  );
}

export function NumberSettingRow({
  title,
  hint,
  value,
  min,
  max,
  step = 1,
  unit,
  disabled,
  bordered = true,
  accessibilityLabel,
  onCommit,
}: {
  title: string;
  hint?: string;
  value: number;
  min: number;
  max?: number;
  step?: number;
  unit?: string;
  disabled: boolean;
  bordered?: boolean;
  accessibilityLabel: string;
  onCommit: (next: number) => void;
}) {
  const p = usePalette();
  const [text, setText] = useState(String(value));
  const [focused, setFocused] = useState(false);
  const [invalid, setInvalid] = useState<string | null>(null);
  const valueAtFocus = useRef(value);

  useEffect(() => {
    if (!focused) {
      setText(String(value));
      setInvalid(null);
    }
  }, [value, focused]);

  const handleChange = (raw: string) => {
    setText(raw);
    const trimmed = raw.trim();
    if (!trimmed) {
      setInvalid(max === undefined ? `请输入不少于 ${min} 的整数` : `范围 ${min}–${max}`);
      return;
    }
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed) || (step === 1 && !Number.isSafeInteger(parsed))) {
      setInvalid('请输入有效整数');
      return;
    }
    if (parsed < min || (max !== undefined && parsed > max)) {
      setInvalid(max === undefined ? `至少 ${min}` : `需在 ${min}–${max} 之间`);
      return;
    }
    setInvalid(null);
    if (parsed !== value) onCommit(parsed);
  };

  const handleBlur = () => {
    setFocused(false);
    if (invalid) {
      setText(String(valueAtFocus.current));
      setInvalid(null);
      if (value !== valueAtFocus.current) onCommit(valueAtFocus.current);
    }
  };

  return (
    <SettingRow title={title} hint={hint} bordered={bordered}>
      <View style={{ alignItems: 'flex-end', gap: 4 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <TextField
            accessibilityLabel={accessibilityLabel}
            value={text}
            editable={!disabled}
            compact
            mono
            keyboardType="numeric"
            onFocus={() => {
              valueAtFocus.current = value;
              setFocused(true);
            }}
            onBlur={handleBlur}
            onChangeText={handleChange}
            style={{ width: 92, textAlign: 'right' }}
          />
          {unit ? <Text style={{ fontSize: 12, color: p.foregroundMuted, minWidth: 28 }}>{unit}</Text> : null}
        </View>
        {invalid ? <Text style={{ fontSize: 11, color: p.statusDanger }}>{invalid}</Text> : null}
      </View>
    </SettingRow>
  );
}

export function CollapsibleRow({
  title,
  hint,
  badge,
  open,
  onToggle,
  bordered = false,
  children,
  testID,
}: {
  title: string;
  hint?: string;
  badge?: ReactNode;
  open: boolean;
  onToggle: () => void;
  bordered?: boolean;
  children: ReactNode;
  testID?: string;
}) {
  const p = usePalette();
  return (
    <View style={bordered ? { borderTopWidth: 1, borderTopColor: p.border } : undefined}>
      <Pressable
        testID={testID}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={onToggle}
        style={({ pressed }) => ({
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          paddingHorizontal: 16,
          paddingVertical: 12,
          opacity: pressed ? 0.75 : 1,
        })}
      >
        <View style={{ flex: 1, gap: 2 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <Text style={{ fontSize: 13, fontWeight: '500', color: p.foreground }}>{title}</Text>
            {badge}
          </View>
          {hint ? <Text style={{ fontSize: 12, color: p.foregroundMuted }}>{hint}</Text> : null}
        </View>
        {open ? <ChevronUp size={16} color={p.foregroundMuted} /> : <ChevronDown size={16} color={p.foregroundMuted} />}
      </Pressable>
      {open ? <View style={{ borderTopWidth: 1, borderTopColor: p.border }}>{children}</View> : null}
    </View>
  );
}

export function ModalSheet({
  title,
  subtitle,
  onClose,
  children,
  testID,
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
  testID?: string;
}) {
  const p = usePalette();
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <View
        style={{
          flex: 1,
          justifyContent: 'center',
          alignItems: 'center',
          padding: 16,
          backgroundColor: 'rgba(0, 0, 0, 0.55)',
        }}
      >
        <View
          accessibilityViewIsModal
          testID={testID}
          style={{
            width: '100%',
            maxWidth: 640,
            maxHeight: '86%',
            borderRadius: 12,
            backgroundColor: p.surface1,
            borderWidth: 1,
            borderColor: p.borderAccent,
            overflow: 'hidden',
            shadowColor: 'rgba(0, 0, 0, 0.45)',
            shadowOffset: { width: 0, height: 12 },
            shadowRadius: 32,
            shadowOpacity: 1,
          }}
        >
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 12,
              paddingHorizontal: 16,
              paddingVertical: 13,
              borderBottomWidth: 1,
              borderBottomColor: p.border,
            }}
          >
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={{ fontSize: 15, fontWeight: '600', color: p.foreground }}>{title}</Text>
              {subtitle ? <Text style={{ fontSize: 12, color: p.foregroundMuted }}>{subtitle}</Text> : null}
            </View>
            <ActionButton icon={X} variant="ghost" size="xs" accessibilityLabel="关闭" onPress={onClose} />
          </View>
          <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: 16, gap: 12 }}>
            {children}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}
