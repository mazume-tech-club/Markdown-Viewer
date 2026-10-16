declare module "markdown-it-task-lists" {
  import type { PluginWithOptions } from "markdown-it";
  const plugin: PluginWithOptions<{ enabled?: boolean; label?: boolean }>;
  export default plugin;
}
declare module "markdown-it-footnote" {
  import type { PluginSimple } from "markdown-it";
  const plugin: PluginSimple;
  export default plugin;
}
declare module "wavedrom" {
  export function renderAny(index: number, source: unknown, waveSkin: unknown): unknown;
  export const waveSkin: unknown;
  export const onml: { stringify(jsonml: unknown): string };
}
