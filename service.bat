@echo off
chcp 65001 >nul 2>&1
setlocal EnableDelayedExpansion

:: ==========================================
:: 飞书 + Cursor CLI 桥接服务管理脚本 (Windows)
:: 用法: service.bat {start|stop|restart|status|logs}
:: ==========================================

set "APP_NAME=feishu-cursor-bridge"
set "APP_DIR=%~dp0"
:: 去掉末尾反斜杠
if "%APP_DIR:~-1%"=="\" set "APP_DIR=%APP_DIR:~0,-1%"
set "PID_FILE=%APP_DIR%\.service.pid"
set "LOG_FILE=%APP_DIR%\service.log"
set "ENTRY=index.js"

:: 主入口
if "%~1"=="start"   goto :start
if "%~1"=="stop"    goto :stop
if "%~1"=="restart" goto :restart
if "%~1"=="status"  goto :status
if "%~1"=="logs"    goto :logs
goto :usage

:: ========== 启动服务 ==========
:start
call :get_pid
if defined RUNNING_PID (
    echo [!] 服务已在运行中 ^(PID: !RUNNING_PID!^)
    goto :eof
)

echo [*] 启动 %APP_NAME% ...

:: 使用 PowerShell 后台启动 Node 进程，并将输出重定向到日志
powershell -NoProfile -Command ^
    "$proc = Start-Process -FilePath 'node' -ArgumentList '%APP_DIR%\%ENTRY%' -WorkingDirectory '%APP_DIR%' -WindowStyle Hidden -RedirectStandardOutput '%LOG_FILE%' -RedirectStandardError '%APP_DIR%\service-error.log' -PassThru; Write-Output $proc.Id" > "%PID_FILE%"

:: 等待 2 秒确认进程存活
timeout /t 2 /nobreak >nul

call :get_pid
if defined RUNNING_PID (
    echo [OK] 服务已启动 ^(PID: !RUNNING_PID!^)
    echo     日志文件: %LOG_FILE%
    echo     查看日志: service.bat logs
) else (
    echo [ERR] 服务启动失败，请检查日志:
    if exist "%LOG_FILE%" type "%LOG_FILE%"
    if exist "%APP_DIR%\service-error.log" type "%APP_DIR%\service-error.log"
)
goto :eof

:: ========== 停止服务 ==========
:stop
call :get_pid
if not defined RUNNING_PID (
    echo [!] 服务未运行
    goto :eof
)

echo [*] 停止服务 ^(PID: !RUNNING_PID!^) ...
taskkill /PID !RUNNING_PID! /T /F >nul 2>&1

:: 等待进程退出
set /a "count=0"
:stop_wait
timeout /t 1 /nobreak >nul
tasklist /FI "PID eq !RUNNING_PID!" 2>nul | find "!RUNNING_PID!" >nul 2>&1
if errorlevel 1 goto :stop_done
set /a "count+=1"
if !count! lss 10 goto :stop_wait

:stop_done
if exist "%PID_FILE%" del "%PID_FILE%"
echo [OK] 服务已停止
goto :eof

:: ========== 重启服务 ==========
:restart
echo [*] 重启 %APP_NAME% ...
call :stop
timeout /t 1 /nobreak >nul
call :start
goto :eof

:: ========== 查看状态 ==========
:status
call :get_pid
if defined RUNNING_PID (
    echo [OK] 服务运行中
    echo     PID: !RUNNING_PID!
    echo     日志文件: %LOG_FILE%
    :: 显示进程启动时间
    powershell -NoProfile -Command ^
        "try { $p = Get-Process -Id !RUNNING_PID! -ErrorAction Stop; Write-Host ('    启动时间: ' + $p.StartTime.ToString('yyyy-MM-dd HH:mm:ss')) } catch { Write-Host '    (无法获取进程信息)' }"
) else (
    echo [X] 服务未运行
)
goto :eof

:: ========== 查看日志 ==========
:logs
if not exist "%LOG_FILE%" (
    echo [!] 日志文件不存在
    goto :eof
)

set "LINES=50"
if not "%~2"=="" set "LINES=%~2"

echo [i] 最近 %LINES% 行日志 ^(%LOG_FILE%^):
echo ----------------------------------------
powershell -NoProfile -Command "Get-Content '%LOG_FILE%' -Tail %LINES%"
goto :eof

:: ========== 获取运行中的 PID ==========
:get_pid
set "RUNNING_PID="
if not exist "%PID_FILE%" goto :eof

set /p RUNNING_PID=<"%PID_FILE%"
:: 去掉空格
for /f "tokens=*" %%a in ("!RUNNING_PID!") do set "RUNNING_PID=%%a"

:: 检查进程是否存活
tasklist /FI "PID eq !RUNNING_PID!" 2>nul | find "!RUNNING_PID!" >nul 2>&1
if errorlevel 1 (
    :: 进程已死，清理 PID 文件
    del "%PID_FILE%" >nul 2>&1
    set "RUNNING_PID="
)
goto :eof

:: ========== 使用说明 ==========
:usage
echo 飞书 + Cursor CLI 桥接服务管理脚本
echo.
echo 用法: %~nx0 {start^|stop^|restart^|status^|logs [行数]}
echo.
echo   start    启动服务（后台运行）
echo   stop     停止服务
echo   restart  重启服务
echo   status   查看服务状态
echo   logs     查看日志, 默认 50 行
echo.
exit /b 1
