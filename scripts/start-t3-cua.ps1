$ErrorActionPreference = 'Stop'
$t3CuaRoot = Split-Path -Parent $PSScriptRoot
$t3CuaLogDir = Join-Path $t3CuaRoot '.t3\logs'
New-Item -ItemType Directory -Path $t3CuaLogDir -Force | Out-Null
$t3CuaNode = (Get-Command node.exe).Source
$t3CuaScript = Join-Path $PSScriptRoot 'start-t3-cua.mjs'
Start-Process -FilePath $t3CuaNode -ArgumentList ('"' + $t3CuaScript + '"') -WorkingDirectory $t3CuaRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $t3CuaLogDir 'desktop.stdout.log') -RedirectStandardError (Join-Path $t3CuaLogDir 'desktop.stderr.log') -PassThru | Select-Object Id
