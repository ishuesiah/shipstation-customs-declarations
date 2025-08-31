/* public/sku-generator.js */
(function () {
    class SKUGenerator {
      constructor(rules, opts = {}) {
        this.rules = rules;
        this.IM_CODE = opts.imperfectCode || 'IM';
        this.MAX = opts.maxLength || 20;
      }
  
      // ---------- finders ----------
      _findYear(s)           { const m = (s||'').match(this.rules.yearRegex); return m ? m[1].slice(2) : ''; }
      _findProductType(pt)   { return this._pick(pt, this.rules.productTypes); }
      _findSubtype(hay)      { return this._pick(hay, this.rules.subtypes); }
      _findCollection(pt)    { return this._pick(pt, this.rules.collections); }
      _isImperfect(...parts) { return parts.some(p => this.rules.imperfectRegex.test(p||'')); }
  
      _findColor(pt, vt, optsArr=[]) {
        const sources = [...optsArr, vt, pt].filter(Boolean);
        for (const src of sources) {
          const c = this._pick(src, this.rules.colors);
          if (c) return c;
        }
        // Fallback: derive a compact code from the variant if nothing matched
        if (vt && !this._isNumericOnly(vt) && !this._isGenericVariant(vt)) {
          return this.rules.fallback3(vt);
        }
        return '';
      }
  
      _findMotif(pt, vt) {
        return this._pick(`${pt} ${vt}`, this.rules.motifs);
      }
  
      _findJewelryType(pt) {
        return this._pick(pt, this.rules.jewelryTypes);
      }
  
      _findMaterial(optsArr=[], hay='') {
        const sources = [...optsArr, hay];
        for (const src of sources) {
          const m = this._pick(src, this.rules.materials);
          if (m) return m;
        }
        return '';
      }
  
      _findPack(optsArr=[], hay='') {
        const sources = [...optsArr, hay];
        for (const src of sources) {
          const p = this._pick(src, this.rules.packs);
          if (p) return p;
        }
        return '';
      }
  
      _findSize(optsArr=[], pt='', vt='') {
        const sources = [...optsArr, vt, pt];
        for (const src of sources) {
          const s = this._pick(src, this.rules.sizes);
          if (s) return s;
        }
        // Also catch A5/B5/TN written plainly anywhere
        const m = (/(^|\s)(A5|B5|TN)(\s|$)/i.exec(`${pt} ${vt}`)||[]);
        return m[2] || '';
      }
  
      // Case-insensitive dictionary match, prefers longer keys
      _pick(text, dict) {
        if (!text || !dict) return '';
        const s = String(text).toLowerCase();
        const keys = Object.keys(dict).sort((a,b)=>b.length-a.length);
        for (const k of keys) if (s.includes(k.toLowerCase())) return dict[k];
        return '';
      }
  
      // ---------- helpers ----------
      _joinAndTrim(parts) {
        let sku = parts.filter(Boolean).join('-').toUpperCase();
        if (sku.length <= this.MAX) return sku;
  
        const segments = sku.split('-');
  
        // 1) drop pack codes like SN/PR/S2 if present
        const packIdx = segments.findIndex(x => /^(SN|PR|S\d)$/i.test(x));
        if (packIdx > -1) { segments.splice(packIdx, 1); sku = segments.join('-'); if (sku.length <= this.MAX) return sku; }
  
        // 2) drop common subtype/collection tokens if still long
        const dropOne = ['LMN','BLNK','DOT','LIN','GRD'];
        for (let i=segments.length-1; i>=0 && sku.length>this.MAX; i--) {
          if (dropOne.includes(segments[i])) { segments.splice(i,1); sku = segments.join('-'); }
        }
        if (sku.length <= this.MAX) return sku;
  
        // 3) last resort: compact (remove hyphens)
        return sku.replace(/-/g, '').slice(0, this.MAX);
      }
  
      _appendSuffix(base, suffix) {
        const hy = `${base}-${suffix}`;
        if (hy.length <= this.MAX) return hy;
        const tight = `${base}${suffix}`;
        if (tight.length <= this.MAX) return tight;
        const compact = base.replace(/-/g,'').slice(0, Math.max(0, this.MAX - suffix.length));
        return `${compact}${suffix}`.toUpperCase();
      }
  
      _uniqueify(base, isUsed) {
        if (!base) base = 'SKU';
        if (!isUsed(base)) return base;
        const L='ABCDEFGHIJKLMNOPQRSTUVWXYZ';
        for (let i=0;i<L.length;i++) for (let j=0;j<L.length;j++) {
          const cand = this._appendSuffix(base, L[i]+L[j]);
          if (!isUsed(cand)) return cand;
        }
        const fb = this._appendSuffix(base, Date.now().toString(36).slice(-2).toUpperCase());
        return fb.slice(0, this.MAX);
      }
  
      _isNumericOnly(s='') { return /^\s*[$€£]?\s*\d+(\.\d{2})?\s*$/.test(s); }
      _isGenericVariant(s='') { return /^(default( title)?|standard|regular)$/i.test(String(s).trim()); }
  
      _giftAmount(pt='', vt='') {
        const grab = (txt) => {
          const m = String(txt||'').match(/([$€£]?\s*)(\d{1,4})(?:\.\d{2})?/);
          return m ? m[2] : '';
        };
        return grab(vt) || grab(pt) || '';
      }
  
      // Ensure we have at least two informative tokens
      _ensureDescriptive(parts, fallbackFrom) {
        const compact = parts.filter(Boolean);
        if (compact.length >= 2) return parts;
  
        const fb = this.rules.fallback3(fallbackFrom || '');
        if (fb) compact.push(fb);
  
        return compact;
      }
  
      // ---------- main ----------
      generate(productTitle, variantTitle, isUsedFn, optionsArr=[]) {
        const pt = productTitle || '';
        const vt = variantTitle || '';
        const hay = `${pt} ${vt}`.trim();
  
        // Brand: MT Washi → MT-WAS-COLOR
        const brandHit = (this.rules.brands || []).find(b => b.test.test(pt));
        if (brandHit) {
          const color = this._findColor(pt, vt, optionsArr) || this.rules.fallback3(vt || pt);
          const base = this._joinAndTrim([brandHit.code, this.rules.washiType, color]);
          return this._uniqueify(base, isUsedFn);
        }
  
        // Jewelry
        const jType = this._findJewelryType(pt);
        if (jType) {
          const motif    = this._findMotif(pt, vt) || this._findColor(pt, vt, optionsArr) || this.rules.fallback3(pt);
          const pack     = this._findPack(optionsArr, hay);
          const material = this._findMaterial(optionsArr, hay);
          const base = this._joinAndTrim(['JWL', motif, jType, pack, material]);
          return this._uniqueify(base, isUsedFn);
        }
  
        // Product primitives
        const year        = this._findYear(hay);
        const type        = this._findProductType(pt);
        const subtype     = this._findSubtype(hay);
        const collection  = this._findCollection(pt);
        const size        = this._findSize(optionsArr, pt, vt);
        const color       = this._findColor(pt, vt, optionsArr);
        const imperfect   = this._isImperfect(pt, vt);
  
        // Gift Card: GFT-<amount>
        if (type === 'GFT' || /gift\s*card/i.test(pt)) {
          const amt = this._giftAmount(pt, vt);
          const base = this._joinAndTrim(['GFT', amt || this.rules.fallback3(vt || pt)]);
          return this._uniqueify(base, isUsedFn);
        }
  
        // Regular goods
        let parts;
        if (!year && type === 'NTB') {
          // Undated notebook pattern: NTB-BLNK-LMN-WIS
          parts = [type, subtype, collection, color];
          if (size) parts.splice(2, 0, size); // put size after type
          if (imperfect) parts.push(this.IM_CODE);
        } else if (type === 'INS' || type === 'RFL') {
          // Inserts/Refills: require a size; ensure color/motif if available
          parts = [type, size || '', subtype || '', collection || '', color || ''];
          parts = this._ensureDescriptive(parts, vt || pt);
          if (imperfect) parts.push(this.IM_CODE);
        } else {
          // General pattern
          parts = [];
          if (year) parts.push(year);
          if (type) parts.push(type);
          if (subtype) parts.push(subtype);
          if (collection) parts.push(collection);
          if (size) parts.push(size);
          if (color) parts.push(color);
  
          // If we only got one token (e.g., CLP-ELS), enforce a variant fallback
          if (parts.filter(Boolean).length < 2) {
            const fb = this.rules.fallback3(vt || pt);
            if (fb) parts.push(fb);
          }
  
          if (imperfect) parts.push(this.IM_CODE);
        }
  
        let base = this._joinAndTrim(parts);
  
        // Last-resort fallback (should be rare now)
        if (!base) {
          const fb = this.rules.fallback3(vt || pt);
          base = this._joinAndTrim([type || collection || fb, fb]);
          if (!base) base = fb || 'SKU';
        }
  
        return this._uniqueify(base, isUsedFn);
      }
    }
  
    window.SKUGenerator = SKUGenerator;
  })();
  