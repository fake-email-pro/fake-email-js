import { readFileSync } from "node:fs";
import { defineConfig } from "tsup";

const { version } = JSON.parse(readFileSync("./package.json", "utf8")) as { version: string };

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  target: "node18",
  platform: "neutral",
  // package.json is the single source of the version; the User-Agent reads it from here.
  define: { __SDK_VERSION__: JSON.stringify(version) },
});
