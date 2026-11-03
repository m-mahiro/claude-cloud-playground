// DOM API を包み、UserScript からの要素の取得・読み取り・書き換えを要素ごとに数える。
// 呼び出し元はスタックトレースの userscript://<id>/ のフレームで判定する。
// 計測の負荷が大きいので、時間を測る回とは別の回で使う。
(() => {
	const T = (window.__trace = {
		callers: [], // 呼び出し元のスタック(userscript のフレームだけ)
		callerIndex: new Map(),
		elements: [], // 要素ごとの記述
		elementIds: new WeakMap(),
		ops: new Map(), // `${elementId}|${callerIdx}|${op}` -> 回数
		calls: new Map(), // `${callerIdx}|${api}` -> {n, scanned, returned}
		forced: new Map(), // callerIdx -> 強制レイアウトの疑いの回数
		dirty: false,
		dirtyBy: -1,
	});
	Error.stackTraceLimit = 40;
	const US = "userscript://";
	const raw = {
		gebtn: Element.prototype.getElementsByTagName,
		dgebtn: Document.prototype.getElementsByTagName,
	};

	let busy = false; // 計測の中から呼ばれた API は数えない

	const caller = () => {
		const stack = new Error().stack;
		if (!stack.includes(US)) return -1;
		const frames = [];
		for (const line of stack.split("\n")) {
			const i = line.indexOf(US);
			if (i < 0) continue;
			const m = /userscript:\/\/([^/]+)\/([^:]+):(\d+):(\d+)/.exec(line.slice(i));
			if (m) frames.push(`${m[1]}/${m[2]}:${m[3]}:${m[4]}`);
		}
		const key = frames.join(" < ");
		let idx = T.callerIndex.get(key);
		if (idx === undefined) {
			idx = T.callers.length;
			T.callers.push(key);
			T.callerIndex.set(key, idx);
		}
		return idx;
	};

	const describe = (el) => {
		if (el === document) return "#document";
		if (!(el instanceof Element)) return el?.nodeName || String(el);
		const parts = [];
		let cur = el;
		for (let depth = 0; cur && cur instanceof Element && depth < 4; depth++) {
			let s = cur.localName;
			if (cur.id) {
				s += `#${cur.id}`;
				parts.unshift(s);
				break;
			}
			const cls = typeof cur.className === "string" ? cur.className.trim().split(/\s+/).filter(Boolean).slice(0, 2) : [];
			if (cls.length) s += `.${cls.join(".")}`;
			parts.unshift(s);
			cur = cur.parentElement;
		}
		return parts.join(" > ");
	};

	const elementId = (el) => {
		let id = T.elementIds.get(el);
		if (id === undefined) {
			id = T.elements.length;
			T.elementIds.set(el, id);
			busy = true;
			try {
				T.elements.push(describe(el));
			} finally {
				busy = false;
			}
		}
		return id;
	};

	const recordOp = (el, c, op) => {
		if (!el || typeof el !== "object") return;
		const key = `${elementId(el)}|${c}|${op}`;
		T.ops.set(key, (T.ops.get(key) || 0) + 1);
	};
	const recordCall = (c, api, scanned, returned) => {
		const key = `${c}|${api}`;
		const v = T.calls.get(key) || {n: 0, scanned: 0, returned: 0};
		v.n++;
		v.scanned += scanned;
		v.returned += returned;
		T.calls.set(key, v);
	};
	const subtreeSize = (root) => {
		if (root === document || root instanceof Document) return raw.dgebtn.call(root, "*").length;
		if (root instanceof Element) return raw.gebtn.call(root, "*").length;
		return 0;
	};
	const markWrite = (c) => {
		T.dirty = true;
		T.dirtyBy = c;
	};
	const layoutRead = (c) => {
		if (T.dirty && c >= 0) T.forced.set(c, (T.forced.get(c) || 0) + 1);
		T.dirty = false;
	};
	const frame = () => {
		T.dirty = false;
		requestAnimationFrame(frame);
	};
	requestAnimationFrame(frame);

	// ---- 取得 ----
	const wrapQuery = (proto, name, kind) => {
		const orig = proto[name];
		if (typeof orig !== "function") return;
		proto[name] = function (...args) {
			const result = orig.apply(this, args);
			if (busy) return result;
			const c = caller();
			if (c < 0) return result;
			busy = true;
			try {
				let returned = 0;
				if (kind === "one") {
					if (result) {
						recordOp(result, c, `query:${name}`);
						returned = 1;
					}
				} else if (kind === "bool") {
					recordOp(this, c, `query:${name}`);
				} else if (result) {
					returned = result.length;
					for (let i = 0; i < result.length; i++) recordOp(result[i], c, `query:${name}`);
				}
				const scanned = name === "getElementById" || kind === "bool" || name === "closest" ? 0 : subtreeSize(this);
				recordCall(c, `${name}`, scanned, returned);
			} finally {
				busy = false;
			}
			return result;
		};
	};
	for (const proto of [Document.prototype, Element.prototype, DocumentFragment.prototype]) {
		wrapQuery(proto, "querySelector", "one");
		wrapQuery(proto, "querySelectorAll", "many");
		wrapQuery(proto, "getElementsByClassName", "many");
		wrapQuery(proto, "getElementsByTagName", "many");
	}
	wrapQuery(Document.prototype, "getElementById", "one");
	wrapQuery(DocumentFragment.prototype, "getElementById", "one");
	wrapQuery(Document.prototype, "getElementsByName", "many");
	wrapQuery(Element.prototype, "closest", "one");
	wrapQuery(Element.prototype, "matches", "bool");

	// ---- 読み取り(レイアウトを要するものは layout: true) ----
	const wrapGetter = (proto, prop, op, layout) => {
		const d = Object.getOwnPropertyDescriptor(proto, prop);
		if (!d || !d.get) return;
		Object.defineProperty(proto, prop, {
			...d,
			get() {
				const v = d.get.call(this);
				if (busy) return v;
				const c = caller();
				if (c < 0) return v;
				busy = true;
				try {
					recordOp(this, c, `${op}:${prop}`);
					recordCall(c, `get ${prop}`, 0, 0);
					if (layout) layoutRead(c);
				} finally {
					busy = false;
				}
				return v;
			},
		});
	};
	const wrapMethod = (proto, name, op, {layout = false, write = false, target = (self) => self} = {}) => {
		const orig = proto[name];
		if (typeof orig !== "function") return;
		proto[name] = function (...args) {
			if (busy) return orig.apply(this, args);
			const c = caller();
			if (c >= 0) {
				busy = true;
				try {
					const el = target(this, args);
					recordOp(el, c, `${op}:${name}${write && typeof args[0] === "string" && name.endsWith("Attribute") ? `(${args[0]})` : ""}`);
					recordCall(c, name, 0, 0);
					if (layout) layoutRead(c);
				} finally {
					busy = false;
				}
			}
			if (write) markWrite(c);
			return orig.apply(this, args);
		};
	};
	for (const [proto, props] of [
		[Node.prototype, ["textContent"]],
		[Element.prototype, ["innerHTML", "outerHTML"]],
	]) for (const p of props) wrapGetter(proto, p, "read", false);
	wrapGetter(HTMLElement.prototype, "innerText", "read", true);
	for (const p of ["offsetWidth", "offsetHeight", "offsetTop", "offsetLeft", "offsetParent"]) wrapGetter(HTMLElement.prototype, p, "read", true);
	for (const p of ["clientWidth", "clientHeight", "clientTop", "clientLeft", "scrollWidth", "scrollHeight", "scrollTop", "scrollLeft"]) wrapGetter(Element.prototype, p, "read", true);
	wrapMethod(Element.prototype, "getBoundingClientRect", "read", {layout: true});
	wrapMethod(Element.prototype, "getClientRects", "read", {layout: true});
	wrapMethod(Element.prototype, "getAttribute", "read");
	wrapMethod(Element.prototype, "hasAttribute", "read");
	const origGCS = window.getComputedStyle;
	window.getComputedStyle = function (el, ...rest) {
		if (!busy) {
			const c = caller();
			if (c >= 0) {
				busy = true;
				try {
					recordOp(el, c, "read:getComputedStyle");
					recordCall(c, "getComputedStyle", 0, 0);
					layoutRead(c);
				} finally {
					busy = false;
				}
			}
		}
		return origGCS.call(this, el, ...rest);
	};

	// ---- 書き換え ----
	const wrapSetter = (proto, prop, ownerOf = (self) => self) => {
		const d = Object.getOwnPropertyDescriptor(proto, prop);
		if (!d || !d.set) return;
		Object.defineProperty(proto, prop, {
			...d,
			set(v) {
				if (!busy) {
					const c = caller();
					if (c >= 0) {
						busy = true;
						try {
							recordOp(ownerOf(this), c, `write:${prop}`);
							recordCall(c, `set ${prop}`, 0, 0);
						} finally {
							busy = false;
						}
					}
					markWrite(c);
				}
				d.set.call(this, v);
			},
		});
	};
	for (const p of ["textContent"]) wrapSetter(Node.prototype, p);
	for (const p of ["innerHTML", "outerHTML", "className", "id"]) wrapSetter(Element.prototype, p);
	for (const p of ["innerText", "hidden", "title"]) wrapSetter(HTMLElement.prototype, p);
	for (const name of ["setAttribute", "removeAttribute", "toggleAttribute", "insertAdjacentHTML", "insertAdjacentElement",
		"insertAdjacentText", "append", "prepend", "before", "after", "replaceWith", "remove", "replaceChildren"]) {
		wrapMethod(Element.prototype, name, "write", {write: true});
	}
	for (const name of ["appendChild", "insertBefore", "removeChild", "replaceChild"]) {
		wrapMethod(Node.prototype, name, "write", {write: true});
	}

	// classList と style は持ち主の要素へ結び付けて数える
	const owners = new WeakMap();
	for (const [proto, prop] of [[Element.prototype, "classList"], [HTMLElement.prototype, "style"], [SVGElement.prototype, "style"]]) {
		const d = Object.getOwnPropertyDescriptor(proto, prop);
		if (!d?.get) continue;
		Object.defineProperty(proto, prop, {
			...d,
			get() {
				const v = d.get.call(this);
				owners.set(v, this);
				return v;
			},
		});
	}
	const ownerOf = (self) => owners.get(self) || self;
	for (const name of ["add", "remove", "toggle", "replace"]) wrapMethod(DOMTokenList.prototype, name, "write", {write: true, target: ownerOf});
	wrapMethod(DOMTokenList.prototype, "contains", "read", {target: ownerOf});
	wrapMethod(CSSStyleDeclaration.prototype, "setProperty", "write", {write: true, target: ownerOf});
	wrapMethod(CSSStyleDeclaration.prototype, "removeProperty", "write", {write: true, target: ownerOf});
	for (const p of Object.getOwnPropertyNames(CSSStyleDeclaration.prototype)) {
		const d = Object.getOwnPropertyDescriptor(CSSStyleDeclaration.prototype, p);
		if (d?.set && !p.startsWith("webkit")) wrapSetter(CSSStyleDeclaration.prototype, p, ownerOf);
	}

	// ---- 監視・タイマー・通信の数 ----
	const counter = (label) => {
		const c = caller();
		if (c >= 0) recordCall(c, label, 0, 0);
		return c;
	};
	const OrigMO = window.MutationObserver;
	window.MutationObserver = class extends OrigMO {
		constructor(cb) {
			const c = counter("new MutationObserver");
			super(function (records, obs) {
				if (c >= 0) {
					const key = `${c}|MutationObserver callback`;
					const v = T.calls.get(key) || {n: 0, scanned: 0, returned: 0};
					v.n++;
					v.returned += records.length;
					T.calls.set(key, v);
				}
				return cb.call(this, records, obs);
			});
		}
		observe(target, opts) {
			if (!busy) {
				const c = counter(`MutationObserver.observe${opts?.subtree ? "(subtree)" : ""}`);
				if (c >= 0) recordOp(target, c, `observe${opts?.subtree ? ":subtree" : ""}`);
			}
			return super.observe(target, opts);
		}
	};
	for (const [obj, name] of [[window, "setInterval"], [window, "setTimeout"], [window, "requestAnimationFrame"], [window, "fetch"], [EventTarget.prototype, "addEventListener"]]) {
		const orig = obj[name];
		obj[name] = function (...args) {
			if (!busy) counter(name);
			return orig.apply(this, args);
		};
	}
	const origOpen = XMLHttpRequest.prototype.open;
	XMLHttpRequest.prototype.open = function (...args) {
		if (!busy) counter("XMLHttpRequest");
		return origOpen.apply(this, args);
	};

	T.dump = () => ({
		callers: T.callers,
		elements: T.elements,
		ops: [...T.ops.entries()],
		calls: [...T.calls.entries()],
		forced: [...T.forced.entries()],
	});
})();
