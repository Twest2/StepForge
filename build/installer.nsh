!include LogicLib.nsh
!include nsDialogs.nsh

Var StepForgeDesktopShortcutCheckbox
Var StepForgeDesktopShortcutState

!ifndef BUILD_UNINSTALLER
  ; Assisted installer page for the desktop shortcut choice.
  !macro customInit
    StrCpy $StepForgeDesktopShortcutState "true"
    ${If} ${isNoDesktopShortcut}
      StrCpy $StepForgeDesktopShortcutState "false"
    ${EndIf}
  !macroend

  !macro customHeader
    Function StepForgeDesktopShortcutPagePre
      !insertmacro MUI_PAGE_FUNCTION_CUSTOM PRE
      !insertmacro MUI_HEADER_TEXT "Desktop Icon" "Choose whether StepForge creates a desktop icon."

      nsDialogs::Create 1018
      Pop $0
      ${If} $0 == error
        Abort
      ${EndIf}

      ${NSD_CreateLabel} 0u 0u 280u 24u "StepForge can create a desktop icon for quick access from the desktop."
      Pop $0

      ${NSD_CreateCheckbox} 0u 34u 280u 12u "Create a desktop icon"
      Pop $StepForgeDesktopShortcutCheckbox

      StrCpy $StepForgeDesktopShortcutState "true"
      ${If} ${isNoDesktopShortcut}
        StrCpy $StepForgeDesktopShortcutState "false"
        EnableWindow $StepForgeDesktopShortcutCheckbox 0
      ${Else}
        ReadRegStr $0 SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" CreateDesktopShortcut
        ${If} $0 == "false"
          StrCpy $StepForgeDesktopShortcutState "false"
        ${Else}
          ReadRegStr $1 SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" ShortcutName
          ${If} $1 == ""
            StrCpy $1 "${SHORTCUT_NAME}"
          ${EndIf}

          ${If} ${FileExists} "$DESKTOP\$1.lnk"
            StrCpy $StepForgeDesktopShortcutState "true"
          ${ElseIf} ${FileExists} "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
            StrCpy $StepForgeDesktopShortcutState "false"
          ${EndIf}
        ${EndIf}
      ${EndIf}

      ${If} $StepForgeDesktopShortcutState == "false"
        SendMessage $StepForgeDesktopShortcutCheckbox ${BM_SETCHECK} ${BST_UNCHECKED} 0
      ${Else}
        SendMessage $StepForgeDesktopShortcutCheckbox ${BM_SETCHECK} ${BST_CHECKED} 0
      ${EndIf}

      !insertmacro MUI_PAGE_FUNCTION_CUSTOM SHOW
      nsDialogs::Show
    FunctionEnd

    Function StepForgeDesktopShortcutPageLeave
      !insertmacro MUI_PAGE_FUNCTION_CUSTOM LEAVE

      SendMessage $StepForgeDesktopShortcutCheckbox ${BM_GETCHECK} 0 0 $StepForgeDesktopShortcutState
      ${If} $StepForgeDesktopShortcutState == ${BST_UNCHECKED}
        StrCpy $StepForgeDesktopShortcutState "false"
      ${Else}
        StrCpy $StepForgeDesktopShortcutState "true"
      ${EndIf}
    FunctionEnd
  !macroend

  !macro customPageAfterChangeDir
    !insertmacro MUI_PAGE_INIT
    PageEx custom
      PageCallbacks StepForgeDesktopShortcutPagePre StepForgeDesktopShortcutPageLeave
      Caption " "
    PageExEnd
  !macroend

  !macro customInstall
    ; Reconcile the desktop shortcut after the default installer logic runs.
    ${If} ${isNoDesktopShortcut}
      StrCpy $StepForgeDesktopShortcutState "false"
    ${EndIf}

    WriteRegStr SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" CreateDesktopShortcut "$StepForgeDesktopShortcutState"

    ${If} $StepForgeDesktopShortcutState == "false"
      Delete "$newDesktopLink"
      Delete "$oldDesktopLink"
    ${Else}
      ${IfNot} ${FileExists} "$newDesktopLink"
        ${If} ${FileExists} "$oldDesktopLink"
          Rename "$oldDesktopLink" "$newDesktopLink"
        ${Else}
          CreateShortCut "$newDesktopLink" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
        ${EndIf}
        ClearErrors
        WinShell::SetLnkAUMI "$newDesktopLink" "${APP_ID}"
      ${EndIf}
    ${EndIf}

    System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'
  !macroend
!endif
