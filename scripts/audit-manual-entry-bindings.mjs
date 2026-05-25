#!/usr/bin/env node
/**
 * Audits manual-entry components: HTML formControlName vs buildForm keys vs generateXml reads.
 * Run: node scripts/audit-manual-entry-bindings.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MANUAL_ENTRY = path.join(__dirname, '../src/app/pages/manual-entry');

const SKIP = new Set(['bic-search-dialog', 'manual-entry']);

function extractHtmlControls(html) {
  const controls = new Set();
  const staticRe = /formControlName="([^"]+)"/g;
  let m;
  while ((m = staticRe.exec(html)) !== null) controls.add(m[1]);

  const dynamicRe = /formControlName\]="([^"]+)"/g;
  while ((m = dynamicRe.exec(html)) !== null) {
    const expr = m[1];
    const suffixes = [
      'Bic', 'Name', 'AddrType', 'BldgNb', 'BldgNm', 'StrtNm', 'PstCd', 'TwnNm', 'Ctry',
      'AdrLine1', 'AdrLine2', 'ClrSysMmbId', 'OrgClrSysMmbId', 'ClrSysCd', 'OrgClrSysCd',
      'Lei', 'OrgLEI', 'Acct', 'OrgAnyBIC',
    ];
    const prefixMatch = expr.match(/prefix\+'([^']+)'/);
    if (prefixMatch) {
      for (const s of suffixes) controls.add(`{prefix}${s}`);
      continue;
    }
    const ternary = expr.match(/prefix\+'(\w+)'\s*:\s*prefix\+'(\w+)'/);
    if (ternary) {
      controls.add(`{prefix}${ternary[1]}`);
      controls.add(`{prefix}${ternary[2]}`);
    }
  }
  return controls;
}

function extractFormKeys(ts) {
  const keys = new Set();
  const groupMatch = ts.match(/(?:buildForm|this\.fb\.group)\s*\(\s*\{([\s\S]*?)\}\s*\)/);
  if (!groupMatch) return keys;
  const body = groupMatch[1];
  const keyRe = /^\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*:/gm;
  let m;
  while ((m = keyRe.exec(body)) !== null) keys.add(m[1]);
  const forEachAgent = ts.match(/\[\.\.\.this\.agentPrefixes[^\]]*\]\.forEach\(p\s*=>\s*\{([\s\S]*?)\}\);/);
  if (forEachAgent) {
    const block = forEachAgent[1];
    const fieldRe = /c\[p\s*\+\s*'([^']+)'\]/g;
    while ((m = fieldRe.exec(block)) !== null) keys.add(`{prefix}${m[1]}`);
  }
  return keys;
}

function extractXmlReads(ts) {
  const keys = new Set();
  const genMatch = ts.match(/generateXml\s*\([^)]*\)\s*\{([\s\S]*?)^\s{2}\}/m);
  const searchBody = genMatch ? genMatch[1] : ts;
  const patterns = [
    /v\.([a-zA-Z_][a-zA-Z0-9_]*)/g,
    /v\[['"]([a-zA-Z_][a-zA-Z0-9_]*)['"]\]/g,
    /v\[`([a-zA-Z_][a-zA-Z0-9_]*)`\]/g,
    /v\[prefix\s*\+\s*'([^']+)'\]/g,
    /v\[p\s*\+\s*'([^']+)'\]/g,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(searchBody)) !== null) {
      if (m[1] && !['trim', 'toString', 'value'].includes(m[1])) keys.add(m[1]);
    }
  }
  return keys;
}

function normalizeForCompare(name) {
  if (name.includes('{prefix}')) return name;
  return name;
}

function auditComponent(dir) {
  const name = path.basename(dir);
  const htmlPath = fs.readdirSync(dir).find(f => f.endsWith('.component.html'));
  const tsPath = fs.readdirSync(dir).find(f => f.endsWith('.component.ts'));
  if (!htmlPath || !tsPath) return null;

  const html = fs.readFileSync(path.join(dir, htmlPath), 'utf8');
  const ts = fs.readFileSync(path.join(dir, tsPath), 'utf8');
  const htmlControls = extractHtmlControls(html);
  const formKeys = extractFormKeys(ts);
  const xmlReads = extractXmlReads(ts);

  const htmlStatic = [...htmlControls].filter(c => !c.includes('{prefix}'));
  const formStatic = [...formKeys].filter(c => !c.includes('{prefix}'));

  const uiOrphan = htmlStatic.filter(c => !formStatic.includes(c));
  const hiddenXml = formStatic.filter(c => xmlReads.has(c) && !htmlStatic.includes(c));
  const xmlOrphan = formStatic.filter(c => !xmlReads.has(c) && !['msgDefIdr', 'bizSvc'].includes(c));
  const deadControl = formStatic.filter(c => !xmlReads.has(c) && htmlStatic.includes(c));

  const hasDynamicTemplate = [...htmlControls].some(c => c.includes('{prefix}'));
  const hasAgentLoop = ts.includes('agentPrefixes');

  return {
    name,
    htmlCount: htmlStatic.length,
    formCount: formStatic.length,
    xmlReadCount: xmlReads.size,
    uiOrphan: uiOrphan.slice(0, 20),
    uiOrphanTotal: uiOrphan.length,
    hiddenXml: hiddenXml.slice(0, 25),
    hiddenXmlTotal: hiddenXml.length,
    xmlOrphan: xmlOrphan.slice(0, 15),
    xmlOrphanTotal: xmlOrphan.length,
    deadInFormNotXml: formStatic.filter(c => !xmlReads.has(c)).length,
    hasDynamicTemplate,
    hasAgentLoop,
  };
}

const dirs = fs.readdirSync(MANUAL_ENTRY, { withFileTypes: true })
  .filter(d => d.isDirectory() && !SKIP.has(d.name))
  .map(d => path.join(MANUAL_ENTRY, d.name));

console.log('Manual Entry Binding Audit\n' + '='.repeat(60));
const results = dirs.map(auditComponent).filter(Boolean);
for (const r of results.sort((a, b) => b.uiOrphanTotal - a.uiOrphanTotal || b.hiddenXmlTotal - a.hiddenXmlTotal)) {
  console.log(`\n## ${r.name}`);
  console.log(`  HTML controls: ${r.htmlCount} | Form keys: ${r.formCount} | XML reads: ${r.xmlReadCount}`);
  if (r.hasDynamicTemplate) console.log('  (uses dynamic prefix+ partyForm template)');
  if (r.uiOrphanTotal) console.log(`  UI orphan (HTML not in form): ${r.uiOrphanTotal}`, r.uiOrphan.length ? ` e.g. ${r.uiOrphan.join(', ')}` : '');
  if (r.hiddenXmlTotal) console.log(`  Hidden XML (form+XML, no HTML): ${r.hiddenXmlTotal}`, r.hiddenXml.length ? ` e.g. ${r.hiddenXml.join(', ')}` : '');
  if (r.xmlOrphanTotal) console.log(`  Form not in generateXml: ${r.xmlOrphanTotal}`, r.xmlOrphan.length ? ` e.g. ${r.xmlOrphan.join(', ')}` : '');
}
console.log('\n' + '='.repeat(60));
console.log(`Audited ${results.length} components.`);
