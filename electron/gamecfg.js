import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, readdirSync, existsSync, statSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { logger } from './logger.js';
import { dataDir } from './config.js';
import electron from 'electron';
const { app, shell } = electron;

// ── 游戏配置目录与文件（游戏配置固定在 %LOCALAPPDATA%\DungeonCrawler，与安装位置无关） ──
const GAME_CFG_DIR = join (process.env.LOCALAPPDATA || join (os.homedir (), 'AppData', 'Local'), 'DungeonCrawler', 'Saved', 'Config', 'Windows');
const GAME_FILES = [ 'GameUserSettings.ini', 'Engine.ini' ];

// ── 内置预设：差异补丁（只改关键画质/性能键，其余按键/音频/网络不动） ──
const PRESETS = [
  {
    id: 'perf',
    name: '极限性能',
    desc: '全低画质 + 关体积雾/SSAO/运动模糊 + PSO 缓存优化，适合追求帧率',
    tag: '推荐',
    normal: [
      { section: 'Video', key: 'ShadowQuality', value: '0' },
      { section: 'Video', key: 'EffectsQuality', value: '0' },
      { section: 'Video', key: 'PostProcessQuality', value: '0' },
      { section: 'Video', key: 'TextureQuality', value: '0' },
      { section: 'Video', key: 'AntiAliasingSuperResolution', value: 'AntialiasMode_TSR' },
      { section: 'Video', key: 'RenderScale', value: '70.000000' },
      { section: 'Scalability', key: 'sg.ResolutionQuality', value: '0' },
      { section: 'Scalability', key: 'sg.ViewDistanceQuality', value: '0' },
      { section: 'Scalability', key: 'sg.AntiAliasingQuality', value: '2' },
      { section: 'Scalability', key: 'sg.ShadowQuality', value: '0' },
      { section: 'Scalability', key: 'sg.GlobalIlluminationQuality', value: '0' },
      { section: 'Scalability', key: 'sg.ReflectionQuality', value: '0' },
      { section: 'Scalability', key: 'sg.PostProcessQuality', value: '0' },
      { section: 'Scalability', key: 'sg.TextureQuality', value: '0' },
      { section: 'Scalability', key: 'sg.EffectsQuality', value: '0' },
      { section: 'Scalability', key: 'sg.FoliageQuality', value: '0' },
      { section: 'Scalability', key: 'sg.ShadingQuality', value: '0' },
      { section: 'Scalability', key: 'sg.LandscapeQuality', value: '0' },
    ],
    engine: [
      [ 'r.VolumetricFog', '0' ],
      [ 'r.DefaultFeature.MotionBlur', '0' ],
      [ 'r.MotionBlur.Max', '0' ],
      [ 'r.DefaultFeature.AmbientOcclusion', '0' ],
      [ 'r.DefaultFeature.AmbientOcclusionLevels', '0' ],
      [ 'r.Shadow.MaxCSMResolution', '512' ],
      [ 'r.Shadow.RadiusThreshold', '0.03' ],
      [ 'r.ShaderPipelineCache.Enabled', '1' ],
      [ 'r.ShaderPipelineCache.SaveAfterPSOsLogged', '1' ],
      [ 'r.ShaderPipelineCache.BatchSize', '50' ],
      [ 'r.ShaderPipelineCache.PreOptimizeEnabled', '1' ],
      [ 'r.ShaderPipelineCache.ExcludePrecachePSO', '0' ],
      [ 'r.PSOPrecache.ProxyCreationWhenNotInGame', '1' ],
      [ 'r.PSOPrecache.ProxyCreationInGame', '1' ],
      [ 'r.DynamicRes.Enabled', '0' ],
    ],
  },
  {
    id: 'balanced',
    name: '均衡',
    desc: '中低画质 + 关体积雾/SSAO + PSO 缓存优化，帧率与画质兼顾',
    tag: '',
    normal: [
      { section: 'Video', key: 'ShadowQuality', value: '2' },
      { section: 'Video', key: 'EffectsQuality', value: '1' },
      { section: 'Video', key: 'PostProcessQuality', value: '1' },
      { section: 'Video', key: 'TextureQuality', value: '2' },
      { section: 'Video', key: 'AntiAliasingSuperResolution', value: 'AntialiasMode_TSR' },
      { section: 'Video', key: 'RenderScale', value: '85.000000' },
      { section: 'Scalability', key: 'sg.ResolutionQuality', value: '0' },
      { section: 'Scalability', key: 'sg.ViewDistanceQuality', value: '1' },
      { section: 'Scalability', key: 'sg.AntiAliasingQuality', value: '2' },
      { section: 'Scalability', key: 'sg.ShadowQuality', value: '0' },
      { section: 'Scalability', key: 'sg.GlobalIlluminationQuality', value: '1' },
      { section: 'Scalability', key: 'sg.ReflectionQuality', value: '1' },
      { section: 'Scalability', key: 'sg.PostProcessQuality', value: '0' },
      { section: 'Scalability', key: 'sg.TextureQuality', value: '1' },
      { section: 'Scalability', key: 'sg.EffectsQuality', value: '0' },
      { section: 'Scalability', key: 'sg.FoliageQuality', value: '1' },
      { section: 'Scalability', key: 'sg.ShadingQuality', value: '1' },
      { section: 'Scalability', key: 'sg.LandscapeQuality', value: '1' },
    ],
    engine: [
      [ 'r.VolumetricFog', '0' ],
      [ 'r.DefaultFeature.MotionBlur', '0' ],
      [ 'r.MotionBlur.Max', '0' ],
      [ 'r.DefaultFeature.AmbientOcclusion', '0' ],
      [ 'r.DefaultFeature.AmbientOcclusionLevels', '0' ],
      [ 'r.ShaderPipelineCache.Enabled', '1' ],
      [ 'r.ShaderPipelineCache.SaveAfterPSOsLogged', '1' ],
      [ 'r.ShaderPipelineCache.BatchSize', '50' ],
      [ 'r.ShaderPipelineCache.PreOptimizeEnabled', '1' ],
      [ 'r.ShaderPipelineCache.ExcludePrecachePSO', '0' ],
      [ 'r.PSOPrecache.ProxyCreationWhenNotInGame', '1' ],
      [ 'r.PSOPrecache.ProxyCreationInGame', '1' ],
    ],
  },
  {
    id: 'default',
    name: '官方默认',
    desc: '还原游戏内默认设置（超高 GI/反射/植被等），不附加任何 Engine.ini 优化',
    tag: '',
    normal: [
      { section: 'Video', key: 'RenderScale', value: '85.000000' },
      { section: 'Scalability', key: 'sg.ViewDistanceQuality', value: '3' },
      { section: 'Scalability', key: 'sg.GlobalIlluminationQuality', value: '3' },
      { section: 'Scalability', key: 'sg.ReflectionQuality', value: '3' },
      { section: 'Scalability', key: 'sg.FoliageQuality', value: '3' },
      { section: 'Scalability', key: 'sg.ShadingQuality', value: '3' },
      { section: 'Scalability', key: 'sg.LandscapeQuality', value: '3' },
    ],
    engine: [],
    engineClear: true,
  },
];

// ── 只读属性（Windows 上 chmodSync 同步控制只读位，避免异步竞态） ──
function setReadOnly (file, on) {
  try {
    // 444 = 只读；666 = 可写
    chmodSync (file, on ? 0o444 : 0o666);
  } catch (e) {
    logger.warn (`设置只读属性失败 ${on ? '+' : '-'}R`, { file, error: e?.message });
  }
}

function isReadonly (file = join (GAME_CFG_DIR, 'Engine.ini')) {
  try {
    return !(statSync (file).mode & 0o222);
  } catch (e) {
    return false;
  }
}

function isGameRunning () {
  return new Promise ((resolve) => {
    execFile ('tasklist', [ '/FI', 'IMAGENAME eq DungeonCrawler.exe', '/FO', 'CSV', '/NH' ], { timeout: 5000 }, (err, stdout) => {
      if (err) return resolve (false);
      resolve (/DungeonCrawler\.exe/i.test (stdout));
    });
  });
}

// ── 配置读取/修改 ──
function readGameFile (name) {
  const p = join (GAME_CFG_DIR, name);
  if (!existsSync (p)) return '';
  return readFileSync (p, 'utf8');
}

function writeGameFile (name, content) {
  const p = join (GAME_CFG_DIR, name);
  // 解只读 → 写 → 由调用方决定是否恢复只读
  setReadOnly (p, false);
  writeFileSync (p, content);
}

// 按 section/key 修改 GameUserSettings.ini（文本级正则，保留其余内容）
function applyNormal (content, normal) {
  let out = content;
  for (const item of (normal || [])) {
    if (item.section === 'Video') {
      // 视频设置位于 GameUserSettingVideoDisplaySaved=(...) 结构体内：限定该行内替换
      const lineRe = /^GameUserSettingVideoDisplaySaved=.*$/m;
      const line = out.match (lineRe);
      if (!line) { logger.warn ('gamecfg 视频行不存在，跳过', { key: item.key }); continue; }
      const re = new RegExp (item.key + '=[^,)]*');
      if (!re.test (line[0])) { logger.warn ('gamecfg 键不存在，跳过', { key: item.key }); continue; }
      out = out.replace (lineRe, line[0].replace (re, item.key + '=' + item.value));
    } else {
      // 独立行（ScalabilityGroups 等）：行首精确匹配，避免误伤带前缀的同名键
      const re = new RegExp (`^([ \\t]*${item.key}=)[^\\r\\n]*`, 'm');
      if (!out.match (re)) { logger.warn ('gamecfg 键不存在，跳过', { key: item.key }); continue; }
      out = out.replace (re, (m, p) => p + item.value);
    }
  }
  return out;
}

// Engine.ini [SystemSettings]：按参数名替换，不存在则追加
function applyEngine (content, entries, clear = false) {
  let out = content;
  if (clear) {
    // 清空旧 [SystemSettings] 段，再写新参数（default 预设用）
    out = out.replace (/\[SystemSettings\][\s\S]*?(?=\n\[|\s*$)/, '[SystemSettings]\n');
  }
  if (!/\[SystemSettings\]/i.test (out)) out += '\n[SystemSettings]\n';
  for (const [ key, value ] of (entries || [])) {
    const re = new RegExp (`^(${key.replace (/\./g, '\\.')}=)[^\\r\\n]*`, 'm');
    if (out.match (re)) {
      out = out.replace (re, (m, prefix) => prefix + value);
    } else {
      out += `${key}=${value}\n`;
    }
  }
  return out;
}

// ── 备份 ──
function backupDir () {
  const d = join (dataDir (app), 'game_backups');
  mkdirSync (d, { recursive: true });
  return d;
}

function makeBackup (id) {
  const ts = new Date ().toISOString ().replace (/[:.]/g, '-').slice (0, 19);
  const dir = join (backupDir (), `${ts}_${id}`);
  mkdirSync (dir, { recursive: true });
  for (const name of GAME_FILES) {
    const content = readGameFile (name);
    if (!content) continue;
    // 备份目录文件无需只读保护；源文件只读不影响读取，保持原状
    writeFileSync (join (dir, name), content);
  }
  return dir;
}

// ── 对外 API ──
function listPresets () {
  const dir = join (dataDir (app), 'game_presets');
  const customs = [];
  if (existsSync (dir)) {
    for (const f of readdirSync (dir)) {
      if (!f.endsWith ('.json')) continue;
      try {
        const cfg = JSON.parse (readFileSync (join (dir, f), 'utf8'));
        if (cfg && cfg.id && cfg.normal) {
          customs.push ({ ...cfg, custom: true });
        }
      } catch (e) { logger.warn ('自定义预设解析失败', { file: f, error: e?.message }); }
    }
  }
  return { presets: [ ...PRESETS.map (p => ({ id: p.id, name: p.name, desc: p.desc, tag: p.tag, custom: false })), ...customs ] };
}

function getPreset (id) {
  const builtin = PRESETS.find (p => p.id === id);
  if (builtin) return builtin;
  const dir = join (dataDir (app), 'game_presets');
  const p = join (dir, `${id}.json`);
  if (!existsSync (p)) return null;
  try { return JSON.parse (readFileSync (p, 'utf8')); } catch (e) { return null; }
}

async function applyPreset (id) {
  const preset = getPreset (id);
  if (!preset) return { success: false, error: `预设不存在：${id}` };

  if (await isGameRunning ()) {
    return { success: false, error: '游戏正在运行，请先关闭游戏再切换配置' };
  }

  // 备份当前配置
  let backup = '';
  try { backup = makeBackup (id); } catch (e) {
    logger.warn ('游戏配置备份失败', { error: e?.message });
  }

  try {
    const gus = readGameFile ('GameUserSettings.ini');
    const eng = readGameFile ('Engine.ini');
    const newGus = applyNormal (gus, preset.normal);
    const newEng = applyEngine (eng, preset.engine, preset.engineClear === true);
    writeGameFile ('GameUserSettings.ini', newGus);
    writeGameFile ('Engine.ini', newEng);
    // 应用后恢复只读，防止游戏覆盖
    for (const name of GAME_FILES) setReadOnly (join (GAME_CFG_DIR, name), true);
    logger.info ('游戏配置预设已应用', { id, backup });
    return { success: true, backup };
  } catch (e) {
    logger.error ('应用游戏配置预设失败', { id, error: e?.message, stack: e?.stack });
    return { success: false, error: `应用失败：${e?.message}` };
  }
}

function saveCustom (id, name, normal, engine) {
  if (!id || !/^[a-zA-Z0-9_-]{1,32}$/.test (id)) return { success: false, error: '预设 ID 不合法' };
  const dir = join (dataDir (app), 'game_presets');
  mkdirSync (dir, { recursive: true });
  const cfg = { id, name: name || id, desc: '自定义预设', normal: normal || [], engine: engine || [], custom: true };
  writeFileSync (join (dir, `${id}.json`), JSON.stringify (cfg, null, 2));
  logger.info ('自定义预设已保存', { id });
  return { success: true };
}

function current () {
  const gus = readGameFile ('GameUserSettings.ini');
  const eng = readGameFile ('Engine.ini');
  const get = (re) => { const m = gus.match (re) || eng.match (re); return m ? m[1] : null; };
  const renderScale = get (/RenderScale=([\d.]+)/);
  const api = get (/DirectXVersion=(\w+)/);
  const engineEntries = [...eng.matchAll (/^r\.([^=\r\n]+)=([^\r\n]*)/gm)].map (m => ({ key: 'r.' + m[1], value: m[2] }));
  return {
    success: true,
    renderScale: renderScale ? parseFloat (renderScale) : null,
    api: api || 'Unknown',
    readonly: isReadonly (),
    engineCount: engineEntries.length,
  };
}

function openDir () {
  if (!existsSync (GAME_CFG_DIR)) {
    return { success: false, error: '未找到游戏配置目录（可能尚未安装或运行 Dark and Darker）' };
  }
  try {
    shell.openPath (GAME_CFG_DIR);
    return { success: true };
  } catch (e) {
    return { success: false, error: e?.message };
  }
}

export { GAME_CFG_DIR, PRESETS, applyPreset, current, listPresets, saveCustom, openDir };