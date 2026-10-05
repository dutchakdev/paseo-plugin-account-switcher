import type { PluginHandlerContext } from "@getpaseo/plugin/server";

// Paseo installs npm packages without devDependencies, so server code cannot
// name `@getpaseo/client` types directly. The host-provided SDK entry carries the same type.
export type PaseoApi = PluginHandlerContext["paseo"];
