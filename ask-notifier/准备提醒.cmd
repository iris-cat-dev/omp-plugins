@echo off
chcp 65001 >nul
setlocal
set "OMP_RUNTIME=%LOCALAPPDATA%\Programs\OMP Desktop\OMP Desktop.exe"
if not exist "%OMP_RUNTIME%" (
  echo 未找到 OMP Desktop。请先安装 OMP Desktop 0.7.0 或兼容版本。
  pause
  exit /b 1
)
set "ELECTRON_RUN_AS_NODE=1"
"%OMP_RUNTIME%" "%~dp0scripts\prepare-runtime.mjs"
set "RESULT=%ERRORLEVEL%"
if "%RESULT%"=="0" (
  echo.
  echo QQ 提醒准备完成。请在 OMP 的插件管理中选择本文件所在目录安装。
) else (
  echo.
  echo 准备未完成，请按上方提示处理。尚未安装插件，也未连接 QQ。
)
pause
exit /b %RESULT%
