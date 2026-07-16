Unicode true

!include "MUI2.nsh"

!define PRODUCT_NAME "苜芬绘图AI"
!define PRODUCT_VERSION "0.1.0"
!define PRODUCT_EXE "苜芬绘图AI.exe"
!define UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\苜芬绘图AI"

Name "${PRODUCT_NAME}"
OutFile "${__FILEDIR__}\..\release\Mufen-Image-AI-Setup-${PRODUCT_VERSION}.exe"
InstallDir "$LOCALAPPDATA\Programs\${PRODUCT_NAME}"
InstallDirRegKey HKCU "Software\苜芬绘图AI" "InstallDir"
RequestExecutionLevel user
SetCompressor /SOLID lzma
ShowInstDetails show
ShowUninstDetails show

!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_RUN "$INSTDIR\${PRODUCT_EXE}"

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "SimpChinese"

Section "安装" MainSection
  SetOutPath "$INSTDIR"
  File /r "${__FILEDIR__}\..\release\win-unpacked\*.*"

  WriteRegStr HKCU "Software\苜芬绘图AI" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayName" "${PRODUCT_NAME}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayVersion" "${PRODUCT_VERSION}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayIcon" "$INSTDIR\${PRODUCT_EXE}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "UninstallString" '$INSTDIR\卸载.exe'
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoRepair" 1

  WriteUninstaller "$INSTDIR\卸载.exe"
  CreateShortCut "$DESKTOP\${PRODUCT_NAME}.lnk" "$INSTDIR\${PRODUCT_EXE}"
  CreateDirectory "$SMPROGRAMS\${PRODUCT_NAME}"
  CreateShortCut "$SMPROGRAMS\${PRODUCT_NAME}\${PRODUCT_NAME}.lnk" "$INSTDIR\${PRODUCT_EXE}"
  CreateShortCut "$SMPROGRAMS\${PRODUCT_NAME}\卸载.lnk" "$INSTDIR\卸载.exe"
SectionEnd

Section "Uninstall"
  Delete "$DESKTOP\${PRODUCT_NAME}.lnk"
  RMDir /r "$SMPROGRAMS\${PRODUCT_NAME}"
  DeleteRegKey HKCU "${UNINSTALL_KEY}"
  DeleteRegKey HKCU "Software\苜芬绘图AI"
  RMDir /r "$INSTDIR"
SectionEnd

