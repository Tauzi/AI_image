# 苜芬绘图AI

本地优先的 AI 生图桌面工作台，面向参考图驱动和批量生成场景。

## 本地开发

```powershell
npm install
npm run dev
```

## 构建

```powershell
npm run build
npm run package:win
```

安装包输出到 `release/`。应用数据默认由 Electron 保存在当前 Windows 用户的 `AppData/Roaming/苜芬绘图AI/` 下。

详细范围与验收标准见 [docs/requirements.md](docs/requirements.md)。
