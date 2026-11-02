@echo off
title DeathZone - Servidor
cd /d "%~dp0"
where node >nul 2>nul || (echo Instala Node.js desde https://nodejs.org & pause & exit /b)
if not exist node_modules call npm install
rem Dueno del juego: unica cuenta que puede crear un personaje llamado Kaito X.
rem Escribe aqui el nombre de TU cuenta (el que usas para iniciar sesion), por ejemplo: set OWNER_ACCOUNT=MiCuenta
if exist owner.txt (set /p OWNER_ACCOUNT=<owner.txt) else (set /p OWNER_ACCOUNT=Nombre de tu cuenta para ser Kaito X: & (echo %OWNER_ACCOUNT%> owner.txt))
echo.
echo Servidor en http://localhost:3000   (dueno: %OWNER_ACCOUNT%)
echo Para jugar desde fuera de tu casa, abre otra ventana y ejecuta:
echo    cloudflared tunnel --url http://localhost:3000
echo.
call npm start
pause
