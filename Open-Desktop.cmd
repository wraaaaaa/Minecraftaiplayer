@echo off
setlocal
cd /d "%~dp0"

rem 先确保 WebUI 服务在后台运行（幂等；缺构建产物时会明确报错）
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-webui-background.ps1"
if errorlevel 1 (
  pause
  exit /b 1
)

rem 检查 Electron 运行时
if not exist "%~dp0node_modules\electron\dist\electron.exe" (
  echo [错误] 未找到 Electron 运行时，请先在项目根目录运行 npm install。
  pause
  exit /b 1
)

rem 以原生窗口启动（不依赖浏览器）
start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0"
