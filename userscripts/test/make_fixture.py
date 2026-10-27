# -*- coding: utf-8 -*-
"""生成差分测试夹具：用 Python 版实现抓一份真实百度响应，并记下 Python 的解析结果。
node 端的 core.js 必须解析出**完全一样**的东西，否则就是移植错了。
"""
import json
import os
import sys

sys.stdout.reconfigure(encoding="utf-8")

HERE = os.path.dirname(os.path.abspath(__file__))
RESEARCH = os.path.abspath(os.path.join(HERE, "..", ".."))
sys.path.insert(0, RESEARCH)
sys.path.insert(0, os.path.join(RESEARCH, "pylibs"))

import free_tiku_bridge as B  # noqa: E402

QUESTIONS = [
    "中华人民共和国的首都是哪里",
    "马克思主义的三个组成部分",
    "北京是中华人民共和国的首都",
]

out = {"questions": []}

for q in QUESTIONS:
    data = B._fetch(q)
    entry = {"question": q, "raw": data, "candidates": [], "expected": None}
    if data:
        lst = B._dig(data, "data", "list") or []
        for item in lst:
            bdjson, actk = item.get("bdjson"), item.get("actk")
            if not bdjson or not actk:
                continue
            try:
                dec = B.decrypt(bdjson, actk)
            except Exception as exc:
                entry["candidates"].append({"bdjson": bdjson, "actk": actk,
                                            "decrypt_error": str(exc), "decrypted": None})
                continue
            try:
                obj = json.loads(dec)
            except Exception:
                entry["candidates"].append({"bdjson": bdjson, "actk": actk,
                                            "decrypted": dec, "parsed": None})
                continue
            stem, texts, letters = B.parse_candidate(obj)
            entry["candidates"].append({
                "bdjson": bdjson, "actk": actk,
                "decrypted": dec,
                "parsed": {"stem": stem, "texts": texts, "letters": letters},
                "score": B._sim(q, stem) if stem else 0.0,
            })
        texts, letters = B.search_free(q)
        entry["expected"] = {"texts": texts, "letters": letters}
    out["questions"].append(entry)
    print(f"{q}  ->  {entry['expected']}  候选 {len(entry['candidates'])} 条")

with open(os.path.join(HERE, "fixture.json"), "w", encoding="utf-8") as f:
    json.dump(out, f, ensure_ascii=False, indent=1)
print("\n夹具已写入 fixture.json")