$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$root = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
$source = Join-Path $root 'native\qq'
$minHook = Join-Path $source 'minhook'
$build = Join-Path $root 'build\qq-native'
$output = Join-Path $source 'omp_qq_bootstrap.dll'
$cSources = @(
    (Join-Path $minHook 'src\buffer.c'),
    (Join-Path $minHook 'src\hook.c'),
    (Join-Path $minHook 'src\trampoline.c'),
    (Join-Path $minHook 'src\hde\hde64.c')
)
$required = @(
    (Join-Path $source 'bootstrap.cpp'),
    (Join-Path $source 'bootstrap_protocol.hpp'),
    (Join-Path $minHook 'include\MinHook.h')
) + $cSources
foreach ($path in $required) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw "Required QQ bootstrap source is missing: $path"
    }
}

$vsdev = $null
$candidates = @()
if ($env:VSINSTALLDIR) {
    $candidates += Join-Path $env:VSINSTALLDIR 'Common7\Tools\VsDevCmd.bat'
}
$candidates += Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\2022\BuildTools\Common7\Tools\VsDevCmd.bat'
foreach ($candidate in $candidates) {
    if (Test-Path -LiteralPath $candidate -PathType Leaf) {
        $vsdev = $candidate
        break
    }
}
if (-not $vsdev) {
    $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
    if (Test-Path -LiteralPath $vswhere -PathType Leaf) {
        $installation = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
        if ($LASTEXITCODE -ne 0) { throw 'Visual Studio discovery failed' }
        if ($installation) {
            $candidate = Join-Path ([string]($installation | Select-Object -First 1)) 'Common7\Tools\VsDevCmd.bat'
            if (Test-Path -LiteralPath $candidate -PathType Leaf) { $vsdev = $candidate }
        }
    }
}
if (-not $vsdev) { throw 'Visual Studio x64 C++ Build Tools were not found' }

New-Item -ItemType Directory -Force -Path $build | Out-Null
$environmentScript = Join-Path ([IO.Path]::GetTempPath()) ('omp-qq-vsenv-' + [Guid]::NewGuid().ToString('N') + '.cmd')
Set-Content -LiteralPath $environmentScript -Encoding ascii -Value "@echo off`r`ncall `"$vsdev`" -arch=x64 -host_arch=x64 -no_logo >nul`r`nif errorlevel 1 exit /b %errorlevel%`r`nset"
try {
    $environment = & "$env:SystemRoot\System32\cmd.exe" /d /c $environmentScript
    $environmentExitCode = $LASTEXITCODE
}
finally {
    Remove-Item -LiteralPath $environmentScript -Force -ErrorAction SilentlyContinue
}
if ($environmentExitCode -ne 0) { throw 'Visual Studio x64 build environment initialization failed' }
foreach ($line in $environment) {
    $separator = $line.IndexOf('=')
    if ($separator -gt 0) {
        [Environment]::SetEnvironmentVariable($line.Substring(0, $separator), $line.Substring($separator + 1), 'Process')
    }
}

# All dependencies are bundled under native/qq; the adjacent robot project and
# QQ installation are not consulted or modified.
Push-Location -LiteralPath $build
try {
    $cArgs = @('/nologo', '/O2', '/W3', '/MT', '/guard:cf', '/DNOMINMAX',
        '/DWIN32_LEAN_AND_MEAN', '/TC', '/c', '/Fo.\', "/I$minHook\include") + $cSources
    & cl.exe @cArgs
    if ($LASTEXITCODE -ne 0) { throw "MinHook compilation failed with exit code $LASTEXITCODE" }
    $cppArgs = @('/nologo', '/utf-8', '/O2', '/W4', '/WX', '/EHsc', '/MT',
        '/std:c++17', '/permissive-', '/guard:cf', '/DNOMINMAX', '/DWIN32_LEAN_AND_MEAN',
        '/DUNICODE', '/D_UNICODE', "/I$minHook\include", '/LD',
        "/Fo$build\bootstrap.obj", "/Fd$build\bootstrap-compile.pdb", "/Fe:$output",
        (Join-Path $source 'bootstrap.cpp'), '.\buffer.obj', '.\hook.obj', '.\trampoline.obj', '.\hde64.obj',
        '/link', '/MACHINE:X64', '/INCREMENTAL:NO', '/Brepro', '/DYNAMICBASE', '/HIGHENTROPYVA',
        '/NXCOMPAT', '/GUARD:CF', 'shell32.lib',
        "/IMPLIB:$build\omp_qq_bootstrap.lib", "/PDB:$build\omp_qq_bootstrap.pdb")
    & cl.exe @cppArgs
    if ($LASTEXITCODE -ne 0) {
        throw "QQ bootstrap compilation failed with exit code $LASTEXITCODE. A loaded DLL cannot be replaced; fully exit that QQ instance before rebuilding."
    }
    if (-not (Test-Path -LiteralPath $output -PathType Leaf)) { throw 'QQ bootstrap DLL was not produced' }
}
finally {
    Pop-Location
}
Write-Output "Built x64 QQ bootstrap: $output"
