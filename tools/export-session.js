import { chromium } from "playwright";
import fs from "node:fs/promises";
import path from "node:path";

const name = String(process.argv[2] || "akun-1")
  .toLowerCase()
  .replace(/[^a-z0-9_-]+/g, "-")
  .replace(/^-+|-+$/g, "") || "akun-1";

const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
const contexts = browser.contexts();
if (!contexts.length) throw new Error("Chrome context tidak ditemukan pada port 9222.");

const outDir = path.resolve("data");
await fs.mkdir(outDir, { recursive: true });
const out = path.join(outDir, `${name}.json`);
await contexts[0].storageState({ path: out });
console.log(`Session tersimpan: ${out}`);
await browser.close();
