#!/usr/bin/env node
import * as esbuild from "esbuild";
import { copyFileSync, mkdirSync, readdirSync, readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

// ── Load .env into esbuild define map ────────────────────────────────────
function loadEnvDefines(envPath) {
  const defines = {};
  if (!existsSync(envPath)) return defines;
  const lines = readFileSync(envPath, "utf-8").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx < 0) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim();
    defines[`process.env.${key}`] = JSON.stringify(val);
  }
  return defines;
}

const envDefines = loadEnvDefines(resolve(root, ".env"));

mkdirSync(resolve(root, "deploy"), { recursive: true });

copyFileSync(
  resolve(root, "src/html/index.html"),
  resolve(root, "deploy/index.html")
);

const vendorSrc = resolve(root, "src/html/vendor");
const vendorDest = resolve(root, "deploy/vendor");
function copyDirRecursive(src, dest) {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const srcPath = resolve(src, entry.name);
    const destPath = resolve(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      copyFileSync(srcPath, destPath);
    }
  }
}
copyDirRecursive(vendorSrc, vendorDest);

await esbuild.build({
  entryPoints: [resolve(root, "src/index.ts")],
  bundle: true,
  format: "esm",
  target: "es2020",
  outfile: resolve(root, "deploy/app.js"),
  sourcemap: true,
  minify: false,
  logLevel: "info",
  define: envDefines,
});

console.log("Build complete → deploy/");
