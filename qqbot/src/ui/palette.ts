import type { PluginTheme } from '@omp-desktop/plugin';
import { useUnistyles } from 'react-native-unistyles';

export interface QQPalette {
  readonly surface0: string;
  readonly surface1: string;
  readonly surface2: string;
  readonly surface3: string;
  readonly border: string;
  readonly borderAccent: string;
  readonly foreground: string;
  readonly foregroundMuted: string;
  readonly foregroundExtraMuted: string;
  readonly accent: string;
  readonly accentForeground: string;
  readonly destructive: string;
  readonly destructiveForeground: string;
  readonly statusSuccess: string;
  readonly statusWarning: string;
  readonly statusDanger: string;
  readonly dotSuccess: string;
  readonly dotWarning: string;
  readonly dotDanger: string;
  readonly dotRunning: string;
  readonly monoFont: string;
}

interface HostThemeShape {
  readonly colors?: Partial<Record<string, string>>;
  readonly fontFamily?: { readonly mono?: string };
}

export function useQQPalette(hostTheme: PluginTheme): QQPalette {
  let host: HostThemeShape | undefined;
  try {
    host = useUnistyles().theme as unknown as HostThemeShape;
  } catch {
    host = undefined;
  }
  const u = host?.colors;
  const c = hostTheme.colors;
  return {
    surface0: c.surface0,
    surface1: u?.surface1 ?? 'rgba(127, 127, 127, 0.08)',
    surface2: u?.surface2 ?? 'rgba(127, 127, 127, 0.14)',
    surface3: u?.surface3 ?? 'rgba(127, 127, 127, 0.24)',
    border: u?.border ?? 'rgba(127, 127, 127, 0.22)',
    borderAccent: u?.borderAccent ?? 'rgba(127, 127, 127, 0.36)',
    foreground: u?.foreground ?? c.foreground,
    foregroundMuted: u?.foregroundMuted ?? c.foregroundMuted,
    foregroundExtraMuted: u?.foregroundExtraMuted ?? c.foregroundMuted,
    accent: u?.accent ?? c.accent,
    accentForeground: u?.accentForeground ?? c.accentForeground,
    destructive: u?.destructive ?? c.statusDanger,
    destructiveForeground: u?.destructiveForeground ?? '#ffffff',
    statusSuccess: u?.statusSuccess ?? '#4ade80',
    statusWarning: u?.statusWarning ?? '#d4a44a',
    statusDanger: u?.statusDanger ?? c.statusDanger,
    dotSuccess: u?.statusDotSuccess ?? u?.statusSuccess ?? '#35c264',
    dotWarning: u?.statusDotWarning ?? u?.statusWarning ?? '#db932e',
    dotDanger: u?.statusDotDanger ?? u?.statusDanger ?? c.statusDanger,
    dotRunning: u?.statusDotRunning ?? u?.accent ?? c.accent,
    monoFont: host?.fontFamily?.mono ?? 'monospace',
  };
}
