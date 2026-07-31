# DarkTavern

Dark and Darker 中文实时查价工具。鼠标悬停游戏内物品、按下扫描键，即在物品提示框旁浮出**像素级还原原版样式**的价格面板（中文物品名 + 属性 + 市场价 / 商人价 / 每格价值）。

> 本项目 fork 自 [GrimVault-Chinese-Edition](https://github.com/Songyt1110/GrimVault-Chinese-Edition)（其上游为 [DarkerDB/GrimVault](https://github.com/DarkerDB/GrimVault)）。
> 与原版最大的不同：**彻底移除 C++ 原生模块**，截图 / 提示框检测 / 中文 OCR / 窗口跟踪全部由 **Python 后端**接管；并新增启动**主页**（实时显示 OCR / 游戏窗口 / 热键 / API 状态）。

## 它怎么工作

```
鼠标悬停物品 + 按扫描键
        │
        ▼
Python 后端 (chinese/ocr-service, 本地 HTTP :19528)
   截图(mss) → 提示框检测(YOLO DNN) → 中文OCR(RapidOCR) → 中→英翻译 → DarkerDB 查价
        │
        ▼
Electron 壳：透明悬浮窗贴在游戏上，渲染原版样式 tooltip
```

全程**只读屏幕**，不注入 DLL、不读游戏内存。

## 功能

- **中文 OCR 查价** — RapidOCR (PP-OCRv4 + ONNX Runtime) 识别游戏内中文
- **980+ 词条翻译** — 物品 / 属性 / 术语自动中译英
- **实时价格** — 市场价 / 商人价 / 每格价值（经 DarkerDB API）
- **游戏内悬浮窗** — 价格信息直接叠在游戏画面上，样式像素级还原原版
- **稀有度配色** — 物品名按稀有度着色（灰 / 白 / 绿 / 蓝 / 紫 / 橙 / 金 / 红）
- **启动主页** — 暗酒馆主题，左栏实时状态符文（OCR / 游戏窗口 / 热键 / API），后端在后台加载、就绪自动点亮
- **词条编辑器** — 内置查看 / 增删改翻译词条
- **自定义热键** — 任意键盘键或鼠标侧键作扫描触发
- **系统托盘** — 关闭主页窗口不退程序，退回后台继续运行

## 快捷键

| 按键 | 功能 |
|------|------|
| 鼠标侧键（默认 XButton1） | 扫描当前悬停物品的价格 |
| F5 | 设置（API Key、扫描键、扫描模式） |
| F6 | 词条编辑器 |
| F7 | 调试模式 |
| F8 | 清除悬浮窗 |

## 环境准备

前置：**Node.js 20+**、**Python 3.11**。

```powershell
# 1. 前端 + Electron 依赖
npm install

# 2. 建 Python 虚拟环境并装后端依赖
#    （若当前终端激活着别的 venv，先 deactivate，确保用全局 Python 3.11 建环境）
py -3.11 -m venv ocr_env
ocr_env\Scripts\python -m pip install -r requirements.txt
#    国内网络慢可加清华源：
#    ocr_env\Scripts\python -m pip install -r requirements.txt -i https://pypi.tuna.tsinghua.edu.cn/simple
```

> **为什么必须是 `ocr_env` 这个名字？** Electron 启动时**自动优先**调用 `ocr_env\Scripts\python.exe` 来跑后端（见 `src/chinese/index.js`）。这样无论你 shell 里激活着哪个 venv，DarkTavern 都用自己的环境，**不会**因为缺 `fastapi` 等包而卡住。所以**不需要手动激活** ocr_env，建好即可。

> **模型文件** `models/tooltip.onnx` 已随仓库提供，无需另行下载。

## 运行

```powershell
# 方式一：双击根目录的 启动.bat
# 方式二：命令行
npx electron .
```

启动后先弹出**主页**；左栏「OCR 侍者」会在后端加载完模型后（约数秒）由灰转金点亮。打开游戏、悬停物品、按扫描键即可查价。

> 挂代理 / VPN 时，程序已内置让本地后端（`127.0.0.1`）直连、不走代理。若你用的是 TUN / 全局增强模式仍出现主页 OCR 状态卡在「正在唤醒」，临时关闭代理再启动一次即可。

## 配置

按 **F5** 打开设置：

- **DarkerDB API Key** — 在 [darkerdb.com](https://darkerdb.com/) 注册获取。不填也能识别物品名与属性，**填了才有价格数据**。
- **扫描触发键** — 点击录入框后按下新键（支持 F1–F12、Ctrl 组合键、鼠标侧键）。
- **扫描模式** — 手动（按键触发）/ 自动（悬停触发）。

## 项目结构

```
DarkTavern/
├── src/                    # Electron 主进程（壳：窗口 / 托盘 / 热键 / IPC）
│   ├── main.js             # 入口，启动主页 / 设置 / 拉起 Python 后端
│   ├── native.js           # 适配层：把原 C++ 接口转为调用 Python 后端
│   └── chinese/index.js    # 管理 Python 后端进程生命周期
├── chinese/ocr-service/    # Python 后端（截图 / 检测 / OCR / 翻译 / 查价 / 窗口跟踪）
│   └── server.py           # 本地 HTTP 服务 :19528
├── chinese/mapping/        # 中→英翻译词条表
├── ui/overlay/             # 悬浮窗前端（Vue 3 + Tailwind，原版样式）
├── home.html               # 启动主页
├── assets/                 # 悬浮窗纹理 / 字体 / 图标
├── models/tooltip.onnx     # 提示框检测模型
├── ocr_env/                # Python 虚拟环境（git 忽略，需自建）
├── requirements.txt        # Python 后端依赖
├── 启动.bat                # 双击启动
└── package.json            # 前端 / Electron 依赖
```

## 技术栈

| 组件 | 技术 |
|------|------|
| 桌面壳 | Electron 33 |
| 悬浮窗 UI | Vue 3 + Tailwind CSS |
| 截图 | mss |
| 提示框检测 | YOLO DNN（tooltip.onnx，OpenCV dnn） |
| 中文 OCR | RapidOCR + ONNX Runtime（PP-OCRv4） |
| 后端服务 | Python + FastAPI（本地 HTTP） |
| 查价 API | DarkerDB |

## 从源码打包（可选）

```powershell
npx vite build                 # 编译悬浮窗前端
npx electron-builder --win     # 打包为安装程序
```

## 致谢

- [DarkerDB](https://darkerdb.com/) — 原版 GrimVault 与查价 API
- [Songyt1110](https://github.com/Songyt1110/GrimVault-Chinese-Edition) — GrimVault 中文版（本项目直接 fork 源）
- [Ironmace](https://www.ironmace.com/) — Dark and Darker
- [RapidOCR](https://github.com/RapidAI/RapidOCR) — OCR 引擎
- [PaddleOCR](https://github.com/PaddlePaddle/PaddleOCR) — PP-OCRv4 模型
- [NFU Database](https://dnd.nfuwow.com/) — 中文物品翻译
- [Dark and Darker Wiki](https://dnd.wiki/) — Dark and Darker Adventurer's Tavern

## License

MIT License.

```
Copyright (c) 2025 DarkerDB (Original GrimVault)
Copyright (c) 2026 GrimVault Chinese Edition Contributors
Copyright (c) 2026 DarkTavern
```
