// 計測するページ。ログインなしで開けるものに限る(提出一覧・順位表・提出画面はログインが要る)。
export const PAGES = {
	top: "https://atcoder.jp/?lang=ja",
	contests: "https://atcoder.jp/contests/?lang=ja",
	contest: "https://atcoder.jp/contests/abc400?lang=ja",
	tasks: "https://atcoder.jp/contests/abc400/tasks?lang=ja",
	task: "https://atcoder.jp/contests/abc400/tasks/abc400_c?lang=ja",
	editorial: "https://atcoder.jp/contests/abc400/editorial?lang=ja",
	user: "https://atcoder.jp/users/tourist?lang=ja",
	history: "https://atcoder.jp/users/tourist/history?lang=ja",
	tessoku: "https://atcoder.jp/contests/tessoku-book/tasks?lang=ja",
};

// どの条件でも外す第三者の計測・広告。ばらつきの元になる
export const BLOCK = /googletagmanager|google-analytics|doubleclick|googlesyndication|adservice|platform\.twitter|facebook|hatena|pocket|yjtag|clarity\.ms/;
