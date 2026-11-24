param(
  [Parameter(Mandatory = $true)]
  [string] $ServiceExecutable
)

$ErrorActionPreference = 'Stop'

$root = Join-Path $env:ProgramData 'HoaxConnect'
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
if ($null -eq $sid) {
  throw 'The desktop user SID is unavailable.'
}

[IO.Directory]::CreateDirectory($root) | Out-Null
[IO.File]::WriteAllText((Join-Path $root 'allowed-user.sid'), $sid.Value)

$acl = [Security.AccessControl.DirectorySecurity]::new()
$acl.SetAccessRuleProtection($true, $false)
$inherit = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
  [Security.AccessControl.InheritanceFlags]::ObjectInherit
$none = [Security.AccessControl.PropagationFlags]::None
$allow = [Security.AccessControl.AccessControlType]::Allow
$full = [Security.AccessControl.FileSystemRights]::FullControl
$read = [Security.AccessControl.FileSystemRights]::ReadAndExecute

foreach ($rule in @(
  [Security.AccessControl.FileSystemAccessRule]::new(
    [Security.Principal.SecurityIdentifier]::new('S-1-5-18'), $full, $inherit, $none, $allow),
  [Security.AccessControl.FileSystemAccessRule]::new(
    [Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'), $full, $inherit, $none, $allow),
  [Security.AccessControl.FileSystemAccessRule]::new(
    $sid, $read, $inherit, $none, $allow)
)) {
  $acl.AddAccessRule($rule)
}

[IO.Directory]::SetAccessControl($root, $acl)

& $env:SystemRoot\System32\sc.exe stop HoaxConnectTunnel *> $null
& $env:SystemRoot\System32\sc.exe delete HoaxConnectTunnel *> $null
Start-Sleep -Milliseconds 800

$quotedExecutable = '"' + $ServiceExecutable + '"'
$enginePath = Join-Path (Split-Path -Parent $ServiceExecutable) 'routing\sing-box.exe'
$binaryPath = $quotedExecutable + ' --engine-path "' + $enginePath + '"'
New-Service -Name HoaxConnectTunnel -BinaryPathName $binaryPath `
  -DisplayName 'HoaxConnect Tunnel' -StartupType Automatic | Out-Null

& $env:SystemRoot\System32\sc.exe description HoaxConnectTunnel `
  'Routes only selected applications through HoaxConnect.' *> $null
& $env:SystemRoot\System32\sc.exe failure HoaxConnectTunnel `
  reset= 86400 actions= restart/3000/restart/10000/none/0 *> $null
$startOutput = & $env:SystemRoot\System32\sc.exe start HoaxConnectTunnel 2>&1
if ($LASTEXITCODE -ne 0) {
  & $env:SystemRoot\System32\sc.exe delete HoaxConnectTunnel *> $null
  throw "Could not start the tunnel service: $startOutput"
}
