export const CLASS_CN = {
  Barbarian: '野蛮人',
  Bard: '吟游诗人',
  Cleric: '牧师',
  Druid: '德鲁伊',
  Fighter: '战士',
  Ranger: '游侠',
  Rogue: '潜行者',
  Sorcerer: '术士',
  Warlock: '邪术师',
  Wizard: '法师',
};

export function cnClass (cls) {
  if (!cls) return '';
  const key = String (cls).split (':').pop ().split ('_').pop ();
  return CLASS_CN[key] || key;
}
