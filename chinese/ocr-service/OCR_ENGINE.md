# OCR 引擎：排查记录与提速方案

> 目的：存档"换 RapidOCR 后识别变慢 / 旧引擎快但蓝字残缺"的根因与解决方案，避免后续反复排查。
> 当前线上状态：`server.py` 已切到 RapidOCR 整图 det+rec（**准、慢**）。提速方案 A/B **仅存档，尚未实施**。

## 1. 数据链路

```
游戏中文 tooltip
  → 本地 OCR 服务 (chinese/ocr-service/server.py)：截图 → 检测(tooltip.onnx) → OCR识别 → 翻译英文
  → Electron 主进程 (electron/scan.js) 调 DarkerDB
      GET /v1/internal/grimvault/analyze?tooltip=<英文>
  → 返回 item.primary / item.secondary(含 min/max/grade) / pricing / demand / adventure_points
  → 悬浮窗 (src/overlay/components/Tooltip.vue) 渲染
```

**关键事实**：评分字母 S/A/B/C/D/F 由 **API 直接返回**（`item.secondary[].grade`，连同 `min/max/value`）。
前端 `getGradeColor()` 只负责按字母着色，**不做本地评分计算**。
→ 因此"词条/评分不显示"几乎必然是 **OCR 翻译文本质量** 问题，而非前端或接口问题。

## 2. 现象

| 引擎 | 文件 | 速度 | 蓝字随机属性 | analyze 的 secondary |
|---|---|---|---|---|
| 旧（自实现 Paddle，逐行 rec） | `ocr_engine.py` | **快** | **残缺** | 空 → 不显示词条/评分 |
| 新（RapidOCR 整图） | `ocr_engine_rapid.py` | **慢** | 完整 | 带 grade → 正常显示 |

旧引擎残缺样例（来自真实 scan 日志）：
- `+1.6% 物理伤害减免` → `+1.6% e`
- `+1 额外武器伤害` → `+1Additional Weapon Damage [`
- `意志 5` → `Will`（数值丢失）

## 3. 根因 A — 为什么 RapidOCR 慢

RapidOCR 默认 `use_det=true, use_cls=true, use_rec=true`（见包内 `config.yaml`），**三个模型全跑**：

- **det**（`ch_PP-OCRv4_det_infer.onnx`，整图 `limit_side_len=736`）= **速度大头**。对整张 tooltip 跑一次文本框检测。
- **cls**（方向分类器，每个文本框跑一次）= 次要开销，对水平游戏文本**完全无用**。
- **rec**（`ch_PP-OCRv4_rec_infer.onnx`，`rec_batch_num=6`）= 批量推理，本身快。

旧引擎**完全跳过 det 和 cls**：用像素水平投影 `line_bands`（纯 numpy，无模型）自己切行，只跑 rec，且用 `ThreadPoolExecutor` 逐行并发 → 所以快。

## 4. 根因 B — 旧引擎为什么蓝字残缺

旧引擎 rec 输入宽度 **cap 在 320**（`ocr_engine.py` 的 `_preprocess`：`w = min(MODEL_WIDTH=320, ...)`）。
超长行用 `col_chunks` **横向硬切**成多段喂 rec，切点落在字/词中间 → 蓝字长行被切碎。
白字行较短不切，故白字正常、蓝字残缺。

RapidOCR 的 rec（`text_recognize.py` 的 `resize_norm_img`）按行真实宽高比**动态算宽、不 cap、不切**，整行识别 → 准。

**一句话**：旧引擎 = 快但切行致脏；RapidOCR 默认 = 准但 det/cls 致慢。两者优点可合并（见方案 A）。

## 5. RapidOCR 内部接口发现（方案 A 的依据）

读包源码确认：

- `RapidOCR.__call__(img, use_det=, use_cls=, use_rec=)` 可按需开关三阶段。
- 识别器可**单独批量调用**：`self.ocr.text_rec(crop_list)` 接受**行 crop 列表**（`text_recognize.py` 的 `__call__`：`img_list` 为 list 时按宽高比排序、`batch_num=6` 一次 `session.run` 喂多行、返回顺序与输入对齐），且**不切长行**。
- det 输出经 `get_crop_img_list` 做透视矫正得到行 crop；我们若自己分行，可直接构造 crop 列表喂 `text_rec`，绕过 det/cls。

## 6. 提速方案

### 方案 A（推荐，又快又准，根治脏）— 混合引擎

保留 RapidOCR 实例（用它的 v4 rec 模型与会话），但 `ChineseOCR.read(region)` 改为：

1. 复用旧引擎的**纯 numpy 分行**：`line_bands`（水平投影切行）+ `trim_cols`（去左右空白）+ 首行/水平分隔线过滤逻辑。
2. **不切 chunk**（弃用 `col_chunks`，避免切长行致脏）。
3. 把行 crop 列表整批喂 `self.ocr.text_rec(crops)` 批量识别。
4. **不跑 det、不跑 cls**。

预期：速度 ≈ 旧引擎或更快（批量 rec 比旧引擎逐行并发更高效，且无 det/cls 开销）；质量 = v4 rec + 整行不切 → 蓝字完整。
改动范围：**仅重写 `ocr_engine_rapid.py` 的 `read()`**，把旧 `ocr_engine.py` 的分行函数搬进来（**不搬** `col_chunks` / `_preprocess` 的 320 cap）。`server.py` / 前端 / 接口 / 翻译表**全不动**。

### 方案 B（最小改动退路）

保留 RapidOCR 整图调用，构造时 `use_cls=False` + 缩小 det 输入（`limit_side_len` 736 → ~480，或 `det_db_box_thresh` 调高）。
det 仍在，比 A 慢，但比当前快一截。改动：仅构造参数一行。

### 验证方法（两方案通用）

1. **重启 app**（杀掉旧 OCR 子进程，否则不加载新代码）。
2. 看 scan 日志 `Scan complete in ...ms (ocr+translate: Xms)`，X 应明显回落（旧引擎量级）。
3. 悬停带蓝字装备扫描：悬浮窗出现蓝字词条 + 每行 `(min-max)(grade)`，且蓝字内容完整无碎片。

## 7. 已完成的接线改动（本次提交）

`server.py`：
- `from ocr_engine_rapid import ChineseOCR`
- `ocr = ChineseOCR()`（RapidOCR 无参构造，自带 det/rec 模型，不再读 `DARKTAVERN_REC_MODEL/REC_DICT`）
- warmup 改 `ocr.read(dummy)`（旧 `read_line` 已不存在）
- 删除已无用的 `REC_MODEL_PATH` / `REC_DICT_PATH` 死变量与误导注释

新增：`ocr_engine_rapid.py`（从 GrimVault-Chinese-Edition 拷入，接口 `read(image)->str` 与 server 调用点 `ocr.read(region)` 兼容）。

`electron/backend.js` 仍传 `DARKTAVERN_REC_MODEL/REC_DICT` env，但 server 已不读，属无害冗余（清理需动主进程，暂未做）。
旧 `ocr_engine.py` 已无人 import，保留作 RapidOCR 出岔子时的回退（死文件，可日后删）。

## 8. 依赖

`rapidocr-onnxruntime` 已在 `requirements.txt` 且已装入 `ocr_env`（Electron 启动 OCR 正用该 venv）。

## 9. 决策记录

- 2026-08-01：确认根因为 OCR 质量（非接口/前端/key/UA），切 RapidOCR 修复蓝字识别；速度问题存档方案 A/B，**暂不实施**，先保证功能正确。
