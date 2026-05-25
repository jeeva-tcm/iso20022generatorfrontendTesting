#!/usr/bin/env node
/**
 * Cross-check pacs8.component.ts form validators against the SWIFT CBPR+ pacs.008 JSON schema.
 *
 * Strategy:
 *  1. Walk the JSON schema, harvest a catalog of {type-ref → constraints}.
 *  2. Parse pacs8.component.ts, extract every form key + its validator list.
 *  3. Infer each form key's expected schema type from its name (suffix-based).
 *     Examples:
 *        *Bic    → BICFIDec2014Identifier        (pattern, no length)
 *        *Lei    → LEIIdentifier                 (pattern)
 *        uetr    → UUIDv4Identifier              (pattern)
 *        *MmbId  → CBPR_RestrictedFINXMax28Text  (max 28!)  ← form currently uses 35
 *        *Name / *Nm     → CBPR_Restricted...Max140Text  (max 140)
 *        addr lines      → CBPR_Restricted...Max70Text   (max 70)
 *        bldg# / pst#    → CBPR_Restricted...Max16Text   (max 16)
 *        ctry            → ^[A-Z]{2,2}$
 *  4. Diff: missing pattern, wrong maxLength, wrong minLength → REPORT.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const SCHEMA = path.join(ROOT, 'validation-rules', 'CBPRPlus_SR2025_(Combined)_CBPRPlus-pacs_008_001_08_FIToFICustomerCreditTransfer_20260521_0929.json');
const PACS8_TS = path.join(ROOT, 'src/app/pages/manual-entry/pacs8/pacs8.component.ts');

const schema = JSON.parse(fs.readFileSync(SCHEMA, 'utf8'));
const defs = schema.definitions || {};

// --- 1. Catalog ---
const catalog = {}; // refName -> { pattern, minLength, maxLength, enum, description }
for (const [name, def] of Object.entries(defs)) {
  if (def.type === 'string' || def.enum) {
    catalog[name] = {
      pattern: def.pattern,
      minLength: def.minLength,
      maxLength: def.maxLength,
      enum: def.enum,
      description: def.description?.slice(0, 80),
    };
  }
}

// --- 2. Suffix → expected type ---
// Ordered by specificity (most specific first)
const SUFFIX_MAP = [
  // settlement-specific identifiers
  { suffix: 'MmbId',                  ref: 'CBPR_RestrictedFINXMax28Text' },
  { suffix: 'ClrSysMmbId',            ref: 'CBPR_RestrictedFINXMax28Text' },
  { suffix: 'ClrSysCd',               ref: 'ExternalClearingSystemIdentification1Code' },
  { suffix: 'ClrSysId',               ref: 'ExternalClearingSystemIdentification1Code' },
  { suffix: 'OrgClrSysCd',            ref: 'ExternalClearingSystemIdentification1Code' },
  { suffix: 'OrgClrSysMmbId',         ref: 'CBPR_RestrictedFINXMax28Text' },
  // BIC variants
  { suffix: 'Bic',                    ref: 'BICFIDec2014Identifier' },
  { suffix: 'BIC',                    ref: 'BICFIDec2014Identifier' },
  { suffix: 'BICFI',                  ref: 'BICFIDec2014Identifier' },
  { suffix: 'AnyBIC',                 ref: 'AnyBICDec2014Identifier' },
  { suffix: 'OrgAnyBIC',              ref: 'AnyBICDec2014Identifier' },
  { suffix: 'OrgAnyBic',              ref: 'AnyBICDec2014Identifier' },
  // LEI
  { suffix: 'Lei',                    ref: 'LEIIdentifier' },
  { suffix: 'LEI',                    ref: 'LEIIdentifier' },
  { suffix: 'OrgLEI',                 ref: 'LEIIdentifier' },
  // UETR
  { suffix: 'uetr',                   ref: 'UUIDv4Identifier' },
  { suffix: 'UETR',                   ref: 'UUIDv4Identifier' },
  // Country (2-letter)
  { suffix: 'Ctry',                   ref: 'CountryCode' },
  { suffix: 'CtryOfRes',              ref: 'CountryCode' },
  // Currency (3-letter)
  { suffix: 'Ccy',                    ref: 'ActiveOrHistoricCurrencyCode' },
  { suffix: 'currency',               ref: 'ActiveOrHistoricCurrencyCode' },
  // Date / datetime
  { suffix: 'DtTm',                   ref: 'CBPR_DateTime' },
  { suffix: 'creDtTm',                ref: 'CBPR_DateTime' },
  { suffix: 'dbtDtTm',                ref: 'CBPR_DateTime' },
  { suffix: 'cdtDtTm',                ref: 'CBPR_DateTime' },
  { suffix: 'Dt',                     ref: 'ISODate' },
  { suffix: 'sttlmDt',                ref: 'ISODate' },
  // Identifiers / Max35 text
  { suffix: 'Id',                     ref: 'CBPR_RestrictedFINXMax35Text' },
  { suffix: 'msgId',                  ref: 'CBPR_RestrictedFINXMax35Text' },
  { suffix: 'bizMsgId',               ref: 'CBPR_RestrictedFINXMax35Text' },
  { suffix: 'instrId',                ref: 'CBPR_RestrictedFINXMax35Text' },
  { suffix: 'endToEndId',             ref: 'CBPR_RestrictedFINXMax35Text' },
  { suffix: 'txId',                   ref: 'CBPR_RestrictedFINXMax35Text' },
  { suffix: 'clrSysRef',              ref: 'CBPR_RestrictedFINXMax35Text' },
  { suffix: 'mndtId',                 ref: 'CBPR_RestrictedFINXMax35Text' },
  // Address fields (extended pattern allows additional chars)
  { suffix: 'AdrLine1',               ref: 'CBPR_RestrictedFINXMax70Text_Extended' },
  { suffix: 'AdrLine2',               ref: 'CBPR_RestrictedFINXMax70Text_Extended' },
  { suffix: 'StrtNm',                 ref: 'CBPR_RestrictedFINXMax70Text_Extended' },
  { suffix: 'Dept',                   ref: 'CBPR_RestrictedFINXMax70Text_Extended' },
  { suffix: 'SubDept',                ref: 'CBPR_RestrictedFINXMax70Text_Extended' },
  { suffix: 'Flr',                    ref: 'CBPR_RestrictedFINXMax70Text_Extended' },
  { suffix: 'Room',                   ref: 'CBPR_RestrictedFINXMax70Text_Extended' },
  { suffix: 'BldgNb',                 ref: 'CBPR_RestrictedFINXMax16Text_Extended' },
  { suffix: 'PstBx',                  ref: 'CBPR_RestrictedFINXMax16Text_Extended' },
  { suffix: 'PstCd',                  ref: 'CBPR_RestrictedFINXMax16Text_Extended' },
  { suffix: 'BldgNm',                 ref: 'CBPR_RestrictedFINXMax35Text_Extended' },
  { suffix: 'TwnNm',                  ref: 'CBPR_RestrictedFINXMax35Text_Extended' },
  { suffix: 'TwnLctnNm',              ref: 'CBPR_RestrictedFINXMax35Text_Extended' },
  { suffix: 'DstrctNm',               ref: 'CBPR_RestrictedFINXMax35Text_Extended' },
  { suffix: 'CtrySubDvsn',            ref: 'CBPR_RestrictedFINXMax35Text_Extended' },
  // Name
  { suffix: 'Name',                   ref: 'CBPR_RestrictedFINXMax140Text_Extended' },
  { suffix: 'Nm',                     ref: 'CBPR_RestrictedFINXMax140Text_Extended' },
  // Account
  { suffix: 'Acct',                   ref: 'CBPR_RestrictedFINXMax34Text' },
  { suffix: 'AcctIban',               ref: 'IBAN2007Identifier' },
  { suffix: 'Iban',                   ref: 'IBAN2007Identifier' },
];

// --- 3. Parse pacs8.component.ts ---
const ts = fs.readFileSync(PACS8_TS, 'utf8');

// Find all key declarations in buildForm body:
// pattern 1:  key: ['default', validators...],
// pattern 2:  c[p + 'X'] = ['', validators...]
// pattern 3:  c['key'] = ['', validators...]
function braceMatch(s, openIdx) {
  let d = 0;
  for (let k = openIdx; k < s.length; k++) {
    if (s[k] === '{') d++;
    else if (s[k] === '}') { d--; if (d === 0) return k; }
  }
  return -1;
}

// Extract buildForm body
const bfMatch = ts.match(/private\s+buildForm\s*\(\s*\)\s*\{/);
if (!bfMatch) { console.error('buildForm() not found'); process.exit(1); }
const bfStart = ts.indexOf('{', bfMatch.index);
const bfEnd = braceMatch(ts, bfStart);
const bfBody = ts.slice(bfStart + 1, bfEnd);

// Extract each "key: [default, validator-arr],"
// We just capture the validator span as text for diagnosis
const fields = [];
// Walk depth=0 inside bfBody, split by top-level commas? Too brittle.
// Instead: regex-match  ^\s*<ident>:\s*\[ ... \],   at the obj-literal levels we care about.

// We'll iterate line-by-line; each line that starts with `<ident>:` followed by `[` is a field.
const lines = bfBody.split('\n');
let pending = null;
for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  const m = line.match(/^\s*([A-Za-z_][\w]*)\s*:\s*\[(.*)$/);
  if (m) {
    if (pending) fields.push(pending);
    pending = { name: m[1], raw: m[2], lineStart: i };
  } else if (pending) {
    pending.raw += '\n' + line;
  }
  if (pending && pending.raw.includes(']')) {
    // close the field at first balanced ']'
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

// Also pick up:  c['x'] = ['', ...]    and    c[p + 'X'] = ['', ...]
// AND the legacy form: c[p + 'X']:[...]   AND   c[p + 'X'] = []
// (We treat these as "validator-set declarations")
const assigns = [];
const lineSrc = ts.split('\n');
for (let i = 0; i < lineSrc.length; i++) {
  const l = lineSrc[i];
  // c[p + 'X'] = ['', validator]
  const m1 = l.match(/^\s*if\s*\(\s*!c\[\s*p\s*\+\s*'([A-Za-z_][\w]*)'\s*\]\s*\)\s*c\[\s*p\s*\+\s*'\1'\s*\]\s*=\s*\[(.*)\]\s*;?\s*$/);
  if (m1) {
    assigns.push({ name: '{prefix}' + m1[1], raw: m1[2], suffix: m1[1] });
    continue;
  }
  // c['X'] = ['', ...]
  const m2 = l.match(/^\s*c\[\s*'([A-Za-z_][\w]*)'\s*\]\s*=\s*\[(.*)\]\s*;?\s*$/);
  if (m2) {
    assigns.push({ name: m2[1], raw: m2[2] });
  }
}

// Resolve `const FOO = Validators.pattern(/.../)` aliases so that fields referencing FOO are recognised as patterned.
// Use `(?:\\.|[^\/])+` so that escaped forward slashes inside the regex body don't terminate the capture.
function harvestPatternAliases(src) {
  const out = {};
  const re = /const\s+([A-Z][A-Z0-9_]*)\s*=\s*Validators\.pattern\s*\(\s*\/((?:\\.|[^\/\n])+)\/[a-z]*\s*\)/g;
  let m;
  while ((m = re.exec(src)) !== null) out[m[1]] = m[2];
  const re2 = /const\s+([A-Z][A-Z0-9_]*)\s*=\s*\[[^\]]*Validators\.pattern\s*\(\s*\/((?:\\.|[^\/\n])+)\/[a-z]*\s*\)/g;
  while ((m = re2.exec(src)) !== null) out[m[1]] = out[m[1]] || m[2];
  return out;
}
const ALIASES = harvestPatternAliases(ts);

// Parse validator string into structured info we can check
function parseValidators(raw) {
  const info = { required: false, pattern: null, minLength: null, maxLength: null, raw };
  if (/Validators\.required\b/.test(raw)) info.required = true;
  const mx = raw.match(/Validators\.maxLength\s*\(\s*(\d+)\s*\)/);
  if (mx) info.maxLength = +mx[1];
  const mn = raw.match(/Validators\.minLength\s*\(\s*(\d+)\s*\)/);
  if (mn) info.minLength = +mn[1];
  const pp = raw.match(/Validators\.pattern\s*\(\s*\/([^\/]+)\/[a-z]*\s*\)/);
  if (pp) info.pattern = pp[1];
  // Look for aliased pattern variables (ADDR_PATTERN, SAFE_NAME, BIC, BIC_OPT, UETR, LEI, etc.)
  if (!info.pattern) {
    for (const [name, pat] of Object.entries(ALIASES)) {
      const aliasRe = new RegExp(`\\b${name}\\b`);
      if (aliasRe.test(raw)) { info.pattern = pat; break; }
    }
  }
  // Pattern-implied maxLength: an alias whose name encodes a length (e.g. derived elsewhere) — skip for now
  return info;
}

// Combine fields + assigns
const allFields = [
  ...fields.map(f => ({ name: f.name, suffix: null, ...parseValidators(f.raw) })),
  ...assigns.map(a => ({ name: a.name, suffix: a.suffix || null, ...parseValidators(a.raw) })),
];

// --- 4. Infer expected ref for each field ---
function inferRef(name, suffixHint) {
  // Use suffix if provided (from {prefix}X pattern)
  if (suffixHint) {
    for (const s of SUFFIX_MAP) {
      if (s.suffix === suffixHint) return s.ref;
    }
  }
  // Match by suffix: pick longest matching suffix
  let best = null;
  for (const s of SUFFIX_MAP) {
    if (name.endsWith(s.suffix)) {
      if (!best || s.suffix.length > best.suffix.length) best = s;
    }
  }
  return best ? best.ref : null;
}

// Compare regex strings loosely (strip anchors, quantifier alt forms)
function patternsEqual(a, b) {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  const norm = s => s.replace(/\{(\d+),\1\}/g, '{$1}')   // {4,4} -> {4}
                    .replace(/\{0,1\}/g, '?')
                    .replace(/\s+/g, '');
  return norm(a) === norm(b);
}

// --- 5. Diff & report ---
// Two severity levels:
//   • RED   form is LOOSER than schema (accepts data the validator will later reject) — must fix.
//   • INFO  form has NO pattern when schema requires one — must add.
// We DO NOT flag fields where the form's pattern is a strict subset of the schema's (e.g. ADDR_PATTERN ⊂ Extended).
const issues = [];
for (const f of allFields) {
  const ref = inferRef(f.name, f.suffix);
  if (!ref) continue;
  const rule = catalog[ref];
  if (!rule) continue;
  const probs = [];
  // maxLength: form looser ⇒ flag. Stricter ⇒ accept silently.
  if (rule.maxLength != null) {
    if (f.maxLength == null) probs.push(`MISSING maxLength (rule=${rule.maxLength})`);
    else if (f.maxLength > rule.maxLength) probs.push(`maxLength too LOOSE: form=${f.maxLength} > rule=${rule.maxLength}`);
  }
  // pattern: only flag if form has no pattern at all (assume any present pattern is intentional)
  if (rule.pattern && !f.pattern) {
    probs.push(`MISSING pattern (rule=${rule.pattern.slice(0, 60)})`);
  }
  if (rule.minLength != null && f.minLength != null && f.minLength < rule.minLength) {
    probs.push(`minLength too LOOSE: form=${f.minLength} < rule=${rule.minLength}`);
  }
  if (probs.length) issues.push({ field: f.name, ref, probs });
}

// Group issues by ref for readability
const byRef = {};
for (const i of issues) {
  byRef[i.ref] = byRef[i.ref] || [];
  byRef[i.ref].push(i);
}

console.log(`pacs8 form fields inspected: ${allFields.length}`);
console.log(`Fields with at least one mismatch vs schema: ${issues.length}\n`);
for (const [ref, items] of Object.entries(byRef).sort((a, b) => b[1].length - a[1].length)) {
  const r = catalog[ref];
  console.log(`\n## ${ref} (pat=${r.pattern ? 'yes' : '-'}, max=${r.maxLength ?? '-'})  — ${items.length} field(s)`);
  for (const it of items) {
    for (const p of it.probs) {
      console.log(`  • ${it.field.padEnd(35)} ${p}`);
    }
  }
}
