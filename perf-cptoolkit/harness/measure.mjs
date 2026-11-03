// 計測の本体。
//   node harness/measure.mjs --mode perf --n 15 --throttle 1 --out results/perf-x1.jsonl
// mode:
//   record  … 通信を録画する(全条件で1回ずつ開く)
//   perf    … 読み込み時のコスト。CDP の Performance.getMetrics とページ内の記録
//   idle    … 読み込み後に放置したときのコスト
//   profile … CPU プロファイルからスクリプトごとの時間を出す
//   memory  … GC 後に残るヒープと、サンプリングヒーププロファイラによるスクリプトごとの生存メモリ
//   trace   … DOM API を包み、要素ごとの重複アクセスを数える
import {appendFileSync, mkdirSync} from "node:fs";
import {dirname} from "node:path";
import {parseArgs} from "node:util";
import {createRequire} from "node:module";
import {loadConditions} from "./conditions.mjs";
import {FixtureStore} from "./fixtures.mjs";
import {buildInitScript} from "./inject.mjs";
import {PAGES} from "./pages.mjs";

const {chromium} = createRequire(import.meta.url)("playwright");

const {values: args} = parseArgs({
	options: {
		mode: {type: "string", default: "perf"},
		n: {type: "string", default: "1"},
		throttle: {type: "string", default: "1"},
		pages: {type: "string", default: Object.keys(PAGES).join(",")},
		conds: {type: "string", default: "A,B_own,C_own,B_all,C_eq,C_default"},
		out: {type: "string"},
		idle: {type: "string", default: "20000"},
	},
});
const mode = args.mode;
const N = Number(args.n);
const throttle = Number(args.throttle);
const pageKeys = args.pages.split(",");
const condKeys = args.conds.split(",");
const conditions = loadConditions({analysisBuild: mode === "trace" || mode === "profile" || mode === "memory"});
const SETTLE = throttle > 1 ? 6000 : 3000;
const out = args.out ?? `results/${mode}-x${throttle}.jsonl`;
mkdirSync(dirname(out), {recursive: true});

const store = new FixtureStore();
const browser = await chromium.launch({args: ["--disable-features=Translate", "--no-first-run"]});

const LONGTASK_JS = `(() => { if (window.top !== window) return;
 window.__lt = {n: 0, total: 0, max: 0};
 try { new PerformanceObserver((l) => { for (const e of l.getEntries()) { __lt.n++; __lt.total += e.duration; __lt.max = Math.max(__lt.max, e.duration); } }).observe({type: "longtask", buffered: true}); } catch {}
})();`;

const metricsOf = async (cdp) => Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map((m) => [m.name, m.value]));

function aggregateProfile(profile) {
	const byId = new Map(profile.nodes.map((n) => [n.id, n]));
	const parent = new Map();
	for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
	const selfMs = new Map();
	for (let i = 0; i < profile.samples.length; i++) {
		const dt = (profile.timeDeltas[i + 1] ?? 0) / 1000;
		selfMs.set(profile.samples[i], (selfMs.get(profile.samples[i]) || 0) + dt);
	}
	const byScript = {};
	const toolkitStacks = {};
	for (const [id, ms] of selfMs) {
		const node = byId.get(id);
		const url = node.callFrame.url;
		let bucket;
		const m = /^userscript:\/\/([^/]+)\//.exec(url);
		if (m) bucket = `us:${m[1]}`;
		else if (url) bucket = "page";
		else bucket = node.callFrame.functionName || "(native)";
		// ネイティブ関数(DOM API など)は呼び出し元の UserScript へ寄せる
		if (!m && !url) {
			let p = parent.get(id);
			while (p !== undefined) {
				const pu = byId.get(p).callFrame.url;
				const pm = /^userscript:\/\/([^/]+)\//.exec(pu);
				if (pm) {
					bucket = `us:${pm[1]}`;
					break;
				}
				if (pu) break;
				p = parent.get(p);
			}
		}
		byScript[bucket] = (byScript[bucket] || 0) + ms;
		if (bucket === "us:CpToolkit") {
			const frames = [];
			let cur = id;
			while (cur !== undefined && frames.length < 25) {
				const cf = byId.get(cur).callFrame;
				if (cf.url.startsWith("userscript://CpToolkit/main")) frames.push(`${cf.lineNumber + 1}:${cf.columnNumber + 1}`);
				cur = parent.get(cur);
			}
			const key = frames.join(" < ");
			toolkitStacks[key] = (toolkitStacks[key] || 0) + ms;
		}
	}
	return {byScript, toolkitStacks};
}

/** サンプリングヒーププロファイル(GC 後の生存オブジェクト)を、確保したスクリプトごとに集計する */
function aggregateHeap(profile, scriptUrls) {
	const urlOf = (cf) => cf.url || scriptUrls.get(cf.scriptId) || "";
	const byScript = {};
	const toolkitStacks = {};
	const walk = (node, ancestors) => {
		const url = urlOf(node.callFrame);
		const m = /^userscript:\/\/([^/]+)\//.exec(url);
		const chain = [...ancestors, node];
		if (node.selfSize > 0) {
			let bucket = null;
			for (let i = chain.length - 1; i >= 0; i--) {
				const u = urlOf(chain[i].callFrame);
				const um = /^userscript:\/\/([^/]+)\//.exec(u);
				if (um) {
					bucket = `us:${um[1]}`;
					break;
				}
				if (u && !m) break; // ページ自身のスクリプトが確保したもの
			}
			bucket ??= url ? "page" : (node.callFrame.functionName || "(native)");
			byScript[bucket] = (byScript[bucket] || 0) + node.selfSize;
			if (bucket === "us:CpToolkit") {
				const frames = chain.filter((n) => urlOf(n.callFrame).startsWith("userscript://CpToolkit/main"))
					.reverse().slice(0, 25).map((n) => `${n.callFrame.lineNumber + 1}:${n.callFrame.columnNumber + 1}`);
				const key = frames.join(" < ");
				toolkitStacks[key] = (toolkitStacks[key] || 0) + node.selfSize;
			}
		}
		for (const c of node.children ?? []) walk(c, chain);
	};
	walk(profile.head, []);
	return {heapByScript: byScript, heapToolkitStacks: toolkitStacks};
}

async function runOnce(condKey, pageKey, iteration) {
	const url = PAGES[pageKey];
	const condition = conditions[condKey];
	const context = await browser.newContext({
		viewport: {width: 1600, height: 900},
		locale: "ja-JP",
		timezoneId: "Asia/Tokyo",
		bypassCSP: true,
		serviceWorkers: "block",
	});
	await store.attach(context, {record: mode === "record"});
	const page = await context.newPage();
	const consoleErrors = [];
	page.on("pageerror", (e) => consoleErrors.push(String(e).slice(0, 300)));
	const {script, scripts} = buildInitScript(condition, url, {trace: mode === "trace"});
	await page.addInitScript(LONGTASK_JS);
	await page.addInitScript(script);
	const cdp = await context.newCDPSession(page);
	const scriptUrls = new Map();
	await cdp.send("Performance.enable");
	if (throttle > 1) await cdp.send("Emulation.setCPUThrottlingRate", {rate: throttle});
	if (mode === "profile") {
		await cdp.send("Profiler.enable");
		await cdp.send("Profiler.setSamplingInterval", {interval: 100});
		await cdp.send("Profiler.start");
	}
	if (mode === "memory") {
		// 自前の eval で読み込んだスクリプトは、ヒーププロファイルに URL が載らないので scriptId から引く
		cdp.on("Debugger.scriptParsed", (e) => scriptUrls.set(e.scriptId, e.url));
		await cdp.send("Debugger.enable");
		await cdp.send("HeapProfiler.enable");
		await cdp.send("HeapProfiler.startSampling", {samplingInterval: 1024});
	}
	const t0 = Date.now();
	await page.goto(url, {waitUntil: "load", timeout: 120000});
	const loadWall = Date.now() - t0;
	await page.waitForTimeout(SETTLE);
	const metrics = await metricsOf(cdp);
	const row = {mode, cond: condKey, page: pageKey, iteration, throttle, scripts, loadWall, metrics};
	if (mode === "profile") {
		const {profile} = await cdp.send("Profiler.stop");
		Object.assign(row, aggregateProfile(profile));
	}
	if (mode === "memory") {
		// GC を2回かけ、回収されずに残るものだけを数える
		await cdp.send("HeapProfiler.collectGarbage");
		await cdp.send("HeapProfiler.collectGarbage");
		row.afterGc = await metricsOf(cdp);
		row.domCounters = await cdp.send("Memory.getDOMCounters");
		const {profile} = await cdp.send("HeapProfiler.getSamplingProfile");
		await cdp.send("HeapProfiler.stopSampling");
		Object.assign(row, aggregateHeap(profile, scriptUrls));
	}
	if (mode === "idle") {
		await page.waitForTimeout(Number(args.idle));
		const after = await metricsOf(cdp);
		row.idleMs = Number(args.idle);
		row.idle = Object.fromEntries(Object.keys(after).map((k) => [k, after[k] - (metrics[k] ?? 0)]));
	}
	row.page_ = await page.evaluate(() => {
		const nav = performance.getEntriesByType("navigation")[0];
		return {
			us: window.__us ? {sync: __us.sync, errors: __us.errors, gmxhr: __us.gmxhr} : null,
			longtasks: window.__lt,
			dcl: nav?.domContentLoadedEventEnd,
			load: nav?.loadEventEnd,
			nodes: document.getElementsByTagName("*").length,
			trace: window.__trace ? window.__trace.dump() : undefined,
		};
	});
	row.pageErrors = consoleErrors;
	await context.close();
	return row;
}

// 条件を順番に回し、時間による偏りを条件の間で均す
let done = 0;
const total = N * pageKeys.length * condKeys.length;
for (let i = 0; i < N; i++) {
	for (const pageKey of pageKeys) {
		for (const condKey of condKeys) {
			let row;
			try {
				row = await runOnce(condKey, pageKey, i);
			} catch (e) {
				row = {mode, cond: condKey, page: pageKey, iteration: i, throttle, failed: String(e).slice(0, 500)};
			}
			appendFileSync(out, `${JSON.stringify(row)}\n`);
			done++;
			if (done % 10 === 0 || mode === "record") console.log(`[${mode} x${throttle}] ${done}/${total} ${pageKey} ${condKey} ${row.failed ? "FAILED " + row.failed : ""}`);
		}
	}
	if (mode === "record") store.save();
}
if (mode === "record") store.save();
if (store.misses.size) console.log("fixture misses:", JSON.stringify([...store.misses.entries()].slice(0, 50), null, 1));
await browser.close();
