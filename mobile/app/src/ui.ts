/**
 * The phone's look: the desktop's Steel theme, from the same theme files,
 * and the few shapes the screens share.
 */
import { StyleSheet } from "react-native";
import { steel } from "../../../src/theme/themes/steel.ts";

export const { colors } = steel;

export const ui = StyleSheet.create({
  button: {
    alignItems: "center",
    backgroundColor: colors.accent,
    borderRadius: 8,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  buttonText: {
    color: colors.onAccent,
    fontSize: 15,
    fontWeight: "600",
  },
  ghostButton: {
    alignItems: "center",
    borderColor: colors.border,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  ghostButtonText: {
    color: colors.inkPrimary,
    fontSize: 15,
  },
  /** A text field. */
  input: {
    borderColor: colors.border,
    borderRadius: 8,
    borderWidth: 1,
    color: colors.inkBright,
    padding: 10,
  },
  hint: {
    color: colors.inkMuted,
    fontSize: 13,
    lineHeight: 18,
  },
  row: {
    alignItems: "center",
    borderBottomColor: colors.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    gap: 10,
    paddingVertical: 12,
  },
  rowTitle: {
    color: colors.inkBright,
    flex: 1,
    fontSize: 15,
  },
  screen: {
    backgroundColor: colors.chromeWindow,
    flex: 1,
  },
  sectionLabel: {
    color: colors.inkMuted,
    fontSize: 12,
    fontWeight: "600",
    letterSpacing: 0.6,
    marginTop: 20,
    textTransform: "uppercase",
  },
  title: {
    color: colors.inkBright,
    fontSize: 22,
    fontWeight: "600",
  },
});
