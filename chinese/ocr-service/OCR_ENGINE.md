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

## 探查结果（2026-08-01，只读）

- 旧 `models/paddle/ch/rec.onnx` 输入 shape = `[1, 3, 48, 320]` → **W 维固定 320**。
  → 档1「整行不切」**物理不可能**；长行必须切到 ≤320 宽，连续中文长行无可避免切字。
  → 旧 `dict.txt` = 18383 行（输出 vocab 18385 = 含 blank + space）。
- RapidOCR rec（`ch_PP-OCRv4_rec_infer.onnx`）经 `resize_norm_img` 按行真实宽高比**动态算宽、不 cap** → 整行不切可行（档2 依据）。
- 结论：档1 只能优化切点（投影谷），**无法根治**蓝字残缺；档2 才能根治。两档都跑以取得对比数据。

## 实施落地（三档并存 + 开关）

| 档 | 文件 | rec 模型 | det/cls | 切长行 | 开关值 |
|---|---|---|---|---|---|
| 1 | `ocr_engine_v1fix.py` | 旧 rec.onnx（固定320） | 无 | 投影谷切点优化 | `v1fix` |
| 2 | `ocr_engine_hybrid.py` | RapidOCR v4 rec（动态宽） | 无 | 不切 | `hybrid` |
| 3 | `ocr_engine_rapid.py` | RapidOCR v4 rec | **有** | 不切 | `rapid` |

切换：环境变量 `DARKTAVERN_OCR_ENGINE` ∈ {v1fix, hybrid, rapid}，`server.py` 顶部读取，**默认 `v1fix`**。
切档后**必须重启 app**（OCR 为 Electron 子进程，不重启不加载新代码）。
档2 仅构造 RapidOCR 的 `TextRecognizer`（rec），启动不加载 det/cls，启动速度与旧引擎同级。

## 实测对比（逐档由用户重启测试后填）

测法：悬停带蓝字装备扫描，取**第二次起稳态** `ocr+translate: Xms`（避开首次 warmup；translate 各档相同可抵消），并看悬浮窗蓝字是否完整 + 评分是否出现。

| 档 | 稳态 ocr+translate (ms) | 蓝字完整? | 评分显示? | 备注 |
|---|---|---|---|---|
| v1fix | **197** | ❌ 蓝字全乱码（`+3活力`→`t3Vigor`、`+1灵巧`→`[t1n`、`护甲值66`→`[Peee`） | ❌ | 旧 rec 模型对蓝字能力不足，非切点问题，**不可用** |
| hybrid | 串行 batch: 1152→2455ms；并发 w6: 537-647ms；**并发 w20+intra1: 309-522ms** | ✅ 完美 | ✅ | 逐行并发 rec（ThreadPoolExecutor w=cpu_count），无 det/cls。**最优解** |
| rapid | ~400-600ms（含 det ~140ms） | ✅ 完美 | ✅ | 整图 det+rec，det 额外开销 ~140ms，无并发优势 |

## 9. 决策记录

- 2026-08-01：确认根因为 OCR 质量（非接口/前端/key/UA），切 RapidOCR 修复蓝字识别；速度问题存档方案 A/B，**暂不实施**，先保证功能正确。
- 2026-08-01：只读探查确认旧 rec 固定 320 宽 → 实施三档并存（v1fix/hybrid/rapid）+ env 开关，默认 v1fix 先测，逐档量化后选最优。
- 2026-08-01：实测 v1fix=197ms 但蓝字全废（旧 rec 模型能力不足，非切点问题）；hybrid 串行=1152-2455ms 太慢；hybrid 并发 w6=537-647ms；hybrid 并发 w20+intra1=**309-522ms** 蓝字完美 → **选定 hybrid 为默认**。detect 缓存不可行（用户每次扫新装备，缓存必 miss）。CPU 架构底线 ~500ms（capture 40-80 + detect 100-150 + ocr+translate 300-500）。再快需 GPU（DirectML）。
