#!/usr/bin/env node
import * as esbuild from "esbuild";
import { copyFileSync, mkdirSync, watch, existsSync } from "fs";
import { createServer } from "http";
import { readFileSync } from "fs";
import { resolve, dirname, extname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const deployDir = resolve(root, "deploy");

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
const PORT = 8090;

const MIME_TYPES = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".map": "application/json",
  ".css": "text/css",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

mkdirSync(deployDir, { recursive: true });

function copyHtml() {
  copyFileSync(
    resolve(root, "src/html/index.html"),
    resolve(deployDir, "index.html")
  );
}

async function build() {
  copyHtml();
  try {
    await esbuild.build({
      entryPoints: [resolve(root, "src/index.ts")],
      bundle: true,
      format: "esm",
      target: "es2020",
      outfile: resolve(deployDir, "app.js"),
      sourcemap: true,
      minify: false,
      logLevel: "silent",
      define: envDefines,
    });
    console.log(`[${new Date().toLocaleTimeString()}] Build OK`);
  } catch (err) {
    console.error(`[${new Date().toLocaleTimeString()}] Build FAILED:`, err.message);
  }
}

// Initial build
await build();

// File watcher
const srcDir = resolve(root, "src");
console.log(`[dev-server] Watching ${srcDir} for changes…`);

watch(srcDir, { recursive: true }, (event, filename) => {
  if (filename) {
    console.log(`[dev-server] Changed: ${filename}`);
    build();
  }
});

// HTTP server
const server = createServer((req, res) => {
  let urlPath = req.url ?? "/";
  if (urlPath === "/") urlPath = "/index.html";

  const filePath = resolve(deployDir, urlPath.slice(1));
  const ext = extname(filePath);
  const contentType = MIME_TYPES[ext] ?? "application/octet-stream";

  try {
    const content = readFileSync(filePath);
    res.writeHead(200, {
      "Content-Type": contentType,
      "Cache-Control": "no-cache",
      "Access-Control-Allow-Origin": "*",
    });
    res.end(content);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  }
});

server.listen(PORT, () => {
  console.log(`[dev-server] Listening on http://localhost:${PORT}`);
});
