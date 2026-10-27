# 第三方组件与归属

本项目整体按 **GPL-3.0-or-later** 发布（见根目录 `LICENSE`）。下面列出已知的第三方来源、版权和许可证。若你发现遗漏，请开 issue 或在发布前自行补齐；这份文件不是法律意见。

## 1. Samueli924/chaoxing（GPL-3.0）

- 上游：<https://github.com/Samueli924/chaoxing>
- 许可证：GNU General Public License v3.0
- 版权：Samueli924 及上游贡献者
- 本项目使用的文件/内容：
  - `bridge/resource/api/cxsecret_font.py`（字体解码模块，保留上游文件头）
  - `bridge/resource/font_map_table.json`（字体映射表）
  - `bridge/free_tiku_bridge.py` 中与字体解码兼容的流程
  - `userscripts/src/chaoxing.js`、`userscripts/src/pipeline.js` 中部分学习通 DOM 结构知识
- 说明：本项目选择 GPL-3.0 作为整体许可证，主要就是为了合规保留这些 GPL 字体模块。GPL 全文见根目录 `LICENSE`。

## 2. SocialSisterYi/xuexiaoyi-to-xuexitong-tampermonkey-proxy（MIT）

- 上游：<https://github.com/SocialSisterYi/xuexiaoyi-to-xuexitong-tampermonkey-proxy>
- 许可证：MIT
- 版权：Copyright (c) 2022 社会易姐QwQ
- 本项目使用的内容：`cxsecret_font.py` 文件头标注的参考来源，以及字体/学习通接口相关的公开知识。
- MIT 全文与版权行见 `licenses/MIT-NOTICES.txt`。

## 3. ocsjs/ocsjs（Apache-2.0）

- 上游：<https://github.com/ocsjs/ocsjs>
- 许可证：Apache License 2.0（注意：本地 `LICENSE` 是 Apache-2.0，不是 MIT）
- 版权：OCSJS 及其贡献者；具体版权/归属以各源文件头为准
- 本项目使用的内容：
  - `userscripts/src/pipeline.js`：课程树、任务点、章节切换的选择器知识和流程参考
  - `userscripts/src/chaoxing.js`：章节测验/作业页面的 DOM 结构知识
  - 早期调研中的 `cdn/chaoxing/ocs-cx-api.js`、`sk-main.js`、`cx-H5Video.js` 等入口
- 修改说明：本项目把这些知识重新组织成独立的 ES5 模块，删除了与本地题库桥无关的 OCS 功能，并接入了自己的面板、日志和流水线；没有把 OCSJS 作为运行时依赖。
- Apache-2.0 全文见 `licenses/Apache-2.0.txt`。本文件即对修改的说明。

## 4. DokiDoki1103/tikuAdapter（MIT）

- 上游：<https://github.com/DokiDoki1103/tikuAdapter>
- 许可证：MIT
- 版权：Copyright (c) 2023 itihey
- 本项目使用的内容：`bridge/free_tiku_bridge.py` 和 `userscripts/src/core.js` 中 `decrypt()` 的 Python/JS 移植，以及 tikuAdapter 兼容的请求/响应格式和题型编号。
- MIT 全文与版权行见 `licenses/MIT-NOTICES.txt`。

## 5. 2488054910/ocs-deepseek-adapter（MIT）

- 上游：<https://github.com/2488054910/ocs-deepseek-adapter>
- 许可证：MIT
- 版权：Copyright (c) 2026 2488054910
- 本项目使用的内容：`bridge/free_tiku_bridge.py` 中 AI 提示词的改写基础。
- 修改说明：提示词按本项目的题型、图片/公式限制和 JSON 输出要求做了调整；不是原样复制。
- MIT 全文与版权行见 `licenses/MIT-NOTICES.txt`。

## 6. FontTools（MIT）

- 上游：<https://github.com/fonttools/fonttools>
- 许可证：MIT
- 版权：Copyright (c) 2017 Just van Rossum
- 用途：题库桥解析学习通加密字体（运行时依赖）。
- 许可证全文见 `licenses/FontTools-LICENSE.txt`。

## 7. Requests（Apache-2.0）

- 上游：<https://github.com/psf/requests>
- 许可证：Apache License 2.0
- 版权：Copyright 2019 Kenneth Reitz；Requests 贡献者
- 用途：题库桥访问题库和 AI 接口（运行时依赖）。
- 许可证全文见 `licenses/Requests-LICENSE.txt`，NOTICE 见 `licenses/Requests-NOTICE.txt`。

## 8. PyInstaller（GPL-2.0-or-later，带 bootloader exception）

- 上游：<https://github.com/pyinstaller/pyinstaller>
- 许可证：GNU GPL v2 or later，附带 PyInstaller bootloader exception
- 用途：把题库桥打包成 Windows 单文件 exe（构建工具；exe 中可能包含 bootloader）。
- 说明：本项目不修改 PyInstaller；发布包同时提供完整 Python 源码和构建脚本。

## 9. linkedom（ISC）

- 上游：<https://github.com/WebReflection/linkedom>
- 许可证：ISC
- 版权：Copyright (c) 2021, Andrea Giammarchi, @WebReflection
- 用途：仅用于 Node 回归测试的 DOM 模拟，不进入发布包。
- 许可证全文见 `licenses/linkedom-LICENSE.txt`。

## 10. Python（PSF-2.0）

- 上游：<https://www.python.org/>
- 许可证：Python Software Foundation License 2.0
- 用途：题库桥运行时；发布包中的 exe 由 PyInstaller 打包 Python 运行时。

---

## 重新分发时请注意

1. 保留根目录 `LICENSE`、本文件、`licenses/` 目录，以及源码文件中的版权/许可证头。
2. 如果修改了 GPL 字体模块或本项目其他 GPL 代码，再分发时也要按 GPL-3.0-or-later 提供对应源码。
3. 不要把任何人的 `ai_config.json`、`bridge_requests.log`、`free_tiku_cache.json` 或真实 API Key 打进发布包。
4. 如果你把本项目与其它许可证不兼容的代码合并，请先确认许可证兼容性；GPL-3.0 与 Apache-2.0/MIT/ISC 兼容，但与专有代码不兼容。
