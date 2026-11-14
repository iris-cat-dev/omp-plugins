param([string]$OutDir)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$runtimeDir = if ($OutDir) { [IO.Path]::GetFullPath($OutDir) } else { Join-Path $projectRoot '.runtime/native' }
$source = Join-Path $PSScriptRoot 'bridge.cpp'
$sourceHash = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.ToLowerInvariant()
$outputDir = Join-Path $runtimeDir $sourceHash.Substring(0, 12)
New-Item -ItemType Directory -Path $outputDir -Force | Out-Null

$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
if (-not (Test-Path -LiteralPath $vswhere -PathType Leaf)) {
    throw '未找到 Visual Studio Installer；需要已安装的 C++ x64 构建工具。'
}
$installation = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (-not $installation) { throw '没有可用的 Visual Studio C++ x64 构建工具。' }
$vcvars = Join-Path $installation 'VC/Auxiliary/Build/vcvars64.bat'
$dll = Join-Path $outputDir 'omp-wechat-send.dll'
$object = Join-Path $outputDir 'bridge.obj'
$library = Join-Path $outputDir 'bridge.lib'
# The batch stays ASCII; Unicode paths travel through the process environment.
$env:COMPANION_NATIVE_VCVARS = $vcvars
$env:COMPANION_NATIVE_SOURCE = $source
$env:COMPANION_NATIVE_OBJECT = $object
$env:COMPANION_NATIVE_DLL = $dll
$env:COMPANION_NATIVE_LIBRARY = $library
$command = 'cl /nologo /std:c++17 /O2 /MT /EHsc /W4 /WX /LD /utf-8 "%COMPANION_NATIVE_SOURCE%" /Fo"%COMPANION_NATIVE_OBJECT%" /link /MACHINE:X64 /DYNAMICBASE /NXCOMPAT /OUT:"%COMPANION_NATIVE_DLL%" /IMPLIB:"%COMPANION_NATIVE_LIBRARY%"'
$buildScript = Join-Path $outputDir 'build.cmd'
$scriptText = @('@echo off', 'call "%COMPANION_NATIVE_VCVARS%" >nul', 'if errorlevel 1 exit /b 1', $command, 'exit /b %errorlevel%') -join "`r`n"
[IO.File]::WriteAllText($buildScript, $scriptText + "`r`n", [Text.Encoding]::ASCII)
& $env:ComSpec /d /c $buildScript
if ($LASTEXITCODE -ne 0) { throw "原生桥编译失败，退出码 $LASTEXITCODE；保留原 current.json。" }

$stream = [IO.File]::OpenRead($dll)
try {
    $reader = [IO.BinaryReader]::new($stream)
    if ($reader.ReadUInt16() -ne 0x5A4D) { throw '构建产物不是 PE 文件。' }
    $stream.Position = 0x3C
    $headerOffset = $reader.ReadInt32()
    if ($headerOffset -lt 64 -or $headerOffset -gt ($stream.Length - 24)) { throw 'PE 头偏移无效。' }
    $stream.Position = $headerOffset
    if ($reader.ReadUInt32() -ne 0x00004550 -or $reader.ReadUInt16() -ne 0x8664) { throw '构建产物不是 Windows x64 PE。' }
} finally {
    $stream.Dispose()
}

$record = [ordered]@{
    file = [IO.Path]::GetFullPath($dll)
    sha256 = (Get-FileHash -LiteralPath $dll -Algorithm SHA256).Hash.ToLowerInvariant()
    sourceSha256 = $sourceHash
}
$current = Join-Path $runtimeDir 'current.json'
$temporary = Join-Path $runtimeDir ('current.' + [Guid]::NewGuid().ToString('N') + '.tmp')
[IO.File]::WriteAllText($temporary, (($record | ConvertTo-Json) + "`n"), [Text.UTF8Encoding]::new($false))
if (Test-Path -LiteralPath $current -PathType Leaf) {
    [IO.File]::Replace($temporary, $current, $null)
} else {
    [IO.File]::Move($temporary, $current)
}

# Keep previous builds for rollback; never load a DLL or contact Weixin here.
$record | ConvertTo-Json
