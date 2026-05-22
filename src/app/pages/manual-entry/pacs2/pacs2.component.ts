import { Component, OnInit, OnDestroy, ViewChild, ElementRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormBuilder, FormGroup, ReactiveFormsModule, Validators, FormsModule } from '@angular/forms';
import { MatIconModule } from '@angular/material/icon';
import { HttpClient } from '@angular/common/http';
import { ConfigService } from '../../../services/config.service';
import { MatSnackBar } from '@angular/material/snack-bar';
import { Router } from '@angular/router';
import { UetrService } from '../../../services/uetr.service';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
import { BicSearchDialogComponent } from '../bic-search-dialog/bic-search-dialog.component';
import { debounceTime } from 'rxjs/operators';

@Component({
  selector: 'app-pacs2',
  standalone: true,
  imports: [CommonModule, ReactiveFormsModule, FormsModule, MatIconModule, MatDialogModule],
  templateUrl: './pacs2.component.html',
  styleUrls: ['./pacs2.component.css']
})
export class Pacs2Component implements OnInit, OnDestroy {
  @ViewChild('xmlEditor') xmlEditor!: ElementRef<HTMLTextAreaElement>;
  @ViewChild('lineNumbers') lineNumbersRef!: ElementRef<HTMLDivElement>;

  form!: FormGroup;
  generatedXml = '';
  isParsingXml = false;
  isInternalChange = false;
  validating = false;
  
  // Validation reporting
  showValidationModal = false;
  validationStatus: 'idle' | 'validating' | 'done' = 'idle';
  validationReport: any = null;
  validationExpandedIssue: any = null;
  
  editorLineCount: number[] = [1];
  xmlHistory: string[] = [];
  xmlHistoryIdx = -1;
  maxHistory = 50;

  private readonly DRAFT_KEY = 'draft_pacs002';
  private draftSaveTimer: ReturnType<typeof setTimeout> | null = null;
  showDraftBanner = false;
  isClearingDraft = false;

  countries: string[] = [];
  statusCodes = ['ACTC', 'ACCP', 'RJCT', 'PDNG'];
  reasonCodes: { [key: string]: string[] } = {
    'RJCT': [
      'AC01 â€“ Incorrect Account Number',
      'AC04 â€“ Closed Account',
      'AC06 â€“ Blocked Account',
      'AG01 â€“ Transaction Forbidden',
      'AG02 â€“ Invalid Bank',
      'AM04 â€“ Insufficient Funds',
      'BE01 â€“ Invalid Beneficiary',
      'FF01 â€“ Fraud Suspected',
      'RC01 â€“ Invalid BIC'
    ],
    'PDNG': [
      'PD01 â€“ Pending Processing',
      'PD02 â€“ Awaiting Funds',
      'PD03 â€“ Awaiting Authorization'
    ],
    'ACCP': ['NARR â€“ No specific reason / informational'],
    'ACTC': ['NARR â€“ No specific reason / informational']
  };

  get currentReasonCodes() {
    return this.reasonCodes[this.form.get('txSts')?.value] || [];
  }

  constructor(
    private fb: FormBuilder,
    private http: HttpClient,
    private config: ConfigService,
    private snackBar: MatSnackBar,
    private router: Router,
    private uetrService: UetrService,
    private dialog: MatDialog
  ) {}

  ngOnInit() {
    this.fetchCountries();
    this.buildForm();
    // Auto-sync AppHdr BICs with TxInfAndSts InstgAgt/InstdAgt BICs (bidirectional)
    this.form.get('fromBic')?.valueChanges.subscribe(v => this.form.patchValue({ instgAgtBic: v }, { emitEvent: false }));
    this.form.get('toBic')?.valueChanges.subscribe(v => this.form.patchValue({ instdAgtBic: v }, { emitEvent: false }));
    this.form.get('instgAgtBic')?.valueChanges.subscribe(v => this.form.patchValue({ fromBic: v }, { emitEvent: false }));
    this.form.get('instdAgtBic')?.valueChanges.subscribe(v => this.form.patchValue({ toBic: v }, { emitEvent: false }));
    const hadDraft = this.loadDraft();
    if (hadDraft) {
      this.showDraftBanner = true;
      this.generateXml();
    }
    this.generateXml();
    this.pushHistory();
  }

  fetchCountries() {
    this.http.get<any>(this.config.getApiUrl('/codelists/country')).subscribe({
      next: (res) => { if (res && res.codes) this.countries = res.codes; },
      error: (err) => console.error('Failed to load countries', err)
    });
  }

  buildForm() {
    const BIC = [Validators.required, Validators.maxLength(11), Validators.pattern(/^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$/)];
    const BIC_OPT = [Validators.maxLength(11), Validators.pattern(/^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$/)];
    const UETR_PATTERN = [Validators.required, Validators.maxLength(36), Validators.pattern(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/)];

    this.form = this.fb.group({
      // AppHdr
      fromBic: ['BBBBUS33XXX', BIC],
      toBic: ['CCCCGB2LXXX', BIC],
      bizMsgId: ['MSG-2026-FI-S-001', [Validators.required, Validators.maxLength(35)]],
      msgDefIdr: ['pacs.002.001.10', [Validators.required, Validators.maxLength(35)]],
      bizSvc: ['swift.cbprplus.02', [Validators.required, Validators.maxLength(35)]],
      creDtTm: [this.isoNow(), Validators.required],

      // GrpHdr
      msgId: ['MSG-2026-FI-S-001-GH', [Validators.required, Validators.maxLength(35)]],

      // OrgnlGrpInf
      orgnlMsgId: ['MSG-' + Date.now() + '-ORG', [Validators.required, Validators.maxLength(35)]],
      orgnlMsgNmId: ['pacs.008.001.08', [Validators.required, Validators.maxLength(35)]],
      orgnlCreDtTm: [this.isoNow(), Validators.required],

      // TxRef
      orgnlInstrId: ['INSTR-STATUS-001', [Validators.required, Validators.maxLength(35)]],
      orgnlEndToEndId: ['E2E-STATUS-001', Validators.maxLength(35)],
      orgnlTxId: ['TX-STATUS-001', [Validators.required, Validators.maxLength(35)]],
      orgnlUETR: [this.uetrService.generate(), UETR_PATTERN],

      // TxSts
      txSts: ['ACTC', Validators.required],

      // StsRsnInf - Originator
      stsRsnOrgtrName: ['', [Validators.maxLength(140)]],
      stsRsnOrgtrStrtNm: ['', Validators.maxLength(70)],
      stsRsnOrgtrBldgNb: ['', Validators.maxLength(16)],
      stsRsnOrgtrBldgNm: ['', Validators.maxLength(35)],
      stsRsnOrgtrFlr: ['', Validators.maxLength(70)],
      stsRsnOrgtrPstBx: ['', Validators.maxLength(16)],
      stsRsnOrgtrRoom: ['', Validators.maxLength(70)],
      stsRsnOrgtrPstCd: ['', Validators.maxLength(16)],
      stsRsnOrgtrTwnNm: ['', Validators.maxLength(35)],
      stsRsnOrgtrTwnLctnNm: ['', Validators.maxLength(35)],
      stsRsnOrgtrDstrctNm: ['', Validators.maxLength(35)],
      stsRsnOrgtrCtrySubDvsn: ['', Validators.maxLength(35)],
      stsRsnOrgtrCtry: ['', Validators.pattern(/^[A-Z]{2,2}$/)],
      stsRsnOrgtrAdrLine1: ['', Validators.maxLength(70)],
      stsRsnOrgtrAdrLine2: ['', Validators.maxLength(70)],

      // StsRsnInf -> Orgtr -> Identifiers
      stsRsnOrgtrAnyBIC: ['', BIC_OPT],
      stsRsnOrgtrLei: ['', [Validators.pattern(/^[A-Z0-9]{18}[0-9]{2}$/)]],
      stsRsnOrgtrCtryOfRes: ['', [Validators.pattern(/^[A-Z]{2,2}$/)]],
      
      // OrgId -> Othr
      stsRsnOrgtrOrgIdOthrId: ['', Validators.maxLength(35)],
      stsRsnOrgtrOrgIdOthrSchmeNmCd: ['', Validators.maxLength(4)],
      stsRsnOrgtrOrgIdOthrSchmeNmPrtry: ['', Validators.maxLength(35)],
      stsRsnOrgtrOrgIdOthrIssr: ['', Validators.maxLength(35)],

      // PrvtId -> Birth
      stsRsnOrgtrBirthDt: [''],
      stsRsnOrgtrPrvcOfBirth: ['', Validators.maxLength(35)],
      stsRsnOrgtrCityOfBirth: ['', Validators.maxLength(35)],
      stsRsnOrgtrCtryOfBirth: ['', Validators.pattern(/^[A-Z]{2,2}$/)],
      
      // PrvtId -> Othr
      stsRsnOrgtrPrvtIdOthrId: ['', Validators.maxLength(35)],
      stsRsnOrgtrPrvtIdOthrSchmeNmCd: ['', Validators.maxLength(4)],
      stsRsnOrgtrPrvtIdOthrSchmeNmPrtry: ['', Validators.maxLength(35)],
      stsRsnOrgtrPrvtIdOthrIssr: ['', Validators.maxLength(35)],

      // Reason
      stsRsnCd: [''],
      stsRsnPrtry: ['', [Validators.maxLength(35)]],

      // AddtlInf
      stsRsnAddtlInf: ['', [Validators.maxLength(105)]],

      // EffDt
      effDt: [''],
      effDtTm: [''],

      // ClrSysRef
      clrSysRef: ['', Validators.maxLength(35)],

      // InstgAgt
      instgAgtBic: ['BBBBUS33XXX', BIC_OPT],
      instgAgtClrSysCd: ['', Validators.maxLength(5)],
      instgAgtMmbId: ['', Validators.maxLength(35)],
      instgAgtLei: ['', Validators.pattern(/^[A-Z0-9]{18}[0-9]{2}$/)],

      // InstdAgt
      instdAgtBic: ['CCCCGB2LXXX', BIC_OPT],
      instdAgtClrSysCd: ['', Validators.maxLength(5)],
      instdAgtMmbId: ['', Validators.maxLength(35)],
      instdAgtLei: ['', Validators.pattern(/^[A-Z0-9]{18}[0-9]{2}$/)]
    });

    this.form.get('txSts')?.valueChanges.subscribe(() => {
      this.form.patchValue({ stsRsnCd: '' }, { emitEvent: false });
      this.updateReasonValidation();
    });

    this.form.valueChanges.pipe(debounceTime(300)).subscribe(() => {
      if (!this.isParsingXml && !this.isInternalChange) {
        this.generateXml();
        this.pushHistory();
      }
      this.scheduleDraftSave();
    });

    // Initial validation check
    this.updateReasonValidation();
  }

  updateReasonValidation() {
    const sts = this.form.get('txSts')?.value;
    const rsnCd = this.form.get('stsRsnCd');
    if (sts === 'RJCT' || sts === 'PDNG') {
      rsnCd?.setValidators([Validators.required]);
    } else {
      rsnCd?.clearValidators();
    }
    rsnCd?.updateValueAndValidity({ emitEvent: false });
  }

  fdt(dt: string): string {
    if (!dt) return dt;
    let s = dt.trim().replace(/\.\d+/, '').replace('Z', '+00:00');
    if (s && !/([+-]\d{2}:\d{2})$/.test(s)) s += '+00:00';
    return s;
  }

  isoNow(): string {
    return this.fdt(new Date().toISOString());
  }

  get bicSameWarning(): string | null {
    const from = (this.form.get('fromBic')?.value || '').trim().toUpperCase();
    const to = (this.form.get('toBic')?.value || '').trim().toUpperCase();
    if (!from || !to) return null;
    return from === to
      ? 'Sender BIC and Receiver BIC are identical. The instructing and instructed agents must represent different financial institutions.'
      : null;
  }

  generateXml() {
    const v = this.form.value;
    let txInf = '';
    
    // OrgnlGrpInf (Mandatory in CBPR+ if reporting on a msg)
    if (v.orgnlMsgId?.trim()) {
      txInf += this.branch('OrgnlGrpInf', 
        this.leaf('OrgnlMsgId', v.orgnlMsgId, 5) +
        this.leaf('OrgnlMsgNmId', v.orgnlMsgNmId, 5) +
        this.leaf('OrgnlCreDtTm', this.fdt(v.orgnlCreDtTm), 5)
      , 4);
    }

    // Refs
    txInf += this.leaf('OrgnlInstrId', v.orgnlInstrId, 4);
    txInf += this.leaf('OrgnlEndToEndId', v.orgnlEndToEndId, 4);
    txInf += this.leaf('OrgnlTxId', v.orgnlTxId, 4);
    txInf += this.leaf('OrgnlUETR', v.orgnlUETR, 4);

    // TxSts
    txInf += this.leaf('TxSts', v.txSts, 4);

    // StsRsnInf
    txInf += this.buildStsRsnInf(v);

    // FctvIntrBkSttlmDt
    txInf += this.buildFctvIntrBkSttlmDt(v);

    // ClrSysRef
    txInf += this.leaf('ClrSysRef', v.clrSysRef, 4);

    // Agts
    txInf += this.buildAgt('InstgAgt', v, 'instgAgt');
    txInf += this.buildAgt('InstdAgt', v, 'instdAgt');

    let xml = `<?xml version="1.0" encoding="UTF-8"?>
<BusMsgEnvlp xmlns="urn:swift:xsd:envelope">
\t<AppHdr xmlns="urn:iso:std:iso:20022:tech:xsd:head.001.001.02">
\t\t<Fr>
\t\t\t<FIId>
\t\t\t\t<FinInstnId>
\t\t\t\t\t<BICFI>${this.esc(v.fromBic)}</BICFI>
\t\t\t\t</FinInstnId>
\t\t\t</FIId>
\t\t</Fr>
\t\t<To>
\t\t\t<FIId>
\t\t\t\t<FinInstnId>
\t\t\t\t\t<BICFI>${this.esc(v.toBic)}</BICFI>
\t\t\t\t</FinInstnId>
\t\t\t</FIId>
\t\t</To>
\t\t<BizMsgIdr>${this.esc(v.bizMsgId)}</BizMsgIdr>
\t\t<MsgDefIdr>${this.esc(v.msgDefIdr)}</MsgDefIdr>
\t\t<BizSvc>${this.esc(v.bizSvc)}</BizSvc>
\t\t<CreDt>${this.fdt(v.creDtTm)}</CreDt>
\t</AppHdr>
\t<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pacs.002.001.10">
\t\t<FIToFIPmtStsRpt>
\t\t\t<GrpHdr>
\t\t\t\t<MsgId>${this.esc(v.msgId)}</MsgId>
\t\t\t\t<CreDtTm>${this.fdt(v.creDtTm)}</CreDtTm>
\t\t\t</GrpHdr>
\t\t\t<TxInfAndSts>
${txInf.trimEnd()}
\t\t\t</TxInfAndSts>
\t\t</FIToFIPmtStsRpt>
\t</Document>
</BusMsgEnvlp>`;
    this.generatedXml = xml;
    this.formatXml(false);
  }

  buildStsRsnInf(v: any): string {
    let inner = '';
    
    // Originator
    let orgtr = '';
    if (v.stsRsnOrgtrName?.trim() || v.stsRsnOrgtrTwnNm?.trim() || v.stsRsnOrgtrCtry?.trim() || 
        v.stsRsnOrgtrAnyBIC?.trim() || v.stsRsnOrgtrLei?.trim() || v.stsRsnOrgtrCtryOfRes?.trim() ||
        v.stsRsnOrgtrOrgIdOthrId?.trim() || v.stsRsnOrgtrPrvtIdOthrId?.trim() || v.stsRsnOrgtrBirthDt) {
      
      orgtr += this.leaf('Nm', v.stsRsnOrgtrName, 6);
      orgtr += this.addrXml(v, 'stsRsnOrgtr', 6);
      
      // Identifiers
      let id = '';
      
      // OrgId
      let orgId = '';
      orgId += this.leaf('AnyBIC', v.stsRsnOrgtrAnyBIC, 9);
      orgId += this.leaf('LEI', v.stsRsnOrgtrLei, 9);
      
      if (v.stsRsnOrgtrOrgIdOthrId?.trim()) {
        let othr = this.leaf('Id', v.stsRsnOrgtrOrgIdOthrId, 10);
        let scheme = this.leaf('Cd', v.stsRsnOrgtrOrgIdOthrSchmeNmCd, 12) + 
                    this.leaf('Prtry', v.stsRsnOrgtrOrgIdOthrSchmeNmPrtry, 12);
        if (scheme) othr += this.branch('SchmeNm', scheme, 11);
        othr += this.leaf('Issr', v.stsRsnOrgtrOrgIdOthrIssr, 10);
        orgId += this.branch('Othr', othr, 9);
      }
      
      if (orgId) id += this.branch('OrgId', orgId, 8);
      
      // PrvtId
      let prvtId = '';
      
      // Birth Details
      if (v.stsRsnOrgtrBirthDt) {
        let birth = this.leaf('BirthDt', v.stsRsnOrgtrBirthDt, 11);
        birth += this.leaf('PrvcOfBirth', v.stsRsnOrgtrPrvcOfBirth, 11);
        birth += this.leaf('CityOfBirth', v.stsRsnOrgtrCityOfBirth, 11);
        birth += this.leaf('CtryOfBirth', v.stsRsnOrgtrCtryOfBirth, 11);
        prvtId += this.branch('DtAndPlcOfBirth', birth, 10);
      }
      
      if (v.stsRsnOrgtrPrvtIdOthrId?.trim()) {
        let othr = this.leaf('Id', v.stsRsnOrgtrPrvtIdOthrId, 11);
        let scheme = this.leaf('Cd', v.stsRsnOrgtrPrvtIdOthrSchmeNmCd, 13) + 
                    this.leaf('Prtry', v.stsRsnOrgtrPrvtIdOthrSchmeNmPrtry, 13);
        if (scheme) othr += this.branch('SchmeNm', scheme, 12);
        othr += this.leaf('Issr', v.stsRsnOrgtrPrvtIdOthrIssr, 11);
        prvtId += this.branch('Othr', othr, 10);
      }
      
      if (prvtId) id += this.branch('PrvtId', prvtId, 8);
      
      if (id) orgtr += this.branch('Id', id, 7);
      
      orgtr += this.leaf('CtryOfRes', v.stsRsnOrgtrCtryOfRes, 6);
    }
    if (orgtr) inner += this.branch('Orgtr', orgtr, 5);

    // Reason
    let rsn = '';
    if (v.stsRsnCd?.trim()) rsn += this.leaf('Cd', v.stsRsnCd, 7);
    else if (v.stsRsnPrtry?.trim()) rsn += this.leaf('Prtry', v.stsRsnPrtry, 7);
    if (rsn) inner += this.branch('Rsn', rsn, 6);

    // AddtlInf
    if (v.stsRsnAddtlInf?.trim()) inner += this.leaf('AddtlInf', v.stsRsnAddtlInf, 5);

    return inner ? this.branch('StsRsnInf', inner, 4) : '';
  }

  buildFctvIntrBkSttlmDt(v: any): string {
    if (v.effDt?.trim()) return this.branch('FctvIntrBkSttlmDt', this.leaf('Dt', v.effDt, 5), 4);
    if (v.effDtTm?.trim()) return this.branch('FctvIntrBkSttlmDt', this.leaf('DtTm', this.fdt(v.effDtTm), 5), 4);
    return '';
  }

  buildAgt(tag: string, v: any, prefix: string): string {
    let inner = '';
    if (v[prefix + 'Bic']?.trim()) inner += this.leaf('BICFI', v[prefix + 'Bic'], 6);
    if (v[prefix + 'MmbId']?.trim()) {
      let clr = '';
      if (v[prefix + 'ClrSysCd']?.trim()) clr += this.branch('ClrSysId', this.leaf('Cd', v[prefix + 'ClrSysCd'], 8), 7);
      clr += this.leaf('MmbId', v[prefix + 'MmbId'], 7);
      inner += this.branch('ClrSysMmbId', clr, 6);
    }
    if (v[prefix + 'Lei']?.trim()) inner += this.leaf('LEI', v[prefix + 'Lei'], 6);
    
    return inner ? this.branch(tag, this.branch('FinInstnId', inner, 5), 4) : '';
  }

  addrXml(v: any, p: string, indent = 4): string {
    const lines: string[] = []; const t = '\t'.repeat(indent + 1);
    const val = (f: string) => v[p + f]?.trim();

    ['Dept', 'SubDept', 'StrtNm', 'BldgNb', 'BldgNm', 'Flr', 'PstBx', 'Room', 'PstCd', 'TwnNm', 'TwnLctnNm', 'DstrctNm', 'CtrySubDvsn', 'Ctry'].forEach(f => {
      if (val(f)) lines.push(`${t}<${f}>${this.esc(val(f))}</${f}>`);
    });
    if (val('AdrLine1')) lines.push(`${t}<AdrLine>${this.esc(val('AdrLine1'))}</AdrLine>`);
    if (val('AdrLine2')) lines.push(`${t}<AdrLine>${this.esc(val('AdrLine2'))}</AdrLine>`);

    return lines.length ? `${'\t'.repeat(indent)}<PstlAdr>\n${lines.join('\n')}\n${'\t'.repeat(indent)}</PstlAdr>\n` : '';
  }

  private esc(v: any): string {
    if (v === null || v === undefined) return '';
    return v.toString().trim()
      .replace(/[\n\r\t]+/g, ' ')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  private leaf(tag: string, val: any, indent = 3): string {
    const content = this.esc(val);
    if (!content) return '';
    return `${'\t'.repeat(indent)}<${tag}>${content}</${tag}>\n`;
  }

  private branch(tag: string, content: string, indent = 3): string {
    const c = content?.trim();
    if (!c) return '';
    return `${'\t'.repeat(indent)}<${tag}>\n${c}\n${'\t'.repeat(indent)}</${tag}>\n`;
  }

  // History & Editor Logic
  onEditorChange(content: string) {
    if (this.isInternalChange) return;
    this.generatedXml = content;
    this.refreshLineCount();
    this.parseXmlToForm(content);
  }

  pushHistory() {
    if (this.xmlHistory[this.xmlHistoryIdx] === this.generatedXml) return;
    this.xmlHistory = this.xmlHistory.slice(0, this.xmlHistoryIdx + 1);
    this.xmlHistory.push(this.generatedXml);
    if (this.xmlHistory.length > 50) this.xmlHistory.shift();
    else this.xmlHistoryIdx++;
  }

  undoXml() {
    if (this.xmlHistoryIdx > 0) {
      this.xmlHistoryIdx--;
      this.isInternalChange = true;
      this.generatedXml = this.xmlHistory[this.xmlHistoryIdx];
      this.refreshLineCount();
      this.parseXmlToForm(this.generatedXml);
      setTimeout(() => this.isInternalChange = false, 10);
    }
  }

  redoXml() {
    if (this.xmlHistoryIdx < this.xmlHistory.length - 1) {
      this.xmlHistoryIdx++;
      this.isInternalChange = true;
      this.generatedXml = this.xmlHistory[this.xmlHistoryIdx];
      this.refreshLineCount();
      this.parseXmlToForm(this.generatedXml);
      setTimeout(() => this.isInternalChange = false, 10);
    }
  }

  canUndoXml() { return this.xmlHistoryIdx > 0; }
  canRedoXml() { return this.xmlHistoryIdx < this.xmlHistory.length - 1; }

  refreshLineCount() {
    const lines = (this.generatedXml || '').split('\n').length;
    this.editorLineCount = Array.from({ length: Math.max(lines, 1) }, (_, i) => i + 1);
  }

  syncScroll(editor: HTMLTextAreaElement, gutter: HTMLDivElement) {
    gutter.scrollTop = editor.scrollTop;
  }
  formatXml(showToast = true) {
    if (!this.generatedXml?.trim()) return;
    this.pushHistory();

    try {
      const tab = '    ';
      let formatted = '';
      let indent = '';
      // Normalize XML
      let xml = this.generatedXml.replace(/>\s+</g, '><').trim();
      
      // Intelligent regex to split Tags and Comments
      const reg = /(<[^/!?][^>]*>[^<]*<\/[^>]+>)|(<[^>]+\/>)|(<[^>]+>)|(<!--[\s\S]*?-->)|([^<]+)/g;
      const nodes = xml.match(reg) || [];

      nodes.forEach(node => {
        const trimmed = node.trim();
        if (!trimmed) return;

        if (trimmed.startsWith('</')) {
          if (indent.length >= tab.length) indent = indent.substring(tab.length);
          formatted += indent + trimmed + '\r\n';
        } else if ((trimmed.startsWith('<') && trimmed.includes('</')) || trimmed.endsWith('/>')) {
          formatted += indent + trimmed + '\r\n';
        } else if (trimmed.startsWith('<') && !trimmed.startsWith('<?')) {
          formatted += indent + trimmed + '\r\n';
          indent += tab;
        } else {
          formatted += indent + trimmed + '\r\n';
        }
      });
      this.generatedXml = formatted.trim();
      this.refreshLineCount();
      if (showToast) { this.snackBar.open('XML Formatted', '', { duration: 1500 }); }
    } catch (e) {
      this.snackBar.open('Unable to format XML', '', { duration: 3000 });
    }
  }

  parseXmlToForm(content: string) {
    if (!content || content.length < 50) return;
    if (this.isParsingXml) return;
    try {
      this.isParsingXml = true;
      const cleanXml = content.replace(/<(\/?)(?:[\w]+:)/g, '<$1');
      const doc = new DOMParser().parseFromString(cleanXml, 'text/xml');
      if (doc.querySelector('parsererror')) {
        this.snackBar.open('Invalid XML: Unable to parse content.', 'Close', { duration: 3000 });
        return;
      }

      const getT = (t: string, p: any = doc): Element | null => {
        const els = p.getElementsByTagName(t);
        if (els.length > 0) return els[0];
        const all = p.getElementsByTagName('*');
        for (let i = 0; i < all.length; i++) {
          if (all[i].localName === t) return all[i];
        }
        return null;
      };
      const tval = (t: string, p: any = doc) => getT(t, p)?.textContent?.trim() || '';

      const patch: any = {};
      // Only patch fields the parser explicitly reads — previously this wiped
      // every control to '' on each XML edit, silently dropping user data.

      // BAH
      const appHdr = getT('AppHdr');
      if (appHdr) {
        const fr = getT('Fr', appHdr);
        if (fr) {
          patch.fromBic = tval('BICFI', fr);
        }
        const to = getT('To', appHdr);
        if (to) {
          patch.toBic = tval('BICFI', to);
        }
        patch.bizMsgId = tval('BizMsgIdr', appHdr);
        patch.msgDefIdr = tval('MsgDefIdr', appHdr);
        patch.bizSvc = tval('BizSvc', appHdr);
        patch.creDtTm = tval('CreDt', appHdr) || tval('CreDtTm', appHdr);
      }

      // Document
      const grpHdr = getT('GrpHdr');
      if (grpHdr) {
        patch.msgId = tval('MsgId', grpHdr);
      }

      const tx = getT('TxInfAndSts');
      if (tx) {
        const grpInf = getT('OrgnlGrpInf', tx);
        if (grpInf) {
          patch.orgnlMsgId = tval('OrgnlMsgId', grpInf);
          patch.orgnlMsgNmId = tval('OrgnlMsgNmId', grpInf);
          patch.orgnlCreDtTm = tval('OrgnlCreDtTm', grpInf);
        }

        patch.orgnlInstrId = tval('OrgnlInstrId', tx);
        patch.orgnlEndToEndId = tval('OrgnlEndToEndId', tx);
        patch.orgnlTxId = tval('OrgnlTxId', tx);
        patch.orgnlUETR = tval('OrgnlUETR', tx);
        patch.txSts = tval('TxSts', tx);
        patch.clrSysRef = tval('ClrSysRef', tx);

        const rsnInf = getT('StsRsnInf', tx);
        if (rsnInf) {
          const orgtr = getT('Orgtr', rsnInf);
          if (orgtr) {
            patch.stsRsnOrgtrName = tval('Nm', orgtr);
            const pstl = getT('PstlAdr', orgtr);
            if (pstl) {
              patch.stsRsnOrgtrStrtNm = tval('StrtNm', pstl);
              patch.stsRsnOrgtrBldgNb = tval('BldgNb', pstl);
              patch.stsRsnOrgtrBldgNm = tval('BldgNm', pstl);
              patch.stsRsnOrgtrFlr = tval('Flr', pstl);
              patch.stsRsnOrgtrPstBx = tval('PstBx', pstl);
              patch.stsRsnOrgtrRoom = tval('Room', pstl);
              patch.stsRsnOrgtrPstCd = tval('PstCd', pstl);
              patch.stsRsnOrgtrTwnNm = tval('TwnNm', pstl);
              patch.stsRsnOrgtrTwnLctnNm = tval('TwnLctnNm', pstl);
              patch.stsRsnOrgtrDstrctNm = tval('DstrctNm', pstl);
              patch.stsRsnOrgtrCtrySubDvsn = tval('CtrySubDvsn', pstl);
              patch.stsRsnOrgtrCtry = tval('Ctry', pstl);
              const lines = pstl.querySelectorAll(':scope > AdrLine');
              if (lines.length > 0) patch.stsRsnOrgtrAdrLine1 = lines[0].textContent || '';
              if (lines.length > 1) patch.stsRsnOrgtrAdrLine2 = lines[1].textContent || '';
            }

            const id = getT('Id', orgtr);
            if (id) {
              const orgId = getT('OrgId', id);
              if (orgId) {
                patch.stsRsnOrgtrAnyBIC = tval('AnyBIC', orgId);
                patch.stsRsnOrgtrLei = tval('LEI', orgId);
                const othr = getT('Othr', orgId);
                if (othr) {
                  patch.stsRsnOrgtrOrgIdOthrId = tval('Id', othr);
                  const scheme = getT('SchmeNm', othr);
                  if (scheme) {
                    patch.stsRsnOrgtrOrgIdOthrSchmeNmCd = tval('Cd', scheme);
                    patch.stsRsnOrgtrOrgIdOthrSchmeNmPrtry = tval('Prtry', scheme);
                  }
                  patch.stsRsnOrgtrOrgIdOthrIssr = tval('Issr', othr);
                }
              }

              const prvtId = getT('PrvtId', id);
              if (prvtId) {
                const birth = getT('DtAndPlcOfBirth', prvtId);
                if (birth) {
                  patch.stsRsnOrgtrBirthDt = tval('BirthDt', birth);
                  patch.stsRsnOrgtrPrvcOfBirth = tval('PrvcOfBirth', birth);
                  patch.stsRsnOrgtrCityOfBirth = tval('CityOfBirth', birth);
                  patch.stsRsnOrgtrCtryOfBirth = tval('CtryOfBirth', birth);
                }
                const othr = getT('Othr', prvtId);
                if (othr) {
                  patch.stsRsnOrgtrPrvtIdOthrId = tval('Id', othr);
                  const scheme = getT('SchmeNm', othr);
                  if (scheme) {
                    patch.stsRsnOrgtrPrvtIdOthrSchmeNmCd = tval('Cd', scheme);
                    patch.stsRsnOrgtrPrvtIdOthrSchmeNmPrtry = tval('Prtry', scheme);
                  }
                  patch.stsRsnOrgtrPrvtIdOthrIssr = tval('Issr', othr);
                }
              }
            }
            patch.stsRsnOrgtrCtryOfRes = tval('CtryOfRes', orgtr);
          }

          const rsn = getT('Rsn', rsnInf);
          if (rsn) {
            patch.stsRsnCd = tval('Cd', rsn);
            patch.stsRsnPrtry = tval('Prtry', rsn);
          }
          patch.stsRsnAddtlInf = tval('AddtlInf', rsnInf);
        }

        const effDt = getT('FctvIntrBkSttlmDt', tx);
        if (effDt) {
          patch.effDt = tval('Dt', effDt);
          patch.effDtTm = tval('DtTm', effDt);
        }

        const mapAgt = (p: string, tag: string, parent: any = tx) => {
          const el = getT(tag, parent);
          if (!el) return;
          const fi = getT('FinInstnId', el);
          if (fi) {
            patch[p + 'Bic'] = tval('BICFI', fi);
            patch[p + 'Lei'] = tval('LEI', fi);
            const mmb = getT('ClrSysMmbId', fi);
            if (mmb) {
              patch[p + 'MmbId'] = tval('MmbId', mmb);
              patch[p + 'ClrSysCd'] = tval('Cd', getT('ClrSysId', mmb) || mmb);
            }
          }
        };

        mapAgt('instgAgt', 'InstgAgt');
        mapAgt('instdAgt', 'InstdAgt');
      }

      this.form.patchValue(patch, { emitEvent: false });
    } catch (e) {
      console.warn('XML Parse failed', e);
    } finally {
      this.isParsingXml = false;
    }
  }

  validateMessage() {
        if (this.bicSameWarning) return;
    this.form.markAllAsTouched();
    if (this.form.invalid) {
      this.snackBar.open('Please fix the errors in the form before validating.', 'Close', { duration: 3000 });
      return;
    }
    if (!this.generatedXml?.trim()) return;

    this.showValidationModal = true;
    this.validationStatus = 'validating';
    this.validationReport = null;
    this.validationExpandedIssue = null;

    this.http.post(this.config.getApiUrl('/validate'), {
      xml_content: this.generatedXml,
      mode: 'Full 1-3',
      message_type: 'pacs.002.001.10',
      store_in_history: true
    }).subscribe({
      next: (data: any) => {
        this.validationReport = data;
        this.validationStatus = 'done';
        this.clearDraft();
      },
      error: (err) => {
        this.validationReport = {
          status: 'FAIL', errors: 1, warnings: 0,
          message: 'pacs.002.001.10', total_time_ms: 0,
          layer_status: {},
          details: [{
            severity: 'ERROR', layer: 0, code: 'BACKEND_ERROR',
            path: '', message: 'Validation failed â€” ' + (err.error?.detail?.message || 'backend error.'),
            fix_suggestion: 'Verify your network or if the validation service is up.'
          }]
        };
        this.validationStatus = 'done';
      }
    });
  }

  getValidationStatusClass() {
    if (!this.validationReport) return '';
    return this.validationReport.status === 'OK' ? 'status-ok' : 'status-fail';
  }

  // UI Helpers
  err(f: string): string | null {
    const c = this.form.get(f);
    if (!c || c.valid || (!c.touched && !c.dirty)) return null;
    
    // Always show maxlength errors immediately as they occur
    if (c.errors?.['maxlength']) return `Max length ${c.errors['maxlength'].requiredLength} characters.`;
    
    // For other errors (Required, Pattern), only show after the user has interacted with the field
    if (!c.touched && !c.dirty) return null;

    if (c.errors?.['required']) return 'Required field.';
    if (c.errors?.['pattern']) {
      if (f.toLowerCase().includes('bic')) return 'Valid 8 or 11 character BIC is required.';
      if (f.toLowerCase().includes('uetr')) return 'Valid RFC 4122 v4 UUID expected.';
      return 'Invalid format.';
    }
    return 'Invalid value.';
  }

  refreshUetr(): void {
    const newUetr = this.uetrService.generate();
    this.form.patchValue({ orgnlUETR: newUetr });
    this.snackBar.open('New UETR Generated', '', { duration: 1500 });
  }

  onUetrPaste(event: ClipboardEvent): void {
    event.preventDefault();
    const pastedText = event.clipboardData?.getData('text') || '';
    const cleanUetr = pastedText.trim().toLowerCase();
    this.form.patchValue({ orgnlUETR: cleanUetr });
    this.validateManualUetr();
  }

  validateManualUetr(): void {
    const uetrValue = this.form.get('orgnlUETR')?.value;
    if (uetrValue && !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(uetrValue)) {
      this.snackBar.open('Manual UETR might not be valid RFC 4122 v4', 'OK', { duration: 3000 });
    }
  }

  downloadXml() {
    this.generateXml();
    const blob = new Blob([this.generatedXml], { type: 'application/xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `pacs002-${Date.now()}.xml`;
    a.click();
    URL.revokeObjectURL(url);
  }

  copyXml() {
    navigator.clipboard.writeText(this.generatedXml);
    this.snackBar.open('XML Copied!', 'Close', { duration: 2000 });
  }

  closeValidationModal() { this.showValidationModal = false; }
  getValidationLayers() { return this.validationReport?.layer_status ? Object.keys(this.validationReport.layer_status) : []; }
  isLayerPass(k: string) { return this.getLayerStatus(k).includes('âœ…'); }
  isLayerFail(k: string) { return this.getLayerStatus(k).includes('âŒ'); }
  isLayerWarn(k: string) {
    const s = this.getLayerStatus(k);
    return s.includes('âš ') || s.includes('WARNING') || s.includes('WARN');
  }
  getLayerName(k: string) { const m: any = { '1': 'Syntax & Format', '2': 'Schema Validation', '3': 'Business Rules' }; return m[k] || `Layer ${k}`; }
  getLayerTime(k: string) { return this.validationReport.layer_status[k]?.time || 0; }
  getLayerStatus(k: string) { return this.validationReport?.layer_status[k]?.status || 'IDLE'; }
  getValidationIssues() { return this.validationReport?.details || []; }
  toggleValidationIssue(i: any) { this.validationExpandedIssue = this.validationExpandedIssue === i ? null : i; }

  viewXmlModal() {
    this.closeValidationModal();
    // In pacs2, there's no tab system shown in the other files for preview, 
  }

  editXmlModal() {
    this.closeValidationModal();
  }

  runValidationModal() {
    this.validateMessage();
  }

  copyFix(suggestion: string, event: Event) {
    event.stopPropagation();
    navigator.clipboard.writeText(suggestion).then(() => {
      this.snackBar.open('Fix suggestion copied!', 'Close', { duration: 2000 });
    });
  }

  copyToClipboard() {
    this.copyXml();
  }

  hint(f: string, maxLen: number): string | null {
    if (this.err(f)) return null;
    const c = this.form.get(f);
    if (!c || !c.value) return null;
    const len = c.value.toString().length;
    return len > maxLen ? `Maximum ${maxLen} characters reached (${len}/${maxLen})` : null;
  }
  openBicSearch(controlName: string, index?: number) {
    const dialogRef = this.dialog.open(BicSearchDialogComponent, {
      width: '800px',
      disableClose: true
    });

    dialogRef.afterClosed().subscribe(result => {
      if (result && result.bic) {
        if (index !== undefined) {
          const formArray = this.form.get(controlName) as any;
          if (formArray && formArray.at) {
            const arrCtrl = formArray.at(index);
            arrCtrl.setValue(result.bic, { emitEvent: true });
            arrCtrl.markAsTouched();
            arrCtrl.markAsDirty();
            arrCtrl.updateValueAndValidity();
          }
        } else {
          const ctrl = this.form.get(controlName);
                    if (ctrl) {
                      ctrl.setValue(result.bic, { emitEvent: true });
                      ctrl.markAsTouched();
                      ctrl.markAsDirty();
                      ctrl.updateValueAndValidity();
                    }
        }
      }
    });
  }

  openBicSearchGroup(controlName: string, group: any) {
    const dialogRef = this.dialog.open(BicSearchDialogComponent, {
      width: '800px',
      disableClose: true
    });

    dialogRef.afterClosed().subscribe(result => {
      if (result && result.bic) {
        const targetGroup = group || this.form;
        const control = targetGroup.get(controlName);
        
        if (control) {
          control.setValue(result.bic, { emitEvent: true });
          control.markAsTouched();
          control.markAsDirty();
          control.updateValueAndValidity();
        }
      }
    });
  }

  private saveDraft(): void {
    try { localStorage.setItem(this.DRAFT_KEY, JSON.stringify(this.form.value)); }
    catch (e) { console.warn('Draft save failed:', e); }
  }

  private loadDraft(): boolean {
    try {
      const saved = localStorage.getItem(this.DRAFT_KEY);
      if (!saved) return false;
      this.form.patchValue(JSON.parse(saved), { emitEvent: false });
      return true;
    } catch (e) { console.warn('Draft load failed:', e); return false; }
  }

  clearDraft(reload = false): void {
    this.isClearingDraft = reload;
    try { localStorage.removeItem(this.DRAFT_KEY); } catch (e) {}
    this.showDraftBanner = false;
    if (reload) { setTimeout(() => window.location.reload(), 500); }
  }

  private scheduleDraftSave(): void {
    if (this.draftSaveTimer) clearTimeout(this.draftSaveTimer);
    this.draftSaveTimer = setTimeout(() => this.saveDraft(), 2000);
  }

  ngOnDestroy(): void {
    if (this.draftSaveTimer) clearTimeout(this.draftSaveTimer);
  }
}
