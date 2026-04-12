import { rm } from "node:fs/promises";
import { build } from "esbuild";

const banner = [
  "#!/usr/bin/env node",
  'import { createRequire as __createRequire } from "node:module";',
  "const require = __createRequire(import.meta.url);"
].join("\n");

await rm("dist", { recursive: true, force: true });

await build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  minify: true,
  legalComments: "none",
  logLevel: "info",
  banner: { js: banner },
  loader: {
    ".wasm": "file"
  },
  outfile: "dist/plugin.js"
});
