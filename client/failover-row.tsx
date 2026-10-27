import type { PluginCommandCapabilities, PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useRef, useState } from "react";
import { Text, View } from "react-native";
import { applyFailover } from "../shared/contracts";
import { failoverAction, failoverText, type FailoverRow } from "../shared/failover";
import { Button, muted } from "./components";
import { errorMessage } from "./format";

/** The local time a limit lifts: "18:00" today, with the day when it is another one. */
export function resetTime(value: string, now = Date.now()): string {
  const at = new Date(value);
  if (!Number.isFinite(at.getTime())) return value;
  const time = at.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  return at.toDateString() === new Date(now).toDateString() ? time : `${at.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}, ${time}`;
}

/** The failover row's renderer. It calls the RPC through the client handed in at registration, not `useRpc`:
 * an app may draw timeline rows outside the plugin's RPC provider, where the hook throws while rendering. */
export function createFailoverRow(rpc: PluginCommandCapabilities["rpc"]) {
  /** A turn ran out of its account's limit: the offer to switch, then what came of it. The daemon rewrites the row with the outcome. */
  return function FailoverRowView({ theme, agentId, item }: PluginTimelineItemProps<FailoverRow>) {
    // A synchronous lock also blocks a second press before React renders the pending state.
    const lock = useRef(false);
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const row = item.data, action = failoverAction(row);
    const press = () => {
      if (!action || lock.current) return;
      lock.current = true; setPending(true); setError(null);
      // The account the offer moves from lets the daemon refuse an offer that is out of date; older rows lack it.
      void rpc(applyFailover, { agentId, accountId: action.accountId, rowId: row.rowId, ...(row.fromId ? { fromId: row.fromId } : {}) })
        .catch((failure: unknown) => setError(errorMessage(failure)))
        .finally(() => { lock.current = false; setPending(false); });
    };
    const failed = row.state === "failed";
    return <View style={{ gap: 6, paddingVertical: 4 }}>
      <View accessibilityRole={failed ? "alert" : "text"} style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        <Icon name="Users" size={14} color={failed ? theme.colors.statusDanger : theme.colors.foregroundMuted} />
        <Text selectable style={{ ...muted(theme), ...(failed ? { color: theme.colors.statusDanger } : null), flexShrink: 1 }}>{failoverText(row, resetTime)}</Text>
      </View>
      {action ? <View style={{ alignSelf: "flex-start" }}>
        <Button theme={theme} variant="primary" disabled={pending} onPress={press}>{pending ? "Switching…" : action.label}</Button>
      </View> : null}
      {/* Once the daemon has rewritten the row, the row itself shows the reason. */}
      {action && error ? <Text selectable accessibilityRole="alert" style={{ ...muted(theme), color: theme.colors.statusDanger }}>{error}</Text> : null}
    </View>;
  };
}
