!include LogicLib.nsh
!include nsDialogs.nsh

; Runs packaging/windows/chocolatey-setup.ps1 (already extracted to
; $PLUGINSDIR) elevated through UAC with the arguments in a variable, and waits
; for it. ExecShellWait gives no exit code, so the helper writes a result file.
; Sets $3 to "ok" or "failed" and $4 to the log file. A declined UAC prompt or a
; helper that never ran counts as "failed". Uses $2-$7.
!macro StepForgeRunChocoHelper ARGS
  ; Prefer the 64-bit PowerShell; the installer is a 32-bit process.
  StrCpy $2 "$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe"
  ${IfNot} ${FileExists} "$2"
    StrCpy $2 "$SYSDIR\WindowsPowerShell\v1.0\powershell.exe"
  ${EndIf}
  ReadEnvStr $4 ProgramData
  StrCpy $4 "$4\StepForge\chocolatey-setup.log"
  StrCpy $3 "failed"

  ClearErrors
  ExecShellWait "runas" "$2" "${ARGS}" SW_HIDE
  ${If} ${Errors}
    StrCpy $4 "administrator approval was declined, or PowerShell could not start"
  ${Else}
    ClearErrors
    FileOpen $5 "$PLUGINSDIR\chocolatey-setup.result" r
    ${IfNot} ${Errors}
      FileRead $5 $6
      FileRead $5 $7
      FileClose $5
      StrCpy $3 $6 2
      ; Strip the line break from the log path.
      StrCpy $6 $7 1 -1
      ${If} $6 == "$\n"
        StrCpy $7 $7 -1
      ${EndIf}
      StrCpy $6 $7 1 -1
      ${If} $6 == "$\r"
        StrCpy $7 $7 -1
      ${EndIf}
      ${If} $7 != ""
        StrCpy $4 $7
      ${EndIf}
    ${EndIf}
  ${EndIf}
  ClearErrors
!macroend

!ifndef BUILD_UNINSTALLER
  Var StepForgeDesktopShortcutCheckbox
  Var StepForgeDesktopShortcutState
  Var StepForgeChocoCheckbox
  Var StepForgeChocoState
  Var StepForgeChocoSkip
  Var StepForgeChocoPresent

  ; The exact Chocolatey package version for this build: the numbers in the
  ; installer file name. scripts/package-windows.js sets it from buildVersion.
  ; makensis leaves an unset $%VAR% as literal text, so a "%" means unset.
  ; Without it the installer is still built, just without the Updates page.
  !define STEPFORGE_CHOCO_VERSION_ENV "$%STEPFORGE_CHOCO_VERSION%"
  !searchreplace STEPFORGE_CHOCO_VERSION_NO_PCT "${STEPFORGE_CHOCO_VERSION_ENV}" "%" ""
  !if "${STEPFORGE_CHOCO_VERSION_NO_PCT}" == "${STEPFORGE_CHOCO_VERSION_ENV}"
    !if "${STEPFORGE_CHOCO_VERSION_ENV}" != ""
      !define STEPFORGE_CHOCO_VERSION "${STEPFORGE_CHOCO_VERSION_ENV}"
    !endif
  !endif
  !ifndef STEPFORGE_CHOCO_VERSION
    !echo "STEPFORGE_CHOCO_VERSION is not set: this installer will not offer Chocolatey updates."
  !endif

  ; Assisted installer page for the desktop shortcut choice.
  !macro customInit
    StrCpy $StepForgeDesktopShortcutState "true"
    ${If} ${isNoDesktopShortcut}
      StrCpy $StepForgeDesktopShortcutState "false"
    ${EndIf}

    ; Chocolatey updates are offered only in an interactive install. Skip them
    ; for silent installs (unless /chocolatey is passed), for upgrades, and
    ; when Chocolatey itself is running this installer: choco holds a lock,
    ; so starting choco again from here would deadlock or recurse.
    StrCpy $StepForgeChocoState "true"
    StrCpy $StepForgeChocoSkip "false"
    !ifndef STEPFORGE_CHOCO_VERSION
      StrCpy $StepForgeChocoSkip "true"
    !endif
    ; StdUtils takes the option name without its "/" (like electron-builder's
    ; own "updated" flag for --updated); it matches /chocolatey.
    ${If} ${Silent}
      ${StdUtils.TestParameter} $R9 "chocolatey"
      ${If} $R9 != "true"
        StrCpy $StepForgeChocoSkip "true"
      ${EndIf}
    ${EndIf}
    ${If} ${isUpdated}
      StrCpy $StepForgeChocoSkip "true"
    ${EndIf}
    ; Choco sets these only while it runs a package script. ChocolateyInstall
    ; is not checked: it is a permanent machine-wide variable.
    ReadEnvStr $0 ChocolateyPackageName
    ${If} $0 != ""
      StrCpy $StepForgeChocoSkip "true"
    ${EndIf}
    ReadEnvStr $0 ChocolateyPackageFolder
    ${If} $0 != ""
      StrCpy $StepForgeChocoSkip "true"
    ${EndIf}
    ReadEnvStr $0 ChocolateyPackageVersion
    ${If} $0 != ""
      StrCpy $StepForgeChocoSkip "true"
    ${EndIf}

    ; Is Chocolatey installed? %ChocolateyInstall%, then PATH, then ProgramData.
    StrCpy $StepForgeChocoPresent "false"
    ReadEnvStr $0 ChocolateyInstall
    ${If} $0 != ""
    ${AndIf} ${FileExists} "$0\bin\choco.exe"
      StrCpy $StepForgeChocoPresent "true"
    ${EndIf}
    ${If} $StepForgeChocoPresent == "false"
      ClearErrors
      SearchPath $0 "choco.exe"
      ${IfNot} ${Errors}
        StrCpy $StepForgeChocoPresent "true"
      ${EndIf}
    ${EndIf}
    ${If} $StepForgeChocoPresent == "false"
      ReadEnvStr $0 ProgramData
      ${If} $0 != ""
      ${AndIf} ${FileExists} "$0\chocolatey\bin\choco.exe"
        StrCpy $StepForgeChocoPresent "true"
      ${EndIf}
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

    Function StepForgeChocoPagePre
      ${If} $StepForgeChocoSkip == "true"
        Abort
      ${EndIf}

      !insertmacro MUI_PAGE_FUNCTION_CUSTOM PRE
      !insertmacro MUI_HEADER_TEXT "Updates" "Choose how StepForge is kept up to date."

      nsDialogs::Create 1018
      Pop $0
      ${If} $0 == error
        Abort
      ${EndIf}

      ${If} $StepForgeChocoPresent == "true"
        ${NSD_CreateCheckbox} 0u 0u 280u 12u "Keep StepForge updated with Chocolatey"
      ${Else}
        ${NSD_CreateCheckbox} 0u 0u 280u 12u "Install Chocolatey and keep StepForge updated with it"
      ${EndIf}
      Pop $StepForgeChocoCheckbox

      ${If} $StepForgeChocoPresent == "true"
        ${NSD_CreateLabel} 0u 18u 280u 24u "Chocolatey will track this version, so `choco upgrade stepforge` updates it. This needs administrator approval."
      ${Else}
        ${NSD_CreateLabel} 0u 18u 280u 24u "Chocolatey is not installed. Installing it, and registering StepForge, needs internet access and administrator approval."
      ${EndIf}
      Pop $0

      ${NSD_CreateLabel} 0u 48u 280u 24u "If you install only for yourself, a Chocolatey update switches StepForge to an all-users install. Your guides and settings are kept."
      Pop $0

      ${If} $StepForgeChocoState == "false"
        SendMessage $StepForgeChocoCheckbox ${BM_SETCHECK} ${BST_UNCHECKED} 0
      ${Else}
        SendMessage $StepForgeChocoCheckbox ${BM_SETCHECK} ${BST_CHECKED} 0
      ${EndIf}

      !insertmacro MUI_PAGE_FUNCTION_CUSTOM SHOW
      nsDialogs::Show
    FunctionEnd

    Function StepForgeChocoPageLeave
      !insertmacro MUI_PAGE_FUNCTION_CUSTOM LEAVE

      SendMessage $StepForgeChocoCheckbox ${BM_GETCHECK} 0 0 $StepForgeChocoState
      ${If} $StepForgeChocoState == ${BST_UNCHECKED}
        StrCpy $StepForgeChocoState "false"
      ${Else}
        StrCpy $StepForgeChocoState "true"
      ${EndIf}
    FunctionEnd
  !macroend

  !macro customPageAfterChangeDir
    !insertmacro MUI_PAGE_INIT
    PageEx custom
      PageCallbacks StepForgeDesktopShortcutPagePre StepForgeDesktopShortcutPageLeave
      Caption " "
    PageExEnd

    !insertmacro MUI_PAGE_INIT
    PageEx custom
      PageCallbacks StepForgeChocoPagePre StepForgeChocoPageLeave
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

    ; Register this install with Chocolatey so "choco upgrade stepforge" works.
    ; The helper runs once, elevated. Nothing here may fail the install: a
    ; declined UAC prompt, no internet or a version missing from the feed only
    ; shows a message at the end.
    !ifdef STEPFORGE_CHOCO_VERSION
    ${If} $StepForgeChocoSkip != "true"
    ${AndIf} $StepForgeChocoState == "true"
      DetailPrint "Setting up Chocolatey updates..."
      InitPluginsDir
      File "/oname=$PLUGINSDIR\chocolatey-setup.ps1" "${PROJECT_DIR}\packaging\windows\chocolatey-setup.ps1"
      Delete "$PLUGINSDIR\chocolatey-setup.result"

      StrCpy $1 '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "$PLUGINSDIR\chocolatey-setup.ps1" -Version "${STEPFORGE_CHOCO_VERSION}" -ResultFile "$PLUGINSDIR\chocolatey-setup.result"'
      ${If} $StepForgeChocoPresent != "true"
        StrCpy $1 "$1 -InstallChocolatey"
      ${EndIf}

      !insertmacro StepForgeRunChocoHelper $1
      ${If} $3 != "ok"
        DetailPrint "Chocolatey updates were not set up. See $4"
        ${IfNot} ${Silent}
          MessageBox MB_OK|MB_ICONINFORMATION "StepForge was installed, but Chocolatey updates were not set up.$\r$\n$\r$\nDetails: $4$\r$\nHelp: https://github.com/Twest2/StepForge/blob/main/docs/windows/chocolatey.md"
        ${EndIf}
      ${EndIf}
    ${EndIf}
    !endif
  !macroend
!endif

!ifdef BUILD_UNINSTALLER
  ; Uninstalling from Apps & Features unregisters StepForge from Chocolatey, so
  ; "choco upgrade" does not bring it back. Not for upgrades (--updated), silent
  ; uninstalls, or when Chocolatey itself is uninstalling the package. It runs
  ; only if Chocolatey has StepForge registered, found through the machine-wide
  ; ChocolateyInstall variable that only administrators can set, so there is
  ; no UAC prompt for everyone else. The helper is embedded in the uninstaller,
  ; not kept on disk where it could be swapped.
  !macro customUnInstall
    StrCpy $0 "true"
    ${If} ${Silent}
    ${OrIf} ${isUpdated}
      StrCpy $0 "false"
    ${EndIf}
    ReadEnvStr $1 ChocolateyPackageName
    ${If} $1 != ""
      StrCpy $0 "false"
    ${EndIf}
    ReadEnvStr $1 ChocolateyPackageFolder
    ${If} $1 != ""
      StrCpy $0 "false"
    ${EndIf}
    ReadEnvStr $1 ChocolateyPackageVersion
    ${If} $1 != ""
      StrCpy $0 "false"
    ${EndIf}

    ReadRegStr $1 HKLM "SYSTEM\CurrentControlSet\Control\Session Manager\Environment" ChocolateyInstall
    ${If} $0 == "true"
    ${AndIf} $1 != ""
    ${AndIf} ${FileExists} "$1\lib\stepforge\stepforge.nuspec"
      DetailPrint "Removing StepForge from Chocolatey..."
      InitPluginsDir
      File "/oname=$PLUGINSDIR\chocolatey-setup.ps1" "${PROJECT_DIR}\packaging\windows\chocolatey-setup.ps1"
      Delete "$PLUGINSDIR\chocolatey-setup.result"
      StrCpy $1 '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "$PLUGINSDIR\chocolatey-setup.ps1" -Uninstall -ResultFile "$PLUGINSDIR\chocolatey-setup.result"'
      !insertmacro StepForgeRunChocoHelper $1
      ${If} $3 != "ok"
        DetailPrint "StepForge is still registered with Chocolatey. See $4"
      ${EndIf}
    ${EndIf}
  !macroend
!endif
