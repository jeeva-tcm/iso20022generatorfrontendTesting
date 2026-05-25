#!/usr/bin/env node
/**
 * Stronger audit:
 *  - Counts UI input controls (<input>, <select>, <textarea>)
 *  - Counts formControlName bindings (static + dynamic prefix+ + ngModel)
 *  - Extracts ALL form-keys from ANY fb.group(...) in .ts (handles nested groups + arrays)
 *  - Verifies whether each formControlName is read by generateXml() and emitted into XML
 *  - Reports per-component:
 *      Inputs | Bound | Unbound | InForm | UsedInXml | UnusedInXml | UI-orphans | XML-only | Verdict
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MANUAL_ENTRY = path.join(__dirname, '../src/app/pages/manual-entry');
const SKIP = new Set(['bic-search-dialog', 'manual-entry']);

function stripHtmlComments(s) { return s.replace(/<!--[\s\S]*?-->/g, ''); }
function stripTsComments(s) {
  return s
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

function countUiInputs(html) {
  html = stripHtmlComments(html);
  const inputs = (html.match(/<input\b/gi) || []).length;
  const selects = (html.match(/<select\b/gi) || []).length;
  const textareas = (html.match(/<textarea\b/gi) || []).length;
  return { inputs, selects, textareas, total: inputs + selects + textareas };
}

function extractHtmlBindings(html) {
  html = stripHtmlComments(html);
  const formStatic = new Set();
  const formDynamic = new Set();
  const ngModels = new Set();
  let m;

  // formControlName="x"
  const r1 = /formControlName="([^"]+)"/g;
  while ((m = r1.exec(html)) !== null) formStatic.add(m[1]);

  // [formControlName]="expr"  --> dynamic, can't fully resolve. Capture literal strings inside.
  const r2 = /\[formControlName\]="([^"]+)"/g;
  while ((m = r2.exec(html)) !== null) {
    const expr = m[1];
    const literalRe = /['"]([A-Za-z_][\w]*)['"]/g;
    let l;
    while ((l = literalRe.exec(expr)) !== null) {
      formDynamic.add(`(dyn) ${l[1]}`);
    }
    if (!literalRe.exec(expr)) formDynamic.add(`(dyn expr) ${expr.slice(0, 30)}`);
  }

  // [(ngModel)] / ngModel
  const r3 = /\[\(ngModel\)\]="([^"]+)"/g;
  while ((m = r3.exec(html)) !== null) ngModels.add(m[1]);
  const r4 = /\bngModel\b/g;
  const ngModelTotal = (html.match(r4) || []).length;

  // Inputs WITHOUT any binding attribute on them
  const inputTags = html.match(/<(input|select|textarea)\b[^>]*>/gi) || [];
  let unboundCount = 0;
  for (const tag of inputTags) {
    if (/formControlName/.test(tag)) continue;
    if (/\[\(ngModel\)\]|ngModel/.test(tag)) continue;
    if (/\[value\]|\(input\)|\(change\)|formControl\b|formArrayName|formGroupName/.test(tag)) continue;
    unboundCount++;
  }

  return {
    formStatic,
    formDynamic,
    ngModels,
    ngModelTotal,
    unboundCount,
    bindingCount: inputTags.length - unboundCount,
    totalInputTags: inputTags.length,
  };
}

function braceMatchFrom(s, openIdx) {
  let depth = 0;
  for (let k = openIdx; k < s.length; k++) {
    const ch = s[k];
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return k; }
  }
  return -1;
}

function keysFromObjectBody(body) {
  const out = new Set();
  let d = 0, start = 0;
  const segments = [];
  for (let k = 0; k <= body.length; k++) {
    const ch = body[k];
    if (ch === '{' || ch === '[' || ch === '(') d++;
    else if (ch === '}' || ch === ']' || ch === ')') d--;
    else if ((ch === ',' || k === body.length) && d === 0) {
      segments.push(body.slice(start, k));
      start = k + 1;
    }
  }
  for (const seg of segments) {
    const mm = seg.match(/^\s*([A-Za-z_][\w]*)\s*:/);
    if (mm) out.add(mm[1]);
    const mq = seg.match(/^\s*['"]([A-Za-z_][\w]*)['"]\s*:/);
    if (mq) out.add(mq[1]);
  }
  return out;
}

// Extract all form keys (handles fb.group({...}), const c: any = {...} + c['k']=... + c[p+'X']=...)
function extractAllFormKeys(ts) {
  ts = stripTsComments(ts);
  const keys = new Set();

  // 1. fb.group({...}) inline literal — include NESTED occurrences (advance by 1 not past close)
  let idx = 0;
  while (true) {
    const i = ts.indexOf('fb.group(', idx);
    if (i === -1) break;
    const after = ts.slice(i + 9).trimStart();
    if (after.startsWith('{')) {
      let j = ts.indexOf('{', i);
      const end = braceMatchFrom(ts, j);
      if (end !== -1) {
        for (const k of keysFromObjectBody(ts.slice(j + 1, end))) keys.add(k);
      }
    }
    idx = i + 9; // advance past 'fb.group(' so nested calls are visited
  }

  // 2. const c [: anyType ] = { ... }  (any variable name, any type annotation)
  const objLitRe = /\b(const|let|var)\s+([A-Za-z_]\w*)\s*(?::\s*[^=]+?)?\s*=\s*\{/g;
  let om;
  const trackedVars = new Set();
  while ((om = objLitRe.exec(ts)) !== null) {
    const varName = om[2];
    const braceIdx = ts.indexOf('{', om.index + om[0].length - 1);
    if (braceIdx === -1) continue;
    const end = braceMatchFrom(ts, braceIdx);
    if (end === -1) continue;
    const body = ts.slice(braceIdx + 1, end);
    // Only treat as form bag if it later gets passed to fb.group(varName) or assigned to a control
    const isFormBag = ts.includes(`fb.group(${varName})`) || ts.includes(`fb.group( ${varName} )`);
    if (isFormBag) {
      for (const k of keysFromObjectBody(body)) keys.add(k);
      trackedVars.add(varName);
    }
  }

  // 3. Bracket assignments: c['key'] = ...  and c[p+'Suffix'] = ...
  const prefixFields = new Set();
  for (const v of trackedVars) {
    const litRe = new RegExp(`\\b${v}\\s*\\[\\s*['\"]([A-Za-z_][\\w]*)['\"]\\s*\\]\\s*=`, 'g');
    let lm;
    while ((lm = litRe.exec(ts)) !== null) keys.add(lm[1]);
    const pfxRe = new RegExp(`\\b${v}\\s*\\[\\s*([A-Za-z_]\\w*)\\s*\\+\\s*['\"]([A-Za-z_][\\w]*)['\"]\\s*\\]\\s*=`, 'g');
    while ((lm = pfxRe.exec(ts)) !== null) prefixFields.add(lm[2]);
    const pfxIfRe = new RegExp(`\\b${v}\\s*\\[\\s*([A-Za-z_]\\w*)\\s*\\+\\s*['\"]([A-Za-z_][\\w]*)['\"]\\s*\\]`, 'g');
    while ((lm = pfxIfRe.exec(ts)) !== null) prefixFields.add(lm[2]);
  }

  // 4. Computed keys inside any object literal:  [prefix + 'X']: [...]
  const compKeyRe = /\[\s*([A-Za-z_]\w*)\s*\+\s*['"]([A-Za-z_][\w]*)['"]\s*\]\s*:/g;
  let cm;
  while ((cm = compKeyRe.exec(ts)) !== null) prefixFields.add(cm[2]);
  // 5. Template-string keys: [`${prefix}X`]: [...]
  const compTplRe = /\[\s*`\$\{[A-Za-z_]\w*\}([A-Za-z_][\w]*)`\s*\]\s*:/g;
  while ((cm = compTplRe.exec(ts)) !== null) prefixFields.add(cm[1]);
  // 6. form.addControl('literal', ...) and form.addControl(p + 'X', ...)
  const addLitRe = /\.addControl\s*\(\s*['"]([A-Za-z_][\w]*)['"]\s*,/g;
  while ((cm = addLitRe.exec(ts)) !== null) keys.add(cm[1]);
  const addPfxRe = /\.addControl\s*\(\s*[A-Za-z_]\w*\s*\+\s*['"]([A-Za-z_][\w]*)['"]\s*,/g;
  while ((cm = addPfxRe.exec(ts)) !== null) prefixFields.add(cm[1]);
  const addTplRe = /\.addControl\s*\(\s*`\$\{[A-Za-z_]\w*\}([A-Za-z_][\w]*)`\s*,/g;
  while ((cm = addTplRe.exec(ts)) !== null) prefixFields.add(cm[1]);

  return { keys, prefixFields };
}

// Returns { reads (tokens), suffixesRead, prefixesRead }
function extractXmlReads(ts) {
  ts = stripTsComments(ts);
  let body = ts;
  const stripRe = /\b(?:buildForm|createTransactionGroup|createPartyFields|createTxnGroup|createTxGroup|parseXml|parseXmlIntoForm|loadDraft|loadFromDraft|loadFromXml)\s*\(/g;
  let stripped = '';
  let last = 0;
  let mm;
  while ((mm = stripRe.exec(body)) !== null) {
    const bi = body.indexOf('{', mm.index);
    if (bi === -1) continue;
    const end = braceMatchFrom(body, bi);
    if (end === -1) continue;
    stripped += body.slice(last, bi + 1);
    last = end;
  }
  stripped += body.slice(last);
  body = stripped;
  const reads = new Set();
  const tokRe = /\b([A-Za-z_][A-Za-z0-9_]*)\b/g;
  let tm;
  while ((tm = tokRe.exec(body)) !== null) reads.add(tm[1]);
  // [variable + 'Suffix']: suffix is fixed, prefix is dynamic → match form keys ENDING with suffix
  const suffixesRead = new Set();
  // ['Prefix' + variable]: prefix is fixed → match form keys STARTING with prefix
  const prefixesRead = new Set();
  let m;
  const re1 = /\[\s*[A-Za-z_]\w*\s*\+\s*['"]([A-Za-z_][\w]*)['"]\s*\]/g;
  while ((m = re1.exec(body)) !== null) suffixesRead.add(m[1]);
  const re2 = /\[\s*['"]([A-Za-z_][\w]*)['"]\s*\+\s*[A-Za-z_]\w*\s*\]/g;
  while ((m = re2.exec(body)) !== null) prefixesRead.add(m[1]);
  const reTpl1 = /\[\s*`\$\{[A-Za-z_]\w*\}([A-Za-z_][\w]*)`\s*\]/g;
  while ((m = reTpl1.exec(body)) !== null) suffixesRead.add(m[1]);
  const reTpl2 = /\[\s*`([A-Za-z_][\w]*)\$\{[A-Za-z_]\w*\}`\s*\]/g;
  while ((m = reTpl2.exec(body)) !== null) prefixesRead.add(m[1]);
  // Combined prefix+var+suffix:  v[`prefix${var}suffix`]
  const prefixSuffixPairs = [];
  const reTpl3 = /\[\s*`([A-Za-z_][\w]*)\$\{[A-Za-z_]\w*\}([A-Za-z_][\w]*)`\s*\]/g;
  while ((m = reTpl3.exec(body)) !== null) prefixSuffixPairs.push([m[1], m[2]]);
  // Also 'prefix' + var + 'suffix' (string concat form)
  const reCc = /\[\s*['"]([A-Za-z_][\w]*)['"]\s*\+\s*[A-Za-z_]\w*\s*\+\s*['"]([A-Za-z_][\w]*)['"]\s*\]/g;
  while ((m = reCc.exec(body)) !== null) prefixSuffixPairs.push([m[1], m[2]]);
  return { reads, suffixesRead, prefixesRead, prefixSuffixPairs };
}

function audit(dir) {
  const name = path.basename(dir);
  const files = fs.readdirSync(dir);
  const htmlF = files.find(f => f.endsWith('.component.html'));
  const tsF = files.find(f => f.endsWith('.component.ts'));
  if (!htmlF || !tsF) return null;
  const html = fs.readFileSync(path.join(dir, htmlF), 'utf8');
  const ts = fs.readFileSync(path.join(dir, tsF), 'utf8');

  const ui = countUiInputs(html);
  const bindings = extractHtmlBindings(html);
  const { keys: formKeys, prefixFields } = extractAllFormKeys(ts);
  const { reads: xmlReads, suffixesRead, prefixesRead, prefixSuffixPairs } = extractXmlReads(ts);

  const isReadInXml = (k) => {
    if (xmlReads.has(k)) return true;
    for (const sfx of suffixesRead) if (k.endsWith(sfx)) return true;
    for (const pre of prefixesRead) if (k.startsWith(pre)) return true;
    for (const [pre, sfx] of prefixSuffixPairs) {
      if (k.startsWith(pre) && k.endsWith(sfx) && k.length >= pre.length + sfx.length) return true;
    }
    return false;
  };

  // UI orphans: formControlName present but no corresponding form key (and not a prefix suffix)
  const uiOrphans = [...bindings.formStatic].filter(k => {
    if (formKeys.has(k)) return false;
    // Check if it's covered by prefix loop suffix
    for (const sfx of prefixFields) {
      if (k.endsWith(sfx)) return false;
    }
    return true;
  });
  const boundNotInXml = [...bindings.formStatic].filter(k => formKeys.has(k) && !isReadInXml(k));
  const formNotInHtml = [...formKeys].filter(k => !bindings.formStatic.has(k));
  const formNotInXml = [...formKeys].filter(k => !isReadInXml(k));
  const xmlOrphans = [...xmlReads].filter(k => !formKeys.has(k));

  // Detect prefix template usage in HTML
  const hasDynamicForm = bindings.formDynamic.size > 0;
  const hasPartyComponent = /app-(party-form|address-form|agent-form)|<ng-template[^>]*partyForm/.test(html);

  return {
    name,
    ui,
    binding: {
      total: bindings.totalInputTags,
      bound: bindings.bindingCount,
      unbound: bindings.unboundCount,
      formStaticCount: bindings.formStatic.size,
      formDynamicCount: bindings.formDynamic.size,
      ngModelCount: bindings.ngModels.size,
    },
    form: {
      totalKeys: formKeys.size,
      prefixFieldsCount: prefixFields.size,
    },
    xml: {
      readCount: xmlReads.size,
    },
    issues: {
      uiOrphansCount: uiOrphans.length,
      uiOrphansSample: uiOrphans.slice(0, 8),
      boundNotInXmlCount: boundNotInXml.length,
      boundNotInXmlSample: boundNotInXml.slice(0, 8),
      formNotInHtmlCount: formNotInHtml.length,
      formNotInXmlCount: formNotInXml.length,
      xmlOrphansCount: xmlOrphans.length,
      hasDynamicForm,
      hasPartyComponent,
    },
  };
}

const dirs = fs.readdirSync(MANUAL_ENTRY, { withFileTypes: true })
  .filter(d => d.isDirectory() && !SKIP.has(d.name))
  .map(d => path.join(MANUAL_ENTRY, d.name))
  .sort();

const results = dirs.map(audit).filter(Boolean);

// Print compact markdown table
const header = '| Component | Inputs (input+select+textarea) | Bound (formControl/ngModel) | Unbound | Form keys (TS) | XML reads | UI orphans (control with no form key) | Form keys NOT emitted in XML | Verdict |';
const align  = '|---|---:|---:|---:|---:|---:|---:|---:|---|';
console.log(header);
console.log(align);
for (const r of results) {
  let verdict;
  if (r.binding.formStaticCount === 0 && r.binding.formDynamicCount === 0 && r.binding.ngModelCount === 0) {
    verdict = '🔴 NO BINDING (entries lost)';
  } else if (r.binding.unbound > 0 && r.issues.uiOrphansCount > 5) {
    verdict = `🔴 ${r.binding.unbound} unbound + ${r.issues.uiOrphansCount} ui-orphans`;
  } else if (r.issues.boundNotInXmlCount > 5) {
    verdict = `🟠 ${r.issues.boundNotInXmlCount} bound but not written to XML`;
  } else if (r.issues.uiOrphansCount > 0 || r.issues.boundNotInXmlCount > 0 || r.binding.unbound > 0) {
    verdict = `🟡 minor: ${r.binding.unbound} unbound, ${r.issues.uiOrphansCount} orphans, ${r.issues.boundNotInXmlCount} no-xml`;
  } else {
    verdict = '🟢 OK';
  }
  console.log(`| ${r.name} | ${r.ui.total} (${r.ui.inputs}/${r.ui.selects}/${r.ui.textareas}) | ${r.binding.bound} (FC:${r.binding.formStaticCount} +dyn:${r.binding.formDynamicCount} +ngM:${r.binding.ngModelCount}) | ${r.binding.unbound} | ${r.form.totalKeys}${r.form.prefixFieldsCount ? ` +${r.form.prefixFieldsCount} prefix` : ''} | ${r.xml.readCount} | ${r.issues.uiOrphansCount} | ${r.issues.boundNotInXmlCount} | ${verdict} |`);
}

console.log('\n## Critical findings\n');
for (const r of results) {
  const lines = [];
  if (r.binding.unbound > 0) lines.push(`• ${r.binding.unbound} input(s) with NO binding at all (formControlName / ngModel missing) → typed data is dropped`);
  if (r.issues.uiOrphansCount > 0) lines.push(`• ${r.issues.uiOrphansCount} formControlName(s) reference keys that don't exist in the FormGroup → \`${r.issues.uiOrphansSample.slice(0,5).join(', ')}\`...`);
  if (r.issues.boundNotInXmlCount > 0) lines.push(`• ${r.issues.boundNotInXmlCount} bound field(s) NEVER appear in generateXml() → \`${r.issues.boundNotInXmlSample.slice(0,5).join(', ')}\`...`);
  if (lines.length) {
    console.log(`### ${r.name}`);
    for (const l of lines) console.log(l);
    console.log('');
  }
}
