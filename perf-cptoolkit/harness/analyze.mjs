// 計測結果(results/*.jsonl)を集計し、results/summary.json を作る。
//   node harness/analyze.mjs
import {existsSync, readFileSync, writeFileSync} from "node:fs";
import {SourceMap} from "./sourcemap.mjs";

const R = new URL("../results/", import.meta.url).pathname;
const read = (f) => existsSync(R + f)
	? readFileSync(R + f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((r) => !r.failed)
	: [];
const failedCount = (f) => existsSync(R + f) ? readFileSync(R + f, "utf8").trim().split("\n").filter((l) => l.includes('"failed"')).length : 0;

const CONDS = ["A", "B_own", "C_own", "B_all", "C_eq", "C_default"];
const PAIRS = [["B_own", "C_own"], ["B_all", "C_eq"], ["B_all", "C_default"]];
const PAGES = ["top", "contests", "contest", "tasks", "task", "editorial", "user", "history", "tessoku"];

// ---- 統計 ----
const sorted = (xs) => [...xs].sort((a, b) => a - b);
const quantile = (xs, q) => {
	const s = sorted(xs);
	if (!s.length) return NaN;
	const pos = (s.length - 1) * q;
	const lo = Math.floor(pos);
	return s[lo] + (s[Math.min(lo + 1, s.length - 1)] - s[lo]) * (pos - lo);
};
const median = (xs) => quantile(xs, 0.5);
const summary = (xs) => ({median: median(xs), q1: quantile(xs, 0.25), q3: quantile(xs, 0.75), n: xs.length});

/** Mann-Whitney U の両側 p 値(正規近似・同順位補正あり)と Cliff の δ */
function mannWhitney(a, b) {
	const all = [...a.map((v) => [v, 0]), ...b.map((v) => [v, 1])].sort((x, y) => x[0] - y[0]);
	const ranks = new Array(all.length);
	let tieSum = 0;
	for (let i = 0; i < all.length;) {
		let j = i;
		while (j + 1 < all.length && all[j + 1][0] === all[i][0]) j++;
		const r = (i + j) / 2 + 1;
		for (let k = i; k <= j; k++) ranks[k] = r;
		const t = j - i + 1;
		tieSum += t ** 3 - t;
		i = j + 1;
	}
	const n1 = a.length, n2 = b.length, N = n1 + n2;
	const r1 = all.reduce((s, [, g], i) => s + (g === 0 ? ranks[i] : 0), 0);
	const u1 = r1 - n1 * (n1 + 1) / 2;
	const mu = n1 * n2 / 2;
	const sigma = Math.sqrt(n1 * n2 / 12 * ((N + 1) - tieSum / (N * (N - 1))));
	const z = sigma ? (u1 - mu - Math.sign(u1 - mu) * 0.5) / sigma : 0;
	const p = 2 * (1 - normCdf(Math.abs(z)));
	let gt = 0, lt = 0;
	for (const x of a) for (const y of b) {
		if (x > y) gt++;
		else if (x < y) lt++;
	}
	return {p, cliffsDelta: (gt - lt) / (n1 * n2)};
}
function normCdf(x) {
	// Abramowitz-Stegun 7.1.26
	const t = 1 / (1 + 0.3275911 * x / Math.SQRT2);
	const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x / 2);
	return 0.5 * (1 + y);
}

// ---- 読み込み時の指標 ----
const METRICS = {
	TaskDuration: (r) => r.metrics.TaskDuration * 1000,
	ScriptDuration: (r) => r.metrics.ScriptDuration * 1000,
	LayoutDuration: (r) => r.metrics.LayoutDuration * 1000,
	RecalcStyleDuration: (r) => r.metrics.RecalcStyleDuration * 1000,
	LayoutCount: (r) => r.metrics.LayoutCount,
	RecalcStyleCount: (r) => r.metrics.RecalcStyleCount,
	JSHeapUsedMB: (r) => r.metrics.JSHeapUsedSize / 1048576,
	Nodes: (r) => r.metrics.Nodes,
	JSEventListeners: (r) => r.metrics.JSEventListeners,
	LongTaskMs: (r) => r.page_.longtasks?.total ?? 0,
	UserscriptSyncMs: (r) => Object.values(r.page_.us?.sync ?? {}).reduce((s, v) => s + v, 0),
	DomContentLoadedMs: (r) => r.page_.dcl,
	LoadEventMs: (r) => r.page_.load,
};

function analyzePerf(rows) {
	const out = {};
	for (const page of PAGES) {
		const byCond = {};
		for (const cond of CONDS) {
			const rs = rows.filter((r) => r.page === page && r.cond === cond);
			if (!rs.length) continue;
			byCond[cond] = Object.fromEntries(Object.entries(METRICS).map(([k, f]) => [k, {...summary(rs.map(f)), values: rs.map(f)}]));
		}
		if (!byCond.A) continue;
		const comparisons = {};
		for (const [b, c] of PAIRS) {
			if (!byCond[b] || !byCond[c]) continue;
			comparisons[`${b}_vs_${c}`] = Object.fromEntries(Object.keys(METRICS).map((k) => {
				const base = byCond.A[k].median;
				const ob = byCond[b][k].median - base;
				const oc = byCond[c][k].median - base;
				return [k, {
					overheadB: ob,
					overheadC: oc,
					diff: byCond[c][k].median - byCond[b][k].median,
					overheadReductionPct: ob > 0 ? (1 - oc / ob) * 100 : null,
					...mannWhitney(byCond[b][k].values, byCond[c][k].values),
				}];
			}));
		}
		for (const cond of Object.keys(byCond)) for (const k of Object.keys(METRICS)) delete byCond[cond][k].values;
		out[page] = {byCond, comparisons};
	}
	// ページを通した合計(中央値の和)
	const totals = {};
	for (const cond of CONDS) {
		totals[cond] = Object.fromEntries(Object.keys(METRICS).map((k) => [k, PAGES.reduce((s, p) => s + (out[p]?.byCond[cond]?.[k].median ?? 0), 0)]));
	}
	return {pages: out, totals};
}

// ---- 放置時 ----
function analyzeIdle(rows) {
	const out = {};
	for (const page of [...new Set(rows.map((r) => r.page))]) {
		out[page] = {};
		for (const cond of CONDS) {
			const rs = rows.filter((r) => r.page === page && r.cond === cond);
			if (!rs.length) continue;
			const perSec = (k) => rs.map((r) => r.idle[k] * 1000 / (r.idleMs / 1000));
			out[page][cond] = {
				taskMsPerSec: summary(perSec("TaskDuration")),
				scriptMsPerSec: summary(perSec("ScriptDuration")),
				layoutsPerSec: summary(rs.map((r) => r.idle.LayoutCount / (r.idleMs / 1000))),
				styleRecalcsPerSec: summary(rs.map((r) => r.idle.RecalcStyleCount / (r.idleMs / 1000))),
				heapGrowthKB: summary(rs.map((r) => r.idle.JSHeapUsedSize / 1024)),
			};
		}
	}
	return out;
}

// ---- CP Toolkit の呼び出し元を機能へ寄せる ----
const map = new SourceMap(new URL("../scripts/cptoolkit/CpToolkit.analysis.user.js.map", import.meta.url).pathname);
const ownerCache = new Map();
function ownerOfFrames(frames) {
	// frames: ["CpToolkit/main.user.js:L:C", ...] または ["L:C", ...](プロファイル)
	const key = frames.join("<");
	if (ownerCache.has(key)) return ownerCache.get(key);
	let owner = null;
	let first = null;
	for (const f of frames) {
		const m = /(\d+):(\d+)$/.exec(f);
		if (!m) continue;
		const hit = map.lookup(Number(m[1]), Number(m[2]));
		if (!hit) continue;
		const src = hit.source.replace(/^(\.\.\/)+/, "");
		first ??= src;
		const fm = /src\/features\/([^/]+)\//.exec(src);
		if (fm) {
			owner = fm[1];
			break;
		}
	}
	if (!owner) {
		const s = first ?? "unknown";
		const lm = /src\/(app|adapters|application|ui|domain|catalog)\//.exec(s);
		owner = lm ? `(core:${lm[1]})` : s.startsWith("shared/") ? "(core:shared)" : s.includes("node_modules") ? "(lib)" : `(${s})`;
	}
	ownerCache.set(key, owner);
	return owner;
}
const scriptOfCaller = (caller) => caller.split("/")[0];
const ownerOfCaller = (caller) => {
	const script = scriptOfCaller(caller);
	if (script !== "CpToolkit") return script;
	return ownerOfFrames(caller.split(" < ").filter((f) => f.startsWith("CpToolkit/main")));
};

// ---- プロファイル ----
function analyzeProfile(rows) {
	const out = {};
	for (const page of PAGES) {
		out[page] = {};
		for (const cond of CONDS) {
			const rs = rows.filter((r) => r.page === page && r.cond === cond);
			if (!rs.length) continue;
			const userscriptMs = rs.map((r) => Object.entries(r.byScript).filter(([k]) => k.startsWith("us:")).reduce((s, [, v]) => s + v, 0));
			const perScript = {};
			for (const r of rs) for (const [k, v] of Object.entries(r.byScript)) if (k.startsWith("us:")) (perScript[k.slice(3)] ??= []).push(v);
			const perFeature = {};
			for (const r of rs) {
				const acc = {};
				for (const [stack, ms] of Object.entries(r.toolkitStacks ?? {})) {
					const owner = stack ? ownerOfFrames(stack.split(" < ")) : "(unknown)";
					acc[owner] = (acc[owner] || 0) + ms;
				}
				for (const [k, v] of Object.entries(acc)) (perFeature[k] ??= []).push(v);
			}
			const med = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, median([...v, ...new Array(rs.length - v.length).fill(0)])]).sort((a, b) => b[1] - a[1]));
			out[page][cond] = {userscriptMs: summary(userscriptMs), perScript: med(perScript), perFeature: med(perFeature)};
		}
	}
	return out;
}

// ---- メモリ(GC 後) ----
const SHIM_FRAMES = new Set(["run", "onDcl", "onRoot", "__usBoot"]);
function analyzeMemory(rows) {
	const out = {};
	for (const page of PAGES) {
		const byCond = {};
		for (const cond of CONDS) {
			const rs = rows.filter((r) => r.page === page && r.cond === cond);
			if (!rs.length) continue;
			const perScript = {};
			const perFeature = {};
			for (const r of rs) {
				for (const [k, v] of Object.entries(r.heapByScript)) if (k.startsWith("us:")) (perScript[k.slice(3)] ??= []).push(v / 1024);
				const acc = {};
				for (const [stack, b] of Object.entries(r.heapToolkitStacks ?? {})) {
					const owner = stack ? ownerOfFrames(stack.split(" < ")) : "(top-level)";
					acc[owner] = (acc[owner] || 0) + b / 1024;
				}
				for (const [k, v] of Object.entries(acc)) (perFeature[k] ??= []).push(v);
			}
			const med = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, median([...v, ...new Array(rs.length - v.length).fill(0)])]).sort((a, b) => b[1] - a[1]));
			byCond[cond] = {
				heapAfterGcMB: summary(rs.map((r) => r.afterGc.JSHeapUsedSize / 1048576)),
				heapBeforeGcMB: summary(rs.map((r) => r.metrics.JSHeapUsedSize / 1048576)),
				domNodes: summary(rs.map((r) => r.domCounters.nodes)),
				listeners: summary(rs.map((r) => r.domCounters.jsEventListeners)),
				documents: summary(rs.map((r) => r.domCounters.documents)),
				// UserScript が確保して GC 後も残ったもの(KB)。shim の run は eval で読み込んだコード本体
				userscriptKB: summary(rs.map((r) => Object.entries(r.heapByScript).filter(([k]) => k.startsWith("us:")).reduce((s2, [, v]) => s2 + v, 0) / 1024)),
				scriptCodeKB: summary(rs.map((r) => Object.entries(r.heapByScript).filter(([k]) => SHIM_FRAMES.has(k)).reduce((s2, [, v]) => s2 + v, 0) / 1024)),
				v8ApiKB: summary(rs.map((r) => (r.heapByScript["(V8 API)"] ?? 0) / 1024)),
				perScript: med(perScript),
				perFeature: med(perFeature),
			};
		}
		out[page] = byCond;
	}
	return out;
}

// ---- DOM の重複アクセス ----
const opKind = (op) => op.split(":")[0]; // query / read / write / observe
function analyzeTrace(rows) {
	const out = {};
	for (const page of PAGES) {
		out[page] = {};
		for (const cond of CONDS) {
			const r = rows.find((x) => x.page === page && x.cond === cond && x.iteration === 0)
				?? rows.find((x) => x.page === page && x.cond === cond);
			if (!r?.page_.trace) continue;
			const t = r.page_.trace;
			const owners = t.callers.map(ownerOfCaller);
			const scripts = t.callers.map(scriptOfCaller);
			// 要素ごとに、誰がどの種類の操作を何回したか
			const perEl = new Map();
			let totalOps = 0;
			const kindTotals = {query: 0, read: 0, write: 0, observe: 0};
			let repeatedSameOp = 0;
			for (const [key, n] of t.ops) {
				const [el, c, op] = key.split("|");
				const kind = opKind(op);
				totalOps += n;
				kindTotals[kind] = (kindTotals[kind] || 0) + n;
				if (n > 1) repeatedSameOp += n - 1;
				let e = perEl.get(el);
				if (!e) perEl.set(el, e = {owners: new Map(), scripts: new Set(), n: 0, kinds: {}});
				e.n += n;
				e.kinds[kind] = (e.kinds[kind] || 0) + n;
				e.scripts.add(scripts[c]);
				const o = e.owners.get(owners[c]) || {};
				o[kind] = (o[kind] || 0) + n;
				e.owners.set(owners[c], o);
			}
			// 同じ要素を同じ主体が同じ種類の操作で何度も行った回数(別の行の op 名をまとめる)
			let repeatedSameKind = 0;
			for (const e of perEl.values()) for (const o of e.owners.values()) for (const n of Object.values(o)) if (n > 1) repeatedSameKind += n - 1;
			const multiOwner = [...perEl.entries()].filter(([, e]) => e.owners.size >= 2);
			const multiWriter = multiOwner.filter(([, e]) => [...e.owners.values()].filter((o) => o.write).length >= 2);
			const multiScript = [...perEl.values()].filter((e) => e.scripts.size >= 2).length;
			// API 呼び出し
			let scanned = 0, scannedQsa = 0, qsaCalls = 0, docScans = 0, queryCalls = 0, moSubtree = 0, moCallbacks = 0, listeners = 0, timers = 0, intervals = 0, net = 0;
			const perOwnerCalls = {};
			for (const [key, v] of t.calls) {
				const [c, api] = key.split("|");
				const owner = owners[c];
				(perOwnerCalls[owner] ??= {});
				perOwnerCalls[owner][api] = (perOwnerCalls[owner][api] || 0) + v.n;
				if (/^(querySelector|querySelectorAll|getElementsBy|getElementById|closest|matches)/.test(api)) {
					queryCalls += v.n;
					scanned += v.scanned;
				}
				if (api === "querySelectorAll") {
					qsaCalls += v.n;
					scannedQsa += v.scanned;
				}
				if (api === "MutationObserver.observe(subtree)") moSubtree += v.n;
				if (api === "MutationObserver callback") moCallbacks += v.n;
				if (api === "addEventListener") listeners += v.n;
				if (api === "setTimeout" || api === "requestAnimationFrame") timers += v.n;
				if (api === "setInterval") intervals += v.n;
				if (api === "fetch" || api === "XMLHttpRequest") net += v.n;
			}
			// document 全体を対象にした走査の回数(要素数が最大の走査を全体とみなす)
			const forced = t.forced.reduce((s, [, n]) => s + n, 0);
			const forcedBy = {};
			for (const [c, n] of t.forced) forcedBy[owners[c]] = (forcedBy[owners[c]] || 0) + n;
			const top = multiOwner
				.map(([el, e]) => ({element: t.elements[el], total: e.n, owners: Object.fromEntries(e.owners)}))
				.sort((a, b) => b.owners && Object.keys(b.owners).length - Object.keys(a.owners).length || b.total - a.total)
				.slice(0, 15);
			const perOwner = {};
			for (const e of perEl.values()) for (const [o, k] of e.owners) {
				const p = perOwner[o] ??= {elements: 0, ops: 0};
				p.elements++;
				p.ops += Object.values(k).reduce((s, v) => s + v, 0);
			}
			out[page][cond] = {
				elementsTouched: perEl.size,
				totalOps,
				kindTotals,
				repeatedSameOp,
				repeatedSameKind,
				elementsByMultipleOwners: multiOwner.length,
				elementsWrittenByMultipleOwners: multiWriter.length,
				elementsByMultipleScripts: multiScript,
				queryCalls,
				nodesScannedUpperBound: scanned, // querySelector は途中で打ち切るので過大。上限値
				querySelectorAllCalls: qsaCalls,
				nodesScannedByQuerySelectorAll: scannedQsa,
				mutationObserversSubtree: moSubtree,
				mutationObserverCallbacks: moCallbacks,
				addEventListener: listeners,
				timers,
				intervals,
				network: net,
				forcedLayoutSuspects: forced,
				forcedBy,
				perOwner,
				perOwnerCalls,
				topShared: top,
			};
			void docScans;
		}
	}
	return out;
}

const perfX1 = read("perf-x1.jsonl");
const perfX4 = read("perf-x4.jsonl");
const summaryJson = {
	generatedAt: new Date().toISOString(),
	counts: {
		perfX1: perfX1.length, perfX4: perfX4.length, idle: read("idle-x1.jsonl").length,
		profile: read("profile-x1.jsonl").length, trace: read("trace.jsonl").length, memory: read("memory-x1.jsonl").length,
		failed: ["perf-x1.jsonl", "perf-x4.jsonl", "idle-x1.jsonl", "profile-x1.jsonl", "trace.jsonl", "memory-x1.jsonl"].reduce((s, f) => s + failedCount(f), 0),
	},
	scriptsPerPage: Object.fromEntries(PAGES.map((p) => [p, Object.fromEntries(CONDS.map((c) => [c, perfX1.find((r) => r.page === p && r.cond === c)?.scripts ?? []]))])),
	errors: Object.fromEntries(PAGES.map((p) => [p, Object.fromEntries(CONDS.map((c) => [c, [...new Set(perfX1.filter((r) => r.page === p && r.cond === c).flatMap((r) => r.page_.us?.errors ?? []).map((e) => `${e.id}: ${e.message.split("\n")[0]}`))]]))])),
	perfX1: analyzePerf(perfX1),
	perfX4: analyzePerf(perfX4),
	idle: analyzeIdle(read("idle-x1.jsonl")),
	profile: analyzeProfile(read("profile-x1.jsonl")),
	trace: analyzeTrace(read("trace.jsonl")),
	memory: analyzeMemory(read("memory-x1.jsonl")),
};
writeFileSync(R + "summary.json", JSON.stringify(summaryJson, null, 1));
console.log("wrote results/summary.json", summaryJson.counts);
