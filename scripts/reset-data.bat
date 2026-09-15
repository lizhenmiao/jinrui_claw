@echo off
setlocal
for %%I in ("%~dp0..") do set "ROOT=%%~fI"
set "CACHE=%LOCALAPPDATA%\ZgyClaw"
set "OCTEMP=%TEMP%\openclaw"
set "UIDATA=%APPDATA%\zgy-claw-desktop"
set "FIND=%SystemRoot%\System32\find.exe"
set "TASKLIST=%SystemRoot%\System32\tasklist.exe"

echo ================================================
echo   小龙虾U盘版 - 清除运行数据（回到首次运行状态）
echo ================================================
echo.
echo 将清除：
echo   [1] %ROOT%\data
echo       配置、授权、微信/QQ 绑定、登录令牌、日志
echo   [2] %ROOT%\release\data
echo       打包版 exe 的数据目录（存在才清）
echo   [3] %OCTEMP%
echo       插件日志与网关锁
echo   [4] %UIDATA%
echo       渲染层缓存与 localStorage
echo.
echo 不会动：src / resources / node_modules / release 里的 exe / 仓库根 app.config.json
echo.

rem ---- 客户端在跑就先拦住：边跑边删，文件会被重新写回来 ----
set "RUNNING="
%TASKLIST% /fi "imagename eq electron.exe" 2>nul | %FIND% /i "electron.exe" >nul && set "RUNNING=1"
%TASKLIST% /fi "imagename eq 小龙虾U盘版.exe" 2>nul | %FIND% /i "小龙虾U盘版.exe" >nul && set "RUNNING=1"
if defined RUNNING (
  echo [停止] 检测到客户端正在运行，请先关闭客户端（开发模式记得在终端按 Ctrl+C）后再执行本脚本。
  echo.
  pause
  exit /b 1
)

set "CLEARCACHE="
set /p "CLEARCACHE=是否连本机模块缓存一起清掉？清掉后下次启动要重新解压约 20 秒并触发一次冷启动 [y/N]: "
if /i "%CLEARCACHE%"=="y" (
  echo   将清除 [5] %CACHE%
)

echo.
set /p "CONFIRM=确认清除？[y/N]: "
if /i not "%CONFIRM%"=="y" (
  echo 已取消，什么都没删。
  pause
  exit /b 0
)

echo.
for %%P in ("%ROOT%\data" "%ROOT%\release\data" "%OCTEMP%" "%UIDATA%") do (
  if exist "%%~P" (
    rmdir /s /q "%%~P"
    if exist "%%~P" (echo   [失败] %%~P) else (echo   [已删] %%~P)
  ) else (
    echo   [跳过] %%~P 不存在
  )
)
if /i "%CLEARCACHE%"=="y" (
  if exist "%CACHE%" (
    rmdir /s /q "%CACHE%"
    if exist "%CACHE%" (echo   [失败] %CACHE%) else (echo   [已删] %CACHE%)
  ) else (
    echo   [跳过] %CACHE% 不存在
  )
)

echo.
echo 完成。现在启动客户端就是从零开始：首次会解压模块（约 20 秒），
echo 随后 BOT 页的微信面板会盖一次加载页（首次冷启动约 1 分钟，已在启动阶段预热）。
echo.
pause
