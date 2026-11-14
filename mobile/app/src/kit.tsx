/**
 * The pieces every screen is built from, as the mobile design draws them:
 * text styles, icons, status pills (a word, never colour alone), buttons
 * with 44-point targets, cards and the two-way tab. Colours come only from
 * the theme (`useTheme`).
 */
import { type ReactNode, useEffect, useState } from "react";
import {
  Pressable,
  type StyleProp,
  Text,
  type TextStyle,
  View,
  type ViewStyle,
} from "react-native";
import Svg, { Circle, Path } from "react-native-svg";
import type { Tone } from "./state/home.ts";
import { fonts, type Tokens, useTheme } from "./theme.ts";

/** The design's text styles. Sizes follow the phone's text size setting. */
export function type(t: Tokens) {
  return {
    body: {
      color: t.ink1,
      fontFamily: fonts.regular,
      fontSize: 15,
      lineHeight: 21,
    },
    bodyMuted: {
      color: t.ink2,
      fontFamily: fonts.regular,
      fontSize: 14,
      lineHeight: 20,
    },
    caption: {
      color: t.muted,
      fontFamily: fonts.regular,
      fontSize: 13,
      lineHeight: 18,
    },
    h1: { color: t.ink, fontFamily: fonts.bold, fontSize: 32, lineHeight: 38 },
    h2: { color: t.ink, fontFamily: fonts.bold, fontSize: 20, lineHeight: 26 },
    label: {
      color: t.muted,
      fontFamily: fonts.medium,
      fontSize: 13,
      letterSpacing: 0.6,
      textTransform: "uppercase",
    },
    mono: {
      color: t.ink2,
      fontFamily: fonts.mono,
      fontSize: 12,
      lineHeight: 17,
    },
    small: {
      color: t.ink2,
      fontFamily: fonts.regular,
      fontSize: 12,
      lineHeight: 16,
    },
    title: {
      color: t.ink,
      fontFamily: fonts.medium,
      fontSize: 16,
      lineHeight: 22,
    },
  } satisfies Record<string, TextStyle>;
}

/** The theme's tokens and text styles together. */
export function useLook(): { t: Tokens; text: ReturnType<typeof type> } {
  const t = useTheme();
  return { t, text: type(t) };
}

export type IconName =
  | "arrowRight"
  | "back"
  | "check"
  | "chevronDown"
  | "close"
  | "enter"
  | "plus"
  | "question"
  | "scan"
  | "send"
  | "settings";

/** The design's line icons; always beside words or with a label. */
export function Icon({
  color,
  name,
  size = 20,
}: {
  color: string;
  name: IconName;
  size?: number;
}) {
  const stroke = {
    fill: "none",
    stroke: color,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    strokeWidth: 2,
  };
  const paths: Record<IconName, ReactNode> = {
    arrowRight: <Path d="M5 12h14M13 6l6 6-6 6" {...stroke} />,
    back: <Path d="M15 6l-6 6 6 6" {...stroke} />,
    check: <Path d="M5 12l5 5L20 7" {...stroke} />,
    chevronDown: <Path d="M6 9l6 6 6-6" {...stroke} />,
    close: <Path d="M6 6l12 12M18 6L6 18" {...stroke} />,
    enter: <Path d="M9 10l-5 5 5 5M20 4v7a4 4 0 0 1-4 4H4" {...stroke} />,
    plus: <Path d="M12 5v14M5 12h14" {...stroke} />,
    question: (
      <>
        <Circle cx={12} cy={12} r={9} {...stroke} />
        <Path
          d="M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6V14M12 17h.01"
          {...stroke}
        />
      </>
    ),
    scan: (
      <Path
        d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3M8 12h8"
        {...stroke}
      />
    ),
    send: <Path d="M12 19V5M6 11l6-6 6 6" {...stroke} />,
    settings: (
      <>
        <Path d="M4 7h10M18 7h2M4 17h4M12 17h8" {...stroke} />
        <Circle cx={16} cy={7} r={2} {...stroke} />
        <Circle cx={10} cy={17} r={2} {...stroke} />
      </>
    ),
  };
  return (
    <Svg height={size} viewBox="0 0 24 24" width={size}>
      {paths[name]}
    </Svg>
  );
}

/** A status in a word, in its colour family. */
export function Pill({ label, tone }: { label: string; tone: Tone }) {
  const { t } = useLook();
  const look: Record<Tone, { bg: string; fg: string }> = {
    amber: { bg: t.amberChip, fg: t.amberInk },
    blue: { bg: t.blueChip, fg: t.accentInk },
    green: { bg: t.greenChip, fg: t.greenInk },
    plain: { bg: t.overlay, fg: t.ink2 },
  };
  return (
    <View
      style={{
        alignItems: "center",
        // Its own height, never the row's.
        alignSelf: "center",
        backgroundColor: look[tone].bg,
        borderRadius: 12,
        justifyContent: "center",
        minHeight: 24,
        paddingHorizontal: 10,
      }}
    >
      <Text
        style={{
          color: look[tone].fg,
          fontFamily: fonts.bold,
          fontSize: 12,
          letterSpacing: 0.3,
        }}
      >
        {label}
      </Text>
    </View>
  );
}

/** A small dot that only repeats what a word beside it says. */
export function Dot({ color, size = 8 }: { color: string; size?: number }) {
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no"
      style={{
        backgroundColor: color,
        borderRadius: size / 2,
        height: size,
        width: size,
      }}
    />
  );
}

/** How a button shows it can't be pressed, or is being pressed. */
function pressedOpacity(disabled: boolean, pressed: boolean): number {
  if (disabled) {
    return 0.5;
  }
  return pressed ? 0.8 : 1;
}

export type ButtonKind = "amber" | "danger" | "ghost" | "primary" | "soft";

/**
 * A button with words: at least 44 points to tap, however small it looks.
 */
export function Button({
  accessibilityLabel,
  icon,
  kind = "primary",
  label,
  onPress,
  disabled = false,
  wide = false,
  style,
}: {
  /** What a screen reader says, when the words alone don't say enough. */
  accessibilityLabel?: string;
  disabled?: boolean;
  icon?: IconName;
  kind?: ButtonKind;
  label: string;
  onPress: () => void;
  style?: StyleProp<ViewStyle>;
  wide?: boolean;
}) {
  const { t } = useLook();
  const look: Record<ButtonKind, { bg: string; border: string; fg: string }> = {
    amber: { bg: t.amberFill, border: t.amberFill, fg: t.onAmber },
    danger: { bg: "transparent", border: t.redLine, fg: t.red },
    ghost: { bg: "transparent", border: t.lineStrong, fg: t.ink1 },
    primary: { bg: t.accent, border: t.accent, fg: t.onAccent },
    soft: { bg: t.accentSoft, border: t.accentLine, fg: t.accentInk },
  };
  const { bg, border, fg } = look[kind];
  return (
    <Pressable
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      hitSlop={6}
      onPress={onPress}
      style={({ pressed }) => [
        {
          alignItems: "center",
          alignSelf: wide ? "stretch" : "flex-start",
          backgroundColor: bg,
          borderColor: border,
          borderRadius: 22,
          borderWidth: 1,
          flexDirection: "row",
          gap: 6,
          justifyContent: "center",
          minHeight: 44,
          opacity: pressedOpacity(disabled, pressed),
          paddingHorizontal: 16,
        },
        style,
      ]}
    >
      <Text style={{ color: fg, fontFamily: fonts.bold, fontSize: 14 }}>
        {label}
      </Text>
      {icon ? <Icon color={fg} name={icon} size={14} /> : null}
    </Pressable>
  );
}

/** A round 44-point button with only an icon: its label says what it does. */
export function IconButton({
  disabled = false,
  icon,
  label,
  onPress,
  plain = false,
  color,
  tint,
}: {
  color?: string;
  /** Says so to a screen reader, not only in colour. */
  disabled?: boolean;
  icon: IconName;
  label: string;
  onPress: () => void;
  plain?: boolean;
  /** A filled button's colour (Enter, Send). */
  tint?: string;
}) {
  const { t } = useLook();
  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        alignItems: "center",
        backgroundColor: tint ?? (plain ? "transparent" : t.card),
        borderColor: tint ?? (plain ? "transparent" : t.line),
        borderRadius: 22,
        borderWidth: 1,
        height: 44,
        justifyContent: "center",
        opacity: pressed ? 0.7 : 1,
        width: 44,
      })}
    >
      <Icon color={color ?? t.ink2} name={icon} />
    </Pressable>
  );
}

/** A card: the design's rounded surface. */
export function Card({
  children,
  style,
}: {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  const { t } = useLook();
  return (
    <View
      style={[
        {
          backgroundColor: t.card,
          borderColor: t.lineSoft,
          borderRadius: 16,
          borderWidth: 1,
          gap: 10,
          paddingHorizontal: 16,
          paddingVertical: 14,
        },
        style,
      ]}
    >
      {children}
    </View>
  );
}

/** The two-way tab (Readable | Terminal). */
export function Segmented<V extends string>({
  label,
  onChange,
  options,
  value,
}: {
  label: string;
  onChange: (value: V) => void;
  options: { label: string; value: V }[];
  value: V;
}) {
  const { t } = useLook();
  return (
    <View
      accessibilityLabel={label}
      accessibilityRole="tablist"
      style={{
        backgroundColor: t.overlay,
        borderRadius: 10,
        flexDirection: "row",
        gap: 3,
        padding: 3,
      }}
    >
      {options.map((option) => {
        const on = option.value === value;
        return (
          <Pressable
            accessibilityRole="tab"
            accessibilityState={{ selected: on }}
            key={option.value}
            onPress={() => onChange(option.value)}
            style={{
              alignItems: "center",
              backgroundColor: on ? t.lineStrong : "transparent",
              borderRadius: 8,
              flex: 1,
              justifyContent: "center",
              minHeight: 44,
            }}
          >
            <Text
              style={{
                color: on ? t.ink : t.ink2,
                fontFamily: on ? fonts.medium : fonts.regular,
                fontSize: 14,
              }}
            >
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** A screen's top bar: back (or close), a title, and what sits at the right. */
export function TopBar({
  back,
  backLabel = "Back to sessions",
  right,
  subtitle,
  title,
  closeIcon = false,
}: {
  back: () => void;
  backLabel?: string;
  closeIcon?: boolean;
  right?: ReactNode;
  subtitle?: string;
  title: string;
}) {
  const { t, text } = useLook();
  return (
    <View style={{ alignItems: "center", flexDirection: "row", gap: 4 }}>
      <IconButton
        color={closeIcon ? t.ink2 : t.accentInk}
        icon={closeIcon ? "close" : "back"}
        label={backLabel}
        onPress={back}
        plain
      />
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text accessibilityRole="header" numberOfLines={1} style={text.title}>
          {title}
        </Text>
        {subtitle ? (
          <Text numberOfLines={1} style={text.small}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {right ? <View style={{ marginRight: 8 }}>{right}</View> : null}
    </View>
  );
}

/** The time now, again every `everyMs`: for ages and running clocks. */
export function useNow(everyMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(tick);
  }, [everyMs]);
  return now;
}
