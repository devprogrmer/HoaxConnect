!include "LogicLib.nsh"

!macro customInstallMode
  StrCpy $isForceMachineInstall "1"
!macroend

!macro customInstall
  DetailPrint "Configuring HoaxConnect Tunnel service"
  ReadEnvStr $R0 "ProgramData"
  CreateDirectory "$R0\HoaxConnect"
  nsExec::ExecToStack 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\resources\tunnel-service\install-service.ps1" -ServiceExecutable "$INSTDIR\resources\tunnel-service\HoaxConnect.Service.exe"'
  Pop $0
  Pop $1
  ${If} $0 != 0
    Abort "Could not configure the HoaxConnect desktop user."
  ${EndIf}
!macroend

!macro customUnInstall
  DetailPrint "Removing HoaxConnect Tunnel service"
  ReadEnvStr $R0 "ProgramData"
  nsExec::ExecToLog '"$SYSDIR\sc.exe" stop HoaxConnectTunnel'
  nsExec::ExecToLog '"$SYSDIR\sc.exe" delete HoaxConnectTunnel'
  ${ifNot} ${isUpdated}
    RMDir /r "$R0\HoaxConnect\Tunnel"
    Delete "$R0\HoaxConnect\allowed-user.sid"
    RMDir "$R0\HoaxConnect"
  ${endIf}
!macroend
