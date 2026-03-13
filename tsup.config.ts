import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: ["src/index.ts"],
    format: ["esm", "cjs"],
    dts: true,
    clean: true,
    sourcemap: true,
    external: ["@anthropic-ai/sdk"],
  },
  {
    entry: ["src/cli.ts"],
    format: ["esm"],
    clean: false,
    sourcemap: false,
    banner: { js: "#!/usr/bin/env node" },
  },
]);
