import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/extension.ts"],
  format: ["cjs"],
  shims: false,
  // [중요] vscode는 제외하고, typescript는 번들에 포함시킴
  external: ["vscode"],
  noExternal: ["typescript"],
  splitting: false,
});
