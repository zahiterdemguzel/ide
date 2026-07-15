; Custom NSIS uninstall hook (electron-builder nsis.include). The embedded Ollama
; engine keeps its downloaded model files under the app's roaming data dir; remove
; them when the app is uninstalled so multi-GB models don't linger. Stop any
; running engine first (serve spawns model-runner children — /T kills the tree),
; then delete only the ollama subdir (user settings/sessions are left intact, which
; is why deleteAppDataOnUninstall stays false).
!macro customUnInstall
  nsExec::Exec 'taskkill /IM ollama.exe /T /F'
  RMDir /r "$APPDATA\${PRODUCT_NAME}\ollama"
!macroend
