@echo off
title Generador de Paquete Blindado y Actualizador GitHub - By. Carlos Neira
echo 1. Generando carpeta ENTREGA_CLIENTE protegida y blindada...
node "%~dp0build_cliente.js"
echo.
echo 2. Subiendo actualizacion automaticamente a GitHub Pages...
git -C "%~dp0ENTREGA_CLIENTE" add index.html
git -C "%~dp0ENTREGA_CLIENTE" commit -m "Actualizacion automatica BioDent - By. Carlos Neira"
git -C "%~dp0ENTREGA_CLIENTE" push origin main
echo.
echo Listo! La carpeta ENTREGA_CLIENTE y tu enlace web en GitHub han sido actualizados.
pause

