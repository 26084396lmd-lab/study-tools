# -*- coding: utf-8 -*-
"""bridge_cache.test.py —— 题库桥缓存的 TTL / 按题删除（离线）

不联网、不读真实 free_tiku_cache.json；requests 只用空壳顶一下，
因为被测的两个函数本身不发请求。
"""
import importlib.util
import os
import sys
import tempfile
import time
import types

HERE = os.path.dirname(os.path.abspath(__file__))
_CANDIDATES = [
    os.path.abspath(os.path.join(HERE, "..", "free_tiku_bridge.py")),      # 工作区里放在 userscripts/ 下
    os.path.abspath(os.path.join(HERE, "..", "..", "free_tiku_bridge.py")),  # research/free_tiku_bridge.py
]
SRC = next((p for p in _CANDIDATES if os.path.exists(p)), _CANDIDATES[0])

sys.modules.setdefault("requests", types.ModuleType("requests"))

spec = importlib.util.spec_from_file_location("ftk_bridge_test", SRC)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

m.CACHE_PATH = os.path.join(tempfile.mkdtemp(prefix="ftk_cache_"), "cache.json")
m._cache = {}
m._cache_at = {}
m.CACHE_TTL_DAYS = 14

passed = 0
failed = 0


def ok(name, cond, extra=""):
    global passed, failed
    if cond:
        passed += 1
        print("  \u2713 " + name)
    else:
        failed += 1
        print("  \u2717 " + name + ("   " + str(extra) if extra else ""))


print("\n=== 缓存 TTL ===")
k = "k1"
m._cache_put(k, {"question": "题干", "answer": {"bestAnswer": ["A"]}})
ok("刚写入的缓存能读到", m._cache_get(k) is not None)
m._cache_at[k] = time.time() - 15 * 86400
ok("超过 14 天：读取时立刻判过期", m._cache_get(k) is None)
ok("过期条目从内存里删掉了", k not in m._cache and k not in m._cache_at)

print("\n=== 按题干删除（/reject） ===")
m._cache_put("k2", {"question": "只有这一道题", "answer": {"bestAnswer": ["B"]}})
ok("reject 删掉 1 条", m.cache_reject({"question": "只有这一道题"}) == 1)
ok("删掉之后读不到", m._cache_get("k2") is None)

print("\n=== 路由表没有重复的 trace 分支 ===")
with open(SRC, "r", encoding="utf-8") as f:
    src = f.read()
ok("is_trace 只出现一次（另一份是重复死代码，已删）", src.count("if is_trace:") == 1)

print("\n" + "-" * 50)
print("  通过 %d 项，失败 %d 项" % (passed, failed))
print("-" * 50)
sys.exit(1 if failed else 0)
