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

export function rarityColor (rarity) {
  return RARITY_COLORS[rarity] || RARITY_COLORS.Common;
}
