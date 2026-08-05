# 贡献指南

感谢有兴趣参与 DarkTavern！动手前请先读 [README](README.md) 与 [VISION.md](VISION.md)（项目北极星，新功能先对照它再动手）。

## 开发环境

1. 按 README「环境准备」装好 Node.js 20+ / Python 3.11 / Wireshark（可选）
2. `npm install`
3. `py -3.11 -m venv ocr_env && ocr_env\Scripts\python -m pip install -r requirements.txt`
4. 启动开发：
   - `npm run dev`（普通权限，仅查价）
   - `dev-admin.bat`（管理员权限，调试仓库整理必需——游戏以管理员运行时 Windows 会拦截低权限进程的鼠标模拟）

## 代码结构

见 README「项目结构」。三层分工：

- `electron/` — 壳：窗口 / 托盘 / 热键 / IPC / 后端进程管理
- `src/` — Vue 3 前端（home 主页 / overlay 悬浮窗 / ball 悬浮球）
- `chinese/ocr-service/` — Python 后端（FastAPI :19528），查价 OCR 与仓库工具（`dnd/`）

原则（摘自 VISION.md）：

- **后端纯 Python，壳只做壳的事**
- **只读屏幕、只解析网络包**：不注入 DLL、不读游戏内存
- 每一格演进都必须是完整可运行的软件，不预搭空架子

## 提交规范

- 提交信息用中文，直接描述做了什么（参考现有 git log 风格）
- 一个提交做一件事；修复类提交说明根因
- 不要提交：密钥 / 个人路径 / `ocr_env` / 构建产物 / 日志（`.gitignore` 已覆盖大部分）
- 涉及 UI 的改动请保持暗酒馆主题风格，参考 `src/shared/` 现有样式变量

## 许可

提交代码即视为同意以本项目的 **MIT + 附加条款**（见 [LICENSE](LICENSE)）授权。上游 GrimVault / GrimVault-Chinese-Edition 的代码改动需保持与其 MIT 许可兼容。
