@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
set "HERE=%~dp0"
set "PKG=%HERE%dsh-plugin-pet-desktop-1.0.0.tgz"

echo ================================================
echo   灵灵 . DSH 桌面宠物 - 安装
echo ================================================
echo.

where dsh >nul 2>nul
if errorlevel 1 (
  echo [x] 找不到 dsh 命令。
  echo.
  echo     说明这台机器的 DSH 是用别的方式装的。先确认：
  echo       1. 打开一个命令行，敲  dsh --version  能出版本号
  echo       2. 如果不能，把 dsh 所在目录加到 PATH，或者用 npm i -g @deepseek-ai/dsh 重装一次
  echo.
  pause
  exit /b 1
)

if not exist "%PKG%" (
  echo [x] 找不到安装包：%PKG%
  echo     把本 bat 和 tgz 放在同一个文件夹里再运行。
  pause
  exit /b 1
)

echo [1/2] 正在装进 web profile...
call dsh plugin --profile web add "%PKG%"
if errorlevel 1 (
  echo.
  echo [x] 装失败。两个备选：
  echo     1^) 直接用目录方式装（先把 tgz 解压出来）：
  echo        dsh plugin --profile web add "%HERE%dsh-plugin-pet"
  echo     2^) 干脆不用插件，装独立版：
  echo        npx --yes electron@33 "%HERE%app"
  echo.
  pause
  exit /b 1
)

echo.
echo [2/2] 装好了。
echo.
echo   接下来：
echo     1. 关掉正在跑 DSH 的那个黑色命令行窗口
echo     2. 重新双击桌面上启动 DSH 的 bat
echo     3. 桌宠会自己出现在屏幕左下角
echo.
echo   ★ 第一次启动要下载 Electron 运行时（约 115 MB，国内镜像），
echo     屏幕上不会提示，去 %APPDATA%\dsh-pet\pet.log 能看到进度。等 1-3 分钟。
echo.
echo   双击桌宠 = 展开聊天窗口；右上角三角 = 收回；右键 = 菜单。
echo.
pause
