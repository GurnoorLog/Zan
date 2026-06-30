@echo off
title BankaiAgent
cd /d "%~dp0"

echo ============================================
echo  BankaiAgent - Starting all services...
echo ============================================
echo.

:: Kill any old bun server
echo [1/3] Stopping old server...
taskkill /f /im bun.exe >nul 2>&1
timeout /t 2 /nobreak >nul

:: Start the server (auto-launches Chrome on port 3100)
echo [2/3] Starting BankaiAgent server...
start "BankaiAgent-Server" /min cmd /c "bun run server.ts"
timeout /t 5 /nobreak >nul

:: Open the chat UI
echo [3/3] Opening http://localhost:3100 ...
start http://localhost:3100

echo.
echo ============================================
echo  BankaiAgent is running!
echo  Chat UI: http://localhost:3100
echo  CDP:     http://localhost:9222/json/version
echo ============================================
echo.
echo  TIPS:
echo  - For images, set Gemini API key in Settings (gear icon)
echo    and select Gemini as your AI buddy
echo ============================================
echo.
echo  Press any key to stop all services...
pause >nul

:: Stop on key press
echo Stopping BankaiAgent...
taskkill /f /im bun.exe >nul 2>&1
echo Done.
timeout /t 2 /nobreak >nul
