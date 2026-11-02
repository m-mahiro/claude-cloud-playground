#!/usr/bin/env bash
# 全計測を直列に流す(並列にすると CPU の取り合いで数値がゆがむ)
set -u
cd "$(dirname "$0")"
node harness/measure.mjs --mode trace   --n 2  --throttle 1 --out results/trace.jsonl
node harness/measure.mjs --mode profile --n 3  --throttle 1 --out results/profile-x1.jsonl
node harness/measure.mjs --mode perf    --n 12 --throttle 1 --out results/perf-x1.jsonl
node harness/measure.mjs --mode perf    --n 6  --throttle 4 --out results/perf-x4.jsonl
node harness/measure.mjs --mode idle    --n 3  --throttle 1 --idle 15000 --pages top,contest,task,user --out results/idle-x1.jsonl
echo ALL_DONE
