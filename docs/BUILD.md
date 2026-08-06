# 打包与发布说明

## 产物

| 文件 | 说明 |
|------|------|
| `release\AdventurersSquire Setup <版本>.exe` | NSIS 安装包（含全部依赖） |
| `release\AdventurersSquire-<版本>-win.zip` | 免安装压缩包，解压即用 |
| `release\win-unpacked\` | 免安装版解压目录（打包中间产物） |

两个产物均内置：
- OCR 服务（`resources\chinese\ocr-service\ocr-service.exe`，PyInstaller 打包）
- 词条映射（`resources\chinese\mapping\`）
- 识别模型（`native\models\`，tooltip.onnx + PaddleOCR）
- **便携版 Wireshark 4.6.7**（`resources\wireshark\`，含 tshark/dumpcap 全组件）——用户无需自行安装 Wireshark，软件启动时自动检测该路径（优先于 PATH 与全盘扫描）

## 打包流程（两步，缺一不可）

### 第 1 步：打包 OCR 服务（PyInstaller）

```
cd chinese/ocr-service
build.bat
```

- 依赖 `ocr_env`（Python 3.11 虚拟环境），缺失时按脚本提示先建
- 产物：`chinese\ocr-service\dist\ocr-service\ocr-service.exe`
- **改过 Python 代码后必须重跑此步**，否则安装包里是旧版 OCR 服务

### 第 2 步：打包桌面应用（vite + electron-builder）

```
npm run build
```

- 同时产出 NSIS 安装包与 zip 压缩包
- 版本号在 `package.json` 的 `version` 字段，打包前先改
- 打包配置：`electron-builder.yml`（extraFiles 决定 ocr-service / mapping / models / wireshark 进包路径）

## 压缩包使用说明（免安装版）

1. 解压 `AdventurersSquire-<版本>-win.zip` 到任意目录（建议英文路径）
2. 双击 `AdventurersSquire.exe` 运行
3. Wireshark 已内置在 `resources\wireshark\`，无需安装；软件自动识别
4. 首次使用按「角色仓库」页「首次校准」一键完成环境准备
5. 更新版本时：退出旧版 → 解压新版覆盖（或删除旧目录后重新解压）

## 发布前检查清单

- [ ] `package.json` 版本号已更新
- [ ] Python 代码改动后已重跑 `build.bat`
- [ ] 前端/Electron 改动后已跑 `npm run build`
- [ ] 两个产物（exe + zip）均已生成
