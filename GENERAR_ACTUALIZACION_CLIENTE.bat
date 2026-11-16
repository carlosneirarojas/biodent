@echo off
cd /d "%~dp0"
title Generador de Paquete Blindado y Actualizador GitHub - By. Carlos Neira
echo 1. Generando carpeta ENTREGA_CLIENTE protegida y blindada...
node "%~dp0build_cliente.js"
echo.
echo 2. Subiendo actualizacion automaticamente a GitHub Pages...
git add .
git commit -m "Actualizacion automatica BioDent - By. Carlos Neira"
git push -u origin main
echo.
echo Listo! La carpeta ENTREGA_CLIENTE y tu enlace web en GitHub han sido actualizados.
pause

