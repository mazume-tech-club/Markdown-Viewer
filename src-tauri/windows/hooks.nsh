; Tauri の NSIS インストーラに差し込むフック（tauri.conf.json の bundle.windows.nsis.installerHooks）

; インストール先を変えて入れ直したとき、前のインストール先を片付ける（Issue #2）。
; 片付けないと古い exe や uninstall.exe とフォルダが取り残され、アンインストール情報とも食い違う。
; - 前の場所にアプリが残っていれば、前のアンインストーラを静かに実行する（アプリのデータは残す）
; - 再インストール画面の「アンインストール」で消しきれなかった uninstall.exe とフォルダも消す
;   （_?= 付きで実行されたアンインストーラは自分自身を消せないため）
!macro NSIS_HOOK_PREINSTALL
  ; 前回のインストール先（この直後の Install セクションで新しい値に上書きされる）
  ReadRegStr $R9 SHCTX "${MANUPRODUCTKEY}" ""
  ${If} $R9 != ""
  ${AndIf} $R9 != $INSTDIR
    ${If} ${FileExists} "$R9\${MAINBINARYNAME}.exe"
    ${OrIf} ${FileExists} "$R9\uninstall.exe"
      DetailPrint "前のインストール先を削除しています: $R9"
      ${If} ${FileExists} "$R9\${MAINBINARYNAME}.exe"
        ; 前の場所のアプリが起動していたら、黙って終了させずに確認する（キャンセルでインストールを中止）
        !insertmacro CheckIfAppIsRunning "$R9\${MAINBINARYNAME}.exe" "${PRODUCTNAME}"
        ${If} ${FileExists} "$R9\uninstall.exe"
          ExecWait '"$R9\uninstall.exe" /S _?=$R9'
        ${Else}
          Delete "$R9\${MAINBINARYNAME}.exe"
        ${EndIf}
      ${EndIf}
      ; 終了直後はウイルス対策ソフトなどがまだ掴んでいることがあるので、少し待ちながら数回試す
      StrCpy $R7 0
      ${Do}
        Delete "$R9\uninstall.exe"
        ${IfNot} ${FileExists} "$R9\uninstall.exe"
          ${Break}
        ${EndIf}
        Sleep 500
        IntOp $R7 $R7 + 1
      ${LoopUntil} $R7 >= 10
      RMDir "$R9"
    ${EndIf}
  ${EndIf}
!macroend

; エクスプローラーの右クリックメニューに「MDプレビューで開く」を出す。
; 既定のアプリ（関連付け）とは別の SystemFileAssociations に登録するので、
; .md を VS Code など別のアプリに関連付けていても表示される。
; Windows 11 では「その他のオプションを確認」（Shift+F10）の中に表示される。
!define CONTEXT_MENU_KEY "MarkdownPreview.Open"

!macro WriteContextMenu EXT
  WriteRegStr SHCTX "Software\Classes\SystemFileAssociations\.${EXT}\shell\${CONTEXT_MENU_KEY}" "" "MDプレビューで開く"
  WriteRegStr SHCTX "Software\Classes\SystemFileAssociations\.${EXT}\shell\${CONTEXT_MENU_KEY}" "Icon" '"$INSTDIR\${MAINBINARYNAME}.exe",0'
  WriteRegStr SHCTX "Software\Classes\SystemFileAssociations\.${EXT}\shell\${CONTEXT_MENU_KEY}\command" "" '"$INSTDIR\${MAINBINARYNAME}.exe" "%1"'
!macroend

!macro DeleteContextMenu EXT
  DeleteRegKey SHCTX "Software\Classes\SystemFileAssociations\.${EXT}\shell\${CONTEXT_MENU_KEY}"
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; .md ファイルにアプリと別のアイコン（資料の形）を付ける（Issue #4）。
  ; 標準のファイル関連付けはアイコンをアプリの exe に固定するので、関連付けの後で上書きする。
  ; アイコンは bundle.resources で $INSTDIR に置き、アンインストール時は関連付けと一緒に消える
  WriteRegStr SHCTX "Software\Classes\Markdown\DefaultIcon" "" "$INSTDIR\md-document.ico"
  !insertmacro UPDATEFILEASSOC

  ; 右クリックメニュー（拡張子は tauri.conf.json の bundle.fileAssociations と揃える）
  !insertmacro WriteContextMenu "md"
  !insertmacro WriteContextMenu "markdown"
  !insertmacro WriteContextMenu "mdown"
  !insertmacro WriteContextMenu "mkd"
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  !insertmacro DeleteContextMenu "md"
  !insertmacro DeleteContextMenu "markdown"
  !insertmacro DeleteContextMenu "mdown"
  !insertmacro DeleteContextMenu "mkd"
!macroend
