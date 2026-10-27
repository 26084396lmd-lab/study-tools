# 学习小助手

超星学习通（Chaoxing）的本地辅助脚本：**章节测验自动搜题作答 + 视频/音频任务点自动播放 + 加密字体还原**，全部计算在你的电脑本地完成，不上传任何课程数据。

> 免费题库（百度教育 / GO题）+ 可选 DeepSeek AI 兜底。无需搭建服务器，一个本地小程序 + 一个油猴脚本即可。

## ✨ 功能

- **三种模式**（面板下拉切换）
  - 🚄 **流水线（全自动）**：做题 + 视频全包，跑完整章
  - 📺 **只看视频/音频**：题目全部跳过，视频看完自动下一节
  - 📝 **只做题**：视频全部跳过，只答题，答完自动下一份
- **题库 + AI 双保险**：免费题库（百度教育/GO题）优先，命中后可选 AI 复核，不一致听 AI 的（挡住题库串题）
- **加密字体还原**：学习通的反爬字体乱码自动还原（本地 fontTools 解码）
- **图片公式题**：纯图片/公式选项自动走 AI 视觉识别
- **防呆设计**：考试页自动回避、不及格自动清缓存重做（上限防死循环）、结果页不重复作答
- **小玩意**：日志区壁纸轮换（◀▶手动/定时自动，需本机装 Node.js，没有不影响答题）、面板可折叠

## 📦 安装（5 步，约 3 分钟）

> **普通用户请从 [Releases](../../releases/latest) 下载发布包。**
> 不要点「Code → Download ZIP」——那是源码包，里面没有 exe 和启动脚本，无法直接运行。

1. **装 Tampermonkey**：[Edge 加载项](https://microsoftedge.microsoft.com/addons/detail/tampermonkey/iikmkjmpaadaobahmlepeloendndfphd) 或 [Chrome 网上应用店](https://chromewebstore.google.com/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo)，点「获取 / 添加至 Chrome」。
2. **打开「允许用户脚本」**：Edge 地址栏输入 `edge://extensions` → Tampermonkey → 详细信息 → 允许用户脚本；Chrome 用 `chrome://extensions`。**不开这个开关，脚本能装进去但不会运行。**
3. **启动本地服务**：到 [Releases](../../releases/latest) 下载 `study-helper-*.zip`（页面显示名为「学习小助手-…-清洁版.zip」），解压后双击 `一键启动.bat`；想用 AI 兜底就先双击 `设置我的AI-Key.bat` 填自己的 Key（不填也能搜题，只是没有 AI 兜底）。
4. **装脚本**：在打开的 `安装.html` 点绿色「安装脚本」→ Tampermonkey 弹窗点「安装」。如果页面是一整页 JavaScript 代码，按 `F5` 刷新一次。
5. **使用**：登录学习通，进入课程章节，右侧出现「学习小助手」面板，选模式后点「一键启动」。

**详细图文教程（含 4 张截图、SHA256 校验、常见问题、AI 全自动安装）**：

- 安装包内：`安装教程.html` / `安装教程.md`
- 仓库：[安装教程.md](安装教程.md) · [AGENT_INSTALL.md](AGENT_INSTALL.md)（给 AI 助手）
- 直接下载：<https://github.com/26084396lmd-lab/study-tools/releases/download/v1.3.47/study-helper-1.3.47.zip>
- 校验文件：<https://github.com/26084396lmd-lab/study-tools/releases/download/v1.3.47/SHA256SUMS.txt>

有 AI 助手时，可以把 [AGENT_INSTALL.md](AGENT_INSTALL.md) 里的提示词整段发给它；也可以解压后双击 `AI自动安装.bat`。停止本地服务用 `停止学习小助手.bat`。

首次运行 exe 时 Windows 可能提示「已保护你的电脑」，点「更多信息 → 仍要运行」即可（程序未做数字签名）。下载后可用 Releases 页面的 `SHA256SUMS.txt` 校验压缩包；详细步骤见 `安装教程.html`。

## 🐍 从源码运行

仓库里**不含 exe**（发布包在 Releases），本机有 Python 3.10+ 时可以直接跑：

```bash
pip install -r bridge/requirements.txt
python bridge/free_tiku_bridge.py     # 监听 127.0.0.1:8060
```

然后浏览器打开 <http://127.0.0.1:8060/install>，点绿色按钮安装脚本（也可以直接把 `userscripts/dist/学习小助手.user.js` 拖进 Tampermonkey）。源码模式不会自动弹浏览器，手动打开上面的地址即可。

## 🔧 从源码构建

```bash
cd userscripts
node build.js        # 生成 dist/学习小助手.user.js
node test/*.test.js  # 回归测试（需先 npm i linkedom）
```

## 📁 目录结构

```
├── bridge/          本地题库桥（Python，提供 /install /ai/ask /fonts 等接口）
├── userscripts/     油猴脚本（src/ 源码 + build.js + dist/ 产物 + test/ 回归）
├── licenses/        第三方许可证全文
├── release/         面向普通用户的发布包（已 gitignore，二进制走 GitHub Releases）
├── LICENSE          GPL-3.0-or-later
└── THIRD_PARTY_NOTICES.md  第三方代码归属与许可说明
```

## ⚖️ 许可证

本项目主体以 **GPL-3.0-or-later** 发布。字体解码模块源自 [Samueli924/chaoxing](https://github.com/Samueli924/chaoxing)（GPL-3.0），故整体遵循 GPL；详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## ⚠️ 免责声明

- 本项目与超星/学习通官方**无任何关联**，仅供个人学习交流
- 请遵守你所在学校/机构的规定，**不要用于考试**；本工具会自动答题、自动播放视频，可能违反学习通用户协议，请自行评估风险
- 使用本项目产生的任何后果由使用者自行承担
- AI 功能消耗你自己的 API 额度，Key 只存在你本机
