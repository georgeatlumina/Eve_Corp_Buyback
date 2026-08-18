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
!macroend

!macro customUnInstall
  nsExec::Exec 'taskkill /F /T /IM sidecar.exe'
!macroend
