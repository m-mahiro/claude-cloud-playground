---
name: screenshot-preview
description: Capture screenshots of a running dev server (npm run dev, vite, next dev, a Python/Ruby dev server, etc.) and send them to the user as images, for cloud/headless Claude Code sessions that have no live browser preview of localhost. Use this whenever the user asks to "see", "preview", "show me", or "check how it looks" for a web app change, a UI tweak, or a new page/component, and especially whenever claude.ai/code has no way to open a running dev server directly. Also use it to catch visual regressions or browser console errors after a frontend change, or to screenshot several routes/pages at once (desktop and mobile widths). Don't use this for static HTML/CSS/JS that can be published as a Claude Artifact instead — this skill is specifically for apps that need a live dev server (SSR, API-backed, build-tooled) to render correctly.
---

# Screenshot a running dev server

Cloud Claude Code sessions (claude.ai/code) have no way to open a live browser
preview of `localhost`. The only way to show the user what a running web app
actually looks like is to drive a real headless browser against it and hand
back pictures. This skill automates that: start the project's dev server,
wait for it to be ready, screenshot the routes that matter, send the images,
then clean up the server so it doesn't linger.

This is distinct from the `run` skill: `run` is for *you* to drive and
inspect the app yourself (e.g. to verify a fix works). This skill is for
*showing the user* what the app looks like right now. Use `run` when you need
to interact with the app to test something; use this skill when the point is
to produce images for the user to look at. The two can follow each other —
verify with `run`, then screenshot-preview to hand over the picture — but
don't run both when one covers the need.

## 1. Figure out how to start the dev server

Look for the project's own way of starting a dev server before guessing:

- **Node projects**: read `package.json` `scripts` — prefer `dev`, then
  `start`, then `serve`. Note the framework (Next.js, Vite, CRA, etc.) since
  it tells you what a "ready" log line looks like and what the default port
  is.
- **Python**: `manage.py runserver` (Django), `flask run`, `uvicorn`/`fastapi
  dev`, or a plain `python -m http.server` for static output.
- **Ruby**: `bin/rails server` / `rails s`.
- **A repo skill already covers launching this project** (check for one
  before guessing, the same way the `run` skill would) — reuse its command
  instead of inventing your own.
- If none of this resolves a command confidently, ask the user rather than
  guessing blindly — a wrong guess wastes the time this skill is meant to
  save.

Also install dependencies first if `node_modules` (or the Python/Ruby
equivalent) is missing — a dev server started without them just errors out
immediately and wastes the timeout budget in step 2.

## 2. Start it in the background and wait for it to be ready

Launch it detached and log to a file so you can poll readiness without
blocking, and record the PID for cleanup later:

```bash
nohup <dev-command> > /tmp/screenshot-preview-devserver.log 2>&1 &
echo $! > /tmp/screenshot-preview-devserver.pid
```

Then poll the log and/or the port for readiness, with a hard timeout (45–60s
is reasonable for an npm dev server; give a fresh install more). Don't guess
a fixed sleep — frameworks vary wildly in cold-start time, and a fixed sleep
either wastes time or fires before the server is actually up:

```bash
timeout 60 bash -c '
  until grep -qiE "ready|listening|compiled|localhost:[0-9]+" /tmp/screenshot-preview-devserver.log 2>/dev/null \
     || curl -sf http://localhost:PORT/ >/dev/null 2>&1; do
    sleep 1
  done
'
```

Read the log to find the actual port the server bound to — many frameworks
fall back to the next free port (3001, 5174, ...) when the default is taken,
and trusting a hardcoded default silently screenshots nothing or the wrong
app. If the log never signals readiness before the timeout, stop, show the
user the last lines of the log, and don't proceed to screenshotting a server
that isn't up.

## 3. Capture the screenshots

Resolve what to capture from whatever the user passed after the skill name
(e.g. `/screenshot-preview /settings` → one route; `/screenshot-preview
/,/about,/settings` → several). Default to `/` alone when nothing was given.

Run the bundled script, which drives the sandbox's preinstalled Chromium
(`/opt/pw-browsers/chromium`) via the globally installed `playwright` package
— it works even when the target project has neither as its own dependency:

```bash
node .claude/skills/screenshot-preview/scripts/capture_screenshots.cjs \
  --base-url http://localhost:PORT \
  --routes "/,/about,/settings" \
  --out-dir /tmp/claude-.../scratchpad/screenshot-preview-<timestamp> \
  --widths "1280x800,390x844"
```

Always write `--out-dir` inside the session's scratchpad directory, never the
project tree — these are throwaway diagnostic images, not project files.
The script prints a `manifest.json`-shaped summary to stdout: one entry per
route×width with `ok`, `httpStatus`, `consoleErrors`, and `error`. Read it to
know what actually happened — a route that failed to load still produces a
best-effort screenshot, so check `ok`/`error` rather than assuming every file
on disk means success.

Adjust `--widths` if the user only cares about one size, and pass only the
routes they actually asked about — screenshotting the whole site when they
asked about one page just slows down the turn.

## 4. Send the screenshots and report what you saw

Send the image files (not `manifest.json`) with `SendUserFile`, `display:
"render"` so they show inline, and a caption naming which route/width each
one is if there's more than one. Then, in your reply, call out anything the
manifest flagged:

- Any route with `ok: false` — say which route failed and the `error`.
- Any non-2xx `httpStatus`.
- Any `consoleErrors` — these often catch a broken import or a runtime
  exception that still rendered *something*, so don't skip reporting them
  just because a screenshot exists.

If everything is clean, a short confirmation is enough — don't pad it out.

## 5. Clean up the dev server

Always stop what you started, even if screenshotting failed partway through
— a dev server left running holds its port and keeps burning the sandbox's
resources for the rest of the session:

```bash
kill "$(cat /tmp/screenshot-preview-devserver.pid)" 2>/dev/null
fuser -k PORT/tcp 2>/dev/null
```

The `fuser` fallback matters: many dev commands (`npm run dev`, `rails s`)
fork a child process that actually binds the port, so killing just the
parent PID can leave the real server running and the port held. Killing by
port catches that regardless of how the process tree is shaped.

If the user explicitly says they want the server left running (e.g. they're
about to ask for more screenshots, or want to poke at it with `run`), skip
this step and tell them it's still up on that port.
