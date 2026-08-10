import { ref, onBeforeUnmount } from 'vue';

const invoke = (channel, data) => window.electron.invoke (channel, data);

// 市场上架公共逻辑：查价 / 上架 / 进度轮询 / 取消。
// 供「自动上架」页（SellPane）与「角色仓库」页网格上架共用。
export function useSell () {
  const pricing = ref (false);
  const selling = ref (false);
  const status = ref (null);
  const note = ref ('');
  let statusTimer = null;

  // targets: [{ item_id, rarity, sp, price }] — price 会被就地填充
  async function fetchPrices (targets) {
    if (!targets.length) return;
    pricing.value = true;
    note.value = `正在查询 ${targets.length} 件物品的市场价…`;
    try {
      const payload = targets.map ((it, idx) => ({
        index: idx,
        item_id: it.item_id,
        rarity: it.rarity,
        sp: JSON.parse (JSON.stringify (it.sp || [])),
      }));
      const r = await invoke ('market:price', payload);
      const map = new Map ((r?.results || []).map (x => [x.index, x.price]));
      targets.forEach ((it, idx) => { it.price = map.has (idx) ? map.get (idx) : null; });
      const withPrice = targets.filter (t => t.price != null).length;
      note.value = `查价完成：${withPrice}/${targets.length} 件有市场价（无价的已跳过）`;
    } catch (e) {
      note.value = '查价失败：' + (e?.message || '未知错误');
    }
    pricing.value = false;
  }

  // items: [{ stash_id, x, y, w, h, price }]；返回 true=已启动，false=启动失败
  async function startSell (items) {
    if (!items.length) {
      note.value = '请先查价，且至少一件物品有市场价';
      return false;
    }
    selling.value = true;
    note.value = `开始上架 ${items.length} 件物品，请勿操作游戏…`;
    try {
      const r = await invoke ('market:sell', items);
      if (!r?.success) {
        note.value = '启动失败：' + (r?.error || '未知错误');
        selling.value = false;
        return false;
      }
    } catch (e) {
      note.value = '启动失败：' + (e?.message || '未知错误');
      selling.value = false;
      return false;
    }
    pollStatus ();
    return true;
  }

  async function stopSell () {
    await invoke ('market:cancel');
    note.value = '已请求停止，等待当前步骤结束…';
  }

  async function pollStatus () {
    try {
      const r = await invoke ('market:status');
      status.value = r;
      if (r?.running) {
        note.value = `上架中 ${r.current}/${r.total}`;
        if (!statusTimer) statusTimer = setInterval (pollStatus, 2000);
        return;
      }
      if (statusTimer) { clearInterval (statusTimer); statusTimer = null; }
      selling.value = false;
      if (r?.error) note.value = '上架失败：' + r.error;
      else if (r?.result?.success === false) note.value = '上架中断：' + (r.result.error || '未知');
      else if (r?.result?.success) note.value = `上架完成：${r.result.total} 件`;
      else note.value = '';
    } catch (e) {
      if (statusTimer) { clearInterval (statusTimer); statusTimer = null; }
      selling.value = false;
      note.value = '获取上架状态失败';
    }
  }

  function cleanup () {
    if (statusTimer) { clearInterval (statusTimer); statusTimer = null; }
  }

  onBeforeUnmount (cleanup);

  return { pricing, selling, status, note, fetchPrices, startSell, stopSell, cleanup };
}
