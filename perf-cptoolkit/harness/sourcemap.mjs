// 最小限のソースマップ読み取り(依存を増やさないため自前で VLQ を解く)。
import {readFileSync} from "node:fs";

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const VALUE = Object.fromEntries([...B64].map((c, i) => [c, i]));

function decodeVlq(str) {
	const out = [];
	let shift = 0;
	let value = 0;
	for (const ch of str) {
		const digit = VALUE[ch];
		value += (digit & 31) << shift;
		if (digit & 32) shift += 5;
		else {
			out.push(value & 1 ? -(value >>> 1) : value >>> 1);
			shift = 0;
			value = 0;
		}
	}
	return out;
}

export class SourceMap {
	constructor(path) {
		const map = JSON.parse(readFileSync(path, "utf8"));
		this.sources = map.sources;
		this.lines = [];
		let src = 0, srcLine = 0, srcCol = 0;
		for (const line of map.mappings.split(";")) {
			const segs = [];
			let col = 0;
			if (line) for (const seg of line.split(",")) {
				const v = decodeVlq(seg);
				col += v[0];
				if (v.length >= 4) {
					src += v[1];
					srcLine += v[2];
					srcCol += v[3];
					segs.push([col, src, srcLine, srcCol]);
				}
			}
			this.lines.push(segs);
		}
	}

	/** 生成ファイルの 1 始まりの行と列から、元のファイルを返す */
	lookup(line, col) {
		for (let l = line - 1; l >= 0; l--) {
			const segs = this.lines[l];
			if (!segs || !segs.length) continue;
			let best = null;
			for (const s of segs) {
				if (l === line - 1 && s[0] > col - 1) break;
				best = s;
			}
			if (best) return {source: this.sources[best[1]], line: best[2] + 1};
			if (l === line - 1) continue;
		}
		return null;
	}
}
