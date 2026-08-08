# 大角色快照（Type 44）解析失败 · 排查与修复记录

> 背景：2026-08 用户反馈大角色（角色数据 135~155KB）快照抓取后解析失败，
> 角色/仓库数据不显示。排查约 3 天，最终定位为抓包**流重组链路连环 bug**。
> 本文档记录完整排查过程、根因、修复方案与验证，供后续维护参考。

## 症状

- 切换角色后，大角色快照包（Type 44，S2C_LOBBY_CHARACTER_INFO_RES）解析失败
- 小角色（快照 < 50KB）偶尔正常，大角色必挂
- 调试日志出现 `PARSE-FAIL`，`squire_data\debug\parsefail_*.bin` 落盘原始包
- 离线按 `tcp.seq` 排序拼接同一份 pcap 数据，**4 个 Type 44 全部解析成功**
  ——证明抓包数据本身完整，问题在**按到达顺序的流式重组**

## 排查过程（含走过的弯路）

| 怀疑方向 | 结论 |
|---|---|
| Wintun / Meta 网卡损坏 | 排除（已禁用 Meta，路由回落以太网，症状不变） |
| TSO / 网卡 offload | 排除（用户不接受动网卡，pcap 文件模式确认数据完整） |
| pyshark 0.6 大包读取 bug | 部分相关（实时 `-T fields` 丢大包帧），已绕开，但非根因 |
| TLS keep-alive / retransmission 帧污染 | 排除（过滤后仍失败） |
| STREAM-STUCK 10s 超时误杀 | 部分相关（阈值 10s 太短，已提 60s），非根因 |
| 抓包缓冲区 `-B 16384` 太小 | 部分相关（提至 64MB），非根因 |

最终靠 **pcap 回放 + 逐段打印流内部状态**（next_seq / data / segments）逐层拆开。

## 根因：五个 bug 叠加

任意一个 bug 单独不致命，叠加后游戏流被反复 reset / 错位，
135~155KB 快照永远凑不齐：

1. **STREAM-CORRUPT 误杀（最致命）**
   用 `data > expected_length * 2` 判定流损坏。但一个 TCP 段常含多个游戏包
   （22B + 32B + Type44 头部同段到达），`expected` 刚读完小包头部设 22，
   缓冲里已有 226 字节 → 误判损坏 → **整条流清空**。

2. **proto 枚举校验误杀**
   `validate_packet_header` 要求 `proto_type in PacketCommand.values()`。
   游戏实际会发枚举未收录的类型（实测 `type=94`），头部一出现即判无效 → reset。

3. **流起点 next_seq 漏加 len**（重构时引入）
   首个段处理后 `next_seq = seq` 未加 `len(data)`，切包后 next_seq 卡死在起点，
   后续所有段全进 segments 拼不上。

4. **乱序段一律丢弃**
   `seq < next_seq` 时按"旧段/重复"处理直接 drop。但乱序晚到的段可能是
   **唯一副本**（非重传），丢弃即数据永久丢失 → 流错位。

5. **padding 校验误杀**
   `padding in [0, 256]`——游戏 padding 是随机值（回放样本恰为 256 未触发，
   但为同类隐患一并拆除）。

**连锁反应**：reset → 流重建 → 重建后从流中间读头部 → validate 失败 → 又 reset
→ 循环。Type 44 永远拼不出。

## 修复方案（提交 d0b7814）

1. **流按 `tcp.seq` 排序重组**：
   - 首个段 `next_seq = seq + len(data)`
   - 乱序段不丢弃：`seq < data_start` 且与缓冲头连续时**前插**
     （可补回大包缺失的头部），否则暂存 `segments`
   - 缓冲尾用 `while st.next_seq in st.segments` 循环拼接
2. **删除 STREAM-CORRUPT 检查**（同段多包是正常现象，STUCK 已兜底）
3. **validate 只保留长度校验** `8B ~ 2MB`（去掉 padding 与枚举校验）
4. **三道闸兜底**（防毒瘤数据）：
   - 包长超出 2MB → 头部判死，流重置
   - 流缓冲超 `MAX_BUFFER_SIZE`（后从 1MB 提至 4MB，见 37513ad）→ 重置
   - 等待完整包超 60s（STREAM-STUCK）→ 重置
5. **抓包架构**：`tshark -i <iface> -B 65536 -w pcap` 落盘 +
   每 0.4s `-r pcap -Y filter -T fields` 读回（frame.number 去重），
   绕开 pyshark 0.6 实时大包丢帧

## 验证

- pcap 回放（`game_capture.pcap`，915 帧）：captured 从 13 个（修复前）
  → **127 个**，**Type 44 ×4（19418/19418/24442/24442）全部 parsed=True**
- 真实环境：切换角色获取角色/仓库数据正常
- 语法检查通过

## 后续注意

- **validate 已放宽**：乱序错位时可能切出"假包"（长度恰好落在 8B~2MB），
  由 STREAM-STUCK（60s）与缓冲闸兜底，只浪费少量内存，不影响正确流
- **TLS 等其他流**（如 0-D）读到随机长度（如 197399）会进入"等待"状态，
  依赖 STREAM-STUCK 兜底，无害
- 若未来游戏发 >2MB 的包（仓库极端膨胀），需同步提高
  `valid_packet_range` 上限与 `MAX_BUFFER_SIZE`
