@echo off
rem StemPlayer environment setup (bypasses ExecutionPolicy).
rem Double-click this file or run: setup.cmd
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup.ps1" %*
pause
