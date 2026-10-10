!include "nsDialogs.nsh"
!include "LogicLib.nsh"
!macro customCheckAppRunning
  ${nsProcess::FindProcess} "Sidera.exe" $R0
  ${If} $R0 != 603
    MessageBox MB_OK|MB_ICONEXCLAMATION "Sidera is running. Use Quit safely in Sidera first. Active Host turns must finish. This installer will never terminate Sidera." /SD IDOK
    SetErrorLevel 10
    Quit
  ${EndIf}
!macroend
!ifndef BUILD_UNINSTALLER
!macro customPageAfterChangeDir
  Page custom SideraShortcutsPage SideraShortcutsLeave
!macroend
Var SideraDesktopCheckbox
Var SideraDesktopChoice
Function SideraShortcutsPage
  nsDialogs::Create 1018
  Pop $0
  ${NSD_CreateLabel} 0 0 100% 30u "A Start Menu shortcut will be installed. Your private data is preserved across upgrades and uninstall."
  Pop $0
  ${NSD_CreateCheckbox} 0 40u 100% 15u "Create a desktop shortcut"
  Pop $SideraDesktopCheckbox
  nsDialogs::Show
FunctionEnd
Function SideraShortcutsLeave
  ${NSD_GetState} $SideraDesktopCheckbox $SideraDesktopChoice
FunctionEnd
!macro customInstall
  ${If} $SideraDesktopChoice == ${BST_CHECKED}
    CreateShortCut "$DESKTOP\Sidera.lnk" "$INSTDIR\Sidera.exe"
    WriteRegStr HKCU "Software\SideraDesktopPhase2" "DesktopShortcutInstallDir" "$INSTDIR"
  ${EndIf}
!macroend
!endif
!macro customUnInstall
  ReadRegStr $R1 HKCU "Software\SideraDesktopPhase2" "DesktopShortcutInstallDir"
  ${If} $R1 == $INSTDIR
    Delete "$DESKTOP\Sidera.lnk"
    DeleteRegValue HKCU "Software\SideraDesktopPhase2" "DesktopShortcutInstallDir"
  ${EndIf}
!macroend
