# 学习小助手 1.3.47 · 给 AI 助手的安装说明（Agent Install Guide）

> 本文件是给 **AI 助手 / 自动化代理** 读的。  
> 目标：在一台 Windows 10/11 电脑上，自动安装“学习小助手”桌面程序 + 专用 Edge 浏览器配置 + Tampermonkey + 用户脚本，并完成验证。  
> 最后一步“登录学习通”必须由用户本人完成；**不要询问、输入或保存用户的账号密码、短信验证码、扫码授权**。

---

## 0. 一分钟版（推荐直接执行）

在 PowerShell 中运行：

```powershell
$ErrorActionPreference = "Stop"
$u = "https://raw.githubusercontent.com/26084396lmd-lab/study-tools/main/tools/agent-install.ps1"
$p = Join-Path $env:TEMP "study-helper-agent-install.ps1"
Invoke-WebRequest -Uri $u -OutFile $p -UseBasicParsing
Unblock-File $p
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $p
```

脚本会完成：

1. 检查 Windows / PowerShell / Edge / 磁盘空间；
2. 从官方 GitHub Release 下载 `study-helper-1.3.47.zip`；
3. 下载 `SHA256SUMS.txt` 并校验 SHA256（不一致立即停止）；
4. 解压到 `%LOCALAPPDATA%\学习小助手`（保留已有的 `ai_config.json`）；
5. 启动本地服务并验证 `http://127.0.0.1:8060/ping`；
6. 创建专用 Edge 配置（不碰用户日常浏览器）；
7. 下载 Tampermonkey 官方 CRX，加载到专用配置；
8. 打开用户脚本安装页，自动点“安装”；
9. 打开 `edge://extensions`，自动开启“允许用户脚本”；
10. 验证 Tampermonkey 管理面板里出现 `学习小助手 1.3.47`；
11. 在桌面创建“学习小助手浏览器”快捷方式；
12. 打开学习通登录页，把登录交给用户。

**预期结果文件**：

```text
%LOCALAPPDATA%\学习小助手\install-result.json
%LOCALAPPDATA%\学习小助手\install.log
```

`install-result.json` 中 `"ok": true` 表示安装和自动验证通过。  
退出码：`0` 成功；`1` 失败；`2` 程序已装好，但浏览器扩展需要用户/代理手动处理。

---

## 1. 给用户的提示词（可直接转发）

```text
你是我的安装助手。请完整阅读并严格执行：
https://raw.githubusercontent.com/26084396lmd-lab/study-tools/main/AGENT_INSTALL.md

目标：自动安装“学习小助手”（桌面程序 + 专用 Edge 浏览器 + Tampermonkey + 用户脚本），并完成验证。

要求：
1. 只从官方 GitHub 和 Tampermonkey 官方商店/官方 CRX 接口下载；
2. 不要询问、输入或保存我的学习通账号密码；需要登录时停下来让我操作；
3. 安装完成后，把安装目录、验证结果和下一步告诉我。
```

---

## 2. 硬性规则（必须遵守）

1. **不要询问或处理学习通密码 / 短信验证码 / 扫码**。  
   需要登录时，打开登录页，然后停止并请用户操作。
2. **不要修改用户的日常浏览器配置**。  
   自动安装使用独立的 Edge 配置目录；不要删除/覆盖用户的 Edge 默认配置。
3. **不要写企业策略 / 注册表来强制安装扩展**。  
   本方案用独立配置 + 官方 CRX，不需要管理员权限，也不改系统策略。
4. **不要关闭 Windows Defender / SmartScreen / 杀毒软件**。  
   exe 未签名，SmartScreen 可能弹一次，必须由用户点“更多信息 → 仍要运行”；`Unblock-File` 只能去掉“来自网络”标记，不能绕过 SmartScreen。
5. **只从以下来源下载**：
   - 程序：`https://github.com/26084396lmd-lab/study-tools/releases/...`
   - 校验：同一 Release 的 `SHA256SUMS.txt`
   - Tampermonkey：Chrome Web Store 官方 CRX 接口，或 Edge 加载项官方商店
   - **不要**使用第三方 CRX 下载站、网盘、破解站。
6. **校验失败就停止**，不要“先运行看看”。
7. **不要用于考试**；本工具会自动化课程页面操作，可能违反学习通用户协议。
8. **不要暴露 8060 端口**；本地服务只监听 `127.0.0.1`，不要改成 `0.0.0.0`，不要做公网映射。

---

## 3. 输入与环境

### 3.1 固定信息

| 项 | 值 |
|---|---|
| 程序版本 | `1.3.47` |
| Release tag | `v1.3.47` |
| 发布页 | `https://github.com/26084396lmd-lab/study-tools/releases/tag/v1.3.47` |
| zip 文件名 | `study-helper-1.3.47.zip` |
| 直接下载 | `https://github.com/26084396lmd-lab/study-tools/releases/download/v1.3.47/study-helper-1.3.47.zip` |
| 校验文件 | `https://github.com/26084396lmd-lab/study-tools/releases/download/v1.3.47/SHA256SUMS.txt` |
| 默认安装目录 | `%LOCALAPPDATA%\学习小助手` |
| 本地服务 | `http://127.0.0.1:8060` |
| 用户脚本 URL | `http://127.0.0.1:8060/userscript.user.js` |
| 用户脚本大小 | 约 288,770 字节（以实际为准） |
| 结果文件 | `%LOCALAPPDATA%\学习小助手\install-result.json` |

### 3.2 环境检查

```powershell
# Windows 版本
[Environment]::OSVersion.Version

# PowerShell 版本（需要 5.1+）
$PSVersionTable.PSVersion

# Edge 是否存在
$edge = @(
  "$env:ProgramFiles(x86)\Microsoft\Edge\Application\msedge.exe",
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
  "$env:LOCALAPPDATA\Microsoft\Edge\Application\msedge.exe"
) | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
$edge

# 磁盘空间（至少 300 MB）
Get-PSDrive C | Select-Object Used,Free
```

如果 Edge 不存在：

- Windows 10/11 通常自带 Edge；如果没有，先用 `winget install Microsoft.Edge` 安装，或让用户从 <https://www.microsoft.com/edge> 安装；
- 没有 Edge 时，自动安装路径不可用；改用 `-NoBrowser` 安装桌面程序，再按手动教程在用户自己的浏览器里安装 Tampermonkey。

---

## 4. 自动安装脚本的参数

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\agent-install.ps1 `
  -InstallDir "$env:LOCALAPPDATA\学习小助手" `
  -Browser Auto `
  -Force
```

| 参数 | 默认 | 说明 |
|---|---|---|
| `-InstallDir` | `%LOCALAPPDATA%\学习小助手` | 安装目录；不要用 `C:\Program Files` |
| `-Browser` | `Auto` | `Auto` / `Edge` / `Chrome` / `None`；推荐 `Edge` |
| `-NoBrowser` | 关 | 只装桌面程序，跳过浏览器扩展（之后可手动装） |
| `-NoLaunch` | 关 | 装完/验证后不重新打开浏览器（适合 CI/代理接管） |
| `-NoShortcut` | 关 | 不创建桌面快捷方式（测试用） |
| `-Force` | 关 | 覆盖安装；仍会保留 `ai_config.json` |
| `-ZipPath` | 空 | 用本地 zip，不重新下载；仍会校验 SHA256 |
| `-ChecksumUrl` | 官方 | 覆盖校验文件地址（一般不用） |
| `-DebugPort` | 自动 | 指定 CDP 调试端口（一般不用） |

**不要**给普通用户加 `-SkipHashCheck` 之类的参数；本脚本默认强制校验。

---

## 5. 脚本执行流程（代理需要知道的细节）

### 阶段 1：下载与校验

- 下载到 `%TEMP%\study-helper-1.3.47.zip`；
- 下载 `SHA256SUMS.txt`，解析 `study-helper-1.3.47.zip` 那一行；
- 如果校验文件下载失败，会尝试 GitHub API 的 release asset `digest`；
- 两者都拿不到 → 报错退出，**不要**跳过校验继续。

**手动复核命令**：

```powershell
$zip = "$env:TEMP\study-helper-1.3.47.zip"
Get-FileHash $zip -Algorithm SHA256
(Invoke-WebRequest "https://github.com/26084396lmd-lab/study-tools/releases/download/v1.3.47/SHA256SUMS.txt" -UseBasicParsing).Content
```

### 阶段 2：解压与启动

- 解压到临时目录，找到 `启动免费题库.exe`；
- 复制到 `%LOCALAPPDATA%\学习小助手`；
- 保留已有 `ai_config.json`；
- 创建 `学习通免费题库助手.user.js`（旧版 exe 只认这个文件名）；
- 设置 `FTK_OPEN=0`，避免 exe 自动打开默认浏览器；
- 启动 `启动免费题库.exe`，等待 `/ping` 返回 200。

**手动验证**：

```powershell
Invoke-WebRequest "http://127.0.0.1:8060/ping" -UseBasicParsing | Select-Object StatusCode,Content
Invoke-WebRequest "http://127.0.0.1:8060/health" -UseBasicParsing | Select-Object StatusCode,Content
$u = Invoke-WebRequest "http://127.0.0.1:8060/userscript.user.js" -UseBasicParsing
$u.StatusCode
$u.RawContentLength
$u.Headers["Content-Type"]
```

预期：`/ping` 200；`/health` 200 JSON；用户脚本 200、约 288770 字节、`text/javascript`。

### 阶段 3：专用 Edge + Tampermonkey

- 配置目录：`%LOCALAPPDATA%\学习小助手\browser\edge-profile`
- 扩展目录：`%LOCALAPPDATA%\学习小助手\browser\tampermonkey`
- 启动参数（示例）：

```text
msedge.exe
  --user-data-dir="%LOCALAPPDATA%\学习小助手\browser\edge-profile"
  --load-extension="%LOCALAPPDATA%\学习小助手\browser\tampermonkey"
  --remote-debugging-port=<临时端口>
  --no-first-run
  --no-default-browser-check
  http://127.0.0.1:8060/userscript.user.js
```

- 脚本通过 CDP 等待 Tampermonkey 的 service worker **或** `ask.html` 安装页（MV3 的后台服务可能延迟启动，不能用“没看到 worker”判断扩展没装好）；
- **首次打开用户脚本 URL 可能是原始 JS**（扩展还没初始化完），脚本会刷新一次；
- 刷新后 Tampermonkey 会打开 `ask.html` 安装页；脚本点“安装”；
- 然后打开 `edge://extensions/?id=<扩展ID>`，找到“允许用户脚本”开关并打开；
- 验证 Tampermonkey 管理面板出现 `学习小助手（无需 key）`；
- 关闭带调试端口的浏览器，再以同样配置、**不带调试端口**重新打开学习通登录页。

> 正常更新会复用专用配置，不会重置，也不会让用户重新登录。只有专用配置里的 Tampermonkey 无法使用（例如配置损坏、扩展被禁用）或调试端口起不来时，脚本才会重置一次并重试；重置后学习通需要重新登录，`install-result.json` / `install.log` 会记录，结果里的 `profileReset` 为 `true`。日常浏览器不受影响。

> 为什么关闭调试端口？  
> 调试端口能让本机任意程序控制浏览器；安装完成后不应长期开着。

### 阶段 4：验证

自动验证项（写入 `install-result.json`）：

```json
{
  "ok": true,
  "version": "1.3.47",
  "installDir": "C:\\Users\\...\\AppData\\Local\\学习小助手",
  "appPort": 8060,
  "appPid": 1234,
  "userscriptBytes": 288770,
  "browser": "Edge",
  "browserExe": "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "profileDir": "...\\browser\\edge-profile",
  "extensionDir": "...\\browser\\tampermonkey",
  "extensionId": "................",
  "userscriptInstalled": true,
  "allowUserScripts": true,
  "dedicatedBrowser": true,
  "profileReset": false,
  "shortcut": "C:\\Users\\...\\Desktop\\学习小助手浏览器.lnk",
  "nextStep": "请在学习小助手浏览器中登录学习通..."
}
```

代理应读取该文件并检查：

- `ok === true`
- `userscriptInstalled === true`
- `allowUserScripts === true`
- `appPort === 8060`
- `userscriptBytes` 接近 288770
- `profileReset === true` 时，提醒用户：专用浏览器配置被重置，需要重新登录学习通（不影响日常浏览器）。

然后做一次独立检查：

```powershell
(Invoke-WebRequest "http://127.0.0.1:8060/ping" -UseBasicParsing).StatusCode
(Invoke-WebRequest "http://127.0.0.1:8060/userscript.user.js" -UseBasicParsing).RawContentLength
Get-Content "$env:LOCALAPPDATA\学习小助手\install-result.json" -Raw
```

如果安装脚本启动时重定向了日志，可以检查：

```powershell
Get-Content "$env:LOCALAPPDATA\学习小助手\app.log" -Tail 30
```

在打开学习通页面后，日志里出现 `[script] INJECTED` 表示脚本确实注入成功；`READY` 表示主流程启动完成。

### 阶段 5：登录交接（必须停）

打开专用浏览器，进入：

```text
https://passport2.chaoxing.com/login
```

> 专用浏览器必须通过桌面快捷方式 **“学习小助手浏览器”** 或安装目录里的 `start-browser.cmd` 启动；不要直接双击普通 Edge/Chrome 图标。普通浏览器不会带专用配置和 `--load-extension`，脚本不会出现。

然后对用户说：

> 安装已经完成并验证通过。请在这个“学习小助手浏览器”窗口里登录学习通；  
> 登录后打开你的课程章节，右侧出现“学习小助手”面板就表示成功。  
> 不需要把账号密码发给我。

**不要**：

- 询问账号密码；
- 代替用户输入密码/验证码；
- 读取用户的浏览器 Cookie / 登录态；
- 尝试绕过验证码、扫码、2FA。

如果用户已经登录，可以让用户打开课程页；代理如果有浏览器控制权，可以检查页面右侧是否出现 `学习小助手` 面板；没有控制权就让用户确认。

---

## 6. 失败时的决策树

### 6.1 下载失败 / GitHub 打不开

1. 换网络（手机热点）重试；
2. 打开发布页确认 asset 是否存在；
3. 让用户手动下载 zip，放到本地，然后用 `-ZipPath` 重跑：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\agent-install.ps1 `
  -ZipPath "C:\Users\你\Downloads\study-helper-1.3.47.zip" `
  -Force
```

4. **不要**改用陌生镜像；如果必须用第三方，先核对官方 SHA256。

### 6.2 SHA256 不一致

**立即停止**，不要解压/运行。删除 zip，重新从官方 Release 下载。  
如果多次不一致，让用户检查网络/代理是否篡改下载；把实际 Hash 和期望 Hash 报告给用户。

### 6.3 SmartScreen / 杀毒拦截

- `Unblock-File` 只能去掉“来自网络”标记；
- SmartScreen 弹窗需要用户点 **“更多信息 → 仍要运行”**；
- 杀毒软件隔离了 exe：让用户核对来源和 SHA256 后，把安装目录加入信任；
- **不要**建议用户关闭 Defender/杀毒软件。

### 6.4 端口 8060 被占用

```powershell
netstat -ano | findstr :8060
Get-Process -Id <PID> | Select-Object Id,ProcessName,Path
```

- 如果是旧的学习小助手 `启动免费题库.exe`：结束它，重新启动；
- 如果是源码版 `python.exe`：让用户先关闭源码版；
- 如果是其他程序：不要杀，报告 PID/路径，让用户处理或换机器。

### 6.5 Tampermonkey CRX 下载失败（脚本退出码 2）

按以下顺序处理：

1. 确认网络能访问 `clients2.google.com` 或 `edge.microsoft.com`；
2. 让用户/代理在专用 Edge 里打开 **Edge 加载项**：

   ```text
   https://microsoftedge.microsoft.com/addons/detail/tampermonkey/iikmkjmpaadaobahmlepeloendndfphd
   ```

3. 点 **“获取” → “添加扩展”**；
4. 打开：

   ```text
   http://127.0.0.1:8060/userscript.user.js
   ```

   如果满屏代码，按 `F5` 刷新；
5. Tampermonkey 安装页点 **“安装”**；
6. 打开 `edge://extensions` → Tampermonkey → 详细信息 → **允许用户脚本** 打开；
7. 打开 Tampermonkey 管理面板，确认脚本在列表里且已启用；
8. 重新运行安装脚本（它会复用已有程序/配置；如果它仍尝试下载 CRX，可以用 `-NoBrowser` 先跳过，然后按上面手动完成浏览器部分）。

> 如果代理有浏览器自动化工具，可以直接完成第 2–7 步，不需要用户点。

### 6.6 用户脚本页一直显示代码

1. 确认 Tampermonkey 已安装且启用；
2. 确认“允许用户脚本”已打开；
3. 刷新页面（`F5`）；
4. 把 `学习小助手.user.js` 拖进浏览器；
5. Tampermonkey 管理面板 → 实用工具 → 从 URL 安装 → 粘贴 `http://127.0.0.1:8060/userscript.user.js`；
6. 仍不行就报告浏览器版本、Tampermonkey 版本、页面截图。

### 6.7 管理面板出现“请启用‘允许用户脚本’”

说明开关没生效：

1. 打开 `edge://extensions`（或 `chrome://extensions`）；
2. Tampermonkey → 详细信息 → 允许用户脚本 → 打开；
3. 回到管理面板刷新；
4. 如果开关又变回关闭，检查是否有企业策略/安全软件阻止；不要用注册表强制绕过，报告用户。

### 6.8 专用浏览器打不开 / 配置被占用

- 先关闭已经打开的“学习小助手浏览器”窗口（不是用户日常 Edge）；
- 确认没有残留 `msedge.exe` 占用该 profile；
- 重新双击桌面快捷方式；
- 仍失败就让用户重启电脑后重试；
- **不要**删除用户的日常 Edge 配置。

如果确认专用配置损坏，可以让用户删除 `%LOCALAPPDATA%\学习小助手\browser\edge-profile` 后重新运行安装脚本；这会丢失该专用配置里的学习通登录状态（不影响日常 Edge），需要重新登录一次。

### 6.9 脚本装了但学习通页面没面板

按顺序检查：

1. 网址必须是 `*.chaoxing.com` 的课程/章节页；
2. Tampermonkey 管理面板里脚本已启用；
3. “允许用户脚本”已打开；
4. `http://127.0.0.1:8060/ping` 返回 200；
5. 刷新页面；
6. 只保留一个学习通脚本；
7. 浏览器 F12 控制台看红色报错；
8. 检查 `app.log` 是否有 `[script] INJECTED` / `READY`；
9. 把版本、浏览器版本、报错、日志最后几十行报告给用户/作者。

---

## 7. 安装完成后向用户报告什么

用简短中文报告：

```text
安装完成，已验证：
- 安装目录：C:\Users\...\AppData\Local\学习小助手
- 本地服务：http://127.0.0.1:8060/ping 正常
- 用户脚本：已安装到专用 Edge（Tampermonkey）
- “允许用户脚本”：已开启
- 桌面快捷方式：学习小助手浏览器

下一步：双击“学习小助手浏览器”，登录学习通，打开课程章节。
右侧出现“学习小助手”面板即成功。
如果 SmartScreen 弹出，请点“更多信息 → 仍要运行”。
不要把学习通密码发给我。
```

如果 `install-result.json` 的 `ok` 为 `false` 或退出码为 2，报告：

- 失败阶段；
- `install.log` 最后 30–50 行；
- 已经完成的部分；
- 用户需要做的 1–2 个动作（例如点 SmartScreen、手动装 Tampermonkey、登录）。

---

## 8. 卸载（供代理参考）

```powershell
# 1. 停止本地服务（只结束占用 8060 的学习小助手）
$conn = Get-NetTCPConnection -LocalPort 8060 -State Listen -ErrorAction SilentlyContinue
if ($conn) { Stop-Process -Id $conn.OwningProcess -Force }

# 2. 删除安装目录（含专用 Edge 配置和扩展）
Remove-Item "$env:LOCALAPPDATA\学习小助手" -Recurse -Force

# 3. 删除桌面快捷方式
Remove-Item "$env:USERPROFILE\Desktop\学习小助手浏览器.lnk" -Force -ErrorAction SilentlyContinue
Remove-Item "$env:USERPROFILE\Desktop\学习小助手.lnk" -Force -ErrorAction SilentlyContinue
```

不要删除用户日常 Edge 的配置目录（`%LOCALAPPDATA%\Microsoft\Edge\User Data`）。

---

## 9. 安全与合规

- 本工具与超星/学习通官方无关联；
- 自动化课程操作可能违反学习通用户协议，**不要用于考试**；
- 只从官方 GitHub / 官方扩展商店下载；
- 校验 SHA256；
- 不收集/上传学习通账号密码；
- 不把 8060 暴露到公网；
- 不把 `ai_config.json`（可能含 API Key）发给别人；
- 未经用户明确同意，不要修改系统策略、注册表、默认浏览器或日常浏览器配置。

---

## 10. 参考

- 详细图文教程（人类阅读）：<https://github.com/26084396lmd-lab/study-tools/blob/main/安装教程.md>
- 发布页：<https://github.com/26084396lmd-lab/study-tools/releases/tag/v1.3.47>
- 问题反馈：<https://github.com/26084396lmd-lab/study-tools/issues>

---

**版本：1.3.47 · 文档更新：2026-10-27**
