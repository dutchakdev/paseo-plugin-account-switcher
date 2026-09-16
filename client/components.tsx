import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useState, type ReactNode } from "react";
import { Pressable, Text, TextInput, View, type TextInputProps, type TextStyle, type ViewStyle } from "react-native";
import type { UsageSnapshot, UsageWindow } from "../shared/contracts";
import { freshness, localDate, percent, quotaTone, remainingPercent, shortCountdown, splitWindows, targetSlop, windowIsExpired, windowLength, type Tone } from "./format";

export type ThemeProps = { theme: PluginTheme };
export const row: ViewStyle = { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 8 };
export const tabular: TextStyle = { fontVariant: ["tabular-nums"] };
export const muted = (theme: PluginTheme): TextStyle => ({ color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: 17 });
export const body = (theme: PluginTheme): TextStyle => ({ color: theme.colors.foreground, fontSize: 13, lineHeight: 18 });
export const heading = (theme: PluginTheme): TextStyle => ({ color: theme.colors.foreground, fontSize: 15, lineHeight: 20, fontWeight: "600" });

export function toneColor(theme: PluginTheme, tone: Tone): string {
  return tone === "success" ? theme.colors.statusSuccess : tone === "warning" ? theme.colors.statusWarning
    : tone === "danger" ? theme.colors.statusDanger : theme.colors.foregroundMuted;
}

// Keep the actual box tappable: hitSlop is clipped by a parent's bounds on native.
const hitSlop = targetSlop(44);

export function Button({ theme, children, onPress, disabled, variant = "secondary", label }: ThemeProps & {
  children: ReactNode; onPress(): void; disabled?: boolean; variant?: "primary" | "secondary" | "ghost" | "danger"; label?: string;
}) {
  const primary = variant === "primary";
  const textColor = primary ? theme.colors.accentForeground : variant === "danger" ? theme.colors.statusDanger : theme.colors.foreground;
  return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled: Boolean(disabled) }} hitSlop={hitSlop}
    disabled={disabled} onPress={onPress} style={({ pressed }) => ({
      minHeight: 44, paddingHorizontal: variant === "ghost" ? 8 : 12, borderRadius: 8, justifyContent: "center",
      backgroundColor: primary ? theme.colors.accent : variant === "ghost" ? "transparent" : theme.colors.surface2,
      borderWidth: variant === "ghost" ? 0 : 1, borderColor: primary ? theme.colors.accent : theme.colors.border,
      opacity: disabled ? 0.45 : pressed ? 0.7 : 1,
    })}>
    <Text numberOfLines={1} style={{ color: textColor, fontSize: 13, fontWeight: "600", textAlign: "center" }}>{children}</Text>
  </Pressable>;
}

export function IconButton({ theme, icon, label, onPress, disabled, active }: ThemeProps & {
  icon: string; label: string; onPress(): void; disabled?: boolean; active?: boolean;
}) {
  return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled: Boolean(disabled), expanded: active }}
    hitSlop={hitSlop} disabled={disabled} onPress={onPress} style={({ pressed }) => ({
      width: 44, height: 44, borderRadius: 8, alignItems: "center", justifyContent: "center",
      backgroundColor: active ? theme.colors.surface2 : "transparent", opacity: disabled ? 0.45 : pressed ? 0.7 : 1,
    })}>
    <Icon name={icon} size={18} color={theme.colors.foreground} />
  </Pressable>;
}

/** Small text-only action inside a line of muted text. */
export function InlineAction({ theme, children, onPress, disabled }: ThemeProps & { children: ReactNode; onPress(): void; disabled?: boolean }) {
  return <Pressable accessibilityRole="button" accessibilityState={{ disabled: Boolean(disabled) }} hitSlop={targetSlop(44, 6)} disabled={disabled} onPress={onPress}
    style={({ pressed }) => ({ minHeight: 44, justifyContent: "center", opacity: disabled ? 0.45 : pressed ? 0.7 : 1 })}>
    <Text style={{ color: theme.colors.foreground, fontSize: 12, fontWeight: "600" }}>{children}</Text>
  </Pressable>;
}

export function Notice({ theme, children, tone = "muted" }: ThemeProps & { children: ReactNode; tone?: Tone }) {
  const color = toneColor(theme, tone);
  return <View accessibilityRole={tone === "danger" ? "alert" : undefined}
    style={{ borderLeftWidth: 2, borderLeftColor: color, paddingLeft: 10, paddingVertical: 2 }}>
    <Text selectable style={{ ...body(theme), color: tone === "muted" ? theme.colors.foregroundMuted : color }}>{children}</Text>
  </View>;
}

export function StatusDot({ theme, tone }: ThemeProps & { tone: Tone }) {
  return <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: toneColor(theme, tone) }} />;
}

export function Segmented<Value extends string>({ theme, value, options, onChange, disabled, label }: ThemeProps & {
  value: Value; options: readonly { value: Value; label: string }[]; onChange(value: Value): void; disabled?: boolean; label: string;
}) {
  return <View accessibilityRole="radiogroup" accessibilityLabel={label} style={{ flexDirection: "row", borderWidth: 1, borderColor: theme.colors.border, borderRadius: 8, overflow: "hidden", alignSelf: "flex-start" }}>
    {options.map((option) => {
      const selected = option.value === value;
      return <Pressable key={option.value} accessibilityRole="radio" accessibilityState={{ selected, checked: selected, disabled: Boolean(disabled) }} disabled={disabled}
        hitSlop={targetSlop(44, 0)} onPress={() => onChange(option.value)} style={({ pressed }) => ({
          minHeight: 44, paddingHorizontal: 12, justifyContent: "center",
          backgroundColor: selected ? theme.colors.surface2 : "transparent", opacity: disabled ? 0.45 : pressed ? 0.7 : 1,
        })}>
        <Text style={{ ...body(theme), fontWeight: selected ? "600" : "400" }}>{option.label}</Text>
      </Pressable>;
    })}
  </View>;
}

export function Field({ theme, ...props }: ThemeProps & TextInputProps) {
  return <TextInput placeholderTextColor={theme.colors.foregroundMuted} {...props}
    style={{ ...body(theme), minHeight: 44, borderWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.surface0, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8, flexGrow: 1, minWidth: 160 }} />;
}

export function Disclosure({ theme, title, open, onToggle, children }: ThemeProps & { title: string; open: boolean; onToggle(): void; children: ReactNode }) {
  return <View style={{ gap: 6 }}>
    <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} hitSlop={targetSlop(44)} onPress={onToggle}
      style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", gap: 4, minHeight: 44, alignSelf: "flex-start", opacity: pressed ? 0.7 : 1 })}>
      <Icon name={open ? "ChevronDown" : "ChevronRight"} size={14} color={theme.colors.foregroundMuted} />
      <Text style={muted(theme)}>{title}</Text>
    </Pressable>
    {open ? children : null}
  </View>;
}

export function Meter({ theme, used }: ThemeProps & { used: number | null }) {
  const width = used === null || !Number.isFinite(used) ? 0 : Math.min(100, Math.max(0, used));
  return <View accessibilityRole="progressbar" accessibilityValue={used === null ? { text: "Unknown" } : { min: 0, max: 100, now: width }}
    style={{ height: 4, borderRadius: 2, overflow: "hidden", backgroundColor: theme.colors.surface2, flexGrow: 1 }}>
    <View style={{ height: 4, width: `${width}%`, backgroundColor: toneColor(theme, quotaTone(used)) }} />
  </View>;
}

/** One quota on one line: label · meter · used/left · countdown. Expired windows keep the last value and say so. */
export function QuotaWindowRow({ theme, quota, now }: ThemeProps & { quota: UsageWindow; now: number }) {
  const tone = quotaTone(quota.usedPercent);
  const expired = windowIsExpired(quota, now);
  const unknown = quota.usedPercent === null || !Number.isFinite(quota.usedPercent);
  return <View accessibilityLabel={`${quota.label}: ${percent(quota.usedPercent)} used, ${shortCountdown(quota.resetsAt, now)}`} style={{ gap: 3 }}>
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
      <Text numberOfLines={1} style={{ ...body(theme), flexShrink: 1, minWidth: 56 }}>{quota.label}</Text>
      <Text style={{ ...muted(theme), ...tabular, color: unknown ? theme.colors.foregroundMuted : toneColor(theme, tone), fontWeight: "600", marginLeft: "auto" }}>
        {unknown ? "no data" : `${percent(quota.usedPercent)} · ${percent(remainingPercent(quota.usedPercent))} left`}
      </Text>
    </View>
    <Meter theme={theme} used={quota.usedPercent} />
    <Text style={{ ...muted(theme), ...tabular, fontSize: 11, lineHeight: 14, color: expired ? theme.colors.statusWarning : theme.colors.foregroundMuted }}>
      {expired ? "reset time passed · last known data" : shortCountdown(quota.resetsAt, now)}
    </Text>
  </View>;
}

function DetailLine({ theme, children }: ThemeProps & { children: ReactNode }) {
  return <Text selectable style={{ ...muted(theme), ...tabular }}>{children}</Text>;
}

/**
 * Compact quota block: measured windows first, then one disclosure with the windows without data,
 * exact reset times, quota lengths and fetch timestamps. Errors and freshness are always visible.
 */
export function QuotaSummary({ theme, snapshot, now, compact, onRefresh, refreshing }: ThemeProps & {
  snapshot: UsageSnapshot | undefined; now: number; compact: boolean; onRefresh?: () => void; refreshing?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const { known, unknown } = snapshot ? splitWindows(snapshot.windows) : { known: [], unknown: [] };
  const fresh = freshness(snapshot, now);
  const detailsTitle = unknown.length ? `${unknown.length} more without data · details` : "Details";
  return <View style={{ gap: 8 }}>
    {known.length ? <View style={{ flexDirection: "row", flexWrap: "wrap", gap: compact ? 8 : 10 }}>
      {known.map((quota) => <View key={quota.id} style={{ flexGrow: 1, flexBasis: compact ? "100%" : "46%", minWidth: 0 }}>
        <QuotaWindowRow theme={theme} quota={quota} now={now} />
      </View>)}
    </View> : snapshot && snapshot.status !== "needs_auth" ? <Text style={muted(theme)}>{snapshot.windows.length ? "The provider did not return limit values." : "The provider has not returned limit windows yet."}</Text> : null}
    {snapshot?.error ? <Notice theme={theme} tone="danger">{snapshot.error}</Notice> : null}
    <View style={{ ...row, gap: 10 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        <StatusDot theme={theme} tone={fresh.tone} />
        <Text style={{ ...muted(theme), color: fresh.tone === "muted" ? theme.colors.foregroundMuted : toneColor(theme, fresh.tone) }}>{fresh.text}{snapshot?.plan ? ` · ${snapshot.plan}` : ""}</Text>
      </View>
      {onRefresh ? <InlineAction theme={theme} disabled={refreshing} onPress={onRefresh}>{refreshing ? "Refreshing…" : "Refresh"}</InlineAction> : null}
    </View>
    {snapshot ? <Disclosure theme={theme} title={detailsTitle} open={open} onToggle={() => setOpen(!open)}>
      <View style={{ gap: 4, paddingLeft: 18 }}>
        {snapshot.windows.map((quota) => <DetailLine key={quota.id} theme={theme}>
          {quota.label}: {quota.usedPercent === null ? "no data" : `${percent(quota.usedPercent)} used`}
          {quota.resetsAt ? ` · resets ${localDate(quota.resetsAt)}` : " · reset time unknown"}
          {windowLength(quota.windowDurationMins) ? ` · period ${windowLength(quota.windowDurationMins)}` : ""}
        </DetailLine>)}
        <DetailLine theme={theme}>Fetched: {localDate(snapshot.fetchedAt)} · checked: {localDate(snapshot.checkedAt)}</DetailLine>
        {snapshot.nextRetryAt ? <DetailLine theme={theme}>Next attempt: {localDate(snapshot.nextRetryAt)}</DetailLine> : null}
        <DetailLine theme={theme}>Reset times use your local time zone.</DetailLine>
      </View>
    </Disclosure> : null}
  </View>;
}
