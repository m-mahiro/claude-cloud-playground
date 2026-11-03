// 通信の録画と再生。録画した応答だけを返し、計測中は外へ出ない。
import {createHash} from "node:crypto";
import {existsSync, mkdirSync, readFileSync, writeFileSync} from "node:fs";
import {join} from "node:path";
import {BLOCK} from "./pages.mjs";

const DIR = new URL("../fixtures/", import.meta.url).pathname;
const INDEX = join(DIR, "index.json");
const BODY_DIR = join(DIR, "bodies");

const normalize = (url) => {
	const u = new URL(url);
	u.searchParams.delete("_"); // jQuery のキャッシュよけ
	u.searchParams.delete("v");
	u.searchParams.delete("t");
	u.hash = "";
	return u.href;
};
const keyOf = (method, url) => `${method} ${normalize(url)}`;
const DROP_HEADERS = new Set(["content-encoding", "content-length", "transfer-encoding", "set-cookie", "strict-transport-security", "content-security-policy", "cache-control", "expires", "pragma", "etag", "last-modified"]);

export class FixtureStore {
	constructor() {
		mkdirSync(BODY_DIR, {recursive: true});
		this.index = existsSync(INDEX) ? JSON.parse(readFileSync(INDEX, "utf8")) : {};
		this.misses = new Map();
	}

	save() {
		writeFileSync(INDEX, JSON.stringify(this.index, null, 1));
	}

	put(method, url, status, headers, body) {
		const sha = createHash("sha1").update(body).digest("hex");
		writeFileSync(join(BODY_DIR, sha), body);
		const kept = Object.fromEntries(Object.entries(headers).filter(([k]) => !DROP_HEADERS.has(k.toLowerCase())));
		this.index[keyOf(method, url)] = {status, headers: kept, body: sha};
	}

	get(method, url) {
		const e = this.index[keyOf(method, url)];
		if (!e) return null;
		return {...e, body: readFileSync(join(BODY_DIR, e.body))};
	}

	/** context のすべての通信をここで扱う。record なら実際に取りに行き、保存する。 */
	async attach(context, {record}) {
		const handle = async (route, targetUrl) => {
			const req = route.request();
			const url = targetUrl ?? req.url();
			if (BLOCK.test(url) || url.startsWith("data:") || url.startsWith("blob:")) return route.abort();
			const method = targetUrl ? "GET" : req.method();
			if (record && !this.get(method, url)) {
				try {
					const res = await context.request.fetch(url, {method, headers: targetUrl ? {} : req.headers(), data: req.postDataBuffer() ?? undefined, maxRedirects: 0, failOnStatusCode: false});
					this.put(method, url, res.status(), res.headers(), await res.body());
				} catch (e) {
					this.put(method, url, 599, {}, Buffer.from(String(e)));
				}
			}
			const hit = this.get(method, url);
			if (!hit) {
				this.misses.set(keyOf(method, url), (this.misses.get(keyOf(method, url)) || 0) + 1);
				return route.fulfill({status: 404, body: "not recorded", headers: {"access-control-allow-origin": "*"}});
			}
			const headers = {...hit.headers};
			if (!Object.keys(headers).some((k) => k.toLowerCase() === "access-control-allow-origin")) headers["access-control-allow-origin"] = "*";
			if (hit.status >= 300 && hit.status < 400) return route.fulfill({status: hit.status, headers});
			return route.fulfill({status: hit.status, headers, body: hit.body});
		};
		await context.route("https://gmxhr.invalid/**", (route) => handle(route, new URL(route.request().url()).searchParams.get("u")));
		await context.route(/^(?!https:\/\/gmxhr\.invalid\/).*/, (route) => handle(route));
	}
}
