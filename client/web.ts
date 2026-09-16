import { Linking, Platform } from "react-native";

// Keep browser globals inside this platform adapter, as required by the plugin SDK.
declare const window: { open(url: string, target: string, features: string): unknown };
declare const navigator: { readonly userAgent: string };

/** The desktop renderer has no public SDK API for opening the system browser. */
export function prefersCopiedLink(): boolean {
  return Platform.OS === "web" && /\bElectron\/\d/i.test(navigator.userAgent);
}

export async function openExternal(url: string): Promise<void> {
  if (prefersCopiedLink()) throw new Error("Copy the sign-in link and open it in your browser.");
  if (Platform.OS === "web") {
    window.open(url, "_blank", "noopener,noreferrer");
    return;
  }
  await Linking.openURL(url);
}
