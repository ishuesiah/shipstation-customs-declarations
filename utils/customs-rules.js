// utils/customs-rules.js - CORRECTED VERSION WITH B5 NOTEBOOK HANDLING

// Title keywords for product identification
const INSERT_KEYWORDS = /\b(inserts)\b/i;  // Check this FIRST
const PLANNER_KEYWORDS = /\b(planner)\b/i;
const NOTEBOOK_KEYWORDS = /\b(notebook|sketchbook)\b/i;
const STICKY_KEYWORDS = /\b(sticky|stickies|sticky\s*notes?|post-?its?)\b/i;
const NOTEPAD_KEYWORDS = /\b(notepad)\b/i;
const STICKER_KEYWORDS = [
  /monthly\s+tabs?/i,
  /\bstickers?\b/i,
  /time\s*management/i,
  /square\s*bullets?/i,
  /\bfinance\b/i,
  /\bwellness\b/i,
  /wildflowers?/i,
  /botanical\s+stickers?/i,
  /sticker\s*sheet/i,
  /shaded\s+box(es)?/i,        // Add this
  /lists?\s*-\s*top\s*three/i,  // Add this
  /\bhighlight(s)?\b/i          // Add this for "Highlight Stickers"
];

function titleForcesSticker(title) {
  const t = String(title || '');
  return STICKER_KEYWORDS.some(rx => rx.test(t));
}

// Fix ONLY obviously malformed codes (missing digits, etc)
// Don't assume what product type it should be
function fixMalformedHS(code) {
  const cleaned = String(code || '').replace(/[^0-9]/g, '');
  
  // Only fix structural issues, not product type issues
  if (cleaned.length === 8 && cleaned.startsWith('2048')) {
    // Missing leading 4 for paper products
    return '4' + cleaned;
  }
  if (cleaned.length === 7 && cleaned.startsWith('820')) {
    // Missing leading 4 and a 0
    return '4' + cleaned.slice(0, 3) + '0' + cleaned.slice(3);
  }
  if (cleaned === '48201020') {
    // Missing last 2 digits - don't assume which product!
    return cleaned + '00'; // Generic suffix
  }
  
  return cleaned;
}

// Determine product type from title
function identifyProductFromTitle(title) {
  const t = String(title || '').toLowerCase();
  
  // Check in order of specificity - INSERTS FIRST!
  if (titleForcesSticker(title)) return 'sticker';
  if (INSERT_KEYWORDS.test(t)) return 'insert';  
  if (STICKY_KEYWORDS.test(t)) return 'sticky';
  if (PLANNER_KEYWORDS.test(t)) return 'planner';
  if (/\bmt\s+washi\b/i.test(title)) return 'tape';
  
  // Special handling for notebooks with B5
  if (NOTEBOOK_KEYWORDS.test(t)) {
    // Check if it's a B5 notebook specifically
    if (/\bB5\b/i.test(title)) {
      return 'notebook-b5';
    }
    return 'notebook';
  }
  
  if (NOTEPAD_KEYWORDS.test(t)) return 'notepad';
  
  // Check for other specific products
  if (/\bpen\b/.test(t)) return 'pen';
  if (/\belastic\b/.test(t)) return 'elastic';
  if (/\bcharm\b/.test(t)) return 'charm';
  if (/\bclip/.test(t)) return 'clip';
  if (/\btape\b/.test(t)) return 'tape';
  if (/\bpocket\b/.test(t)) return 'pocket';
  if (/(bracelet|pendant|stud|earring|jewellery|jewelry)/.test(t)) return 'jewelry';
  
  return null;
}

// Map product type to correct HS and description
function getCorrectHSAndDescription(productType) {
  switch(productType) {
    case 'sticker':
      return { hs: '4911998000', desc: 'Paper sticker' };
    case 'sticky':
      return { hs: '4820102020', desc: 'Sticky notepad' };
    case 'planner':
      return { hs: '4820102010', desc: 'Planner agenda (bound diary)' };
    case 'notebook-b5': 
      return { hs: '4820102030', desc: 'Notebook (sewn journal, B5 size)' };
    case 'notebook':
      return { hs: '4820102060', desc: 'Notebook (bound journal)' };
    case 'notepad':
      return { hs: '4820102020', desc: 'Notepad' };
    case 'insert':
      return { hs: '4820900000', desc: 'Planner inserts (loose refills)' };
    case 'pen':
      return { hs: '9608100000', desc: 'Gel ink pen' };
    case 'elastic':
      return { hs: '6307909800', desc: 'Elastic for notebook' };
    case 'charm':
      return { hs: '7117909000', desc: 'Charm for notebook ribbon' };
    case 'clip':
      return { hs: '8305903010', desc: 'Office paper clips' };
    case 'tape':
      return { hs: '4811412100', desc: 'Decorative tape for journaling' };
    case 'pocket':
      return { hs: '4811412100', desc: 'Paper pocket for notebook' };
    case 'jewelry':
      return { hs: '7113115000', desc: 'Sterling silver jewellery' };
    case 'tape': 
      return { hs:'4811412100', desc: 'Decorative tape for journaling'};
    default:
      return null;
  }
}

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

// MAIN PICKER
function pickCustomsDescription(harmonizedCode, titleOrDesc) {
  const title = String(titleOrDesc || '');
  
  // FIRST: Identify product from title - this takes priority!
  const productType = identifyProductFromTitle(title);
  
  if (productType) {
    // We know what it is from the title, so use the correct HS
    const correct = getCorrectHSAndDescription(productType);
    if (correct) {
      // Always override with the correct HS for this product type
      return { 
        desc: correct.desc, 
        overrideHS: correct.hs,  // Always override when identified by title
        rule: `title-${productType}` 
      };
    }
  }
  
  // If we couldn't identify from title, try to use the HS code
  const fixedHS = fixMalformedHS(harmonizedCode);
  const key = normHS(fixedHS);
  
  // Check exact match with fixed HS
  const exact = HS_DESCRIPTION_RULES[key];
  if (exact) return { desc: exact(title), rule: 'exact' };
  
  // Try prefix matching
  const fuzzy = pickByPrefix(key, title);
  if (fuzzy) return { desc: fuzzy, rule: 'prefix' };
  
  // Last resort - use the title as description
  return { desc: title, rule: 'fallback' };
}

// Your existing HS_DESCRIPTION_RULES...
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

// Keep the prefix function for backward compatibility
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

module.exports = {
  titleForcesSticker,
  HS_DESCRIPTION_RULES,
  normHS,
  getHS,
  pickByPrefix,
  pickCustomsDescription,
  fixMalformedHS,
  identifyProductFromTitle,
  getCorrectHSAndDescription  // Add this line
};