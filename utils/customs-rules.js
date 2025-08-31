// Customs rules and HS code mappings

// Title-based override → force HS 4911998000 + "Paper sticker"
const STICKER_KEYWORDS = [
  /monthly\s+tabs?/i,
  /\bstickers?\b/i,
  /time\s*management/i,
  /square\s*bullets?/i,
  /\bfinance\b/i,
  /wildflowers?/i,
  /botanical\s+stickers?/i
];

function titleForcesSticker(title) {
  const t = String(title || '');
  return STICKER_KEYWORDS.some(rx => rx.test(t));
}

// Canonical HS → description dictionary (exact matches)
const HS_DESCRIPTION_RULES = {
  '4820102010': () => 'Planner agenda (bound diary)',
  '4820102060': () => 'Notebook (bound journal)',
  '4820102030': () => 'Notebook (sewn journal, B5 size)',
  '4820102020': (title='') => {
    const t = String(title).toLowerCase();
    return (t.includes('sticky') || t.includes('stickies')) ? 'Sticky notepad' : 'Notepad';
  },
  '4911998000': () => 'Paper sticker',
  '9608100000': () => 'Gel ink pen',
  '4820900000': () => 'Planner inserts (loose refills)',
  '8305903010': () => 'Office paper clips',
  '6307909800': () => 'Elastic for notebook',
  '7117909000': () => 'Charm for notebook ribbon',
  '9608600000': () => 'Refills for ballpoint pen',
  '4811412100': (title='') => {
    const t = String(title).toLowerCase();
    return t.includes('pocket') ? 'Paper pocket for notebook' : 'Decorative tape for journaling';
  },
  '7113115000': (title='') => {
    const t = String(title).toLowerCase();
    if (/(bracelet|bracelets)/.test(t)) return 'Sterling silver jewellery bracelets';
    if (/(pendant|pendants)/.test(t))   return 'Sterling silver jewellery pendants';
    if (/(stud|studs)/.test(t))         return 'Sterling silver jewellery studs';
    if (/(earring|earrings)/.test(t))   return 'Sterling silver jewellery earrings';
    return 'Sterling silver jewellery';
  },
};

// normalize HS to digits
function normHS(code) {
  return String(code ?? '').replace(/[^0-9]/g, '');
}

// robust getter for the HS field on a ShipStation customs item
function getHS(ci) {
  const raw =
    ci?.harmonizedTariffCode ?? 
    ci?.harmonizedCode ??       
    ci?.hsCode ??               
    ci?.tariffCode ??           
    '';
  return String(raw);
}

// optional prefix-based mapping to catch nearby siblings
function pickByPrefix(h, title='') {
  const t = String(title).toLowerCase();

  if (h.startsWith('48201020')) {
    const last4 = h.slice(-4);
    if (last4 === '2010') return 'Planner agenda (bound diary)';
    if (last4 === '2060') return 'Notebook (bound journal)';
    if (last4 === '2030') return 'Notebook (sewn journal, B5 size)';
    if (last4 === '2020') return (t.includes('sticky') || t.includes('stickies')) ? 'Sticky notepad' : 'Notepad';
    return 'Notebook (bound journal)';
  }
  if (h.startsWith('4911')) return 'Paper sticker';
  if (h.startsWith('960810')) return 'Gel ink pen';
  if (h.startsWith('960860')) return 'Refills for ballpoint pen';
  if (h.startsWith('8305')) return 'Office paper clips';
  if (h.startsWith('630790')) return 'Elastic for notebook';
  if (h.startsWith('481141')) return t.includes('pocket') ? 'Paper pocket for notebook' : 'Decorative tape for journaling';
  if (h.startsWith('711311')) {
    if (/(bracelet|bracelets)/.test(t)) return 'Sterling silver jewellery bracelets';
    if (/(pendant|pendants)/.test(t))   return 'Sterling silver jewellery pendants';
    if (/(stud|studs)/.test(t))         return 'Sterling silver jewellery studs';
    if (/(earring|earrings)/.test(t))   return 'Sterling silver jewellery earrings';
    return 'Sterling silver jewellery';
  }
  if (h.startsWith('7117')) return 'Charm for notebook ribbon';
  return null;
}

// PICKER that can also override HS when title indicates stickers.
function pickCustomsDescription(harmonizedCode, titleOrDesc) {
  if (titleForcesSticker(titleOrDesc)) {
    return { desc: 'Paper sticker', overrideHS: '4911998000', rule: 'title-sticker' };
  }

  const key = normHS(harmonizedCode);
  const exact = HS_DESCRIPTION_RULES[key];
  if (exact) return { desc: exact(titleOrDesc), rule: 'exact' };

  const fuzzy = pickByPrefix(key, titleOrDesc);
  if (fuzzy) return { desc: fuzzy, rule: 'prefix' };

  return { desc: (titleOrDesc || ''), rule: 'fallback' };
}

module.exports = {
  titleForcesSticker,
  HS_DESCRIPTION_RULES,
  normHS,
  getHS,
  pickByPrefix,
  pickCustomsDescription
};
