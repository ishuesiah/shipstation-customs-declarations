// Fuzzy name matching utilities for SKU resolution

function _norm(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function _normalizeToken(tok) {
  if (!tok) return '';
  if (/^tabs?$/.test(tok) || /^stickers?$/.test(tok) || /^tab[- ]?stickers?$/.test(tok)) return 'sticker';
  if (/^wildflowers?$/.test(tok)) return 'wildflower';
  if (/^botanicals?$/.test(tok)) return 'botanical';
  return tok;
}

function _tokens(name) {
  return _norm(name).split(' ').map(_normalizeToken).filter(Boolean);
}

function _scoreNameMatch(queryName, candidateName) {
  const tqArr = _tokens(queryName);
  const tcArr = _tokens(candidateName);
  const tq = new Set(tqArr);
  const tc = new Set(tcArr);

  const inter = new Set([...tq].filter(x => tc.has(x)));
  const union = new Set([...tq, ...tc]);

  const coverage = inter.size / Math.max(1, tq.size);
  const jaccard  = inter.size / Math.max(1, union.size);

  let bonus = 0;
  const distinctive = ['woodlands','enchanted','forest','botanical','sticker','monthly','tabs'];
  distinctive.forEach(w => { if (tq.has(w) && tc.has(w)) bonus += 0.05; });

  const score = Math.min(1, 0.7 * coverage + 0.25 * jaccard + bonus);
  return { score, coverage, jaccard };
}

function _nameVariants(name) {
  const variants = new Set();
  variants.add(name);

  const beforeDash = name.split(' - ')[0];
  if (beforeDash && beforeDash.length >= 4) variants.add(beforeDash);

  variants.add(name.replace(/tabs?/ig, 'sticker'));
  variants.add(name.replace(/stickers?/ig, 'sticker'));

  return Array.from(variants);
}

module.exports = {
  _norm,
  _normalizeToken,
  _tokens,
  _scoreNameMatch,
  _nameVariants
};
