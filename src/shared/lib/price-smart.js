// 现价显示基准：smart=现价低于均价×阈值% 时显示均价（避免异常低价挂单误导）；live=始终显示真实最低挂单
export function displayLive (price, market, basis, thresholdPct) {
  if (basis === 'live') return price;
  const t = (parseInt (thresholdPct) || 50) / 100;
  if (price != null && market != null && price < market * t) return market;
  return price ?? market ?? null;
}
