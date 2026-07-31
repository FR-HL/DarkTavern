**中文 | [English](README.md)**

# GrimVault 中文版

[GrimVault](https://github.com/DarkerDB/GrimVault) 的中文扩展版，为《Dark and Darker》提供实时物品价格查询，完整支持中文游戏界面。

## 快速上手

1. 从 [Releases](../../releases) 下载安装包
2. 运行安装程序，按提示安装
3. 启动 GrimVault 中文版
4. 打开《Dark and Darker》（中文语言）
5. 鼠标悬停在物品上，按 **鼠标侧键** 查看价格
6. 按 **F5** 设置 API Key 和自定义按键

> 在 [DarkerDB.com](https://darkerdb.com/) 免费注册获取 API Key，可获得完整的价格数据。

## 功能特性

- **中文 OCR 识别** — 使用 RapidOCR（PP-OCRv4 + ONNX Runtime）识别游戏内中文文字
- **960+ 翻译词条** — 物品名称、属性词条、游戏术语自动中英翻译
- **实时查价** — 通过 DarkerDB API 获取市场价、商人价、每格价值
- **游戏内叠加显示** — 价格信息直接显示在游戏画面上
- **稀有度颜色** — 物品名称按稀有度着色（灰/白/绿/蓝/紫/金/暗金/红）
- **词条编辑器** — 内置编辑器（F6）可查看和修改翻译词条
- **自定义按键** — 支持所有键盘按键和鼠标按键作为扫描触发键
- **安全无风险** — 仅使用屏幕截图识别，不注入 DLL，不读取内存

## 快捷键

| 按键 | 功能 |
|------|------|
| 鼠标侧键（默认） | 扫描物品价格 |
| F5 | 设置（API Key、按键绑定、扫描模式） |
| F6 | 中英文翻译词条编辑器 |
| F7 | 调试模式 |
| F8 | 清除叠加显示 |

## 工作原理

```
屏幕截图 → DNN 提示框检测 → 中文 OCR 识别 → 翻译映射 → DarkerDB API 查价 → 叠加显示
```

采用与原版 GrimVault 相同的屏幕截图方式，不注入 DLL，不读取游戏内存，完全安全。

## 从源码构建

<details>
<summary>点击展开构建步骤</summary>

### 环境要求

- Node.js 20+
- Python 3.11
- Visual Studio 2022+（需要 C++ 桌面开发工作负载）
- [vcpkg](https://github.com/microsoft/vcpkg)

### 构建步骤

```bash
# 1. 安装 C++ 依赖
vcpkg install cppwinrt:x64-windows directxtex:x64-windows directxtk:x64-windows opencv:x64-windows onnxruntime:x64-windows
git clone https://github.com/smasherprog/screen_capture_lite.git vendor/screen_capture_lite

# 2. 安装 Node.js 依赖
npm install --ignore-scripts

# 3. 构建 UI
npx vite build

# 4. 编译原生模块
node build-gyp.js

# 5. 配置 Python OCR 环境
py -3.11 -m venv ocr_env
ocr_env\Scripts\pip install rapidocr-onnxruntime flask mss numpy opencv-python pywin32

# 6. 打包 OCR 服务为 exe
cd chinese/ocr-service
..\..\ocr_env\Scripts\pyinstaller --noconfirm --onedir --name ocr-service ^
    --collect-all rapidocr_onnxruntime --collect-all onnxruntime --collect-all cv2 ^
    --hidden-import=win32gui --hidden-import=win32api --hidden-import=win32con ^
    --hidden-import=pywintypes --hidden-import=mss --hidden-import=flask --hidden-import=numpy ^
    server.py
cd ../..

# 7. 打包安装程序
npx electron-builder --win --config.npmRebuild=false
```

</details>

## 技术栈

| 组件 | 技术 |
|------|------|
| 桌面框架 | Electron 33 |
| 原生模块 | C++（OpenCV、ONNX Runtime、WGC） |
| 中文 OCR | RapidOCR + ONNX Runtime（PP-OCRv4 模型） |
| 提示框检测 | YOLO DNN（tooltip.onnx） |
| UI | Vue 3 + Tailwind CSS |
| 价格 API | DarkerDB |

## 许可证

本项目是 [GrimVault](https://github.com/DarkerDB/GrimVault)（DarkerDB 开发）的中文分支，采用 MIT 许可证。

```
Copyright (c) 2025 DarkerDB（原版 GrimVault）
Copyright (c) 2026 GrimVault Chinese Edition Contributors
```

## 致谢

- [DarkerDB](https://darkerdb.com/) — 原版 GrimVault 和物品价格 API
- [Ironmace](https://www.ironmace.com/) — 《Dark and Darker》游戏开发商
- [RapidOCR](https://github.com/RapidAI/RapidOCR) — OCR 识别引擎
- [PaddleOCR](https://github.com/PaddlePaddle/PaddleOCR) — PP-OCRv4 训练模型
- [NFU Database](https://dnd.nfuwow.com/) — 中文物品名称数据库
- [Dark and Darker Wiki](https://dnd.wiki/) — Dark and Darker 冒险者酒馆
