@echo off
setlocal
REM ============================================================
REM  V.Canvas - sync source into the SillyTavern extensions dir
REM
REM  SRC is derived from this script's own directory, so it needs no edit.
REM  ST must point at the SillyTavern root directory - edit the line below.
REM
REM  (Keep this file ASCII-only: cmd.exe reads .bat as ANSI.)
REM ============================================================

REM -------- source: the directory holding this script --------
set "SRC=%~dp0"
set "SRC=%SRC:~0,-1%"

REM -------- EDIT THIS: SillyTavern root directory --------
set "ST=<SillyTavern>"

set "DST=%ST%\data\default-user\extensions\V.Canvas"

if not exist "%SRC%\manifest.json" (
  echo [error] source not found: %SRC%
  echo         Run this script from inside the V.Canvas source folder.
  exit /b 1
)
if not exist "%ST%" (
  echo [error] SillyTavern not found: %ST%
  echo         Open this .bat in a text editor and set ST to your SillyTavern root.
  exit /b 1
)

if not exist "%DST%" mkdir "%DST%"
if not exist "%DST%\lib" mkdir "%DST%\lib"

copy /Y "%SRC%\manifest.json" "%DST%\manifest.json" >nul
copy /Y "%SRC%\index.js"      "%DST%\index.js"      >nul
copy /Y "%SRC%\style.css"     "%DST%\style.css"     >nul
copy /Y "%SRC%\panel.html"    "%DST%\panel.html"    >nul
copy /Y "%SRC%\README.md"     "%DST%\README.md"     >nul
REM Wildcards copy every module under lib\, so new files need no edit here.
REM Keep the destination path free of a trailing backslash, otherwise the
REM trailing \" is read as an escaped quote and cmd reports access denied.
copy /Y "%SRC%\lib\*.js"      "%DST%\lib"           >nul

echo.
echo [ok] synced to %DST%
echo      restart SillyTavern (or reload the page) to pick up changes.
exit /b 0
