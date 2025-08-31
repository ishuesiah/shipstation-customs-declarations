/* public/sku-rules.js */
(function () {
    // 3-char product types
    const productTypes = {
      'daily planner': 'DLP', 'daily': 'DLP',
      'weekly planner': 'WKP', 'weekly': 'WKP',
      'horizontal planner': 'HLP', 'horizontal': 'HLP',
      'insert': 'INS', 'inserts': 'INS',
      'refill': 'RFL', 'refills': 'RFL',
      'notebook': 'NTB', 'notebooks': 'NTB',
      'journal': 'NTB',
      'stickers': 'STK',
      'gift card': 'GFT',
    };
  
    // Notebook/insert sub-types we want to show (so NTB-BLNK-…)
    const subtypes = {
      'blank': 'BLNK',
      'dotted': 'DOT',
      'dot grid': 'DOT',
      'graph': 'GRD', 'grid': 'GRD',
      'lined': 'LIN',
      'weekly inserts': 'WKL', 'horizontal inserts': 'HNL',
    };
  
    // Collections / families
    const collections = {
      'jewlry': 'JWL', 'jewellery': 'JWL',
      'undated': 'UND',
      'minimalist': 'MIN',
      'square bullets': 'SQB',
      'square bullet': 'SQB',
      'time management': 'TMG',
      'monthly tab': 'TAB',
      'wellness': 'WLN',
      'decorative': 'DCR',
      'highlight': 'HLT',
      'charm': 'CHRM',
      'bundle': 'BNDL',
      'signature planner bundle': 'PLNR-BNDL',
      'clip band elastics': 'CLP-ELS',
      'printable': 'PRNT',
      'finance': 'FIN',
    };
  
    // Jewelry type detection
    const jewelryTypes = {
      'earring': 'EAR', 'earrings': 'EAR', 'stud': 'EAR', 'studs': 'EAR',
      'bracelet': 'BRC', 'bracelets': 'BRC',
      'pendant': 'PND', 'pendants': 'PND',
      'necklace': 'NCK', 'necklaces': 'NCK',
      'ring': 'RNG', 'rings': 'RNG',
    };
  
    // Metals / materials
    const materials = {
      'gold': 'GLD', '14k gold': 'GLD-14', '18k gold': 'GLD-18', 'gold-plated': 'GLD',
      'silver': 'SLV', 'sterling silver': 'SLV',
      'rose gold': 'RGL', 'brass': 'BRS', 'steel': 'STL'
    };
  
    // Pack size (true packs for jewelry etc.)
    const packs = {
      'single': 'SN', 'one': 'SN',
      'pair': 'PR', 'pairs': 'PR',
    };
  
    // Paper/insert sizes (separate from packs so we can require size for inserts/refills)
    const sizes = {
      'a5': 'A5',
      'b5': 'B5',
      'tn': 'TN',
      'half letter': 'HL',
      'classic': 'CL',
      'classic hp': 'CL',
      'discbound - half letter': 'DB-HL',
      'disc-bound classic hp': 'DB-CL',
    };
  
    // Brands (Washi special)
    const brands = [
      { test: /mt\s*washi/i, code: 'MT' },
      { test: /(^|\s)mt(\s|$)/i, code: 'MT' },
    ];
  
    // “Washi” type code
    const washiType = 'WAS';
  
    // Colors / motifs (trimmed list – add as needed)
    const colors = {
      'charbon': 'CHB', 'witching hour': 'WCH', 'willow': 'WIL', 'wild orchid': 'WOR',
      'pacific': 'PAC', 'juniper': 'JUN', 'deep aster': 'DAH', 'aster': 'AST', 'slate': 'SLA',
      'moss': 'MOS', 'rivière': 'RIV', 'riviere': 'RIV', 'light riviere': 'LRV',
      'enchanted forest': 'ECF', 'autumnal': 'AUT', 'blossomfield': 'BLO', 'fawn': 'FWN',
      'elderberry': 'ELD', 'lilac': 'LIL', 'secret garden': 'SCG', 'rosewood': 'RWO',
      'wisteria': 'WIS', 'marigold': 'MRG', 'white oak': 'WOK', 'oak': 'OAK', 'nimbus': 'NIM',
      'toile de lin': 'TDL', 'deep forest': 'DPF', 'deep oak': 'DPO',
      // tapes / stickers / prints (examples)
      'washi': 'WSH', 'pink': 'PNK', 'pink dots': 'PND', 'glacial': 'GLC',
      'pastel cream': 'PCR', 'mocha': 'MOC', 'evergreen': 'EVG', 'empress blue': 'EMB',
      'aqua': 'AQA', 'matte white': 'MWH', 'fog': 'FOG', 'lichen': 'LIC', 'sweet almond': 'SWA',
      'dahlia': 'DAH', 'hyacinth': 'HYA', 'matte purple': 'MAP', 'dusty mint': 'DUM',
      'moonflower': 'MNF', 'oasis': 'OAS', 'pewter': 'PEW', 'heart spot': 'HSP',
      'pink bubbles': 'PKB', 'pink star': 'PKS', 'gold star': 'GST', 'red star': 'RST',
      'pink mini dots': 'PMD', 'red mini dots': 'RMD', 'pink waves': 'PW', 'teal waves': 'TW',
      'diamond mini grid': 'DMG', 'gold square graph': 'GSG', 'blue square graph grid': 'BSG',
      'cyan square grid': 'CSG', 'milk tea dots': 'MTD', 'navy mini dots': 'NVM',
      'silver dots': 'SLD', 'navy blue stripes': 'NBS', 'light blue stripes': 'LBS',
      'peony': 'PNY', 'light earth': 'LTE', 'meadow': 'MDW', 'sea to sky': 'STS',
      'life in pastels': 'LFP', 'foxberry': 'FXB', 'matte black': 'MTB', 'summer solstice': 'SMT',
      'spring neutrals': 'SPN', 'hydrangea': 'HDR', 'lakeside': 'LKS', 'poplar': 'PLR',
      'clove': 'CLV', 'mulberry': 'MLB', 'lavande': 'LVD', 'matte gold': 'MAG',
      'buttercup': 'BTR', 'snapdragon':'SNP', 'woodlands': 'WDL', 'wild indigo':'WIN', 'plum grove':'PLG',
    };
  
    const motifs = {
      'lunar': 'LNR',
      'lumine': 'LUM',
      'solstice': 'SOL',
      'rabbit': 'RBT',
      'heart of the forest': 'HOF',
      'mushroom': 'MSH',
      'hummingbird': 'HUM',
      'jardin': 'JAR',
      'floriculture': 'FLC',
      'monarque': 'MON',
      'blank': 'BLNK',
      'heart of the forest lined notebook':'HOF',
      'heart of the forest dotted notebook':'HOF',
    };
  
    const imperfectRegex = /\bimperfect|imperfection(s)?\b/i;
    const yearRegex = /\b(20\d{2})\b/;
  
    // Default compact code when no dictionary match is found
    function fallback3(str) {
      const words = (str || '').toUpperCase().replace(/[^A-Z0-9\s]/g, ' ').trim().split(/\s+/).filter(Boolean);
      if (words.length === 0) return 'XXX';
      if (words.length === 1) return words[0].slice(0, 3).padEnd(3, 'X');
      // Prefer first 3 letters of first word for readability (e.g., Midnight Stars -> MID)
      return (words[0].slice(0, 3)).padEnd(3, 'X');
    }
  
    window.SKU_RULES = {
      productTypes, subtypes, collections,
      jewelryTypes, materials, packs, sizes,
      brands, washiType,
      colors, motifs,
      imperfectRegex, yearRegex, fallback3,
    };
  })();
  