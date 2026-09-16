import { useRpc } from "@getpaseo/plugin/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { listAccounts, listUsage } from "../shared/contracts";

export const accountsKey = (hostId: string) => ["account-switcher", hostId, "accounts"] as const;
export const usageKey = (hostId: string) => ["account-switcher", hostId, "usage"] as const;

export function useAccountsData(hostId: string) {
  const accountsRpc = useRpc(listAccounts);
  const usageRpc = useRpc(listUsage);
  const accounts = useQuery({ queryKey: accountsKey(hostId), queryFn: () => accountsRpc({}), refetchInterval: 5_000, retry: 1 });
  // Each mounted surface/dialog renews the foreground lease; collection is throttled by the daemon.
  const usage = useQuery({ queryKey: usageKey(hostId), queryFn: () => usageRpc({ visible: true }), refetchInterval: 30_000, retry: 1 });
  return { accounts, usage };
}

export function useNow() {
  const [now, setNow] = useState(Date.now);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 15_000); return () => clearInterval(timer); }, []);
  return now;
}

// A synchronous lock also blocks a second press before React renders mutation.isPending.
export function useAction(hostId: string, onChanged?: () => void) {
  const cache = useQueryClient();
  const lock = useRef(false);
  const mutation = useMutation({
    mutationFn: async (action: () => Promise<unknown>) => action(),
    onSettled: async () => {
      // Account creation can succeed before authorization startup fails.
      try {
        await Promise.all([
          cache.invalidateQueries({ queryKey: accountsKey(hostId) }),
          cache.invalidateQueries({ queryKey: usageKey(hostId) }),
        ]);
        onChanged?.();
      } finally { lock.current = false; }
    },
  });
  const run = (action: () => Promise<unknown>) => {
    if (lock.current) return;
    lock.current = true;
    mutation.mutate(action);
  };
  return { ...mutation, run };
}
