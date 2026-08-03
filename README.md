# DarkTavern

Dark and Darker 中文实时查价 + 仓库整理工具。鼠标悬停游戏内物品、按下扫描键，即在物品提示框旁浮出**像素级还原原版样式**的价格面板（中文物品名 + 属性 + 市场价 / 商人价 / 每格价值）；另可通过网络抓包可视化各角色的仓库与背包，并一键自动整理。

> 本项目 fork 自 [GrimVault-Chinese-Edition](https://github.com/Songyt1110/GrimVault-Chinese-Edition)（其上游为 [DarkerDB/GrimVault](https://github.com/DarkerDB/GrimVault)）。
> 与原版最大的不同：**彻底移除 C++ 原生模块**，截图 / 提示框检测 / 中文 OCR / 窗口跟踪 / 仓库抓包与整理全部由 **Python 后端**接管；并新增启动**主页**（实时显示 OCR / 游戏窗口 / 热键 / API 状态）。

## 它怎么工作

```
【查价】鼠标悬停物品 + 按扫描键
        │
        ▼
Python 后端 (chinese/ocr-service, 本地 HTTP :19528)
   截图(mss) → 提示框检测(YOLO DNN) → 行分割+中文识别(RapidOCR, 行级并行) → 中→英翻译 → DarkerDB 查价
        │
        ▼
Electron 壳：透明悬浮窗贴在游戏上，渲染原版样式 tooltip

【仓库工具】游戏内打开仓库后
        │
        ▼
Python 后端 (chinese/ocr-service, 本地 HTTP :19528)
   网络抓包(tshark) → protobuf 解码 → 仓库 / 背包数据可视化（角色仓库页）
        │
        ▼
   选择预设一键整理：排序算法生成摆放方案 → 模拟鼠标拖放（pyautogui）
```

**全程不注入 DLL、不读游戏内存**：查价只读屏幕，仓库工具只解析游戏网络数据包。

## 功能

### 查价
- **中文 OCR 查价** — 像素行分割 + RapidOCR 识别（ONNX Runtime，无文本检测模型），多行并行识别
- **重复扫描缓存** — 提示框画面未变时跳过检测与识别；查价结果缓存 60s，同物品不重复请求
- **980+ 词条翻译** — 物品 / 属性 / 术语自动中译英
- **实时价格** — 市场价 / 商人价 / 每格价值（经 DarkerDB API）
- **查价记录** — 最近 3 天的查询历史自动保存，价格数据完整记录

### 悬浮窗
- **游戏内悬浮窗** — 价格信息直接叠在游戏画面上，样式像素级还原原版
- **稀有度配色** — 物品名按稀有度着色（灰 / 白 / 绿 / 蓝 / 紫 / 橙 / 金 / 红）
- **桌面悬浮球** — 可拖动 / 锁定的小球，实时显示查价与整理状态（Ctrl+Alt+B 锁定）

### 仓库工具
- **角色仓库** — 抓包可视化各职业角色的仓库与背包
- **一键自动整理** — 三种预设（默认整理 / 品质区分 / 装备优先），自动生成摆放方案并模拟鼠标整理
- **智能排序** — 同名同款分组相邻、大件优先、溢出整组不打散、可选先合并可堆叠物品
- **整理预览** — 开始前预览生成方案，可随时 Ctrl+F12 中断

### 启动主页
- **暗酒馆主题** — 左栏实时状态符文（OCR / 游戏窗口 / 热键 / API），后端在后台加载、就绪自动点亮
- 页面：概览 / 查价器 / 查价记录 / 角色仓库 / 仓库配置 / 设置 / 关于酒馆 / 赞助酒馆

### 其他
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
| Ctrl+F11 | 开始整理（仓库自动整理，需先配置目标） |
| Ctrl+F12 | 取消整理 |
| Ctrl+Alt+B | 锁定 / 解锁悬浮球 |

## 环境准备

前置：**Node.js 20+**、**Python 3.11**、**Wireshark**（仓库抓包需要其附带的 `tshark`，安装时勾选 "Add tshark to PATH"；查价功能不依赖）。

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

> **为什么必须是 `ocr_env` 这个名字？** Electron 启动时**自动优先**调用 `ocr_env\Scripts\python.exe` 来跑后端（见 `electron/backend.js`）。这样无论你 shell 里激活着哪个 venv，DarkTavern 都用自己的环境，**不会**因为缺 `fastapi` 等包而卡住。所以**不需要手动激活** ocr_env，建好即可。

> **模型文件** `models/tooltip.onnx`（提示框检测）与 `models/paddle/ch/rec.onnx` + `dict.txt`（回退用 Paddle 识别模型）已随仓库提供，无需另行下载；主用识别模型由 `rapidocr-onnxruntime` 包自带。

## 运行

```powershell
# 方式一：双击根目录的 启动.bat
# 方式二：命令行
npx electron .
```

启动后先弹出**主页**；左栏「OCR 侍者」会在后端加载完模型后（约数秒）由灰转金点亮。打开游戏、悬停物品、按扫描键即可查价。

> 挂代理 / VPN 时，程序已内置让本地后端（`127.0.0.1`）直连、不走代理。若你用的是 TUN / 全局增强模式仍出现主页 OCR 状态卡在「正在唤醒」，临时关闭代理再启动一次即可。

## 使用提示

- **查价**：游戏内悬停物品 → 按扫描键（默认鼠标侧键），价格面板浮出。
- **仓库整理**：先在游戏中打开要整理的仓库界面（能看到物品格子），在「仓库配置」页选择角色与目标仓库，再按 Ctrl+F11。整理期间保持游戏窗口在前台。
- **管理员权限**：若游戏以管理员权限运行，DarkTavern 也需以管理员身份运行（右键 → 以管理员身份运行），否则 Windows 会拦截整理时的鼠标操作。

## 配置

按 **F5** 打开设置：

- **DarkerDB API Key** — 在 [darkerdb.com](https://darkerdb.com/) 注册获取。不填也能识别物品名与属性，**填了才有价格数据**。
- **扫描触发键** — 点击录入框后按下新键（支持 F1–F12、Ctrl 组合键、鼠标侧键）。
- **扫描模式** — 手动（按键触发）/ 自动（悬停触发）。

## 项目结构

```
DarkTavern/
├── electron/                 # Electron 主进程（壳：窗口 / 托盘 / 热键 / IPC / 后端调用）
│   ├── main.js               # 入口：窗口 / 托盘 / 热键 / 设置 IPC
│   ├── backend.js            # 拉起 Python 后端 + 所有 :19528 HTTP 调用
│   ├── scan.js               # 查价流水线：OCR → 查价 → 渲染进程
│   ├── overlay.js            # 轮询游戏窗口，定位透明悬浮窗
│   ├── settings.js           # 读写 settings.ini（userData）
│   ├── logger.js             # winston 日志
│   ├── config.js             # 路径常量
│   └── preload.cjs           # 渲染进程 IPC 桥
├── src/                      # 前端（Vue 3 + Vite + Tailwind）
│   ├── home/                 # 启动主页（概览 / 查价 / 记录 / 仓库 / 整理 / 设置 / 关于）
│   ├── overlay/              # 游戏内悬浮窗
│   ├── ball/                 # 桌面悬浮状态球
│   └── shared/               # 共享样式与工具库（稀有度 / 职业 / 模式等）
├── chinese/ocr-service/      # Python 后端（查价 + 仓库工具）
│   ├── server.py             # 本地 HTTP 服务 :19528（含扫描缓存）
│   ├── ocr_engine_hybrid.py  # 像素行分割 + RapidOCR v4 rec（行级并行，主用）
│   ├── ocr_engine_rapid.py   # 备选引擎（整图识别）
│   ├── ocr_engine.py         # 旧 Paddle rec 引擎（回退保留）
│   ├── detect.py             # 提示框检测（YOLO DNN）
│   ├── capture.py            # 游戏窗口截图（mss）
│   ├── translator.py         # 中→英词条翻译
│   └── dnd/                  # 仓库工具
│       ├── capture/          # 游戏网络抓包（pyshark）
│       ├── sort/             # 排序算法与整理执行（pyautogui）
│       ├── stash/            # 仓库 / 背包数据模型
│       ├── items/            # 物品数据与图标
│       └── routers/          # /capture /stash /sort /packet 路由
├── chinese/mapping/          # 中→英翻译词条表
├── assets/                   # 物品图标 / 字体 / 纹理 / items.json
├── models/tooltip.onnx       # 提示框检测模型
├── models/paddle/ch/         # 旧 Paddle rec 模型（回退用）
├── ocr_env/                  # Python 虚拟环境（git 忽略，需自建）
├── requirements.txt          # Python 后端依赖
├── 启动.bat                  # 双击启动
└── package.json              # 前端 / Electron 依赖
```

## 技术栈

| 组件 | 技术 |
|------|------|
| 桌面壳 | Electron 33 |
| 主页 / 悬浮窗 / 悬浮球 | Vue 3 + Vite + Tailwind CSS |
| 截图 | mss |
| 提示框检测 | YOLO DNN（tooltip.onnx，OpenCV dnn） |
| 中文 OCR | 像素行分割 + RapidOCR（PP-OCRv4 rec，行级并行，无检测模型） |
| 仓库数据 | 游戏网络抓包（pyshark + tshark，protobuf 解码） |
| 自动整理 | 鼠标模拟（pyautogui）+ 排序算法 |
| 后端服务 | Python + FastAPI（本地 HTTP） |
| 查价 API | DarkerDB |

## 从源码打包（可选）

```powershell
npx vite build                 # 编译前端
npx electron-builder --win     # 打包为安装程序
```

## 使用声明

- **仅供个人学习与娱乐**：本工具与本作《Dark and Darker》无官方关联，也不支持作弊（不注入、不读内存）。游戏内的使用合规性请自行判断。
- **禁止转卖**：禁止将本软件（或其修改版、构建产物）作为商品二次销售、捆绑销售或任何形式收费。发现倒卖/滥用，请在 [GitHub Issues](https://github.com/FR-HL/DarkTavern/issues) 举报。
- **商标**：「DarkTavern」名称与图标为本项目品牌标识，不得用于任何衍生品或商业产品，详见 [LICENSE](LICENSE) 附加条款。
- **免责声明**：本项目按 MIT 许可证「AS IS」提供，作者不对任何使用后果负责。

## 致谢

- [DarkerDB](https://darkerdb.com/) — 原版 GrimVault 与查价 API
- [GrimVault-Chinese-Edition](https://github.com/Songyt1110/GrimVault-Chinese-Edition) — GrimVault 开源中文版（本项目 fork 源，已完整重写）
- [DarkerDB/GrimVault](https://github.com/DarkerDB/GrimVault) — 行分割 + 单行识别算法移植来源
- [Ironmace](https://www.ironmace.com/) — Dark and Darker
- [RapidOCR](https://github.com/RapidAI/RapidOCR) — OCR 识别引擎
- [PaddleOCR](https://github.com/PaddlePaddle/PaddleOCR) — PP-OCR 识别模型
- [NFU Database](https://dnd.nfuwow.com/) — 中文物品翻译
- [Dark and Darker Wiki](https://dnd.wiki/) — Dark and Darker Adventurer's Tavern

## License

MIT License.

```
Copyright (c) 2025 DarkerDB (Original GrimVault)
Copyright (c) 2026 GrimVault Chinese Edition Contributors
Copyright (c) 2026 DarkTavern
```
