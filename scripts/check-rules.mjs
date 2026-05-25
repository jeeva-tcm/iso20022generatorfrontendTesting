#!/usr/bin/env node
/**
 * Generic CBPR+ schema cross-checker.
 *
 * Usage:
 *   node scripts/check-rules.mjs <component-name>
 *   node scripts/check-rules.mjs --all
 *
 * <component-name> matches a folder under src/app/pages/manual-entry/.
 * The script auto-resolves the matching JSON schema from validation-rules/ by
 * filename keyword (pacs_008, pacs_009, pacs_009_ADV, pacs_009_COV, camt_057).
 *
 * Reports only TRUE leaks where the form is LOOSER than the schema:
 *   - maxLength missing or higher than schema's
 *   - pattern missing entirely (form has no Validators.pattern AND no aliased pattern var)
 *   - minLength below schema's minimum
 * Stricter form rules are accepted silently (intentional business overrides).
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const SCHEMA_DIR = path.join(ROOT, 'validation-rules');
const PAGES_DIR = path.join(ROOT, 'src/app/pages/manual-entry');

// component slug → expected schema filename keyword AND form-key prefix conventions used in that component
const COMPONENT_MAP = {
  pacs8:    { schemaKey: 'pacs_008_001_08_FIToFI',                    label: 'pacs.008.001.08' },
  pacs9:    { schemaKey: 'pacs_009_001_08_FinancialInstitution',      label: 'pacs.009.001.08 (core)' },
  pacs9adv: { schemaKey: 'pacs_009_001_08_ADV',                       label: 'pacs.009.001.08 ADV' },
  pacs9cov: { schemaKey: 'pacs_009_001_08_COV',                       label: 'pacs.009.001.08 COV' },
  camt057:  { schemaKey: 'camt_057_001_06',                           label: 'camt.057.001.06' },
};

// Suffix → CBPR+ type ref. Stable across all ISO 20022 message families.
const SUFFIX_MAP = [
  { suffix: 'OrgClrSysMmbId',    ref: 'CBPR_RestrictedFINXMax28Text' },
  { suffix: 'ClrSysMmbId',       ref: 'CBPR_RestrictedFINXMax28Text' },
  { suffix: 'MmbId',             ref: 'CBPR_RestrictedFINXMax28Text' },
  { suffix: 'OrgClrSysCd',       ref: 'ExternalClearingSystemIdentification1Code' },
  { suffix: 'ClrSysCd',          ref: 'ExternalClearingSystemIdentification1Code' },
  { suffix: 'ClrSysId',          ref: 'ExternalClearingSystemIdentification1Code' },
  { suffix: 'OrgAnyBIC',         ref: 'AnyBICDec2014Identifier' },
  { suffix: 'OrgAnyBic',         ref: 'AnyBICDec2014Identifier' },
  { suffix: 'AnyBIC',            ref: 'AnyBICDec2014Identifier' },
  { suffix: 'BICFI',             ref: 'BICFIDec2014Identifier' },
  { suffix: 'BIC',               ref: 'BICFIDec2014Identifier' },
  { suffix: 'Bic',               ref: 'BICFIDec2014Identifier' },
  { suffix: 'OrgLEI',            ref: 'LEIIdentifier' },
  { suffix: 'LEI',               ref: 'LEIIdentifier' },
  { suffix: 'Lei',               ref: 'LEIIdentifier' },
  { suffix: 'uetr',              ref: 'UUIDv4Identifier' },
  { suffix: 'UETR',              ref: 'UUIDv4Identifier' },
  { suffix: 'CtryOfRes',         ref: 'CountryCode' },
  { suffix: 'Ctry',              ref: 'CountryCode' },
  { suffix: 'Ccy',               ref: 'ActiveOrHistoricCurrencyCode' },
  { suffix: 'currency',          ref: 'ActiveOrHistoricCurrencyCode' },
  { suffix: 'DtTm',              ref: 'CBPR_DateTime' },
  { suffix: 'creDtTm',           ref: 'CBPR_DateTime' },
  { suffix: 'sttlmDt',           ref: 'ISODate' },
  { suffix: 'Dt',                ref: 'ISODate' },
  { suffix: 'msgId',             ref: 'CBPR_RestrictedFINXMax35Text' },
  { suffix: 'bizMsgId',          ref: 'CBPR_RestrictedFINXMax35Text' },
  { suffix: 'instrId',           ref: 'CBPR_RestrictedFINXMax35Text' },
  { suffix: 'endToEndId',        ref: 'CBPR_RestrictedFINXMax35Text' },
  { suffix: 'txId',              ref: 'CBPR_RestrictedFINXMax35Text' },
  { suffix: 'clrSysRef',         ref: 'CBPR_RestrictedFINXMax35Text' },
  { suffix: 'mndtId',            ref: 'CBPR_RestrictedFINXMax35Text' },
  { suffix: 'Id',                ref: 'CBPR_RestrictedFINXMax35Text' },
  { suffix: 'AdrLine1',          ref: 'CBPR_RestrictedFINXMax70Text_Extended' },
  { suffix: 'AdrLine2',          ref: 'CBPR_RestrictedFINXMax70Text_Extended' },
  { suffix: 'StrtNm',            ref: 'CBPR_RestrictedFINXMax70Text_Extended' },
  { suffix: 'Dept',              ref: 'CBPR_RestrictedFINXMax70Text_Extended' },
  { suffix: 'SubDept',           ref: 'CBPR_RestrictedFINXMax70Text_Extended' },
  { suffix: 'Flr',               ref: 'CBPR_RestrictedFINXMax70Text_Extended' },
  { suffix: 'Room',              ref: 'CBPR_RestrictedFINXMax70Text_Extended' },
  { suffix: 'BldgNb',            ref: 'CBPR_RestrictedFINXMax16Text_Extended' },
  { suffix: 'PstBx',             ref: 'CBPR_RestrictedFINXMax16Text_Extended' },
  { suffix: 'PstCd',             ref: 'CBPR_RestrictedFINXMax16Text_Extended' },
  { suffix: 'BldgNm',            ref: 'CBPR_RestrictedFINXMax35Text_Extended' },
  { suffix: 'TwnNm',             ref: 'CBPR_RestrictedFINXMax35Text_Extended' },
  { suffix: 'TwnLctnNm',         ref: 'CBPR_RestrictedFINXMax35Text_Extended' },
  { suffix: 'DstrctNm',          ref: 'CBPR_RestrictedFINXMax35Text_Extended' },
  { suffix: 'CtrySubDvsn',       ref: 'CBPR_RestrictedFINXMax35Text_Extended' },
  { suffix: 'Name',              ref: 'CBPR_RestrictedFINXMax140Text_Extended' },
  { suffix: 'Nm',                ref: 'CBPR_RestrictedFINXMax140Text_Extended' },
  { suffix: 'AcctIban',          ref: 'IBAN2007Identifier' },
  { suffix: 'Iban',              ref: 'IBAN2007Identifier' },
  { suffix: 'Acct',              ref: 'CBPR_RestrictedFINXMax34Text' },
];

function braceMatch(s, openIdx) {
  let d = 0;
  for (let k = openIdx; k < s.length; k++) {
    if (s[k] === '{') d++;
    else if (s[k] === '}') { d--; if (d === 0) return k; }
  }
  return -1;
}

function harvestPatternAliases(src) {
  const out = {};
  const re = /const\s+([A-Z][A-Z0-9_]*)\s*=\s*Validators\.pattern\s*\(\s*\/((?:\\.|[^\/\n])+)\/[a-z]*\s*\)/g;
  let m;
  while ((m = re.exec(src)) !== null) out[m[1]] = m[2];
  const re2 = /const\s+([A-Z][A-Z0-9_]*)\s*=\s*\[[^\]]*Validators\.pattern\s*\(\s*\/((?:\\.|[^\/\n])+)\/[a-z]*\s*\)/g;
  while ((m = re2.exec(src)) !== null) out[m[1]] = out[m[1]] || m[2];
  return out;
}

function extractCatalog(schema) {
  const catalog = {};
  for (const [name, def] of Object.entries(schema.definitions || {})) {
    if (def.type === 'string' || def.enum) {
      catalog[name] = {
        pattern: def.pattern,
        minLength: def.minLength,
        maxLength: def.maxLength,
        enum: def.enum,
        description: (def.description || '').slice(0, 80),
      };
    }
  }
  return catalog;
}

function extractFields(ts) {
  const aliases = harvestPatternAliases(ts);
  // Find every buildForm() body
  const bfMatch = ts.match(/(?:private\s+)?(?:buildForm)\s*\(\s*\)\s*\{/);
  if (!bfMatch) return [];
  const bfStart = ts.indexOf('{', bfMatch.index);
  const bfEnd = braceMatch(ts, bfStart);
  const bfBody = ts.slice(bfStart + 1, bfEnd);

  const fields = [];
  // 1) literal `key: [default, validators...],`
  const lines = bfBody.split('\n');
  let pending = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(/^\s*([A-Za-z_][\w]*)\s*:\s*\[(.*)$/);
    if (m) {
      if (pending) fields.push(pending);
      pending = { name: m[1], raw: m[2] };
    } else if (pending) {
      pending.raw += '\n' + line;
    }
    if (pending && pending.raw.includes(']')) {
      let depth = 1;
      let endIdx = -1;
      for (let p = 0; p < pending.raw.length; p++) {
        const ch = pending.raw[p];
        if (ch === '[') depth++;
        else if (ch === ']') { depth--; if (depth === 0) { endIdx = p; break; } }
      }
      if (endIdx !== -1) {
        pending.raw = pending.raw.slice(0, endIdx);
        fields.push(pending);
        pending = null;
      }
    }
  }
  if (pending) fields.push(pending);

  // 2) prefix-loop assigns: `if (!c[p+'X']) c[p+'X'] = ['', ...]`
  for (const l of ts.split('\n')) {
    const m1 = l.match(/^\s*if\s*\(\s*!c\[\s*p\s*\+\s*'([A-Za-z_][\w]*)'\s*\]\s*\)\s*c\[\s*p\s*\+\s*'\1'\s*\]\s*=\s*\[(.*)\]\s*;?\s*$/);
    if (m1) {
      fields.push({ name: '{prefix}' + m1[1], raw: m1[2], suffixHint: m1[1] });
      continue;
    }
    // 3) c['literal'] = ['', ...]
    const m2 = l.match(/^\s*c\[\s*'([A-Za-z_][\w]*)'\s*\]\s*=\s*\[(.*)\]\s*;?\s*$/);
    if (m2) {
      fields.push({ name: m2[1], raw: m2[2] });
    }
    // 4) form.addControl('name', fb.control('', validators))
    const m3 = l.match(/\.addControl\s*\(\s*[pP]\s*\+\s*'([A-Za-z_][\w]*)'\s*,\s*this\.fb\.control\s*\(\s*[^,]*,\s*(.*)\)\s*\)/);
    if (m3) {
      fields.push({ name: '{prefix}' + m3[1], raw: m3[2], suffixHint: m3[1] });
    }
    const m4 = l.match(/\.addControl\s*\(\s*'([A-Za-z_][\w]*)'\s*,\s*this\.fb\.control\s*\(\s*[^,]*,\s*(.*)\)\s*\)/);
    if (m4) {
      fields.push({ name: m4[1], raw: m4[2] });
    }
  }

  // Parse validator string into {required, maxLength, minLength, pattern}
  function parseValidators(raw) {
    const info = { required: false, pattern: null, minLength: null, maxLength: null };
    if (/Validators\.required\b/.test(raw)) info.required = true;
    const mx = raw.match(/Validators\.maxLength\s*\(\s*(\d+)\s*\)/);
    if (mx) info.maxLength = +mx[1];
    const mn = raw.match(/Validators\.minLength\s*\(\s*(\d+)\s*\)/);
    if (mn) info.minLength = +mn[1];
    const pp = raw.match(/Validators\.pattern\s*\(\s*\/((?:\\.|[^\/\n])+)\/[a-z]*\s*\)/);
    if (pp) info.pattern = pp[1];
    if (!info.pattern) {
      for (const [name, pat] of Object.entries(aliases)) {
        if (new RegExp(`\\b${name}\\b`).test(raw)) { info.pattern = pat; break; }
      }
    }
    return info;
  }

  return fields.map(f => ({ name: f.name, suffix: f.suffixHint || null, ...parseValidators(f.raw) }));
}

function inferRef(name, suffixHint) {
  const sources = [];
  if (suffixHint) sources.push(suffixHint);
  sources.push(name);
  for (const s of SUFFIX_MAP) {
    for (const src of sources) {
      if (src.endsWith(s.suffix)) return s.ref;
    }
  }
  return null;
}

function checkOne(componentSlug) {
  const cfg = COMPONENT_MAP[componentSlug];
  if (!cfg) {
    console.error(`Unknown component '${componentSlug}'. Known: ${Object.keys(COMPONENT_MAP).join(', ')}`);
    process.exit(2);
  }

  // Resolve schema file
  const schemaFiles = fs.readdirSync(SCHEMA_DIR).filter(f => f.endsWith('.json'));
  const schemaFile = schemaFiles.find(f => f.toLowerCase().includes(cfg.schemaKey.toLowerCase()));
  if (!schemaFile) {
    console.log(`[${componentSlug}] No schema file in validation-rules/ matching '${cfg.schemaKey}' — SKIPPING.`);
    return { slug: componentSlug, issues: [], skipped: true };
  }
  const schema = JSON.parse(fs.readFileSync(path.join(SCHEMA_DIR, schemaFile), 'utf8'));
  const catalog = extractCatalog(schema);

  // Resolve component .ts
  const tsPath = path.join(PAGES_DIR, componentSlug, `${componentSlug}.component.ts`);
  if (!fs.existsSync(tsPath)) {
    console.error(`[${componentSlug}] component file not found: ${tsPath}`);
    process.exit(3);
  }
  const ts = fs.readFileSync(tsPath, 'utf8');
  const fields = extractFields(ts);

  const issues = [];
  for (const f of fields) {
    const ref = inferRef(f.name, f.suffix);
    if (!ref) continue;
    const rule = catalog[ref];
    if (!rule) continue;
    const probs = [];
    if (rule.maxLength != null) {
      if (f.maxLength == null) probs.push(`MISSING maxLength (rule=${rule.maxLength})`);
      else if (f.maxLength > rule.maxLength) probs.push(`maxLength too LOOSE: form=${f.maxLength} > rule=${rule.maxLength}`);
    }
    if (rule.pattern && !f.pattern) probs.push(`MISSING pattern (rule=${rule.pattern.slice(0, 60)})`);
    if (rule.minLength != null && f.minLength != null && f.minLength < rule.minLength) {
      probs.push(`minLength too LOOSE: form=${f.minLength} < rule=${rule.minLength}`);
    }
    if (probs.length) issues.push({ field: f.name, ref, probs });
  }

  console.log(`\n## ${componentSlug} → ${cfg.label}`);
  console.log(`   schema:  ${schemaFile}`);
  console.log(`   fields inspected: ${fields.length} | issues: ${issues.length}`);
  if (!issues.length) {
    console.log('   🟢 no leaks — form is at least as strict as the schema.');
  } else {
    const byRef = {};
    for (const i of issues) {
      byRef[i.ref] = byRef[i.ref] || [];
      byRef[i.ref].push(i);
    }
    for (const [ref, items] of Object.entries(byRef).sort((a, b) => b[1].length - a[1].length)) {
      const r = catalog[ref];
      console.log(`\n   ${ref}  (max=${r.maxLength ?? '-'}, pat=${r.pattern ? 'yes' : '-'})  — ${items.length} field(s)`);
      for (const it of items) {
        for (const p of it.probs) console.log(`     • ${it.field.padEnd(30)} ${p}`);
      }
    }
  }
  return { slug: componentSlug, issues };
}

// --- main ---
const argv = process.argv.slice(2);
let targets;
if (argv[0] === '--all') {
  targets = Object.keys(COMPONENT_MAP);
} else if (argv[0]) {
  targets = [argv[0]];
} else {
  console.log('Usage: node scripts/check-rules.mjs <component-name> | --all');
  console.log('Known:', Object.keys(COMPONENT_MAP).join(', '));
  process.exit(1);
}
let totalIssues = 0;
for (const t of targets) {
  const r = checkOne(t);
  totalIssues += r.issues.length;
}
console.log(`\n========\nTOTAL issues across ${targets.length} component(s): ${totalIssues}`);
