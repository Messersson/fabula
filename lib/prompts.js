// 提示词工具：从 prompts.defaults.json 组装 system prompt（题材卡/篇制/偏好/平台/去 AI 味/风格卡/技能模板）。
'use strict';
const fs = require('fs');
const path = require('path');

let P = null;
function promptsFile() {
  const local = path.join(__dirname, '..', 'data', 'prompts.defaults.json');
  if (fs.existsSync(local)) return local;
  return path.join(__dirname, '..', 'resources', 'prompts.defaults.json');
}
function prompts() {
  if (!P) {
    P = JSON.parse(fs.readFileSync(promptsFile(), 'utf-8'));
  }
  return P;
}

// 题材名 -> templates key
const GENRE_MAP = [
  [/玄幻/, 'xuanhuan'], [/城市|都市/, 'dushi'], [/古言|古代/, 'guyan'], [/科幻/, 'kehuan'],
  [/末世/, 'moshi'], [/历史/, 'lishi'], [/快穿|穿书/, 'kuaichuan'], [/年代|种田/, 'niandai'],
  [/悬疑|惊悚/, 'xuanyi'], [/言|言情/, 'yanqing'], [/游戏|无限流/, 'youxi'], [/高武/, 'gaowu'],
  [/大女主/, 'danvzhu'], [/女频/, 'nvshengcun'], [/男频/, 'tongyong'],
];

function genreKey(genre) {
  if (!genre) return 'tongyong';
  for (const [re, k] of GENRE_MAP) if (re.test(genre)) return k;
  return 'tongyong';
}

function genreCard(genre, form) {
  const p = prompts();
  const parts = [];
  const gk = genreKey(genre);
  if (p['genre__' + gk]) parts.push(p['genre__' + gk]);
  const fm = form === 'short' ? 'form_short'
    : form === 'medium' ? 'form_medium'
      : form === 'midlong' ? 'form_midlong'
        : form === 'long' ? 'form_long'
          : form === 'million' ? 'form_million' : null;
  // 书长判定交给 backend 传入；缺省给短篇/中篇提示
  if (fm && p[fm]) parts.push(p[fm]);
  return parts.join('\n');
}

// 风格卡：book_meta.style_json 结构（与前端“风格卡”一致）
function styleCardText(style) {
  if (!style) return '';
  const p = prompts();
  const header = p.book_style_header || '【本书文风·优先遵循】';
  let body = '';
  if (typeof style === 'string') body = style;
  else if (style && typeof style === 'object') {
    const parts = [];
    for (const k of ['summary', 'tone', 'sentence', 'dialogue', 'pacing', 'emotion', 'samples', 'flavor', 'avoid', 'strengths', 'weaknesses', 'signature', 'structure', 'highFreq', 'templates', 'faq']) {
      if (style[k]) parts.push(`### ${k}\n${typeof style[k] === 'string' ? style[k] : JSON.stringify(style[k])}`);
    }
    body = parts.join('\n\n');
  }
  return body ? header + '\n' + body : '';
}

function antiAiTone(deep) {
  const p = prompts();
  return p[deep ? 'anti_ai_tone_deep' : 'anti_ai_tone'] || '';
}

// 平台卡：publicationPlatform（fanqie/jinjiang/qidian/salve）
function platformCard(platform) {
  const p = prompts();
  if (platform && p['platform_' + platform]) return p['platform_' + platform];
  return '';
}

// 偏好：书 style + 设置里的偏好键（pref_*）
function prefCards(prefs = {}) {
  const p = prompts();
  const out = [];
  for (const [k, v] of Object.entries(p)) {
    if (k.startsWith('pref_') && v && prefs[k] !== false && prefs[k] != null && prefs[k] !== 'none') {
      out.push(v);
    }
  }
  return out.join('\n');
}

// 技能模板：技能记录里的 prompt_template 可能用 {{...}} 占位符
function fillTemplate(tpl, vars = {}) {
  return String(tpl || '').replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (m, k) =>
    vars[k] != null ? String(vars[k]) : m
  );
}

// 内置官方技能 builtin_key -> 完整工作流/方法模板（prompts.defaults.json 键）
const SKILL_TEMPLATE_MAP = {
  'method.plot': 'arc_plan', 'method.outline': 'outline_json', 'method.body': 'skill_body',
  'method.blueprint': 'skill_blueprint', 'method.blurb': 'skill_blurb', 'method.lead_workshop': 'skill_lead_workshop',
  'method.section_body': 'skill_section_body', 'method.consistency_review': 'skill_consistency',
  'method.dialogue_polish': 'skill_dialogue', 'method.scene_enhance': 'skill_scene',
  'method.setting_extract': 'skill_extract', 'method.setting_coach': 'skill_setting', 'method.setting_ingest': 'skill_setting_ingest',
  'method.writers_block_rescue': 'skill_rescue', 'method.opening_review': 'skill_opening',
  'method.pacing_review': 'skill_pace', 'method.reader_review': 'skill_reader', 'method.return_briefing': 'skill_briefing',
  'method.library_audit': 'skill_audit', 'method.short_review': 'skill_short_review',
  'method.skill_workshop': 'skill_draft', 'method.humanize.standard': 'anti_ai_tone', 'method.humanize.deep': 'anti_ai_tone_deep',
  'workflow.book_setup': 'book_setup_quality', 'workflow.short_body': 'skill_shortbody',
};
// 技能 → 完整模板全文（内置技能技能表里的 prompt_template 只是摘要，官方完整工作流在此）
function skillFullTemplate(skill) {
  const key = skill && skill.builtin_key ? SKILL_TEMPLATE_MAP[skill.builtin_key] : null;
  if (key && prompts()[key]) return prompts()[key];
  return skill && skill.prompt_template || '';
}

module.exports = { prompts, genreKey, genreCard, styleCardText, antiAiTone, platformCard, prefCards, fillTemplate, skillFullTemplate };
