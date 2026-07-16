; Custom NSIS uninstall hook (electron-builder nsis.include). The local-model
; engine (node-llama-cpp) keeps its downloaded GGUF files under the app's roaming
; data dir; remove them on uninstall so multi-GB models don't linger. There's no
; external engine process anymore (models run in-process), so nothing to kill —
; just delete the `llama` subdir (user settings/sessions are left intact, which is
; why deleteAppDataOnUninstall stays false).
!macro customUnInstall
  RMDir /r "$APPDATA\${PRODUCT_NAME}\llama"
!macroend
