; Like Echo's installer: ask whether Rakazo starts when the person signs in to Windows.
!include nsDialogs.nsh
!include LogicLib.nsh

Var StartOnLogin
Var StartOnLoginState

Function RakazoStartupPage
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}
  ${NSD_CreateLabel} 0 0 100% 28u "Choose whether Rakazo should start automatically when you sign in to Windows."
  Pop $0
  ${NSD_CreateCheckbox} 0 38u 100% 14u "Start Rakazo when Windows starts"
  Pop $StartOnLogin
  ${NSD_SetState} $StartOnLogin ${BST_CHECKED}
  nsDialogs::Show
FunctionEnd

Function RakazoStartupPageLeave
  ${NSD_GetState} $StartOnLogin $StartOnLoginState
FunctionEnd

!macro customPageAfterChangeDir
  Page custom RakazoStartupPage RakazoStartupPageLeave
!macroend

!macro customInstall
  ; An update reinstalls silently and skips the page; keep whatever the person chose before.
  ${IfNot} ${Silent}
    ${If} $StartOnLoginState == ${BST_CHECKED}
      WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Rakazo" '"$INSTDIR\Rakazo.exe"'
    ${Else}
      DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Rakazo"
    ${EndIf}
  ${EndIf}
!macroend

!macro customUnInstall
  ${IfNot} ${isUpdated}
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Rakazo"
  ${EndIf}
!macroend
