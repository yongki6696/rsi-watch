@echo off
chcp 65001 >nul
rem 오더허브 - 윈도우 PC에서 실행 (Node.js 22 LTS 이상 필요: https://nodejs.org)
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 가 설치되어 있지 않습니다. https://nodejs.org 에서 LTS 버전을 설치한 뒤 다시 실행하세요.
  pause
  exit /b 1
)
if not exist node_modules (
  echo 처음 실행: 필요한 파일을 설치합니다...
  call npm install --omit=dev
)
echo.
echo 브라우저에서 http://localhost:3000 을 여세요. 이 창을 닫으면 오더허브가 멈춥니다.
echo.
node --disable-warning=ExperimentalWarning server.js
pause
