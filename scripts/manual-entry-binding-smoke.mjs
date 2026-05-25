#!/usr/bin/env node
/**
 * Static smoke checks for manual-entry binding fixes.
 * Run: node scripts/manual-entry-binding-smoke.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const me = path.join(root, 'src/app/pages/manual-entry');

const checks = [
  {
    name: 'pacs2 uses ClrSysMmbId in buildForm',
    file: 'pacs2/pacs2.component.ts',
    test: (s) => s.includes("c[p + 'ClrSysMmbId']") && s.includes('agentPrefixes'),
  },
  {
    name: 'pacs2 buildAgt reads ClrSysMmbId',
    file: 'pacs2/pacs2.component.ts',
    test: (s) => s.includes("prefix + 'ClrSysMmbId'") && s.includes('addrXml(v, prefix'),
  },
  {
    name: 'pacs8 emits purpCd',
    file: 'pacs8/pacs8.component.ts',
    test: (s) => /v\.purpCd\?\.trim\(\).*Purp/s.test(s),
  },
  {
    name: 'pacs8 has purpCd in HTML',
    file: 'pacs8/pacs8.component.html',
    test: (s) => s.includes('formControlName="purpCd"'),
  },
  {
    name: 'pacs10 validate syncs form',
    file: 'pacs10/pacs10.component.ts',
    test: (s) => /validateMessage[\s\S]*parseXmlToForm[\s\S]*generateXml/.test(s),
  },
  {
    name: 'shared message config exists',
    file: '../config/manual-entry-messages.ts',
    test: (s) => s.includes('camt.057.001.06') && s.includes('pacs.010.001.10'),
  },
  {
    name: 'catalog uses shared config',
    file: 'manual-entry.component.ts',
    test: (s) => s.includes('POPULAR_MANUAL_ENTRY_MESSAGES'),
  },
  {
    name: 'catalog viewMode toggles panels',
    file: 'manual-entry.component.html',
    test: (s) => s.includes('*ngIf="viewMode === \'form\'"') && s.includes('*ngIf="viewMode === \'xml\'"'),
  },
];

let failed = 0;
for (const c of checks) {
  const p = path.join(me, c.file.replace('../', ''));
  const alt = path.join(root, 'src/app', c.file.replace('../', ''));
  const fp = fs.existsSync(p) ? p : alt;
  const content = fs.readFileSync(fp, 'utf8');
  const ok = c.test(content);
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${c.name}`);
  if (!ok) failed++;
}

process.exit(failed > 0 ? 1 : 0);
