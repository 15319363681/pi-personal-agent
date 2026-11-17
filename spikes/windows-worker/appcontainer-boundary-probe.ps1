param([ValidateSet('all')][string]$Scenario = 'all')
$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot 'build-probe.ps1')
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Push-Location (Join-Path $PSScriptRoot '../pi-durable-validation')
try { & node src/windows-boundary.mjs; $result = $LASTEXITCODE } finally { Pop-Location }
exit $result
