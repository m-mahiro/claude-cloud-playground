// 実際の Tampermonkey に UserScript を入れて計測する。シムでは測れない、
// スクリプト1本ごとの注入や GM API の準備の負荷を含めた比較。
//   node harness/tm-measure.mjs --crx <Tampermonkey を展開したフォルダ> --n 8 --out results/tm-x1.jsonl
// 条件ごとに Chromium のプロファイルを分け、Tampermonkey を入れたまま繰り返し開く。
import {appendFileSync, mkdirSync, readFileSync, writeFileSync, existsSync} from "node:fs";
import http from "node:http";
import {createRequire} from "node:module";
import {join} from "node:path";
import {parseArgs} from "node:util";
import {loadConditions} from "./conditions.mjs";
import {FixtureStore} from "./fixtures.mjs";
import {PAGES} from "./pages.mjs";

const {chromium} = createRequire(import.meta.url)("playwright");
const {values: args} = parseArgs({
	options: {
		crx: {type: "string"},
		profiles: {type: "string", default: "/tmp/cp-perf-tm-profiles"},
		n: {type: "string", default: "8"},
		pages: {type: "string", default: Object.keys(PAGES).join(",")},
		conds: {type: "string", default: "A,B_own,C_own,B_all,C_eq"},
		out: {type: "string", default: "results/tm-x1.jsonl"},
		mode: {type: "string", default: "cpu"}, // cpu: CPU プロファイル / memory: GC 後のヒープ
	},
});
const N = Number(args.n);
const SETTLE = 3000;
const conditions = loadConditions();
const store = new FixtureStore();

// UserScript を配る小さなサーバー。Tampermonkey は *.user.js への遷移を拾ってインストール画面を開く
const served = new Map();
const server = http.createServer((req, res) => {
	const body = served.get(decodeURIComponent(req.url.slice(1)));
	if (!body) {
		res.writeHead(404);
		return res.end();
	}
	res.writeHead(200, {"content-type": "text/javascript; charset=utf-8"});
	res.end(body);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

/** CP Toolkit の設定(機能の ON/OFF)を、最初の起動の前に書いておく1行を足す */
function withSeed(script) {
	if (!script.store?.settings) return script.code;
	const seed = `\nif (GM_getValue("settings") === undefined) GM_setValue("settings", ${JSON.stringify(script.store.settings)});\n`;
	return script.code.replace(/(\/\/\s*==\/UserScript==)/, `$1${seed}`);
}

async function launch(cond) {
	const dir = join(args.profiles, cond);
	const fresh = !existsSync(join(dir, "installed.json"));
	mkdirSync(dir, {recursive: true});
	const context = await chromium.launchPersistentContext(join(dir, "profile"), {
		headless: true,
		channel: "chromium",
		viewport: {width: 1600, height: 900},
		locale: "ja-JP",
		timezoneId: "Asia/Tokyo",
		bypassCSP: true,
		args: [`--disable-extensions-except=${args.crx}`, `--load-extension=${args.crx}`, "--enable-precise-memory-info"],
	});
	let sw = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker");
	const extId = new URL(sw.url()).host;
	await new Promise((r) => setTimeout(r, 3000)); // 拡張の起動を待つ
	// Chrome 138 以降は拡張ごとに「ユーザー スクリプトを許可」を ON にする必要がある。
	// 環境によっては起動し直すと外れるので、毎回確かめて OFF のときだけ押す
	const allowed = () => sw.evaluate(async () => {
		try {
			await chrome.userScripts.getScripts();
			return true;
		} catch {
			return false;
		}
	});
	if (!(await allowed())) {
		const p = await context.newPage();
		await p.goto(`chrome://extensions/?id=${extId}`);
		await p.locator("#allow-user-scripts").first().click();
		await p.waitForTimeout(2000);
		await p.close();
		if (!(await allowed())) throw new Error(`could not allow user scripts for ${cond}`);
	}
	if (fresh) {
		const installed = [];
		for (const s of conditions[cond].scripts) {
			const name = `${cond}/${s.id}.user.js`;
			served.set(name, withSeed(s));
			const page = await context.newPage();
			await page.goto(`http://127.0.0.1:${port}/${name}`).catch(() => {});
			let askPage = null;
			for (let t = 0; t < 100 && !askPage; t++) {
				askPage = context.pages().find((pg) => pg.url().includes("/ask.html")) ?? null;
				if (!askPage) await new Promise((r) => setTimeout(r, 200));
			}
			if (!askPage) throw new Error(`install page did not open for ${name}: ${context.pages().map((pg) => pg.url()).join(" ")}`);
			await askPage.locator('input[type=button][value="Install"]').first().click({timeout: 20000});
			await askPage.waitForEvent("close", {timeout: 20000}).catch(() => {});
			await page.close().catch(() => {});
			installed.push(s.id);
		}
		writeFileSync(join(dir, "installed.json"), JSON.stringify(installed));
	}
	for (const p of context.pages()) if (!p.url().startsWith("about:")) await p.close().catch(() => {});
	await store.attach(context, {record: false});
	return {context, extId, installed: JSON.parse(readFileSync(join(dir, "installed.json"), "utf8"))};
}

function aggregate(profile, extId) {
	const byId = new Map(profile.nodes.map((n) => [n.id, n]));
	const parent = new Map();
	for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
	const out = {};
	const urls = {};
	const classify = (url) => {
		if (!url) return null;
		if (url.startsWith(`chrome-extension://${extId}/userscript.html`)) return "userscript"; // スクリプト本体(@require を含む)
		if (url.startsWith(`chrome-extension://${extId}/`)) return "tampermonkey"; // Tampermonkey 自身の content script
		return "page";
	};
	for (let i = 0; i < profile.samples.length; i++) {
		const dt = (profile.timeDeltas[i + 1] ?? 0) / 1000;
		let id = profile.samples[i];
		const node = byId.get(id);
		let bucket = classify(node.callFrame.url);
		if (node.callFrame.url) urls[node.callFrame.url] = (urls[node.callFrame.url] || 0) + dt;
		if (!bucket) {
			// ネイティブ関数は呼び出し元へ寄せる
			let p = parent.get(id);
			while (p !== undefined && !bucket) {
				bucket = classify(byId.get(p).callFrame.url);
				p = parent.get(p);
			}
			bucket ??= node.callFrame.functionName || "(native)";
		}
		out[bucket] = (out[bucket] || 0) + dt;
	}
	const topUrls = Object.entries(urls).filter(([u]) => !u.startsWith("https://")).sort((a, b) => b[1] - a[1]).slice(0, 40);
	return {byBucket: out, topUrls};
}

async function runOnce(env, cond, pageKey, iteration) {
	const page = await env.context.newPage();
	const cdp = await env.context.newCDPSession(page);
	await cdp.send("Network.clearBrowserCache");
	await cdp.send("Performance.enable");
	if (args.mode === "cpu") {
		await cdp.send("Profiler.enable");
		await cdp.send("Profiler.setSamplingInterval", {interval: 100});
		await cdp.send("Profiler.start");
	}
	const t0 = Date.now();
	await page.goto(PAGES[pageKey], {waitUntil: "load", timeout: 120000});
	const loadWall = Date.now() - t0;
	await page.waitForTimeout(SETTLE);
	const getMetrics = async () => Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map((m) => [m.name, m.value]));
	const metrics = await getMetrics();
	let agg = {};
	if (args.mode === "cpu") {
		const {profile} = await cdp.send("Profiler.stop");
		agg = aggregate(profile, env.extId);
	} else {
		// シムの memory モードと同じく、GC を2回かけて残ったものだけを数える。
		// Tampermonkey が UserScript を動かす世界も、ページと同じ JS ヒープに載る
		await cdp.send("HeapProfiler.enable");
		await cdp.send("HeapProfiler.collectGarbage");
		await cdp.send("HeapProfiler.collectGarbage");
		agg = {
			afterGc: await getMetrics(),
			domCounters: await cdp.send("Memory.getDOMCounters"),
			inPage: await page.evaluate(() => ({heap: performance.memory?.usedJSHeapSize, nodes: document.getElementsByTagName("*").length, marker: document.documentElement.dataset.cpToolkit ?? null})),
		};
	}
	const marker = await page.evaluate(() => document.documentElement.dataset.cpToolkit ?? null);
	await page.close();
	return {mode: args.mode === "cpu" ? "tm" : "tm-memory", cond, page: pageKey, iteration, installed: env.installed.length, loadWall, metrics, ...agg, cpToolkitVersion: marker};
}

const condKeys = args.conds.split(",");
const pageKeys = args.pages.split(",");
const envs = {};
for (const c of condKeys) envs[c] = await launch(c);
console.log("installed:", Object.fromEntries(condKeys.map((c) => [c, envs[c].installed.length])));
mkdirSync("results", {recursive: true});
let done = 0;
const total = N * pageKeys.length * condKeys.length;
for (let i = 0; i < N; i++) {
	for (const pageKey of pageKeys) {
		for (const cond of condKeys) {
			let row;
			try {
				row = await runOnce(envs[cond], cond, pageKey, i);
			} catch (e) {
				row = {mode: "tm", cond, page: pageKey, iteration: i, failed: String(e).slice(0, 400)};
			}
			appendFileSync(args.out, `${JSON.stringify(row)}\n`);
			if (++done % 10 === 0) console.log(`[tm] ${done}/${total} ${pageKey} ${cond} ${row.failed ?? ""}`);
		}
	}
}
for (const e of Object.values(envs)) await e.context.close();
server.close();
