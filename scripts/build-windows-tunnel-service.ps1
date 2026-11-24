$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$Dotnet = Get-Command dotnet -ErrorAction SilentlyContinue
if (-not $Dotnet) { throw ".NET 8 SDK is required to build the Windows tunnel service." }

& (Join-Path $PSScriptRoot "fetch-windows-routing-engine.ps1")
if ($LASTEXITCODE -ne 0) { throw "Routing engine preparation failed." }

$Output = Join-Path $ProjectRoot "native-bin\service"
$Arguments = @(
  "publish",
  (Join-Path $ProjectRoot "native\HoaxConnect.Service\HoaxConnect.Service.csproj"),
  "-c", "Release",
  "-r", "win-x64",
  "--self-contained", "true",
  "-p:NuGetAudit=false",
  "-o", $Output
)
& $Dotnet.Source @Arguments
if ($LASTEXITCODE -ne 0) { throw "Tunnel service publish failed." }

if (-not (Test-Path (Join-Path $Output "HoaxConnect.Service.exe"))) {
  throw "Tunnel service executable was not produced."
}
Write-Output "WINDOWS_TUNNEL_SERVICE_READY"
