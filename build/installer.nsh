; Custom NSIS hooks — auto-included by electron-builder as build/installer.nsh.
;
; The Python sidecar runs as a SEPARATE process (sidecar.exe) from the main app,
; so electron-builder's built-in "close the running app before installing" logic
; does not stop it. If it is still running during an (auto-)update, Windows cannot
; overwrite the locked sidecar.exe, and the install silently keeps the OLD sidecar
; — e.g. one bound to the previous port — next to the NEW renderer, which then
; can't reach its backend. Kill the whole sidecar process tree before installing
; (and on uninstall) so every file, including the sidecar, is always replaced.
; /F = force, /T = kill child processes too, /IM = match by image name.

!macro customInit
  nsExec::Exec 'taskkill /F /T /IM sidecar.exe'
!macroend

!macro customInstall
  nsExec::Exec 'taskkill /F /T /IM sidecar.exe'

  ; --- Desktop shortcut policy -------------------------------------------------
  ; electron-builder's own desktop-shortcut creation is disabled (nsis.
  ; createDesktopShortcut = false); we manage it here so it is created on the
  ; FIRST install only and NEVER recreated on an update. That way, deleting the
  ; desktop icon to keep the desktop tidy sticks — an update won't bring it back.
  ; (The Start-menu shortcut is always created/kept by electron-builder.)
  Push $0
  ReadRegStr $0 HKCU "Software\NDA-Management-Tool" "DesktopShortcutInit"
  ${If} $0 != "1"
    CreateShortcut "$DESKTOP\${PRODUCT_FILENAME}.lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
    WriteRegStr HKCU "Software\NDA-Management-Tool" "DesktopShortcutInit" "1"
  ${EndIf}
  Pop $0
!macroend

!macro customUnInstall
  nsExec::Exec 'taskkill /F /T /IM sidecar.exe'
  Delete "$DESKTOP\${PRODUCT_FILENAME}.lnk"
  DeleteRegKey HKCU "Software\NDA-Management-Tool"
!macroend
