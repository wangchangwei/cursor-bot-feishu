@echo off
chcp 65001 >nul 2>&1
setlocal EnableDelayedExpansion

:: ==========================================
:: 飞书 + Cursor CLI 桥接服务 — 开机自启安装/卸载
:: 使用 Windows 计划任务实现开机自动启动
:: 需要以管理员权限运行
:: ==========================================

set "TASK_NAME=FeishuCursorBridge"
set "APP_DIR=%~dp0"
if "%APP_DIR:~-1%"=="\" set "APP_DIR=%APP_DIR:~0,-1%"
set "SERVICE_BAT=%APP_DIR%\service.bat"

:: 检查管理员权限
net session >nul 2>&1
if errorlevel 1 (
    echo [ERR] 请以管理员身份运行此脚本！
    echo.
    echo 右键点击此文件 -^> 以管理员身份运行
    pause
    exit /b 1
)

:: 主入口
if "%~1"=="install"   goto :install
if "%~1"=="uninstall" goto :uninstall
if "%~1"=="check"     goto :check
goto :usage

:: ========== 安装开机自启 ==========
:install
echo [*] 正在注册开机自启计划任务: %TASK_NAME%
echo     服务脚本: %SERVICE_BAT%
echo.

:: 先删除已有的同名任务（如果存在）
schtasks /Query /TN "%TASK_NAME%" >nul 2>&1
if not errorlevel 1 (
    echo [!] 已存在同名任务，正在更新...
    schtasks /Delete /TN "%TASK_NAME%" /F >nul 2>&1
)

:: 创建计划任务：用户登录时自动启动
:: /SC ONLOGON  — 用户登录时触发
:: /DELAY 0000:30 — 延迟 30 秒启动（等待网络就绪）
:: /RL HIGHEST  — 以最高权限运行
schtasks /Create ^
    /TN "%TASK_NAME%" ^
    /TR "\"%SERVICE_BAT%\" start" ^
    /SC ONLOGON ^
    /DELAY 0000:30 ^
    /RL HIGHEST ^
    /F

if errorlevel 1 (
    echo.
    echo [ERR] 计划任务创建失败！
    pause
    exit /b 1
)

echo.
echo [OK] 开机自启已注册成功！
echo.
echo     任务名称: %TASK_NAME%
echo     触发方式: 用户登录时（延迟 30 秒）
echo     执行命令: service.bat start
echo.
echo     可使用以下命令管理:
echo       install-service.bat check     — 查看任务状态
echo       install-service.bat uninstall — 卸载开机自启
echo       service.bat start/stop/status — 手动管理服务
echo.
pause
goto :eof

:: ========== 卸载开机自启 ==========
:uninstall
echo [*] 正在卸载开机自启计划任务: %TASK_NAME%

schtasks /Query /TN "%TASK_NAME%" >nul 2>&1
if errorlevel 1 (
    echo [!] 计划任务不存在，无需卸载
    pause
    goto :eof
)

schtasks /Delete /TN "%TASK_NAME%" /F

if errorlevel 1 (
    echo [ERR] 卸载失败！
    pause
    exit /b 1
)

echo.
echo [OK] 开机自启已卸载
echo.
echo     注意: 如果服务正在运行，需要手动停止:
echo       service.bat stop
echo.
pause
goto :eof

:: ========== 查看任务状态 ==========
:check
echo [i] 计划任务状态:
echo.
schtasks /Query /TN "%TASK_NAME%" /V /FO LIST 2>nul
if errorlevel 1 (
    echo [X] 计划任务 "%TASK_NAME%" 未注册
    echo.
    echo     运行 install-service.bat install 来注册开机自启
)
echo.
pause
goto :eof

:: ========== 使用说明 ==========
:usage
echo ==========================================
echo  飞书 + Cursor CLI 桥接服务 — 开机自启管理
echo ==========================================
echo.
echo 用法: %~nx0 {install^|uninstall^|check}
echo.
echo   install    注册开机自启（用户登录时自动启动）
echo   uninstall  卸载开机自启
echo   check      查看计划任务状态
echo.
echo 注意: 需要以管理员身份运行！
echo.
pause
exit /b 1
