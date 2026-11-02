// 実際の Tampermonkey に UserScript を入れて計測する。シムでは測れない、
// スクリプト1本ごとの注入や GM API の準備の負荷を含めた比較。
//   node harness/tm-measure.mjs --crx <Tampermonkey を展開したフォルダ> --mode cpu --n 8 --out results/tm-cpu.jsonl
// mode:
//   cpu    … CPU プロファイル。Tampermonkey 自身と、スクリプトごと(CP Toolkit は機能ごと)の時間
//   memory … GC 後のヒープと、サンプリングヒーププロファイラによるスクリプトごとの生存メモリ
//   perf   … CDP Performance.getMetrics と Long Task(--throttle で CPU を遅くできる)
//   idle   … 読み込み後に放置したあいだの CPU 時間
// 条件ごとに Chromium のプロファイルを分け、Tampermonkey を入れたまま繰り返し開く。
// どの回も、計測のあとで「実際に動いたスクリプト」を Debugger から集めて記録する。
import {appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync} from "node:fs";
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
		pages: {type: "string", default: Object.keys(PAGES).join(",")},
		conds: {type: "string", default: "A,B_own,C_own,B_all,C_eq"},
		out: {type: "string", default: "results/tm"}, // <out>-<mode>-x<倍率>.jsonl に書く
		// 「モード:回数[:CPU を遅くする倍率]」をカンマで並べる。ブラウザを起動し直すと Tampermonkey の
		// スクリプトが動かなくなるので、全モードを1回の起動の中で続けて測る
		plan: {type: "string", default: "cpu:8,memory:5,perf:10,perf:6:4,idle:3"},
		"idle-pages": {type: "string", default: "top,contest,task,user"},
		idle: {type: "string", default: "15000"},
	},
});
const PLAN = args.plan.split(",").map((step) => {
	const [mode, n, rate = "1"] = step.split(":");
	return {mode, n: Number(n), throttle: Number(rate)};
});
// CP Toolkit は、ソースマップで機能へ割り振れる版(中身は配布物と同じ、整形なし)を入れる
const conditions = loadConditions({analysisBuild: true});
const scriptIdByTmName = new Map();
const tmName = (name) => `${name.replace(/ /g, "-")}.user.js`;
for (const c of Object.values(conditions)) for (const s of c.scripts) scriptIdByTmName.set(tmName(s.name), s.id);
const LONGTASK_JS = `(() => { if (window.top !== window) return;
 window.__lt = {n: 0, total: 0};
 try { new PerformanceObserver((l) => { for (const e of l.getEntries()) { __lt.n++; __lt.total += e.duration; } }).observe({type: "longtask", buffered: true}); } catch {}
})();`;
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
	rmSync(dir, {recursive: true, force: true}); // 毎回入れ直す
	const fresh = true;
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

/** Tampermonkey の URL から、どのスクリプトか(または Tampermonkey 自身か)を決める */
function classifier(extId) {
	return (url) => {
		if (!url) return null;
		if (url.startsWith(`chrome-extension://${extId}/userscript.html`)) {
			const name = decodeURIComponent(new URL(url).searchParams.get("name") ?? "");
			return `us:${scriptIdByTmName.get(name) ?? name}`;
		}
		if (url.startsWith(`chrome-extension://${extId}/`)) return "tampermonkey";
		return "page";
	};
}
const isToolkit = (url) => url.includes("userscript.html") && url.includes("name=CP-Toolkit");

function aggregateCpu(profile, extId) {
	const classify = classifier(extId);
	const byId = new Map(profile.nodes.map((n) => [n.id, n]));
	const parent = new Map();
	for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
	const byBucket = {};
	const toolkitStacks = {};
	for (let i = 0; i < profile.samples.length; i++) {
		const dt = (profile.timeDeltas[i + 1] ?? 0) / 1000;
		const id = profile.samples[i];
		const node = byId.get(id);
		let bucket = classify(node.callFrame.url);
		if (!bucket) {
			// ネイティブ関数(DOM API など)は呼び出し元へ寄せる
			let p = parent.get(id);
			while (p !== undefined && !bucket) {
				bucket = classify(byId.get(p).callFrame.url);
				p = parent.get(p);
			}
			bucket ??= node.callFrame.functionName || "(native)";
		}
		byBucket[bucket] = (byBucket[bucket] || 0) + dt;
		if (bucket === "us:CpToolkit") {
			const frames = [];
			for (let cur = id; cur !== undefined && frames.length < 25; cur = parent.get(cur)) {
				const cf = byId.get(cur).callFrame;
				if (isToolkit(cf.url)) frames.push(`${cf.lineNumber + 1}:${cf.columnNumber + 1}`);
			}
			const key = frames.join(" < ");
			toolkitStacks[key] = (toolkitStacks[key] || 0) + dt;
		}
	}
	return {byBucket, toolkitStacks};
}

function aggregateHeap(profile, extId) {
	const classify = classifier(extId);
	const heapByBucket = {};
	const heapToolkitStacks = {};
	const walk = (node, chain) => {
		const here = [...chain, node];
		if (node.selfSize > 0) {
			let bucket = null;
			for (let i = here.length - 1; i >= 0 && !bucket; i--) bucket = classify(here[i].callFrame.url);
			bucket ??= node.callFrame.functionName || "(native)";
			heapByBucket[bucket] = (heapByBucket[bucket] || 0) + node.selfSize;
			if (bucket === "us:CpToolkit") {
				const key = here.filter((n) => isToolkit(n.callFrame.url)).reverse().slice(0, 25)
					.map((n) => `${n.callFrame.lineNumber + 1}:${n.callFrame.columnNumber + 1}`).join(" < ");
				heapToolkitStacks[key] = (heapToolkitStacks[key] || 0) + node.selfSize;
			}
		}
		for (const c of node.children ?? []) walk(c, here);
	};
	walk(profile.head, []);
	return {heapByBucket, heapToolkitStacks};
}

/** 計測のあとで Debugger を有効にし、このページで実際に読み込まれた UserScript を集める。
 * CP Toolkit は、Tampermonkey が前に足した行数(ソースマップとのずれ)も求める */
async function scriptsThatRan(cdp, extId) {
	const parsed = [];
	const onParsed = (e) => parsed.push(e);
	cdp.on("Debugger.scriptParsed", onParsed);
	await cdp.send("Debugger.enable");
	await new Promise((r) => setTimeout(r, 300));
	cdp.off("Debugger.scriptParsed", onParsed);
	const classify = classifier(extId);
	const ran = new Set();
	let toolkitLineOffset = null;
	for (const e of parsed) {
		const b = classify(e.url);
		if (!b?.startsWith("us:")) continue;
		ran.add(b.slice(3));
		if (isToolkit(e.url) && toolkitLineOffset === null) {
			const {scriptSource} = await cdp.send("Debugger.getScriptSource", {scriptId: e.scriptId});
			const lines = scriptSource.split("\n");
			const at = lines.findIndex((l) => l.includes(TOOLKIT_ANCHOR));
			if (at >= 0) toolkitLineOffset = at - TOOLKIT_ANCHOR_LINE + e.startLine;
		}
	}
	await cdp.send("Debugger.disable");
	return {ran: [...ran].sort(), toolkitLineOffset};
}
// ソースマップの行と Tampermonkey 上の行の対応を取る目印(ソースマップ側の行は 0 始まり)
const TOOLKIT_SRC = readFileSync(new URL("../scripts/cptoolkit/CpToolkit.analysis.user.js", import.meta.url), "utf8").split("\n");
const TOOLKIT_ANCHOR = "document.documentElement.dataset.cpToolkit = host.version;";
const TOOLKIT_ANCHOR_LINE = TOOLKIT_SRC.findIndex((l) => l.includes(TOOLKIT_ANCHOR));

async function runOnce(env, cond, pageKey, iteration, mode, throttle) {
	const SETTLE = throttle > 1 ? 6000 : 3000;
	const page = await env.context.newPage();
	if (mode === "perf") await page.addInitScript(LONGTASK_JS);
	const cdp = await env.context.newCDPSession(page);
	await cdp.send("Network.clearBrowserCache");
	await cdp.send("Performance.enable");
	if (throttle > 1) await cdp.send("Emulation.setCPUThrottlingRate", {rate: throttle});
	if (mode === "cpu") {
		await cdp.send("Profiler.enable");
		await cdp.send("Profiler.setSamplingInterval", {interval: 100});
		await cdp.send("Profiler.start");
	}
	if (mode === "memory") {
		await cdp.send("HeapProfiler.enable");
		await cdp.send("HeapProfiler.startSampling", {samplingInterval: 1024});
	}
	const t0 = Date.now();
	await page.goto(PAGES[pageKey], {waitUntil: "load", timeout: 120000});
	const loadWall = Date.now() - t0;
	await page.waitForTimeout(SETTLE);
	const getMetrics = async () => Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map((m) => [m.name, m.value]));
	const metrics = await getMetrics();
	const row = {mode: `tm-${mode}`, cond, page: pageKey, iteration, throttle, installed: env.installed.length, loadWall, metrics};
	if (mode === "cpu") {
		const {profile} = await cdp.send("Profiler.stop");
		Object.assign(row, aggregateCpu(profile, env.extId));
	}
	if (mode === "memory") {
		// シムの memory モードと同じく、GC を2回かけて残ったものだけを数える。
		// Tampermonkey が UserScript を動かす世界も、ページと同じ JS ヒープに載る
		await cdp.send("HeapProfiler.collectGarbage");
		await cdp.send("HeapProfiler.collectGarbage");
		row.afterGc = await getMetrics();
		row.domCounters = await cdp.send("Memory.getDOMCounters");
		const {profile} = await cdp.send("HeapProfiler.getSamplingProfile");
		await cdp.send("HeapProfiler.stopSampling");
		Object.assign(row, aggregateHeap(profile, env.extId));
	}
	if (mode === "idle") {
		await page.waitForTimeout(Number(args.idle));
		const after = await getMetrics();
		row.idleMs = Number(args.idle);
		row.idle = Object.fromEntries(Object.keys(after).map((k) => [k, after[k] - (metrics[k] ?? 0)]));
	}
	row.page_ = await page.evaluate(() => {
		const nav = performance.getEntriesByType("navigation")[0];
		return {longtasks: window.__lt, dcl: nav?.domContentLoadedEventEnd, load: nav?.loadEventEnd, nodes: document.getElementsByTagName("*").length, marker: document.documentElement.dataset.cpToolkit ?? null};
	});
	Object.assign(row, await scriptsThatRan(cdp, env.extId));
	await page.close();
	return row;
}

const condKeys = args.conds.split(",");
const envs = {};
for (const c of condKeys) envs[c] = await launch(c);
console.log("installed:", Object.fromEntries(condKeys.map((c) => [c, envs[c].installed.length])));
mkdirSync("results", {recursive: true});
for (const {mode, n, throttle} of PLAN) {
	const pageKeys = (mode === "idle" ? args["idle-pages"] : args.pages).split(",");
	const out = `${args.out}-${mode}-x${throttle}.jsonl`;
	let done = 0;
	const total = n * pageKeys.length * condKeys.length;
	// 条件を順番に回し、時間による偏りを条件の間で均す
	for (let i = 0; i < n; i++) {
		for (const pageKey of pageKeys) {
			for (const cond of condKeys) {
				let row;
				try {
					row = await runOnce(envs[cond], cond, pageKey, i, mode, throttle);
				} catch (e) {
					row = {mode: `tm-${mode}`, cond, page: pageKey, iteration: i, throttle, failed: String(e).slice(0, 400)};
				}
				appendFileSync(out, `${JSON.stringify(row)}\n`);
				if (++done % 20 === 0 || row.failed) console.log(`[tm-${mode} x${throttle}] ${done}/${total} ${pageKey} ${cond} ran=${row.ran?.length ?? "-"} ${row.failed ?? ""}`);
			}
		}
	}
	console.log(`done ${mode} x${throttle}`);
}
for (const e of Object.values(envs)) await e.context.close();
server.close();
