$ErrorActionPreference = 'Stop'
$target = Join-Path $PSScriptRoot 'bin'
New-Item -ItemType Directory -Path $target -Force | Out-Null
$compiler = 'C:/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe'
& $compiler /nologo /target:exe /platform:x64 ("/out:" + (Join-Path $target 'Win32Probe.exe')) (Join-Path $PSScriptRoot 'fixtures/Win32Probe.cs')
if ($LASTEXITCODE -ne 0) { throw "C# build failed: $LASTEXITCODE" }
