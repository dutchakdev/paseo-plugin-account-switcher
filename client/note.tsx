import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { Text, View } from "react-native";
import { noteText, type AccountNote } from "../shared/timeline";
import { muted } from "./components";

/** One quiet timeline line: which account the agent runs on from here, and why when the plugin chose it. */
export function AccountNoteRow({ theme, item }: PluginTimelineItemProps<AccountNote>) {
  return <View accessibilityRole="text" style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 4 }}>
    <Icon name="Users" size={14} color={theme.colors.foregroundMuted} />
    <Text style={{ ...muted(theme), flexShrink: 1 }}>{noteText(item.data)}</Text>
  </View>;
}
