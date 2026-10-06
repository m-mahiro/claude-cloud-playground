#!/usr/bin/env node
// Navigates to one or more routes on a running dev server and screenshots each
// at one or more viewport widths, using the Playwright build Claude Code's
// cloud sandbox preinstalls at /opt/pw-browsers (set PLAYWRIGHT_BROWSERS_PATH
// so this never tries to download its own copy).
//
// Usage:
//   node capture_screenshots.cjs --base-url http://localhost:3000 \
//     --routes "/,/about,/settings" --out-dir /path/to/out \
//     [--widths "1280x800,390x844"] [--timeout 15000]
//
// Prints a JSON manifest to stdout: { shots: [...] }. Each shot entry has
// route, width, height, file, httpStatus, ok, consoleErrors, error.
// A non-zero exit code means every route failed to load; partial failures
// still exit 0 so the caller can report which routes worked.
//
// CommonJS (not .mjs) on purpose: ESM import specifiers ignore NODE_PATH, so
// a bare `import 'playwright'` can't find the sandbox's globally installed
// copy from a project that doesn't have its own. require() does honor
// NODE_PATH, which is how this finds playwright without the caller's
// project needing it as a dependency.

const { chromium } = require('playwright');
const { mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

function parseArgs(argv) {
  const args = { routes: '/', widths: '1280x800,390x844', timeout: 15000 };
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i].replace(/^--/, '');
    args[key] = argv[i + 1];
  }
  if (!args['base-url'] || !args['out-dir']) {
    console.error('Required: --base-url <url> --out-dir <dir>');
    process.exit(2);
  }
  return args;
}

function slugify(route) {
  return (route === '/' ? 'root' : route.replace(/^\//, '').replace(/[^a-zA-Z0-9_-]+/g, '_'));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const baseUrl = args['base-url'].replace(/\/+$/, '');
  const routes = args.routes.split(',').map((r) => r.trim()).filter(Boolean);
  const widths = args.widths.split(',').map((w) => {
    const [width, height] = w.trim().split('x').map(Number);
    return { width, height: height || Math.round(width * 0.75) };
  });
  const outDir = args['out-dir'];
  const timeout = Number(args.timeout) || 15000;
  mkdirSync(outDir, { recursive: true });

  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const shots = [];

  try {
    for (const { width, height } of widths) {
      const context = await browser.newContext({ viewport: { width, height } });
      const page = await context.newPage();
      const consoleErrors = [];
      page.on('console', (msg) => {
        if (msg.type() === 'error') consoleErrors.push(msg.text());
      });
      page.on('pageerror', (err) => consoleErrors.push(String(err)));

      for (const route of routes) {
        consoleErrors.length = 0;
        const url = baseUrl + route;
        const file = join(outDir, `${slugify(route)}__${width}x${height}.png`);
        const entry = { route, width, height, file, httpStatus: null, ok: false, consoleErrors: [], error: null };
        try {
          const response = await page.goto(url, { waitUntil: 'networkidle', timeout });
          entry.httpStatus = response ? response.status() : null;
          await page.screenshot({ path: file, fullPage: true });
          entry.ok = true;
        } catch (err) {
          // Still try to capture whatever rendered, even if networkidle never settled.
          try {
            await page.screenshot({ path: file, fullPage: true });
            entry.ok = true;
          } catch {
            entry.error = String(err.message || err);
          }
        }
        entry.consoleErrors = [...consoleErrors];
        shots.push(entry);
      }
      await context.close();
    }
  } finally {
    await browser.close();
  }

  const manifest = { shots };
  writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify(manifest, null, 2));
  process.exit(shots.some((s) => s.ok) ? 0 : 1);
}

main();
