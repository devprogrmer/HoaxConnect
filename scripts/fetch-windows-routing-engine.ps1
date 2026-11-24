param(
  [string]$Destination = (Join-Path $PSScriptRoot "..\native-bin\routing")
)

$ErrorActionPreference = "Stop"
$Version = "1.14.4"
$ArchiveName = "sing-box-$Version-windows-amd64.zip"
$ExpectedSha256 = "99185d75d314a07dbba4a130c8ad986cbeb629a07927975636b341ca61f991df"
$ExpectedExecutableSha256 = "8f30682ee198855440d2a7fe070d5d3653793b2d01bb8c85eea88f93bbe7c8b9"
$ExpectedLibrarySha256 = "3217c6260fbca5f16072e0b79735742f40109a63bb0ff88fd6b96dd6b54a2928"
$Url = "https://github.com/SagerNet/sing-box/releases/download/v$Version/$ArchiveName"
$Work = Join-Path ([IO.Path]::GetTempPath()) "hoaxconnect-sing-box-$Version"
$Archive = Join-Path $Work $ArchiveName
$Extracted = Join-Path $Work "expanded"

function Get-Sha256([string]$Path) {
  $Stream = [IO.File]::OpenRead($Path)
  try {
    $Hasher = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($Hasher.ComputeHash($Stream))).Replace("-", "").ToLowerInvariant() }
    finally { $Hasher.Dispose() }
  }
  finally { $Stream.Dispose() }
}

New-Item -ItemType Directory -Force $Work, $Destination | Out-Null
$ExistingExecutable = Join-Path $Destination "sing-box.exe"
$ExistingLibrary = Join-Path $Destination "libcronet.dll"
$ExistingLicense = Join-Path $Destination "LICENSE.sing-box.txt"
if (
  (Test-Path $ExistingExecutable) -and
  (Test-Path $ExistingLibrary) -and
  (Test-Path $ExistingLicense) -and
  (Get-Sha256 $ExistingExecutable) -eq $ExpectedExecutableSha256 -and
  (Get-Sha256 $ExistingLibrary) -eq $ExpectedLibrarySha256
) {
  Write-Output "ROUTING_ENGINE_READY version=$Version cached=true"
  exit 0
}
Invoke-WebRequest -Uri $Url -OutFile $Archive
$Actual = Get-Sha256 $Archive
if ($Actual -ne $ExpectedSha256) {
  throw "Routing engine checksum mismatch."
}

if (Test-Path $Extracted) { Remove-Item -LiteralPath $Extracted -Recurse -Force }
Expand-Archive -LiteralPath $Archive -DestinationPath $Extracted
$Source = Join-Path $Extracted "sing-box-$Version-windows-amd64"
Copy-Item -LiteralPath (Join-Path $Source "sing-box.exe") -Destination (Join-Path $Destination "sing-box.exe") -Force
Copy-Item -LiteralPath (Join-Path $Source "libcronet.dll") -Destination (Join-Path $Destination "libcronet.dll") -Force
Copy-Item -LiteralPath (Join-Path $Source "LICENSE") -Destination (Join-Path $Destination "LICENSE.sing-box.txt") -Force

& (Join-Path $Destination "sing-box.exe") version
Write-Output "ROUTING_ENGINE_READY version=$Version sha256=$ExpectedSha256"
