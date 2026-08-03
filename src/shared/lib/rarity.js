export const RARITY_COLORS = {
  Poor: '#8a8a8e',
  Common: '#6e6e73',
  Uncommon: '#4f9a00',
  Rare: '#0084c8',
  Epic: '#a445d6',
  Legendary: '#d97a00',
  Unique: '#b08a2e',
  Artifact: '#d92d20',
};

export const RARITY_CN = {
  Poor: '粗糙',
  Common: '普通',
  Uncommon: '非凡',
  Rare: '稀有',
  Epic: '史诗',
  Legendary: '传说',
  Unique: '独特',
  Artifact: '神器',
};

export function rarityColor (rarity) {
  return RARITY_COLORS[rarity] || RARITY_COLORS.Common;
}
