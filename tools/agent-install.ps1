#requires -Version 5.1
<#
.SYNOPSIS
    学习小助手 1.3.47 - AI/高级用户自动安装脚本（Windows）

.DESCRIPTION
    自动完成：
      1. 从官方 GitHub Release 下载并校验 study-helper-1.3.47.zip
      2. 解压到 %LOCALAPPDATA%\学习小助手（保留已有 ai_config.json）
      3. 启动本地服务并验证 http://127.0.0.1:8060
      4. 创建专用 Edge 配置 + 下载 Tampermonkey + 安装用户脚本
      5. 自动开启「允许用户脚本」并验证
      6. 创建桌面「学习小助手浏览器」快捷方式
      7. 打开学习通登录页，把登录交给用户

    不会询问/输入学习通密码；不会修改用户日常浏览器配置；不需要管理员权限。

.PARAMETER InstallDir
    安装目录，默认 %LOCALAPPDATA%\学习小助手。不要用 C:\Program Files。

.PARAMETER Browser
    Auto / Edge / Chrome / None。默认 Auto（优先 Edge）。

.PARAMETER NoBrowser
    只安装桌面程序，跳过浏览器扩展。

.PARAMETER NoLaunch
    完成安装和验证后不重新打开浏览器（适合测试/代理接管）。

.PARAMETER NoShortcut
    不创建桌面快捷方式。

.PARAMETER Force
    覆盖安装；仍会保留 ai_config.json。

.PARAMETER ZipPath
    使用本地 zip，不重新下载；仍会校验 SHA256。

.PARAMETER ChecksumUrl
    覆盖 SHA256SUMS.txt 地址（一般不用）。

.PARAMETER CrxPath
    使用本地 Tampermonkey CRX（网络无法访问官方 CRX 接口时用）。

.PARAMETER DebugPort
    指定 CDP 调试端口（一般不用；默认自动选空闲端口）。

.EXAMPLE
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\agent-install.ps1

.EXAMPLE
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\agent-install.ps1 -NoBrowser

.NOTES
    版本：1.3.47
    仓库：https://github.com/26084396lmd-lab/study-tools
#>

[CmdletBinding()]
param(
    [string]$InstallDir = (Join-Path $env:LOCALAPPDATA "学习小助手"),
    [ValidateSet("Auto", "Edge", "Chrome", "None")]
    [string]$Browser = "Auto",
    [switch]$NoBrowser,
    [switch]$NoLaunch,
    [switch]$NoShortcut,
    [switch]$Force,
    [string]$ZipPath = "",
    [string]$ChecksumUrl = "",
    [string]$CrxPath = "",
    [int]$DebugPort = 0
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

# ---------------------------------------------------------------------------
# 常量
# ---------------------------------------------------------------------------
$AppVersion        = "1.3.47"
$Repo              = "https://github.com/26084396lmd-lab/study-tools"
$Tag               = "v1.3.47"
$ZipName           = "study-helper-1.3.47.zip"
$ZipUrl            = "$Repo/releases/download/$Tag/$ZipName"
$DefaultChecksumUrl = "$Repo/releases/download/$Tag/SHA256SUMS.txt"
$ApiReleaseUrl     = "https://api.github.com/repos/26084396lmd-lab/study-tools/releases/tags/$Tag"
$AppPort           = 8060
$AppExeName        = "启动免费题库.exe"
$UserScriptName    = "学习小助手.user.js"
$UserScriptAlias   = "学习通免费题库助手.user.js"
$HideVbsName       = "hide.vbs"
$ChromeUa          = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
$CrxUrls = @(
    "https://clients2.google.com/service/update2/crx?response=redirect&prodversion=120.0&acceptformat=crx2,crx3&x=id%3Ddhdgffkkebhmkfjojejmpbldmpobfkfo%26uc",
    "https://edge.microsoft.com/extensionwebstorebase/v1/crx?response=redirect&x=id%3Diikmkjmpaadaobahmlepeloendndfphd%26uc"
)

# ---------------------------------------------------------------------------
# 全局状态
# ---------------------------------------------------------------------------
$script:InstallDir = [IO.Path]::GetFullPath($InstallDir)
$script:LogPath = Join-Path $script:InstallDir "install.log"
$script:ResultPath = Join-Path $script:InstallDir "install-result.json"
$script:SourceRoot = $null
$script:TempExtractRoot = $null
$script:NeedsUserAction = $false
$script:DebugPort = $null
$script:BrowserProcess = $null
$script:Result = [ordered]@{
    ok = $false
    version = $AppVersion
    stage = "init"
    installDir = $script:InstallDir
    appPath = $null
    appPid = $null
    appPort = $AppPort
    appRunning = $false
    appReused = $false
    pingOk = $false
    healthOk = $false
    userscriptPath = $null
    userscriptBytes = $null
    browser = $null
    browserExe = $null
    profileDir = $null
    profileReset = $false
    extensionDir = $null
    extensionId = $null
    tampermonkeyVersion = $null
    userscriptInstalled = $false
    allowUserScripts = $false
    dedicatedBrowser = $false
    shortcut = $null
    debugPort = $null
    nextStep = $null
    error = $null
    logPath = $script:LogPath
    resultPath = $script:ResultPath
    timestamp = (Get-Date).ToString("s")
}

# ---------------------------------------------------------------------------
# 日志 / 结果
# ---------------------------------------------------------------------------
function Write-Log {
    param(
        [string]$Message,
        [string]$Level = "INFO"
    )
    $line = "[{0}] [{1}] {2}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Level, $Message
    try { Write-Host $line } catch {}
    try {
        if ($script:LogPath) {
            $parent = Split-Path -Parent $script:LogPath
            if ($parent -and -not (Test-Path -LiteralPath $parent)) {
                New-Item -ItemType Directory -Force -Path $parent | Out-Null
            }
            Add-Content -LiteralPath $script:LogPath -Value $line -Encoding UTF8
        }
    } catch {}
}

function Save-Result {
    try {
        $script:Result.timestamp = (Get-Date).ToString("s")
        $json = $script:Result | ConvertTo-Json -Depth 8
        $parent = Split-Path -Parent $script:ResultPath
        if ($parent -and -not (Test-Path -LiteralPath $parent)) {
            New-Item -ItemType Directory -Force -Path $parent | Out-Null
        }
        [IO.File]::WriteAllText($script:ResultPath, $json, (New-Object Text.UTF8Encoding($false)))
    } catch {
        try { Write-Host "[WARN] 写入结果文件失败: $($_.Exception.Message)" } catch {}
    }
}

# ---------------------------------------------------------------------------
# HTTP / 下载 / 校验
# ---------------------------------------------------------------------------
function Test-HttpOk {
    param([string]$Url, [int]$TimeoutSec = 3)
    try {
        $r = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec $TimeoutSec
        return ($r.StatusCode -ge 200 -and $r.StatusCode -lt 300)
    } catch {
        return $false
    }
}

function Wait-Http {
    param([string]$Url, [int]$TimeoutSec = 60)
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        if (Test-HttpOk -Url $Url -TimeoutSec 2) { return $true }
        Start-Sleep -Milliseconds 500
    }
    return $false
}

function Get-FreePort {
    param([int]$Start = 9223, [int]$End = 9399)
    for ($p = $Start; $p -le $End; $p++) {
        try {
            $listener = New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback, $p)
            $listener.Start()
            $listener.Stop()
            return $p
        } catch {}
    }
    throw "找不到空闲的调试端口（$Start-$End）。"
}

function Get-FileSha256 {
    param([string]$Path)
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Invoke-Download {
    param(
        [string]$Url,
        [string]$OutFile,
        [int]$TimeoutSec = 600,
        [string]$UserAgent = $ChromeUa
    )
    $parent = Split-Path -Parent $OutFile
    if ($parent -and -not (Test-Path -LiteralPath $parent)) {
        New-Item -ItemType Directory -Force -Path $parent | Out-Null
    }
    $tmp = "$OutFile.part"
    if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue }
    $headers = @{}
    if ($UserAgent) { $headers["User-Agent"] = $UserAgent }
    try {
        Invoke-WebRequest -Uri $Url -OutFile $tmp -UseBasicParsing -MaximumRedirection 10 -TimeoutSec $TimeoutSec -Headers $headers
    } catch {
        if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue }
        $wc = New-Object Net.WebClient
        if ($UserAgent) { $wc.Headers.Add("User-Agent", $UserAgent) }
        try {
            $wc.DownloadFile($Url, $tmp)
        } finally {
            $wc.Dispose()
        }
    }
    if (-not (Test-Path -LiteralPath $tmp)) { throw "下载失败：$Url" }
    $len = (Get-Item -LiteralPath $tmp).Length
    if ($len -le 0) {
        Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
        throw "下载文件为空：$Url"
    }
    Move-Item -LiteralPath $tmp -Destination $OutFile -Force
    return $len
}

function Get-ExpectedSha256 {
    param([string]$Url)
    $checksumUrl = if ($Url) { $Url } else { $DefaultChecksumUrl }
    $tmp = Join-Path $env:TEMP ("study-helper-sha-" + [Guid]::NewGuid().ToString("N") + ".txt")
    try {
        Write-Log "下载校验文件：$checksumUrl"
        $null = Invoke-Download -Url $checksumUrl -OutFile $tmp -TimeoutSec 120 -UserAgent "study-helper-agent-install"
        $lines = Get-Content -LiteralPath $tmp -ErrorAction Stop
        foreach ($line in $lines) {
            if ($line -match '^([0-9a-fA-F]{64})\s+\*?(.+)$') {
                $hash = $matches[1].ToLowerInvariant()
                $name = $matches[2].Trim()
                if ($name -eq $ZipName -or $name -like "*$ZipName") { return $hash }
            }
        }
        Write-Log "校验文件里没有找到 $ZipName，尝试 GitHub API digest。" "WARN"
    } catch {
        Write-Log "校验文件下载失败：$($_.Exception.Message)" "WARN"
    } finally {
        if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue }
    }
    try {
        $release = Invoke-RestMethod -Uri $ApiReleaseUrl -Headers @{ "User-Agent" = "study-helper-agent-install" } -TimeoutSec 30
        $asset = $release.assets | Where-Object { $_.name -eq $ZipName } | Select-Object -First 1
        if ($asset -and $asset.digest -match '^sha256:([0-9a-fA-F]{64})$') {
            return $matches[1].ToLowerInvariant()
        }
    } catch {
        Write-Log "GitHub API 校验失败：$($_.Exception.Message)" "WARN"
    }
    throw "无法获取 $ZipName 的 SHA256；拒绝在未校验的情况下安装。"
}

# ---------------------------------------------------------------------------
# 端口 / 进程 / 安装包
# ---------------------------------------------------------------------------
function Get-PortOwner {
    param([int]$Port)
    try {
        $conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($conn) {
            $ownerPid = [int]$conn.OwningProcess
            $proc = Get-Process -Id $ownerPid -ErrorAction SilentlyContinue
            $name = ""
            $path = ""
            if ($proc) {
                $name = $proc.ProcessName
                try { $path = $proc.Path } catch {}
            }
            return [pscustomobject]@{ Pid = $ownerPid; Name = $name; Path = $path }
        }
    } catch {}
    $line = (netstat -ano | Select-String ":$Port\s+.*LISTENING" | Select-Object -First 1)
    if ($line -and $line.Line -match '\s+(\d+)\s*$') {
        $ownerPid = [int]$matches[1]
        $proc = Get-Process -Id $ownerPid -ErrorAction SilentlyContinue
        $name = ""
        $path = ""
        if ($proc) {
            $name = $proc.ProcessName
            try { $path = $proc.Path } catch {}
        }
        return [pscustomobject]@{ Pid = $ownerPid; Name = $name; Path = $path }
    }
    return $null
}

function Get-ProcessPaths {
    param([int]$ProcessId)
    $paths = @()
    $cur = $ProcessId
    for ($i = 0; $i -lt 5; $i++) {
        $p = $null
        try {
            $p = Get-CimInstance Win32_Process -Filter "ProcessId=$cur" -ErrorAction Stop
        } catch {
            try { $p = Get-WmiObject Win32_Process -Filter "ProcessId=$cur" -ErrorAction Stop } catch { $p = $null }
        }
        if (-not $p) { break }
        if ($p.ExecutablePath) { $paths += [string]$p.ExecutablePath }
        $parent = 0
        if ($p.ParentProcessId) { $parent = [int]$p.ParentProcessId }
        if ($parent -le 0 -or $parent -eq $cur) { break }
        $cur = $parent
    }
    return $paths
}

function Get-ProcessChain {
    param([int]$ProcessId)
    $chain = @()
    $cur = $ProcessId
    for ($i = 0; $i -lt 6; $i++) {
        $p = $null
        try {
            $p = Get-CimInstance Win32_Process -Filter "ProcessId=$cur" -ErrorAction Stop
        } catch {
            try { $p = Get-WmiObject Win32_Process -Filter "ProcessId=$cur" -ErrorAction Stop } catch { $p = $null }
        }
        if (-not $p) { break }
        $chain += [pscustomobject]@{
            Pid = [int]$p.ProcessId
            ParentPid = [int]$p.ParentProcessId
            Name = [string]$p.Name
            Path = [string]$p.ExecutablePath
        }
        $parent = 0
        if ($p.ParentProcessId) { $parent = [int]$p.ParentProcessId }
        if ($parent -le 0 -or $parent -eq $cur) { break }
        $cur = $parent
    }
    return $chain
}

function Test-PathUnder {
    param([string]$Path, [string]$Root)
    if (-not $Path -or -not $Root) { return $false }
    try {
        $p = [IO.Path]::GetFullPath($Path).TrimEnd('\')
        $r = [IO.Path]::GetFullPath($Root).TrimEnd('\')
        if ($p.Equals($r, [StringComparison]::OrdinalIgnoreCase)) { return $true }
        return $p.StartsWith($r + "\", [StringComparison]::OrdinalIgnoreCase)
    } catch {
        return $false
    }
}

function Stop-OwnApp {
    param([int]$Port, [string]$InstallDir, [string]$SourceRoot)
    $owner = Get-PortOwner -Port $Port
    if (-not $owner) { return $false }

    $paths = @()
    if ($owner.Path) { $paths += $owner.Path }
    $paths += Get-ProcessPaths -ProcessId $owner.Pid
    $ours = $false
    foreach ($p in $paths) {
        if (Test-PathUnder -Path $p -Root $InstallDir) { $ours = $true; break }
        if ($SourceRoot -and (Test-PathUnder -Path $p -Root $SourceRoot)) { $ours = $true; break }
    }

    if (-not $ours) {
        try {
            $h = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 3
            if ($h -and ($h.PSObject.Properties.Name -contains "ai")) { $ours = $true }
        } catch {}
    }

    if (-not $ours) {
        throw "端口 $Port 被其他程序占用：PID $($owner.Pid) $($owner.Name) $($owner.Path)。请先关闭它，或换一台电脑。"
    }

    Write-Log "停止旧的学习小助手进程 PID=$($owner.Pid) ..."
    $chain = @(Get-ProcessChain -ProcessId $owner.Pid)
    $killPid = $owner.Pid
    $ownerBase = ""
    if ($chain.Count -gt 0) {
        $ownerBase = [IO.Path]::GetFileNameWithoutExtension($chain[0].Path)
    }
    if (-not $ownerBase) { $ownerBase = $owner.Name }
    for ($i = 1; $i -lt $chain.Count; $i++) {
        $p = $chain[$i]
        $base = [IO.Path]::GetFileNameWithoutExtension($p.Path)
        $under = Test-PathUnder -Path $p.Path -Root $InstallDir
        if ($SourceRoot -and (Test-PathUnder -Path $p.Path -Root $SourceRoot)) { $under = $true }
        if ($under -and $base -eq $ownerBase) {
            $killPid = $p.Pid
        } else {
            break
        }
    }
    if ($killPid -ne $owner.Pid) {
        Write-Log "同时停止同目录的父进程 PID=$killPid ..."
    }
    try {
        & "$env:WINDIR\System32\taskkill.exe" /PID $killPid /T /F | Out-Null
    } catch {}
    if (Get-Process -Id $owner.Pid -ErrorAction SilentlyContinue) {
        try { Stop-Process -Id $owner.Pid -Force -ErrorAction Stop } catch {}
    }
    for ($i = 0; $i -lt 20; $i++) {
        if (-not (Get-PortOwner -Port $Port)) { return $true }
        Start-Sleep -Milliseconds 500
    }
    throw "旧进程没有退出，端口 $Port 仍被占用。"
}

function Copy-Package {
    param([string]$Source, [string]$Destination)
    $src = [IO.Path]::GetFullPath($Source).TrimEnd('\')
    $dst = [IO.Path]::GetFullPath($Destination).TrimEnd('\')
    if ($src -eq $dst) {
        Write-Log "源目录就是安装目录，跳过复制。"
        return
    }
    New-Item -ItemType Directory -Force -Path $dst | Out-Null

    $robocopy = Join-Path $env:WINDIR "System32\robocopy.exe"
    if (Test-Path -LiteralPath $robocopy) {
        $args = @(
            $src,
            $dst,
            "/E",
            "/COPY:DAT",
            "/R:1",
            "/W:1",
            "/NFL", "/NDL", "/NJH", "/NJS", "/NP",
            "/XD", "browser",
            "/XF", "ai_config.json", "install.log", "install-result.json", "app.log", "app.err.log", $UserScriptAlias
        )
        Write-Log "复制程序文件（robocopy）..."
        & $robocopy @args | Out-Null
        $code = $LASTEXITCODE
        if ($code -ge 8) {
            throw "复制程序文件失败（robocopy 退出码 $code）。请关闭旧的「学习小助手」后重试。"
        }
        Write-Log "程序文件复制完成（robocopy 退出码 $code）。"
        return
    }

    Write-Log "robocopy 不可用，使用 Copy-Item。" "WARN"
    $skipNames = @(
        "ai_config.json",
        "install.log",
        "install-result.json",
        "app.log",
        "app.err.log",
        $UserScriptAlias,
        "browser"
    )
    $errors = 0
    Get-ChildItem -LiteralPath $src -Force | ForEach-Object {
        $item = $_
        if ($skipNames -contains $item.Name) { return }
        $target = Join-Path $dst $item.Name
        try {
            if ($item.PSIsContainer) {
                New-Item -ItemType Directory -Force -Path $target | Out-Null
                Get-ChildItem -LiteralPath $item.FullName -Force | ForEach-Object {
                    Copy-Item -LiteralPath $_.FullName -Destination $target -Recurse -Force
                }
            } else {
                Copy-Item -LiteralPath $item.FullName -Destination $target -Force
            }
        } catch {
            $errors++
            Write-Log "复制失败（可能被占用）：$($item.Name) - $($_.Exception.Message)" "WARN"
        }
    }
    if ($errors -gt 0) {
        Write-Log "有 $errors 个文件复制失败；如果程序无法启动，请关闭旧进程/重启后重试。" "WARN"
    }
}

function Expand-ZipToTemp {
    param([string]$ZipPath)
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $tmp = Join-Path $env:TEMP ("study-helper-extract-" + [Guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Force -Path $tmp | Out-Null
    try {
        [IO.Compression.ZipFile]::ExtractToDirectory($ZipPath, $tmp)
    } catch {
        throw "解压失败：$($_.Exception.Message)"
    }
    $exe = Get-ChildItem -LiteralPath $tmp -Recurse -Filter $AppExeName -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $exe) { throw "zip 里没有找到 $AppExeName，可能不是发布包。" }
    return [pscustomobject]@{ TempRoot = $tmp; PackageRoot = $exe.Directory.FullName }
}

# ---------------------------------------------------------------------------
# 启动 / 验证本地服务
# ---------------------------------------------------------------------------
function Start-App {
    param([string]$InstallDir, [string]$ExeName)
    $exe = Join-Path $InstallDir $ExeName
    if (-not (Test-Path -LiteralPath $exe)) { throw "找不到 $exe" }

    $env:FTK_OPEN = "0"
    $env:FTK_AI_CONFIG = Join-Path $InstallDir "ai_config.json"
    $stdout = Join-Path $InstallDir "app.log"
    $stderr = Join-Path $InstallDir "app.err.log"

    $proc = $null
    try {
        $proc = Start-Process -FilePath $exe -WorkingDirectory $InstallDir -WindowStyle Hidden -PassThru `
            -RedirectStandardOutput $stdout -RedirectStandardError $stderr
        Write-Log "已启动本地服务（日志重定向）：$exe"
    } catch {
        Write-Log "直接启动失败，改用 hide.vbs：$($_.Exception.Message)" "WARN"
        $hide = Join-Path $InstallDir $HideVbsName
        if (-not (Test-Path -LiteralPath $hide)) {
            $vbs = 'CreateObject("WScript.Shell").Run """" & WScript.Arguments(0) & """", 0, False'
            [IO.File]::WriteAllText($hide, $vbs, (New-Object Text.UTF8Encoding($false)))
        }
        $wscript = Join-Path $env:WINDIR "System32\wscript.exe"
        $proc = Start-Process -FilePath $wscript -ArgumentList @("`"$hide`"", "`"$exe`"") -WorkingDirectory $InstallDir -PassThru
        Write-Log "已通过 wscript 隐藏启动本地服务。"
    }
    return $proc
}

function Verify-App {
    param([int]$Port, [string]$InstallDir)
    $pingUrl = "http://127.0.0.1:$Port/ping"
    if (-not (Wait-Http -Url $pingUrl -TimeoutSec 60)) {
        $detail = ""
        foreach ($f in @("app.err.log", "app.log")) {
            $p = Join-Path $InstallDir $f
            if (Test-Path -LiteralPath $p) {
                $tail = Get-Content -LiteralPath $p -Tail 20 -ErrorAction SilentlyContinue
                if ($tail) { $detail += "`n--- $f ---`n" + ($tail -join "`n") }
            }
        }
        throw "本地服务没有在 60 秒内启动。$detail"
    }
    $script:Result.pingOk = $true

    try {
        $health = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 10
        $script:Result.healthOk = $true
        Write-Log ("健康检查：" + ($health | ConvertTo-Json -Compress -Depth 4))
    } catch {
        Write-Log "健康检查失败：$($_.Exception.Message)" "WARN"
    }

    $u = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/userscript.user.js" -UseBasicParsing -TimeoutSec 30
    if ($u.StatusCode -ne 200) { throw "用户脚本地址返回 $($u.StatusCode)" }
    $bytes = 0
    if ($u.RawContentLength -gt 0) {
        $bytes = [int]$u.RawContentLength
    } else {
        $bytes = [Text.Encoding]::UTF8.GetByteCount([string]$u.Content)
    }
    $script:Result.userscriptBytes = $bytes
    Write-Log "用户脚本：HTTP 200，$bytes 字节"
    if ($bytes -lt 100000) { throw "用户脚本大小异常（$bytes 字节），可能不是完整发布包。" }
}

# ---------------------------------------------------------------------------
# 浏览器 / CRX
# ---------------------------------------------------------------------------
function Find-BrowserExe {
    param([string]$Kind)
    $candidates = @()
    if ($Kind -eq "Edge") {
        if (${env:ProgramFiles(x86)}) { $candidates += "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe" }
        if ($env:ProgramFiles) { $candidates += "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe" }
        $candidates += "$env:LOCALAPPDATA\Microsoft\Edge\Application\msedge.exe"
    } elseif ($Kind -eq "Chrome") {
        if ($env:ProgramFiles) { $candidates += "$env:ProgramFiles\Google\Chrome\Application\chrome.exe" }
        if (${env:ProgramFiles(x86)}) { $candidates += "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe" }
        $candidates += "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
    }
    foreach ($p in $candidates) {
        if (Test-Path -LiteralPath $p) { return $p }
    }
    return $null
}

function Get-BrowserInfo {
    param([string]$Kind)
    if ($Kind -eq "Auto") {
        $edge = Find-BrowserExe -Kind "Edge"
        if ($edge) { return [pscustomobject]@{ Kind = "Edge"; Exe = $edge } }
        $chrome = Find-BrowserExe -Kind "Chrome"
        if ($chrome) { return [pscustomobject]@{ Kind = "Chrome"; Exe = $chrome } }
        return $null
    }
    $exe = Find-BrowserExe -Kind $Kind
    if (-not $exe) { return $null }
    return [pscustomobject]@{ Kind = $Kind; Exe = $exe }
}

function Expand-Crx {
    param([string]$CrxPath, [string]$Destination)
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    if (-not (Test-Path -LiteralPath $CrxPath)) { throw "找不到 CRX：$CrxPath" }
    $bytes = [IO.File]::ReadAllBytes($CrxPath)
    if ($bytes.Length -lt 16) { throw "CRX 文件太小。" }
    $magic = [Text.Encoding]::ASCII.GetString($bytes, 0, 4)
    if ($magic -ne "Cr24") { throw "不是有效的 CRX 文件（magic=$magic）" }

    $version = [BitConverter]::ToUInt32($bytes, 4)
    if ($version -eq 3) {
        $headerLen = [BitConverter]::ToUInt32($bytes, 8)
        $zipStart = 12 + $headerLen
    } elseif ($version -eq 2) {
        $keyLen = [BitConverter]::ToUInt32($bytes, 8)
        $sigLen = [BitConverter]::ToUInt32($bytes, 12)
        $zipStart = 16 + $keyLen + $sigLen
    } else {
        throw "不支持的 CRX 版本：$version"
    }
    if ($zipStart -ge $bytes.Length) { throw "CRX 头长度异常。" }

    $zipBytes = New-Object byte[] ($bytes.Length - $zipStart)
    [Array]::Copy($bytes, $zipStart, $zipBytes, 0, $zipBytes.Length)
    $tmpZip = Join-Path $env:TEMP ("ftk-tm-" + [Guid]::NewGuid().ToString("N") + ".zip")
    try {
        [IO.File]::WriteAllBytes($tmpZip, $zipBytes)
        if (Test-Path -LiteralPath $Destination) { Remove-Item -LiteralPath $Destination -Recurse -Force }
        New-Item -ItemType Directory -Force -Path $Destination | Out-Null
        [IO.Compression.ZipFile]::ExtractToDirectory($tmpZip, $Destination)
    } finally {
        if (Test-Path -LiteralPath $tmpZip) { Remove-Item -LiteralPath $tmpZip -Force -ErrorAction SilentlyContinue }
    }

    $manifest = Join-Path $Destination "manifest.json"
    if (-not (Test-Path -LiteralPath $manifest)) { throw "CRX 解压后没有 manifest.json。" }
    $m = Get-Content -LiteralPath $manifest -Raw -Encoding UTF8 | ConvertFrom-Json
    if (-not $m.version) { throw "manifest.json 缺少 version。" }
    return [pscustomobject]@{ Version = [string]$m.version; Manifest = $m }
}

function Download-Crx {
    param([string]$Destination)
    $lastError = ""
    foreach ($url in $CrxUrls) {
        try {
            Write-Log "下载 Tampermonkey：$url"
            $null = Invoke-Download -Url $url -OutFile $Destination -TimeoutSec 180 -UserAgent $ChromeUa
            $bytes = [IO.File]::ReadAllBytes($Destination)
            if ($bytes.Length -gt 500000 -and [Text.Encoding]::ASCII.GetString($bytes, 0, 4) -eq "Cr24") {
                Write-Log "Tampermonkey CRX 下载完成：$($bytes.Length) 字节"
                return $Destination
            }
            throw "返回内容不是有效 CRX（大小 $($bytes.Length)）"
        } catch {
            $lastError = $_.Exception.Message
            Write-Log "CRX 源失败：$lastError" "WARN"
            if (Test-Path -LiteralPath $Destination) { Remove-Item -LiteralPath $Destination -Force -ErrorAction SilentlyContinue }
        }
    }
    throw "无法从官方接口下载 Tampermonkey CRX：$lastError"
}

function Ensure-Extension {
    param([string]$InstallDir, [string]$CrxPath)
    $browserDir = Join-Path $InstallDir "browser"
    New-Item -ItemType Directory -Force -Path $browserDir | Out-Null
    $extDir = Join-Path $browserDir "tampermonkey"
    $manifest = Join-Path $extDir "manifest.json"
    if (Test-Path -LiteralPath $manifest) {
        $m = Get-Content -LiteralPath $manifest -Raw -Encoding UTF8 | ConvertFrom-Json
        Write-Log "复用已解压的 Tampermonkey：$($m.version)"
        return [pscustomobject]@{ Dir = $extDir; Version = [string]$m.version }
    }
    $crx = $CrxPath
    if (-not $crx) {
        $crx = Join-Path $browserDir "tampermonkey.crx"
        Download-Crx -Destination $crx
    } elseif (-not (Test-Path -LiteralPath $crx)) {
        throw "指定的 CRX 不存在：$crx"
    }
    Write-Log "解压 Tampermonkey CRX ..."
    $info = Expand-Crx -CrxPath $crx -Destination $extDir
    Write-Log "Tampermonkey 版本：$($info.Version)"
    return [pscustomobject]@{ Dir = $extDir; Version = $info.Version }
}

# ---------------------------------------------------------------------------
# CDP（Chrome DevTools Protocol）
# ---------------------------------------------------------------------------
$script:CdpId = 0

function Get-CdpTargets {
    param([int]$Port)
    try {
        $r = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/json/list" -TimeoutSec 5
        if ($null -eq $r) { return @() }
        return @($r | ForEach-Object { $_ })
    } catch {
        return @()
    }
}

function Get-CdpVersion {
    param([int]$Port)
    return Invoke-RestMethod -Uri "http://127.0.0.1:$Port/json/version" -TimeoutSec 10
}

function Wait-CdpTarget {
    param(
        [int]$Port,
        [scriptblock]$Predicate,
        [int]$TimeoutSec = 30
    )
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        $targets = @(Get-CdpTargets -Port $Port)
        foreach ($t in $targets) {
            try {
                if (& $Predicate $t) { return $t }
            } catch {}
        }
        Start-Sleep -Milliseconds 500
    }
    return $null
}

function Connect-Cdp {
    param([string]$WsUrl, [int]$TimeoutSec = 10)
    $ws = New-Object System.Net.WebSockets.ClientWebSocket
    $cts = New-Object Threading.CancellationTokenSource
    $cts.CancelAfter($TimeoutSec * 1000)
    try {
        $ws.ConnectAsync([Uri]$WsUrl, $cts.Token).Wait()
    } catch {
        try { $ws.Dispose() } catch {}
        throw "连接 CDP 失败：$($_.Exception.Message)"
    } finally {
        $cts.Dispose()
    }
    return $ws
}

function Receive-Cdp {
    param($Ws, [int]$TimeoutSec = 30)
    $buffer = New-Object byte[] 4194304
    $sb = New-Object Text.StringBuilder
    $cts = New-Object Threading.CancellationTokenSource
    $cts.CancelAfter($TimeoutSec * 1000)
    try {
        do {
            $seg = [ArraySegment[byte]]::new($buffer)
            $res = $Ws.ReceiveAsync($seg, $cts.Token).Result
            if ($res.MessageType -eq [Net.WebSockets.WebSocketMessageType]::Close) {
                throw "CDP WebSocket 已关闭"
            }
            [void]$sb.Append([Text.Encoding]::UTF8.GetString($buffer, 0, $res.Count))
        } while (-not $res.EndOfMessage)
    } catch {
        throw "读取 CDP 消息失败：$($_.Exception.Message)"
    } finally {
        $cts.Dispose()
    }
    $text = $sb.ToString()
    if (-not $text) { throw "CDP 返回空消息" }
    return ($text | ConvertFrom-Json)
}

function Send-Cdp {
    param(
        $Ws,
        [string]$Method,
        [hashtable]$Params = @{},
        [int]$TimeoutSec = 30
    )
    $script:CdpId++
    $id = $script:CdpId
    $msg = @{ id = $id; method = $Method; params = $Params } | ConvertTo-Json -Compress -Depth 20
    $bytes = [Text.Encoding]::UTF8.GetBytes($msg)
    $cts = New-Object Threading.CancellationTokenSource
    $cts.CancelAfter($TimeoutSec * 1000)
    try {
        $Ws.SendAsync([ArraySegment[byte]]::new($bytes), [Net.WebSockets.WebSocketMessageType]::Text, $true, $cts.Token).Wait()
    } catch {
        throw "发送 CDP 命令失败（$Method）：$($_.Exception.Message)"
    } finally {
        $cts.Dispose()
    }
    while ($true) {
        $resp = Receive-Cdp -Ws $Ws -TimeoutSec $TimeoutSec
        if ($resp.id -eq $id) { return $resp }
    }
}

function Eval-Js {
    param($Ws, [string]$Expression, [int]$TimeoutSec = 30)
    $r = Send-Cdp -Ws $Ws -Method "Runtime.evaluate" -Params @{
        expression = $Expression
        returnByValue = $true
        awaitPromise = $true
    } -TimeoutSec $TimeoutSec
    if ($r.error) { throw "CDP 错误：$($r.error.message)" }
    if ($r.result.exceptionDetails) {
        $desc = $r.result.exceptionDetails.text
        if ($r.result.exceptionDetails.exception -and $r.result.exceptionDetails.exception.description) {
            $desc = $r.result.exceptionDetails.exception.description
        }
        throw "页面 JS 异常：$desc"
    }
    return $r.result.result.value
}

function Open-Tab {
    param([int]$Port, [string]$Url, [int]$TimeoutSec = 15)
    $encoded = [Uri]::EscapeDataString($Url)
    try {
        $new = Invoke-RestMethod -Method Put -Uri "http://127.0.0.1:$Port/json/new?$encoded" -TimeoutSec $TimeoutSec
        if ($new -and $new.id) { return $new }
    } catch {
        Write-Log "HTTP /json/new 失败，改用 CDP Target.createTarget：$($_.Exception.Message)" "WARN"
    }
    $ver = Get-CdpVersion -Port $Port
    $browserWs = Connect-Cdp -WsUrl $ver.webSocketDebuggerUrl
    try {
        $r = Send-Cdp -Ws $browserWs -Method "Target.createTarget" -Params @{ url = $Url }
        if ($r.error) { throw $r.error.message }
        return [pscustomobject]@{ id = $r.result.targetId; url = $Url }
    } finally {
        try { $browserWs.Dispose() } catch {}
    }
}

function Close-Tab {
    param([int]$Port, [string]$TargetId)
    if (-not $TargetId) { return }
    try {
        Invoke-RestMethod -Uri "http://127.0.0.1:$Port/json/close/$TargetId" -TimeoutSec 5 | Out-Null
    } catch {}
}

function Close-DebugBrowser {
    param([int]$Port, $Process)
    Write-Log "关闭带调试端口的浏览器 ..."
    try {
        $ver = Get-CdpVersion -Port $Port
        $ws = Connect-Cdp -WsUrl $ver.webSocketDebuggerUrl
        try {
            Send-Cdp -Ws $ws -Method "Browser.close" -Params @{} -TimeoutSec 5 | Out-Null
        } catch {}
        try { $ws.Dispose() } catch {}
    } catch {}
    if ($Process) {
        try {
            $alive = -not $Process.HasExited
        } catch {
            $alive = $false
        }
        if ($alive) {
            try {
                & "$env:WINDIR\System32\taskkill.exe" /PID $Process.Id /T /F 2>$null | Out-Null
            } catch {}
        }
    }
    for ($i = 0; $i -lt 20; $i++) {
        if (-not (Test-HttpOk -Url "http://127.0.0.1:$Port/json/version" -TimeoutSec 1)) { return $true }
        Start-Sleep -Milliseconds 500
    }
    return $false
}

function Find-TampermonkeyWorker {
    param([int]$Port, [int]$TimeoutSec = 30)
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        try {
            $targets = @(Get-CdpTargets -Port $Port)
            foreach ($t in $targets) {
                if (-not $t) { continue }
                $targetType = [string]$t.type
                $targetUrl = [string]$t.url
                $isWorker = ($targetType -eq "service_worker" -or $targetType -eq "background_page")
                if ($isWorker -and $targetUrl -like "chrome-extension://*/background.js") {
                    if ($targetUrl -match "chrome-extension://([a-p]{32})/") {
                        $id = $matches[1]
                        if ($id) {
                            return [pscustomobject]@{ Id = $id; Url = $targetUrl; Type = $targetType }
                        }
                    }
                }
            }
        } catch {
            Write-Log "查找 Tampermonkey 后台服务异常：$($_.Exception.Message)" "ERROR"
            Write-Log ("异常位置：" + $_.InvocationInfo.PositionMessage) "ERROR"
            Write-Log ("调用栈：" + $_.ScriptStackTrace) "ERROR"
            throw
        }
        Start-Sleep -Milliseconds 500
    }
    return $null
}

function Get-ElementCenter {
    param($Ws, [string]$Expression)
    $r = Eval-Js -Ws $Ws -Expression $Expression
    if (-not $r) { return $null }
    $o = $r
    if ($r -is [string]) { $o = $r | ConvertFrom-Json }
    if ($o.error) { return $null }
    if ($null -eq $o.x -or $null -eq $o.y) { return $null }
    return [pscustomobject]@{ X = [double]$o.x; Y = [double]$o.y }
}

function Invoke-TrustedClick {
    param($Ws, [string]$Expression)
    $pt = Get-ElementCenter -Ws $Ws -Expression $Expression
    if (-not $pt) { throw "找不到要点击的元素。" }
    Send-Cdp -Ws $Ws -Method "Input.dispatchMouseEvent" -Params @{ type = "mouseMoved"; x = $pt.X; y = $pt.Y } | Out-Null
    Send-Cdp -Ws $Ws -Method "Input.dispatchMouseEvent" -Params @{ type = "mousePressed"; x = $pt.X; y = $pt.Y; button = "left"; clickCount = 1 } | Out-Null
    Send-Cdp -Ws $Ws -Method "Input.dispatchMouseEvent" -Params @{ type = "mouseReleased"; x = $pt.X; y = $pt.Y; button = "left"; clickCount = 1 } | Out-Null
}

# ---------------------------------------------------------------------------
# 专用浏览器安装 / 验证
# ---------------------------------------------------------------------------
function Stop-DedicatedBrowser {
    param([string]$ProfileDir)
    if (-not $ProfileDir) { return }
    $procs = @()
    foreach ($name in @("msedge.exe", "chrome.exe")) {
        try {
            $procs += @(Get-CimInstance Win32_Process -Filter "Name='$name'" -ErrorAction SilentlyContinue | Where-Object {
                $_.CommandLine -and $_.CommandLine.IndexOf($ProfileDir, [StringComparison]::OrdinalIgnoreCase) -ge 0
            })
        } catch {}
    }
    if ($procs.Count -eq 0) { return }
    Write-Log "关闭已经打开的专用浏览器（$($procs.Count) 个进程）..."
    $pidSet = @($procs | ForEach-Object { [int]$_.ProcessId })
    $roots = @($procs | Where-Object { $pidSet -notcontains [int]$_.ParentProcessId })
    foreach ($root in $roots) {
        try { & "$env:WINDIR\System32\taskkill.exe" /PID $root.ProcessId /T /F 2>$null | Out-Null } catch {}
    }
    for ($i = 0; $i -lt 30; $i++) {
        $left = @($procs | Where-Object { Get-Process -Id ([int]$_.ProcessId) -ErrorAction SilentlyContinue })
        if ($left.Count -eq 0) { break }
        Start-Sleep -Milliseconds 500
    }
    Start-Sleep -Milliseconds 500
}

function Start-DedicatedBrowser {
    param(
        [string]$BrowserKind,
        [string]$BrowserExe,
        [string]$InstallDir,
        [string]$ExtDir,
        [int]$DebugPort = 0,
        [int]$AppPort = 8060
    )
    $profileName = "edge-profile"
    if ($BrowserKind -eq "Chrome") { $profileName = "chrome-profile" }
    $profileDir = Join-Path (Join-Path $InstallDir "browser") $profileName
    if ($DebugPort -le 0) { $DebugPort = Get-FreePort -Start 9223 -End 9399 }
    $userScriptUrl = "http://127.0.0.1:$AppPort/userscript.user.js"

    for ($attempt = 1; $attempt -le 2; $attempt++) {
        if ($attempt -gt 1) {
            Write-Log "专用浏览器配置可能已损坏，重置后重试（学习通可能需要重新登录）..." "WARN"
            Stop-DedicatedBrowser -ProfileDir $profileDir
            if (Test-Path -LiteralPath $profileDir) {
                try {
                    Remove-Item -LiteralPath $profileDir -Recurse -Force -ErrorAction Stop
                } catch {
                    Write-Log "清空专用配置失败：$($_.Exception.Message)" "WARN"
                }
            }
        }
        New-Item -ItemType Directory -Force -Path $profileDir | Out-Null
        Stop-DedicatedBrowser -ProfileDir $profileDir

        $argList = @(
            "--user-data-dir=`"$profileDir`"",
            "--load-extension=`"$ExtDir`"",
            "--remote-debugging-port=$DebugPort",
            "--no-first-run",
            "--no-default-browser-check",
            "--new-window",
            $userScriptUrl
        )

        Write-Log "启动专用浏览器（第 $attempt 次）：$BrowserExe"
        Write-Log ("浏览器参数：" + ($argList -join " "))
        $proc = Start-Process -FilePath $BrowserExe -ArgumentList $argList -PassThru
        if (-not (Wait-Http -Url "http://127.0.0.1:$DebugPort/json/version" -TimeoutSec 40)) {
            try { & "$env:WINDIR\System32\taskkill.exe" /PID $proc.Id /T /F 2>$null | Out-Null } catch {}
            Stop-DedicatedBrowser -ProfileDir $profileDir
            Start-Sleep -Seconds 2
            if ($attempt -lt 2) { continue }
            throw "浏览器调试端口没有在 40 秒内就绪。可能是浏览器不允许命令行加载扩展（Chrome 新版本常见），请改用 Edge 或手动安装。"
        }
        Write-Log "浏览器调试端口已就绪：$DebugPort"
        $script:DebugPort = $DebugPort
        $script:BrowserProcess = $proc
        $script:Result.debugPort = $DebugPort

        Write-Log "等待 Tampermonkey 加载 ..."
        $extensionId = ""
        $worker = Find-TampermonkeyWorker -Port $DebugPort -TimeoutSec 8
        if ($worker) {
            $extensionId = $worker.Id
        } else {
            $ask = Wait-CdpTarget -Port $DebugPort -Predicate {
                param($t)
                $t.type -eq "page" -and $t.url -like "chrome-extension://*/ask.html*"
            } -TimeoutSec 12
            if ($ask -and $ask.url -match '^chrome-extension://([^/]+)/') {
                $extensionId = $Matches[1]
            }
        }
        if ($extensionId) {
            Write-Log "Tampermonkey 已加载，扩展 ID：$extensionId"
        } else {
            Write-Log "启动阶段暂时没有检测到 Tampermonkey 后台服务，继续由脚本安装步骤确认 ..." "WARN"
        }
        return [pscustomobject]@{
            Process = $proc
            Port = $DebugPort
            ProfileDir = $profileDir
            ExtDir = $ExtDir
            ExtensionId = $extensionId
            BrowserKind = $BrowserKind
            BrowserExe = $BrowserExe
        }
    }
}

function Install-Userscript {
    param(
        [int]$Port,
        [int]$AppPort = 8060
    )
    $userScriptUrl = "http://127.0.0.1:$AppPort/userscript.user.js"
    $existing = Wait-CdpTarget -Port $Port -Predicate {
        param($t)
        $t.type -eq "page" -and $t.url -like "*127.0.0.1:$AppPort/userscript.user.js*"
    } -TimeoutSec 8

    $ask = Wait-CdpTarget -Port $Port -Predicate {
        param($t)
        $t.type -eq "page" -and ($t.url -like "*ask.html*" -or $t.title -like "*安装用户脚本*" -or $t.title -like "*Install*")
    } -TimeoutSec 2
    if ($ask) {
        Write-Log "复用已经打开的 Tampermonkey 安装页：$($ask.url)"
    } else {
        Write-Log "打开新的用户脚本标签页，让 Tampermonkey 拦截 ..."
        try {
            $null = Open-Tab -Port $Port -Url $userScriptUrl
        } catch {
            Write-Log "打开新标签页失败：$($_.Exception.Message)" "WARN"
        }
        Start-Sleep -Seconds 2
        $ask = Wait-CdpTarget -Port $Port -Predicate {
            param($t)
            $t.type -eq "page" -and ($t.url -like "*ask.html*" -or $t.title -like "*安装用户脚本*" -or $t.title -like "*Install*")
        } -TimeoutSec 6
    }
    if (-not $ask) {
        # 回退：刷新已经打开的用户脚本页面
        Write-Log "新标签页没有触发安装页，尝试刷新现有页面 ..." "WARN"
        $page = Wait-CdpTarget -Port $Port -Predicate {
            param($t)
            $t.type -eq "page" -and $t.url -like "*userscript.user.js*"
        } -TimeoutSec 10
        if ($page) {
            $ws = Connect-Cdp -WsUrl $page.webSocketDebuggerUrl
            try {
                try { Send-Cdp -Ws $ws -Method "Page.reload" -Params @{ ignoreCache = $true } -TimeoutSec 15 | Out-Null } catch {}
            } finally {
                try { $ws.Dispose() } catch {}
            }
            Start-Sleep -Seconds 3
            $ask = Wait-CdpTarget -Port $Port -Predicate {
                param($t)
                $t.type -eq "page" -and ($t.url -like "*ask.html*" -or $t.title -like "*安装用户脚本*" -or $t.title -like "*Install*")
            } -TimeoutSec 15
        }
    }
    if (-not $ask) {
        throw "Tampermonkey 没有打开安装页。请确认扩展已启用，然后手动打开 http://127.0.0.1:$AppPort/userscript.user.js。"
    }
    $extensionId = ""
    if ($ask.url -match '^chrome-extension://([^/]+)/') {
        $extensionId = $Matches[1]
    }
    Write-Log "Tampermonkey 安装页：$($ask.url)"

    $ws = Connect-Cdp -WsUrl $ask.webSocketDebuggerUrl
    try {
        Start-Sleep -Seconds 2
        $clicked = $false
        for ($attempt = 0; $attempt -lt 3; $attempt++) {
            $js = @'
(function () {
  var b = document.querySelector('input.button.install');
  if (!b) {
    var buttons = [].slice.call(document.querySelectorAll('input[type="button"],button'));
    b = buttons.filter(function (e) {
      var t = (e.value || e.innerText || e.textContent || '').trim();
      return /安装|Install/i.test(t);
    })[0];
  }
  if (!b) return JSON.stringify({ error: 'no-button' });
  b.scrollIntoView({ block: 'center', inline: 'center' });
  var r = b.getBoundingClientRect();
  return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2, text: (b.value || b.innerText || '').trim() });
})()
'@
            $pt = Get-ElementCenter -Ws $ws -Expression $js
            if (-not $pt) {
                Start-Sleep -Seconds 1
                continue
            }
            Write-Log "点击安装按钮（第 $($attempt + 1) 次）..."
            Send-Cdp -Ws $ws -Method "Input.dispatchMouseEvent" -Params @{ type = "mouseMoved"; x = $pt.X; y = $pt.Y } | Out-Null
            Send-Cdp -Ws $ws -Method "Input.dispatchMouseEvent" -Params @{ type = "mousePressed"; x = $pt.X; y = $pt.Y; button = "left"; clickCount = 1 } | Out-Null
            Send-Cdp -Ws $ws -Method "Input.dispatchMouseEvent" -Params @{ type = "mouseReleased"; x = $pt.X; y = $pt.Y; button = "left"; clickCount = 1 } | Out-Null
            $clicked = $true
            Start-Sleep -Seconds 3
            $still = @(Get-CdpTargets -Port $Port) | Where-Object { $_.id -eq $ask.id }
            if (-not $still) { break }
            $txt = ""
            try { $txt = [string](Eval-Js -Ws $ws -Expression 'document.body ? document.body.innerText : ""' -TimeoutSec 10) } catch {}
            if ($txt -match "已安装|安装完成|Installed|Success") { break }
        }
        if (-not $clicked) { throw "安装页上没有找到「安装」按钮。" }
    } finally {
        try { $ws.Dispose() } catch {}
    }
    Start-Sleep -Seconds 2
    Write-Log "用户脚本安装点击完成。"
    return $extensionId
}

function Enable-AllowUserScripts {
    param(
        [int]$Port,
        [string]$ExtensionId,
        [string]$BrowserKind = "Edge"
    )
    $scheme = "edge"
    if ($BrowserKind -eq "Chrome") { $scheme = "chrome" }
    if ([string]::IsNullOrWhiteSpace($ExtensionId)) {
        Write-Log "没有拿到 Tampermonkey 扩展 ID，跳过「允许用户脚本」设置。" "WARN"
        return $false
    }
    $url = "${scheme}://extensions/?id=$ExtensionId"
    Write-Log "打开扩展详情页：$url"
    try {
        $null = Open-Tab -Port $Port -Url $url
        $target = Wait-CdpTarget -Port $Port -Predicate {
            param($t)
            $t.type -eq "page" -and $t.url -like "${scheme}://extensions*"
        } -TimeoutSec 20
        if (-not $target) {
            Write-Log "打不开扩展详情页。" "WARN"
            return $false
        }
        Start-Sleep -Seconds 2
        $ws = Connect-Cdp -WsUrl $target.webSocketDebuggerUrl
        try {
            $result = $null
            for ($attempt = 0; $attempt -lt 12; $attempt++) {
                $js = @'
(function () {
  var found = null;
  function walk(root) {
    if (!root || found) return;
    var els = root.querySelectorAll ? root.querySelectorAll('*') : [];
    for (var i = 0; i < els.length; i++) {
      var e = els[i];
      var text = (e.innerText || e.textContent || '');
      if (e.tagName === 'STANDARD-ROW' && /允许用户脚本|Allow user scripts/i.test(text)) {
        var sw = e.querySelector('fluent-switch,cr-toggle,input[type="checkbox"],[role="switch"]');
        if (sw) { found = sw; return; }
      }
      if (e.shadowRoot) walk(e.shadowRoot);
      if (found) return;
    }
  }
  walk(document);
  if (!found) return JSON.stringify({ status: 'no-switch' });
  var checked = (found.checked === true) || (found.getAttribute && found.getAttribute('aria-checked') === 'true');
  if (checked) return JSON.stringify({ status: 'already-on' });
  found.click();
  return JSON.stringify({ status: 'clicked', checked: !!found.checked });
})()
'@
                $raw = Eval-Js -Ws $ws -Expression $js -TimeoutSec 15
                $result = if ($raw -is [string]) { $raw | ConvertFrom-Json } else { $raw }
                if ($result.status -eq "already-on") { break }
                if ($result.status -eq "clicked") {
                    Start-Sleep -Seconds 1
                    break
                }
                Start-Sleep -Milliseconds 800
            }
            if (-not $result -or $result.status -eq "no-switch") {
                Write-Log "扩展详情页里找不到「允许用户脚本」开关（可能浏览器版本不需要）。" "WARN"
                return $false
            }
            Start-Sleep -Seconds 1
            $checkJs = @'
(function () {
  var found = null;
  function walk(root) {
    if (!root || found) return;
    var els = root.querySelectorAll ? root.querySelectorAll('*') : [];
    for (var i = 0; i < els.length; i++) {
      var e = els[i];
      var text = (e.innerText || e.textContent || '');
      if (e.tagName === 'STANDARD-ROW' && /允许用户脚本|Allow user scripts/i.test(text)) {
        var sw = e.querySelector('fluent-switch,cr-toggle,input[type="checkbox"],[role="switch"]');
        if (sw) { found = sw; return; }
      }
      if (e.shadowRoot) walk(e.shadowRoot);
      if (found) return;
    }
  }
  walk(document);
  if (!found) return JSON.stringify({ status: 'no-switch' });
  var checked = (found.checked === true) || (found.getAttribute && found.getAttribute('aria-checked') === 'true');
  return JSON.stringify({ status: checked ? 'on' : 'off', checked: checked });
})()
'@
            $raw2 = Eval-Js -Ws $ws -Expression $checkJs -TimeoutSec 15
            $check = if ($raw2 -is [string]) { $raw2 | ConvertFrom-Json } else { $raw2 }
            if ($check.status -eq "on") {
                Write-Log "「允许用户脚本」已开启。"
                return $true
            }
            Write-Log "「允许用户脚本」当前状态：$($check.status)" "WARN"
            return $false
        } finally {
            try { $ws.Dispose() } catch {}
            Close-Tab -Port $Port -TargetId $target.id
        }
    } catch {
        Write-Log "自动开启「允许用户脚本」失败：$($_.Exception.Message)" "WARN"
        return $false
    }
}

function Verify-TampermonkeyDashboard {
    param(
        [int]$Port,
        [string]$ExtensionId,
        [switch]$KeepOpenOnFailure
    )
    $url = "chrome-extension://$ExtensionId/options.html#nav=scripts"
    Write-Log "验证 Tampermonkey 管理面板 ..."
    $null = Open-Tab -Port $Port -Url $url
    $target = Wait-CdpTarget -Port $Port -Predicate {
        param($t)
        $t.type -eq "page" -and $t.url -like "*options.html*"
    } -TimeoutSec 20
    if (-not $target) { throw "打不开 Tampermonkey 管理面板。" }
    Start-Sleep -Seconds 3
    $failed = $false
    $ws = Connect-Cdp -WsUrl $target.webSocketDebuggerUrl
    try {
        $text = ""
        for ($i = 0; $i -lt 10; $i++) {
            try { $text = [string](Eval-Js -Ws $ws -Expression 'document.body ? document.body.innerText : ""' -TimeoutSec 15) } catch {}
            if ($text -match "学习小助手") { break }
            Start-Sleep -Seconds 1
        }
        if ($text -notmatch "学习小助手") {
            $snippet = ""
            if ($text) { $snippet = $text.Substring(0, [Math]::Min(500, $text.Length)) }
            throw "管理面板里没有看到「学习小助手」。页面内容：$snippet"
        }
        if ($text -match "请启用.*允许用户脚本|Allow user scripts") {
            $script:NeedsUserAction = $true
            throw "管理面板提示「请启用允许用户脚本」。请手动打开该开关后重试。"
        }
        $versionOk = $text -match "1\.3\.47"
        Write-Log "管理面板已看到学习小助手，版本匹配：$versionOk"
        $script:Result.userscriptInstalled = $true
        return $true
    } catch {
        $failed = $true
        throw
    } finally {
        try { $ws.Dispose() } catch {}
        if (-not ($failed -and $KeepOpenOnFailure)) {
            Close-Tab -Port $Port -TargetId $target.id
        }
    }
}

# ---------------------------------------------------------------------------
# 启动器 / 快捷方式
# ---------------------------------------------------------------------------
function New-LauncherFiles {
    param(
        [string]$InstallDir,
        [string]$BrowserExe,
        [string]$BrowserKind
    )
    $profileRel = "browser\edge-profile"
    if ($BrowserKind -eq "Chrome") { $profileRel = "browser\chrome-profile" }
    $extRel = "browser\tampermonkey"

    $cmdTemplate = @'
@echo off
chcp 936 >nul
setlocal
cd /d "%~dp0"
if not exist "学习通免费题库助手.user.js" if exist "学习小助手.user.js" copy /y "学习小助手.user.js" "学习通免费题库助手.user.js" >nul 2>nul
powershell -NoProfile -ExecutionPolicy Bypass -Command "try { $c=New-Object Net.Sockets.TcpClient; $c.Connect('127.0.0.1',8060); $c.Close(); exit 0 } catch { exit 1 }" >nul 2>nul
if not errorlevel 1 goto server_ready
set "FTK_AI_CONFIG=%~dp0ai_config.json"
set "FTK_OPEN=0"
if exist "%~dp0hide.vbs" goto start_hidden
start "" /min "%~dp0启动免费题库.exe"
goto wait_server
:start_hidden
wscript "%~dp0hide.vbs" "%~dp0启动免费题库.exe"
:wait_server
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ok=$false; for($i=0;$i -lt 60;$i++){ try { $r=Invoke-WebRequest 'http://127.0.0.1:8060/ping' -UseBasicParsing -TimeoutSec 1; if($r.StatusCode -eq 200){$ok=$true;break} } catch {}; Start-Sleep -Milliseconds 500 }; if(-not $ok){ exit 1 }" >nul 2>nul
if errorlevel 1 goto server_failed
:server_ready
if not exist "@@EDGE@@" goto no_edge
start "" "@@EDGE@@" --user-data-dir="%~dp0@@PROFILEREL@@" --load-extension="%~dp0@@EXTREL@@" --no-first-run --no-default-browser-check "https://i.chaoxing.com/"
endlocal
exit /b 0
:server_failed
powershell -NoProfile -Command "Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show('本地服务启动失败。请双击文件夹里的 一键启动.bat 查看提示，或重启电脑后再试。','学习小助手')" >nul 2>nul
endlocal
exit /b 1
:no_edge
start "" "https://i.chaoxing.com/"
endlocal
exit /b 0
'@

    $cmd = $cmdTemplate.Replace("@@EDGE@@", $BrowserExe).Replace("@@PROFILEREL@@", $profileRel).Replace("@@EXTREL@@", $extRel)
    $cmd = $cmd.Replace("`r`n", "`n").Replace("`n", "`r`n")
    $cmdPath = Join-Path $InstallDir "start-browser.cmd"
    [IO.File]::WriteAllText($cmdPath, $cmd, [Text.Encoding]::GetEncoding(936))

    $vbs = @'
Set fso = CreateObject("Scripting.FileSystemObject")
base = fso.GetParentFolderName(WScript.ScriptFullName)
CreateObject("WScript.Shell").Run """" & base & "\start-browser.cmd""", 0, False
'@
    $vbsPath = Join-Path $InstallDir "start-browser.vbs"
    $vbs = $vbs.Replace("`r`n", "`n").Replace("`n", "`r`n")
    [IO.File]::WriteAllText($vbsPath, $vbs, [Text.Encoding]::ASCII)

    $stop = @'
@echo off
chcp 936 >nul
setlocal
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":8060" ^| findstr "LISTENING"') do (
  taskkill /PID %%p /F >nul 2>nul
)
echo 已尝试停止学习小助手本地服务。
timeout /t 2 >nul
endlocal
'@
    $stopPath = Join-Path $InstallDir "stop-app.bat"
    $stop = $stop.Replace("`r`n", "`n").Replace("`n", "`r`n")
    [IO.File]::WriteAllText($stopPath, $stop, [Text.Encoding]::GetEncoding(936))

    return [pscustomobject]@{ Cmd = $cmdPath; Vbs = $vbsPath; Stop = $stopPath }
}

function New-DesktopShortcut {
    param(
        [string]$InstallDir,
        [string]$BrowserExe
    )
    if ($NoShortcut) {
        Write-Log "按 -NoShortcut 跳过桌面快捷方式。"
        return $null
    }
    $desktop = [Environment]::GetFolderPath("Desktop")
    if (-not $desktop) { throw "找不到桌面目录。" }
    $vbs = Join-Path $InstallDir "start-browser.vbs"
    $lnk = Join-Path $desktop "学习小助手浏览器.lnk"
    $wsh = New-Object -ComObject WScript.Shell
    $sc = $wsh.CreateShortcut($lnk)
    $sc.TargetPath = Join-Path $env:WINDIR "System32\wscript.exe"
    $sc.Arguments = "`"$vbs`""
    $sc.WorkingDirectory = $InstallDir
    $sc.IconLocation = "$BrowserExe,0"
    $sc.Description = "学习小助手专用浏览器（含 Tampermonkey 和用户脚本）"
    $sc.Save()
    Write-Log "已创建桌面快捷方式：$lnk"
    return $lnk
}

function Relaunch-Browser {
    param(
        [string]$BrowserExe,
        [string]$ProfileDir,
        [string]$ExtDir
    )
    if ($NoLaunch) {
        Write-Log "按 -NoLaunch 跳过重新打开浏览器。"
        return $null
    }
    $argList = @(
        "--user-data-dir=`"$ProfileDir`"",
        "--load-extension=`"$ExtDir`"",
        "--no-first-run",
        "--no-default-browser-check",
        "https://i.chaoxing.com/"
    )
    Write-Log "重新打开专用浏览器（不带调试端口）..."
    return (Start-Process -FilePath $BrowserExe -ArgumentList $argList -PassThru)
}

# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------
$exitCode = 0
$script:KeepBrowserOpen = $false
$script:Result.needsUserAction = $false

try {
    # 0. 目录 / 参数
    $script:Result.stage = "init"
    if (-not [IO.Path]::IsPathRooted($script:InstallDir)) {
        $script:InstallDir = [IO.Path]::GetFullPath((Join-Path (Get-Location) $script:InstallDir))
    }
    if ($script:InstallDir -match '^[A-Za-z]:\\Program Files' -or $script:InstallDir -match '^[A-Za-z]:\\Windows') {
        throw "请不要安装到 Program Files 或 Windows 目录。建议使用默认目录：$env:LOCALAPPDATA\学习小助手"
    }
    if (Test-Path -LiteralPath $script:InstallDir -PathType Leaf) {
        throw "安装目录是一个文件：$($script:InstallDir)"
    }
    New-Item -ItemType Directory -Force -Path $script:InstallDir | Out-Null
    $script:LogPath = Join-Path $script:InstallDir "install.log"
    $script:ResultPath = Join-Path $script:InstallDir "install-result.json"
    $script:Result.installDir = $script:InstallDir
    $script:Result.logPath = $script:LogPath
    $script:Result.resultPath = $script:ResultPath
    Save-Result

    Write-Log "===== 学习小助手 $AppVersion 自动安装开始 ====="
    Write-Log "安装目录：$($script:InstallDir)"
    Write-Log "参数：Browser=$Browser；NoBrowser=$NoBrowser；NoLaunch=$NoLaunch；NoShortcut=$NoShortcut；Force=$Force"
    Write-Log "PowerShell：$($PSVersionTable.PSVersion)；系统：$([Environment]::OSVersion.VersionString)"
    if ($PSVersionTable.PSVersion.Major -lt 5) {
        throw "需要 PowerShell 5.1 或更高版本。当前：$($PSVersionTable.PSVersion)"
    }
    if ($Force) {
        Write-Log "已指定 -Force：覆盖程序文件（仍保留 ai_config.json 和 browser 配置）。"
    }

    # 1. 安装包（下载 / 校验）
    $script:Result.stage = "resolve-package"
    $checksumVerified = $false
    $actualSha = ""
    $zipFile = ""

    if ($ZipPath) {
        $zipFile = [IO.Path]::GetFullPath($ZipPath)
        if (-not (Test-Path -LiteralPath $zipFile)) { throw "找不到本地 zip：$zipFile" }
        Write-Log "使用本地 zip：$zipFile"
        if ($ChecksumUrl) {
            $expected = Get-ExpectedSha256 -Url $ChecksumUrl
            $actualSha = Get-FileSha256 -Path $zipFile
            if ($actualSha -ne $expected) {
                throw "SHA256 不匹配。期望 $expected，实际 $actualSha。请重新下载安装包。"
            }
            $checksumVerified = $true
            Write-Log "SHA256 校验通过：$actualSha"
        } else {
            $actualSha = Get-FileSha256 -Path $zipFile
            Write-Log "本地 zip 未提供 ChecksumUrl；SHA256=$actualSha（未与发布页比对）" "WARN"
        }
    } else {
        $script:Result.stage = "download"
        $downloadDir = Join-Path $script:InstallDir "download"
        $zipFile = Join-Path $downloadDir $ZipName
        $expected = Get-ExpectedSha256 -Url $ChecksumUrl

        if (Test-Path -LiteralPath $zipFile) {
            $actualSha = Get-FileSha256 -Path $zipFile
            if ($actualSha -ne $expected) {
                Write-Log "已存在的安装包 SHA256 不匹配，删除后重新下载。" "WARN"
                Remove-Item -LiteralPath $zipFile -Force -ErrorAction SilentlyContinue
            }
        }
        if (-not (Test-Path -LiteralPath $zipFile)) {
            Write-Log "下载安装包：$ZipUrl"
            $null = Invoke-Download -Url $ZipUrl -OutFile $zipFile -TimeoutSec 900
            $actualSha = Get-FileSha256 -Path $zipFile
        }
        if (-not $actualSha) { $actualSha = Get-FileSha256 -Path $zipFile }
        if ($actualSha -ne $expected) {
            Remove-Item -LiteralPath $zipFile -Force -ErrorAction SilentlyContinue
            throw "SHA256 不匹配，已删除下载文件。期望 $expected，实际 $actualSha。请检查网络/代理后重试。"
        }
        $checksumVerified = $true
        Write-Log "SHA256 校验通过：$actualSha"
    }

    $script:Result.zipPath = $zipFile
    if ($ZipPath) { $script:Result.zipUrl = "" } else { $script:Result.zipUrl = $ZipUrl }
    $script:Result.zipBytes = (Get-Item -LiteralPath $zipFile).Length
    $script:Result.zipSha256 = $actualSha
    $script:Result.checksumVerified = $checksumVerified
    Save-Result

    # 2. 解压
    $script:Result.stage = "extract"
    $extract = Expand-ZipToTemp -ZipPath $zipFile
    $script:TempExtractRoot = $extract.TempRoot
    Write-Log "解压完成：$($extract.PackageRoot)"

    # 3. 停止旧服务
    $script:Result.stage = "stop-old"
    $null = Stop-OwnApp -Port $AppPort -InstallDir $script:InstallDir -SourceRoot $extract.PackageRoot

    # 4. 复制程序文件
    $script:Result.stage = "copy"
    Copy-Package -Source $extract.PackageRoot -Destination $script:InstallDir

    $userscriptPath = Join-Path $script:InstallDir $UserScriptName
    if (-not (Test-Path -LiteralPath $userscriptPath)) {
        throw "安装包里缺少 $UserScriptName。"
    }
    $aliasPath = Join-Path $script:InstallDir $UserScriptAlias
    Copy-Item -LiteralPath $userscriptPath -Destination $aliasPath -Force
    $script:Result.userscriptPath = $userscriptPath
    $script:Result.appPath = Join-Path $script:InstallDir $AppExeName
    Save-Result
    Write-Log "程序文件已复制到：$($script:InstallDir)"

    # 5. 启动并验证本地服务
    $script:Result.stage = "start-app"
    $appProc = Start-App -InstallDir $script:InstallDir -ExeName $AppExeName
    $script:Result.stage = "verify-app"
    Verify-App -Port $AppPort -InstallDir $script:InstallDir
    $owner = Get-PortOwner -Port $AppPort
    if ($owner) { $script:Result.appPid = $owner.Pid }
    $script:Result.appRunning = $true
    Write-Log "本地服务已运行：http://127.0.0.1:$AppPort（PID=$($script:Result.appPid)）"
    Save-Result

    # 6. 浏览器扩展
    if ($NoBrowser -or $Browser -eq "None") {
        $script:Result.browser = "none"
        $script:Result.ok = $true
        $script:Result.stage = "done"
        $script:Result.nextStep = "桌面程序已安装。双击安装目录里的 一键启动.bat 可用系统默认浏览器打开；如需自动安装 Tampermonkey，请重新运行本脚本（不要加 -NoBrowser）。"
        Write-Log "按 -NoBrowser/None 跳过浏览器扩展安装。"
    } else {
        $script:Result.stage = "browser"
        $info = Get-BrowserInfo -Kind $Browser
        if (-not $info) {
            $script:NeedsUserAction = $true
            $script:Result.nextStep = "没有找到 Edge 或 Chrome。请安装 Microsoft Edge（Windows 10/11 通常自带），或手动在浏览器里安装 Tampermonkey，然后打开 http://127.0.0.1:8060/userscript.user.js。"
            throw "没有找到可用的 Edge/Chrome。"
        }
        $script:Result.browser = $info.Kind
        $script:Result.browserExe = $info.Exe
        Write-Log "使用浏览器：$($info.Kind) - $($info.Exe)"

        if ($DebugPort -gt 0) {
            if (Test-HttpOk -Url "http://127.0.0.1:$DebugPort/json/version" -TimeoutSec 1) {
                throw "调试端口 $DebugPort 已被占用。请关闭占用它的程序，或不要指定 -DebugPort（让脚本自动选择）。"
            }
        }

        $script:Result.stage = "extension"
        try {
            $ext = Ensure-Extension -InstallDir $script:InstallDir -CrxPath $CrxPath
        } catch {
            $script:NeedsUserAction = $true
            $script:Result.nextStep = "自动下载 Tampermonkey 失败。请按《安装教程》手动安装 Tampermonkey，或换网络后重试；程序本身已安装可用。"
            throw "准备 Tampermonkey 扩展失败：$($_.Exception.Message)"
        }
        $script:Result.extensionDir = $ext.Dir
        $script:Result.tampermonkeyVersion = $ext.Version

        $script:Result.stage = "start-browser"
        $browserSetup = $null
        $installedExtensionId = ""
        for ($setupAttempt = 1; $setupAttempt -le 2; $setupAttempt++) {
            if ($setupAttempt -gt 1) {
                Write-Log "专用配置里的 Tampermonkey 无法使用，重置专用配置后重试一次（学习通需要重新登录）..." "WARN"
                $script:Result.profileReset = $true
                Save-Result
                if ($script:BrowserProcess) {
                    try { $null = Close-DebugBrowser -Port $browserSetup.Port -Process $script:BrowserProcess } catch { }
                    $script:BrowserProcess = $null
                }
                if ($browserSetup) {
                    Stop-DedicatedBrowser -ProfileDir $browserSetup.ProfileDir
                    Start-Sleep -Seconds 2
                    if (Test-Path -LiteralPath $browserSetup.ProfileDir) {
                        try {
                            Remove-Item -LiteralPath $browserSetup.ProfileDir -Recurse -Force -ErrorAction Stop
                        } catch {
                            Write-Log "清空专用配置失败：$($_.Exception.Message)" "WARN"
                        }
                    }
                }
            }
            try {
                $browserSetup = Start-DedicatedBrowser -BrowserKind $info.Kind -BrowserExe $info.Exe -InstallDir $script:InstallDir -ExtDir $ext.Dir -DebugPort $DebugPort -AppPort $AppPort
            } catch {
                $script:NeedsUserAction = $true
                $script:Result.nextStep = "专用浏览器启动失败。请按《安装教程》手动安装 Tampermonkey，或改用 Edge 后重试；程序本身已安装可用。"
                throw "专用浏览器启动失败：$($_.Exception.Message)"
            }
            $script:Result.profileDir = $browserSetup.ProfileDir
            $script:Result.extensionId = $browserSetup.ExtensionId
            $script:Result.stage = "userscript"
            Save-Result

            try {
                $installedExtensionId = Install-Userscript -Port $browserSetup.Port -AppPort $AppPort
                if ($installedExtensionId) {
                    $browserSetup.ExtensionId = $installedExtensionId
                    $script:Result.extensionId = $installedExtensionId
                }
                $script:Result.userscriptInstalled = $true
                Save-Result
                break
            } catch {
                if ($setupAttempt -lt 2) {
                    Write-Log "用户脚本安装失败，准备重置专用配置后重试：$($_.Exception.Message)" "WARN"
                    continue
                }
                $script:KeepBrowserOpen = $true
                $script:NeedsUserAction = $true
                $script:Result.nextStep = "用户脚本没有自动安装。请在已打开的 Tampermonkey 页面点「安装」，或按《安装教程》手动安装；程序本身已安装可用。"
                throw "用户脚本安装失败：$($_.Exception.Message)"
            }
        }
        if (-not $browserSetup) { throw "专用浏览器初始化失败。" }
        $script:Result.userscriptInstalled = $true

        $script:Result.stage = "allow-userscripts"
        $allow = Enable-AllowUserScripts -Port $browserSetup.Port -ExtensionId $browserSetup.ExtensionId -BrowserKind $info.Kind
        $script:Result.allowUserScripts = [bool]$allow

        $script:Result.stage = "verify-dashboard"
        try {
            $null = Verify-TampermonkeyDashboard -Port $browserSetup.Port -ExtensionId $browserSetup.ExtensionId -KeepOpenOnFailure
            if (-not $allow) {
                # 管理面板没有警告，说明当前浏览器版本不要求该开关或已默认允许
                $script:Result.allowUserScripts = $true
            }
        } catch {
            $script:KeepBrowserOpen = $true
            $script:NeedsUserAction = $true
            $script:Result.nextStep = "请在已打开的 Tampermonkey 管理面板/扩展设置里确认：学习小助手脚本已启用，且「允许用户脚本」已打开。完成后刷新学习通页面。"
            throw "Tampermonkey 验证失败：$($_.Exception.Message)"
        }

        # 启动器 / 快捷方式
        $script:Result.stage = "launcher"
        try {
            $launcher = New-LauncherFiles -InstallDir $script:InstallDir -BrowserExe $info.Exe -BrowserKind $info.Kind
            Write-Log "启动器：$($launcher.Cmd)"
        } catch {
            Write-Log "创建启动器失败（不影响当前使用）：$($_.Exception.Message)" "WARN"
        }
        try {
            $shortcut = New-DesktopShortcut -InstallDir $script:InstallDir -BrowserExe $info.Exe
            if ($shortcut) { $script:Result.shortcut = $shortcut }
        } catch {
            Write-Log "创建桌面快捷方式失败（不影响当前使用）：$($_.Exception.Message)" "WARN"
        }
        $script:Result.dedicatedBrowser = $true

        # 关闭带调试端口的浏览器
        $script:Result.stage = "close-debug"
        if ($script:BrowserProcess) {
            $closed = Close-DebugBrowser -Port $browserSetup.Port -Process $script:BrowserProcess
            if (-not $closed) { Write-Log "调试浏览器没有完全关闭；继续。" "WARN" }
            $script:BrowserProcess = $null
        }
        $script:KeepBrowserOpen = $false

        # 重新打开（不带调试端口）
        $script:Result.stage = "relaunch"
        if ($NoLaunch) {
            Write-Log "按 -NoLaunch 不重新打开浏览器。"
            $script:Result.nextStep = "安装完成。双击桌面「学习小助手浏览器」或安装目录里的 start-browser.cmd 打开。"
        } else {
            try {
                $relaunched = Relaunch-Browser -BrowserExe $info.Exe -ProfileDir $browserSetup.ProfileDir -ExtDir $ext.Dir
                if ($relaunched) { Write-Log "已重新打开专用浏览器（PID=$($relaunched.Id)）" }
                $script:Result.nextStep = "浏览器已打开 https://i.chaoxing.com/。请手动登录学习通，然后打开任意课程/作业页面；右下角出现「学习小助手」即成功。"
            } catch {
                Write-Log "重新打开浏览器失败：$($_.Exception.Message)" "WARN"
                $script:Result.nextStep = "安装完成。双击桌面「学习小助手浏览器」打开；如果打不开，双击安装目录里的 start-browser.cmd。"
            }
        }

        if ($script:Result.profileReset) {
            $script:Result.nextStep = [string]$script:Result.nextStep + " 专用浏览器配置已重置，请在打开的学习通页面重新登录。"
        }

        $script:Result.stage = "done"
        $script:Result.ok = $true
        Write-Log "浏览器扩展安装完成。"
    }

    # 成功输出
    if ($script:Result.ok) {
        Save-Result
        Write-Host ""
        Write-Host "=============================================="
        Write-Host " 学习小助手 $AppVersion 安装完成"
        Write-Host "=============================================="
        Write-Host "安装目录：$($script:InstallDir)"
        Write-Host "本地服务：http://127.0.0.1:$AppPort"
        if ($script:Result.browser -ne "none") {
            Write-Host "浏览器：$($script:Result.browser)（专用配置）"
            if ($script:Result.shortcut) { Write-Host "桌面快捷方式：$($script:Result.shortcut)" }
        }
        Write-Host "结果文件：$($script:ResultPath)"
        Write-Host "日志文件：$($script:LogPath)"
        Write-Host ""
        Write-Host "下一步：$($script:Result.nextStep)"
        Write-Host "提示：学习通登录必须由你手动完成；脚本不会保存密码。"
        Write-Host ""
    }
} catch {
    $msg = $_.Exception.Message
    $script:Result.ok = $false
    $script:Result.error = $msg
    $script:Result.needsUserAction = [bool]$script:NeedsUserAction
    try {
        Write-Log ("异常类型：" + $_.Exception.GetType().FullName) "ERROR"
        Write-Log ("异常位置：" + $_.InvocationInfo.PositionMessage) "ERROR"
        Write-Log ("调用栈：" + $_.ScriptStackTrace) "ERROR"
    } catch {}
    if (-not $script:Result.nextStep) {
        if ($script:NeedsUserAction) {
            $script:Result.nextStep = "请按上面的提示手动完成浏览器扩展设置，然后重新运行本脚本。"
        } else {
            $script:Result.nextStep = "请查看 install.log，或按《安装教程》的「故障排查」处理。"
        }
    }
    if ($script:NeedsUserAction) { $exitCode = 2 } else { $exitCode = 1 }
    Write-Log "安装失败：$msg" "ERROR"
    Save-Result
    Write-Host ""
    Write-Host "=============================================="
    Write-Host " 安装没有完全成功"
    Write-Host "=============================================="
    Write-Host "原因：$msg"
    Write-Host "日志：$($script:LogPath)"
    Write-Host "结果：$($script:ResultPath)"
    Write-Host "下一步：$($script:Result.nextStep)"
    Write-Host ""
} finally {
    if ($script:TempExtractRoot -and (Test-Path -LiteralPath $script:TempExtractRoot)) {
        Remove-Item -LiteralPath $script:TempExtractRoot -Recurse -Force -ErrorAction SilentlyContinue
    }

    $procAlive = $false
    if ($script:BrowserProcess) {
        try { $procAlive = -not $script:BrowserProcess.HasExited } catch { $procAlive = $false }
    }
    if ($procAlive -and $script:KeepBrowserOpen) {
        Write-Log "浏览器保持打开，等待用户完成操作。"
    } elseif ($procAlive -and $script:DebugPort) {
        try {
            $closed = Close-DebugBrowser -Port $script:DebugPort -Process $script:BrowserProcess
            if (-not $closed) { Write-Log "关闭调试浏览器超时。" "WARN" }
        } catch {
            Write-Log "关闭调试浏览器失败：$($_.Exception.Message)" "WARN"
        }
        $script:BrowserProcess = $null
    }

    $script:Result.needsUserAction = [bool]$script:NeedsUserAction
    Save-Result
}

exit $exitCode
