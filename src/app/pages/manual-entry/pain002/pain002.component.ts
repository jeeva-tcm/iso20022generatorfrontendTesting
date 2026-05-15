import { BicSearchDialogComponent } from '../bic-search-dialog/bic-search-dialog.component';
import { MatDialog } from '@angular/material/dialog';
import { Component, OnInit, OnDestroy, ViewChild, ElementRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormBuilder, FormGroup, FormArray, ReactiveFormsModule, Validators, FormsModule } from '@angular/forms';
import { MatIconModule } from '@angular/material/icon';
import { HttpClient } from '@angular/common/http';
import { ConfigService } from '../../../services/config.service';
import { MatSnackBar } from '@angular/material/snack-bar';
import { Router } from '@angular/router';
import { UetrService } from '../../../services/uetr.service';
import { debounceTime } from 'rxjs/operators';

@Component({
  selector: 'app-pain002',
  standalone: true,
  imports: [CommonModule, ReactiveFormsModule, FormsModule, MatIconModule],
  templateUrl: './pain002.component.html',
  styleUrls: ['./pain002.component.css']
})
export class Pain002Component implements OnInit, OnDestroy {
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

  // Form submission validation
  formSubmissionErrors: string[] = [];
  showSubmissionErrors = false;

  // Real-time character limit validation
  fieldLimits: Record<string, number> = {
    'BizMsgIdr': 35, 'MsgId': 35, 'Nm': 140, 'AddtlInf': 105,
    'BICFI': 11, 'LEI': 20, 'MmbId': 35, 'AdrLine': 70,
    'BizSvc': 35, 'Regy': 35, 'Id': 35, 'ClrSys': 5,
    'InstrId': 35, 'EndToEndId': 35, 'PmtInfId': 35,
    'Prov': 35, 'City': 35, 'Prtry': 35, 'Issr': 35,
    'Dept': 70, 'SubDept': 70, 'Street': 70, 'Floor': 70, 'Room': 70,
    'BldgNm': 35, 'Town': 35, 'TownLctn': 35, 'District': 35, 'CtrySub': 35,
    'BldgNb': 16, 'PstBx': 16, 'PstCd': 16
  };
  limitMessages: Record<string, string> = {};
  leiValidationMessages: Record<string, string> = {};

  // Collapsible sections
  sections: Record<string, boolean> = {
    'bah': true,
    'bahFrom': false,
    'bahTo': false,
    'bahMktPrctc': false,
    'bahRltd': false,
    'grpHdr': true,
    'orgnlGrpInf': true,
    'orgnlPmtInf': true,
    'txInf': true
  };

  countries: string[] = [];

  private readonly DRAFT_KEY = 'draft_pain002';
  private draftSaveTimer: ReturnType<typeof setTimeout> | null = null;
  showDraftBanner = false;
  isClearingDraft = false;

  // Codelists
  charSetOptions = ['UTF-8', 'US-ASCII', 'ISO-8859-1'];
  groupStatuses = ['ACCP', 'ACSP', 'ACTC', 'PART', 'RCVD', 'RJCT'];
  transactionStatuses = [
    { code: 'ACCP', label: 'Accepted Customer Profile' },
    { code: 'ACSC', label: 'Accepted Settlement Completed' },
    { code: 'ACSP', label: 'Accepted Settlement In Process' },
    { code: 'ACTC', label: 'Accepted Technical Validation' },
    { code: 'ACWC', label: 'Accepted With Change' },
    { code: 'ACWP', label: 'Accepted Without Posting' },
    { code: 'BLCK', label: 'Blocked' },
    { code: 'CANC', label: 'Cancelled' },
    { code: 'PATC', label: 'Partially Accepted' },
    { code: 'PDNG', label: 'Pending' },
    { code: 'RCVD', label: 'Received' },
    { code: 'RJCT', label: 'Rejected' }
  ];
  statusReasonCodes = [
    { code: 'AC01', label: 'Incorrect Account Number' },
    { code: 'AC04', label: 'Closed Account Number' },
    { code: 'AC06', label: 'Blocked Account' },
    { code: 'AG01', label: 'Transaction Forbidden' },
    { code: 'AM04', label: 'Insufficient Funds' },
    { code: 'AM05', label: 'Duplication' },
    { code: 'BE05', label: 'Unrecognised Initiating Party' },
    { code: 'CUST', label: 'Requested By Customer' },
    { code: 'DUPL', label: 'Duplicate Payment' },
    { code: 'MS03', label: 'Not Specified Reason Agent' },
    { code: 'NARR', label: 'Narrative' },
    { code: 'TECH', label: 'Technical Problem' }
  ];

  clrSysCodes = ['CHIPS', 'T2', 'FED', 'CHAPS'];
  copyDplctCodes = ['COPY', 'CODU', 'DUPL'];
  priorityCodes = ['HIGH', 'NORM'];
  
  orgSchemeCodes = ['LEI', 'DUNS', 'VAT', 'TXID', 'GIIN', 'CRN'];
  prvtSchemeCodes = ['CCPT', 'DRLC', 'NIDN', 'SSSN', 'PASSPORT', 'NATIONALID'];

  orgSchemeGuidance: Record<string, string> = {
    'LEI': 'Enter valid Legal Entity Identifier (20 characters)',
    'DUNS': 'Enter valid DUNS number (9 digits)',
    'VAT': 'Enter valid VAT number',
    'TXID': 'Enter valid Tax Identification Number',
    'GIIN': 'Enter valid Global Intermediary Identification Number',
    'CRN': 'Enter valid Company Registration Number'
  };

  prvtSchemeGuidance: Record<string, string> = {
    'CCPT': 'Enter valid passport number',
    'DRLC': 'Enter valid driving license number',
    'NIDN': 'Enter valid national ID number',
    'SSSN': 'Enter valid social security number',
    'PASSPORT': 'Enter valid passport number',
    'NATIONALID': 'Enter valid national identity number'
  };

  constructor(
    private dialog: MatDialog,
    private fb: FormBuilder,
    private http: HttpClient,
    private config: ConfigService,
    private snackBar: MatSnackBar,
    private router: Router,
    public uetrService: UetrService
  ) {}

  ngOnInit() {
    this.fetchCountries();
    this.buildForm();
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

  toggleSection(key: string) {
    this.sections[key] = !this.sections[key];
  }

  getSchemeGuidance(group: any, type: 'org' | 'prvt'): string {
    const code = group.get(type === 'org' ? 'orgScheme' : 'prvtScheme')?.value;
    if (!code) return '';
    return type === 'org' ? this.orgSchemeGuidance[code] : this.prvtSchemeGuidance[code];
  }

  futureDateValidator(control: any) {
    if (!control.value) return null;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const selectedDate = new Date(control.value);
    selectedDate.setHours(0, 0, 0, 0);
    return selectedDate > today ? { future_date: true } : null;
  }

  bahValidator = (g: any): any => {
    const checkClrSys = (prefix: string) => {
      const cd = g.get(`${prefix}ClrSysCd`)?.value;
      const mmb = g.get(`${prefix}MmbId`)?.value;
      if (mmb && !cd) return { [`${prefix}_clrSysCdMissing`]: true };
      return null;
    };

    const prefixes = ['head_from', 'head_to'];
    const rltdEnabled = g.get('head_rltd_enabled')?.value;
    if (rltdEnabled) {
      prefixes.push('head_rltd_from', 'head_rltd_to');
    }

    let errors: any = null;
    for (const p of prefixes) {
      const err = checkClrSys(p);
      if (err) errors = { ...(errors || {}), ...err };
    }

    const cpy = g.get('head_cpyDplct')?.value;
    const rltd = g.get('head_rltd_enabled')?.value;
    if (cpy && !rltd) errors = { ...(errors || {}), rltdHeaderMissing: true };

    const mktRegy = g.get('head_mktPrctcRegy')?.value;
    const mktId = g.get('head_mktPrctcId')?.value;
    if (mktRegy && !mktId) errors = { ...(errors || {}), mktPrctcIdMissing: true };

    const initPty = g.get('initgPty');
    if (initPty) {
      const type = initPty.get('idType')?.value;
      if (type === 'org') {
        const bic = initPty.get('orgAnyBic')?.value;
        const lei = initPty.get('orgLei')?.value;
        const othr = initPty.get('orgId')?.value;
        if (!bic && !lei && !othr) errors = { ...(errors || {}), initgPtyIdRequired: true };
      }
    }

    const fwd = g.get('fwdgAgt');
    if (fwd) {
      const bic = fwd.get('bic')?.value;
      const mmb = fwd.get('mmbId')?.value;
      const lei = fwd.get('lei')?.value;
      if (!bic && !mmb && !lei) errors = { ...(errors || {}), fwdgAgtIdRequired: true };
    }

    const txArr = g.get('transactions') as FormArray;
    if (txArr) {
      txArr.controls.forEach((tx, i) => {
        const sts = tx.get('txSts')?.value;
        const rsn = tx.get('stsRsnCd')?.value;
        if (sts === 'RJCT' && !rsn) errors = { ...(errors || {}), [`tx_${i}_rsnRequired`]: true };
      });
    }

    return errors;
  };

  buildForm() {
    const BIC_OPT = [Validators.pattern(/^[A-Z]{6}[A-Z2-9][A-NP-Z0-9]([A-Z0-9]{3})?$/)];
    const LEI_PATTERN = [Validators.pattern(/^[A-Z0-9]{20}$/)];
    const CLEARING_CODE_PATTERN = [Validators.maxLength(5)];
    const MMB_ID_PATTERN = [Validators.pattern(/^[A-Z0-9]{1,35}$/)];

    this.form = this.fb.group({
      head_charSet: ['UTF-8'],
      head_fromBic: ['HDFCINBBXXX', BIC_OPT],
      head_fromClrSysCd: ['', CLEARING_CODE_PATTERN],
      head_fromMmbId: ['', MMB_ID_PATTERN],
      head_fromLei: ['', LEI_PATTERN],
      head_toBic: ['CHASUS33XXX', BIC_OPT],
      head_toClrSysCd: ['', CLEARING_CODE_PATTERN],
      head_toMmbId: ['', MMB_ID_PATTERN],
      head_toLei: ['', LEI_PATTERN],
      head_bizMsgIdr: ['MSGID-' + this.dateStamp() + '-' + this.randomId(), [Validators.required, Validators.maxLength(35)]],
      head_msgDefIdr: [{ value: 'pain.002.001.10', disabled: true }],
      head_bizSvc: ['swift.cbprplus.02', [Validators.required, Validators.maxLength(35)]],
      head_mktPrctcRegy: ['', [Validators.maxLength(35)]],
      head_mktPrctcId: ['', [Validators.maxLength(35)]],
      head_creDt: [this.isoNow(), Validators.required],
      head_cpyDplct: [''],
      head_pssblDplct: [false],
      head_prty: ['NORM'],

      head_rltd_enabled: [false],
      head_rltd_charSet: ['UTF-8'],
      head_rltd_fromBic: ['', BIC_OPT],
      head_rltd_fromClrSysCd: [''],
      head_rltd_fromMmbId: ['', [Validators.maxLength(35)]],
      head_rltd_fromLei: ['', LEI_PATTERN],
      head_rltd_toBic: ['', BIC_OPT],
      head_rltd_toClrSysCd: [''],
      head_rltd_toMmbId: ['', [Validators.maxLength(35)]],
      head_rltd_toLei: ['', LEI_PATTERN],
      head_rltd_bizMsgIdr: ['', [Validators.maxLength(35)]],
      head_rltd_msgDefIdr: [''],
      head_rltd_bizSvc: [''],
      head_rltd_creDt: [''],
      head_rltd_cpyDplct: [''],
      head_rltd_pssblDplct: [false],
      head_rltd_prty: [''],

      grpHdr_msgId: ['PAIN002-' + this.dateStamp() + '-' + this.randomId(), [Validators.required, Validators.maxLength(35)]],
      grpHdr_creDtTm: [this.isoNow(), Validators.required],
      initgPty: this.initPartyGroup(),
      fwdgAgt: this.initAgentGroup(),

      orgnlMsgId: ['MSGID-' + this.dateStamp() + '-' + this.randomId(), [Validators.required, Validators.maxLength(35)]],
      orgnlMsgNmId: ['pain.001.001.09', [Validators.required, Validators.maxLength(35)]],
      orgnlCreDtTm: ['', [Validators.pattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/)]],

      orgnlPmtInfId: ['PMTINF-' + this.dateStamp() + '-001', [Validators.required, Validators.maxLength(35)]],
      transactions: this.fb.array([this.initTransaction()])
    }, { validators: [this.bahValidator] });

    this.form.valueChanges.pipe(debounceTime(300)).subscribe(() => {
      if (!this.isParsingXml && !this.isInternalChange) {
        this.generateXml();
        this.pushHistory();
        this.scheduleDraftSave();
      }
    });

    // Auto-uppercase all BIC, LEI, and ID fields across the entire form (main, parties, transactions)
    this.form.valueChanges.pipe(debounceTime(300)).subscribe(() => {
        this.applyAutoUppercase(this.form);
    });

    // Auto-enable Related Header when Copy/Duplicate is selected
    this.form.get('head_cpyDplct')?.valueChanges.subscribe(v => {
      if (v) {
        this.form.get('head_rltd_enabled')?.setValue(true);
        this.sections['bahRltd'] = true;
      }
    });

    // Clear Copy/Duplicate if Related Header is manually unchecked to maintain validity
    this.form.get('head_rltd_enabled')?.valueChanges.subscribe(v => {
      if (!v) {
        this.form.get('head_cpyDplct')?.setValue('');
      }
    });
  }

  private applyAutoUppercase(group: FormGroup | FormArray) {
    Object.keys(group.controls).forEach(key => {
      const control = (group.controls as any)[key];
      if (control instanceof FormGroup || control instanceof FormArray) {
        this.applyAutoUppercase(control);
      } else {
        const val = control.value;
        if (typeof val === 'string' && (key.toLowerCase().includes('bic') || key.toLowerCase().includes('lei') || key.toLowerCase().includes('mmbid'))) {
          if (val !== val.toUpperCase()) {
            control.setValue(val.toUpperCase(), { emitEvent: false });
          }
        }
      }
    });
  }

  initPartyGroup() {
    return this.fb.group({
      name: ['ABC CORPORATION', [Validators.maxLength(140)]],
      postal: this.initPostalGroup(),
      idType: ['org'],
      orgAnyBic: ['ABCCUS33XXX', [Validators.pattern(/^[A-Z]{6}[A-Z2-9][A-NP-Z0-9]([A-Z0-9]{3})?$/)]],
      orgLei: ['', [Validators.pattern(/^[A-Z0-9]{20}$/)]],
      orgId: ['', [Validators.maxLength(35)]],
      orgScheme: [''],
      orgPrtry: ['', [Validators.maxLength(35)]],
      orgIssr: ['', [Validators.maxLength(35)]],
      prvtBirthDt: ['', [this.futureDateValidator]],
      prvtProv: ['', [Validators.maxLength(35)]],
      prvtCity: ['', [Validators.maxLength(35)]],
      prvtCtry: [''],
      prvtId: ['', [Validators.maxLength(35)]],
      prvtScheme: [''],
      prvtPrtry: ['', [Validators.maxLength(35)]],
      prvtIssr: ['', [Validators.maxLength(35)]],
      ctryOfRes: ['']
    }, { validators: [this.partyIdValidator] });
  }

  partyIdValidator = (g: any): any => {
    const type = g.get('idType')?.value;
    if (type === 'org') {
        const id = g.get('orgId')?.value;
        const sch = g.get('orgScheme')?.value;
        const prp = g.get('orgPrtry')?.value;
        if (id && !sch && !prp) return { orgSchemeMissing: true };
    } else if (type === 'prvt') {
        const id = g.get('prvtId')?.value;
        const sch = g.get('prvtScheme')?.value;
        const prp = g.get('prvtPrtry')?.value;
        if (id && !sch && !prp) return { prvtSchemeMissing: true };
    }
    return null;
  };

  initAgentGroup() {
    return this.fb.group({
      bic: ['CHASUS33XXX', [Validators.pattern(/^[A-Z]{6}[A-Z2-9][A-NP-Z0-9]([A-Z0-9]{3})?$/)]],
      clrSys: ['', [Validators.maxLength(5)]],
      mmbId: ['', [Validators.maxLength(35)]],
      lei: ['', [Validators.pattern(/^[A-Z0-9]{20}$/)]]
    }, {
      validators: [(g: any) => {
        const cd = g.get('clrSys')?.value;
        const mmb = g.get('mmbId')?.value;
        if (mmb && !cd) return { clrSysDependency: true };
        return null;
      }]
    });
  }

  initPostalGroup() {
    return this.fb.group({
      addrType: ['none'],
      dept: ['', [Validators.maxLength(70)]],
      subDept: ['', [Validators.maxLength(70)]],
      street: ['', [Validators.maxLength(70)]],
      bldgNb: ['', [Validators.maxLength(16)]],
      bldgNm: ['', [Validators.maxLength(35)]],
      floor: ['', [Validators.maxLength(70)]],
      pstBx: ['', [Validators.maxLength(16)]],
      room: ['', [Validators.maxLength(70)]],
      pstCd: ['', [Validators.maxLength(16)]],
      town: ['', [Validators.maxLength(35)]],
      townLctn: ['', [Validators.maxLength(35)]],
      district: ['', [Validators.maxLength(35)]],
      ctrySub: ['', [Validators.maxLength(35)]],
      ctry: [''],
      addrLines: this.fb.array([])
    });
  }

  initTransaction() {
    return this.fb.group({
      orgnlInstrId: ['', [Validators.maxLength(35)]],
      orgnlEndToEndId: ['E2E-' + this.dateStamp() + '-' + this.randomId(), [Validators.required, Validators.maxLength(35)]],
      orgnlUetr: [this.uetrService.generate(), [Validators.required, Validators.pattern(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/)]],
      txSts: ['ACSC', Validators.required],
      orgtr: this.initPartyGroup(),
      stsRsnCd: [''],
      addtlInf: this.fb.array([this.fb.control('', [Validators.maxLength(105)])])
    });
  }

  get transactions() { return this.form.get('transactions') as FormArray; }
  addTransaction() { this.transactions.push(this.initTransaction()); this.generateXml(); }
  removeTransaction(i: number) { if (this.transactions.length > 1) { this.transactions.removeAt(i); this.generateXml(); } }

  addAddrLine(group: any) { (group.get('postal.addrLines') as FormArray).push(this.fb.control('', [Validators.maxLength(70)])); }
  removeAddrLine(group: any, i: number) { const arr = group.get('postal.addrLines') as FormArray; if (arr.length > 1) arr.removeAt(i); }
  getAddrLines(group: any) { return (group.get('postal.addrLines') as FormArray).controls; }

  onAddrTypeChange(group: any) {
    const type = group.get('postal.addrType')?.value;
    const lines = group.get('postal.addrLines') as FormArray;
    while (lines.length) lines.removeAt(0);
    let count = 0;
    if (type === 'unstructured') count = 3;
    else if (type === 'hybrid') count = 2;
    for (let i = 0; i < count; i++) {
        lines.push(this.fb.control('', [Validators.maxLength(70)]));
    }
    this.generateXml();
  }

  onIdTypeChange(group: any) {
    const type = group.get('idType')?.value;
    if (type === 'prvt') {
      group.patchValue({
        orgAnyBic: '', orgLei: '', orgId: '', orgScheme: '', orgPrtry: '', orgIssr: ''
      }, { emitEvent: false });
    } else {
      group.patchValue({
        prvtId: '', prvtScheme: '', prvtPrtry: '', prvtIssr: '', prvtBirthDt: '', prvtCity: '', prvtProv: '', prvtCtry: ''
      }, { emitEvent: false });
    }
    this.generateXml();
  }

  addAddtlInf(tx: any) { (tx.get('addtlInf') as FormArray).push(this.fb.control('', [Validators.maxLength(105)])); }
  removeAddtlInf(tx: any, i: number) { const arr = tx.get('addtlInf') as FormArray; if (arr.length > 1) arr.removeAt(i); }
  getAddtlInf(tx: any) { return (tx.get('addtlInf') as FormArray).controls; }

  handleInput(event: any, controlPath: string, limitKey: string) {
    const max = this.fieldLimits[limitKey];
    if (!max) return;
    const val = event.target.value || '';
    if (val.length >= max) {
      this.limitMessages[controlPath] = `Maximum ${max} characters reached (${max}/${max})`;
      setTimeout(() => { delete this.limitMessages[controlPath]; }, 3000);
    }
  }

  checkLei(event: any, controlPath: string) {
    const val = event.target.value || '';
    if (val && val.length < 20) {
      this.leiValidationMessages[controlPath] = 'LEI must be exactly 20 characters';
    } else {
      delete this.leiValidationMessages[controlPath];
    }
  }

  refreshUetr(tx: any) { tx.patchValue({ orgnlUetr: this.uetrService.generate() }); }

  dateStamp() { return new Date().toISOString().slice(0, 10).replace(/-/g, ''); }
  randomId() { return Math.random().toString(36).substring(2, 8).toUpperCase(); }
  isoNow() { return new Date().toISOString().split('.')[0] + 'Z'; }
  fdt(d: string) { return d ? d.replace('Z', '+00:00') : d; }

  get bicSameWarning(): string | null {
    const from = (this.form.get('head_fromBic')?.value || '').trim().toUpperCase();
    const to = (this.form.get('head_toBic')?.value || '').trim().toUpperCase();
    if (!from || !to) return null;
    return from === to
      ? 'Sender BIC and Receiver BIC are identical. The instructing and instructed agents must represent different financial institutions.'
      : null;
  }

  generateXml() {
    const v = this.form.getRawValue();
    let bah = '';
    bah += this.leaf('CharSet', v.head_charSet, 2);
    bah += this.renderFIId('Fr', v.head_fromBic, v.head_fromClrSysCd, v.head_fromMmbId, v.head_fromLei, 2);
    bah += this.renderFIId('To', v.head_toBic, v.head_toClrSysCd, v.head_toMmbId, v.head_toLei, 2);
    bah += this.leaf('BizMsgIdr', v.head_bizMsgIdr, 2);
    bah += this.leaf('MsgDefIdr', 'pain.002.001.10', 2);
    bah += this.leaf('BizSvc', v.head_bizSvc, 2);
    if (v.head_mktPrctcId || v.head_mktPrctcRegy) {
      let mkt = '';
      if (v.head_mktPrctcRegy) mkt += this.leaf('Regy', v.head_mktPrctcRegy, 3);
      if (v.head_mktPrctcId) mkt += this.leaf('Id', v.head_mktPrctcId, 3);
      bah += this.branch('MktPrctc', mkt, 2);
    }
    bah += this.leaf('CreDt', this.fdt(v.head_creDt), 2);
    if (v.head_cpyDplct) bah += this.leaf('CpyDplct', v.head_cpyDplct, 2);
    if (v.head_pssblDplct) bah += this.leaf('PssblDplct', 'true', 2);
    bah += this.leaf('Prty', v.head_prty, 2);
    if (v.head_rltd_enabled) {
      let r = '';
      if (v.head_rltd_charSet) r += this.leaf('CharSet', v.head_rltd_charSet, 3);
      r += this.renderFIId('Fr', v.head_rltd_fromBic, v.head_rltd_fromClrSysCd, v.head_rltd_fromMmbId, v.head_rltd_fromLei, 3);
      r += this.renderFIId('To', v.head_rltd_toBic, v.head_rltd_toClrSysCd, v.head_rltd_toMmbId, v.head_rltd_toLei, 3);
      if (v.head_rltd_bizMsgIdr) r += this.leaf('BizMsgIdr', v.head_rltd_bizMsgIdr, 3);
      if (v.head_rltd_msgDefIdr) r += this.leaf('MsgDefIdr', v.head_rltd_msgDefIdr, 3);
      if (v.head_rltd_bizSvc) r += this.leaf('BizSvc', v.head_rltd_bizSvc, 3);
      if (v.head_rltd_creDt) r += this.leaf('CreDt', this.fdt(v.head_rltd_creDt), 3);
      if (v.head_rltd_cpyDplct) r += this.leaf('CpyDplct', v.head_rltd_cpyDplct, 3);
      if (v.head_rltd_pssblDplct) r += this.leaf('PssblDplct', 'true', 3);
      if (v.head_rltd_prty) r += this.leaf('Prty', v.head_rltd_prty, 3);
      bah += this.branch('Rltd', r, 2);
    }
    let doc = '';
    doc += this.branch('GrpHdr', this.leaf('MsgId', v.grpHdr_msgId, 4) + this.leaf('CreDtTm', this.fdt(v.grpHdr_creDtTm), 4) + this.renderParty('InitgPty', v.initgPty, 4) + this.renderAgent('FwdgAgt', v.fwdgAgt, 4), 3);
    let orgnlGrp = '';
    orgnlGrp += this.leaf('OrgnlMsgId', v.orgnlMsgId, 4);
    orgnlGrp += this.leaf('OrgnlMsgNmId', v.orgnlMsgNmId, 4);
    if (v.orgnlCreDtTm) orgnlGrp += this.leaf('OrgnlCreDtTm', this.fdt(v.orgnlCreDtTm), 4);
    doc += this.branch('OrgnlGrpInfAndSts', orgnlGrp, 3);
    let orgnlPmt = '';
    orgnlPmt += this.leaf('OrgnlPmtInfId', v.orgnlPmtInfId, 4);
    v.transactions.forEach((tx: any) => {
      let txInf = '';
      if (tx.orgnlInstrId) txInf += this.leaf('OrgnlInstrId', tx.orgnlInstrId, 5);
      txInf += this.leaf('OrgnlEndToEndId', tx.orgnlEndToEndId, 5);
      txInf += this.leaf('OrgnlUETR', tx.orgnlUetr, 5);
      if (tx.txSts) txInf += this.leaf('TxSts', tx.txSts, 5);
      let rsn = '';
      if (tx.orgtr) rsn += this.renderParty('Orgtr', tx.orgtr, 6);
      if (tx.stsRsnCd) rsn += this.branch('Rsn', this.leaf('Cd', tx.stsRsnCd, 7), 6);
      tx.addtlInf.forEach((info: string) => { if (info) rsn += this.leaf('AddtlInf', info, 6); });
      if (rsn) txInf += this.branch('StsRsnInf', rsn, 5);
      orgnlPmt += this.branch('TxInfAndSts', txInf, 4);
    });
    doc += this.branch('OrgnlPmtInfAndSts', orgnlPmt, 3);
    this.generatedXml = `<?xml version="1.0" encoding="UTF-8"?>
<BusMsgEnvlp xmlns="urn:swift:xsd:envelope">
	<AppHdr xmlns="urn:iso:std:iso:20022:tech:xsd:head.001.001.02">
${bah.trimEnd()}
	</AppHdr>
	<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pain.002.001.10">
		<CstmrPmtStsRpt>
${doc.trimEnd()}
		</CstmrPmtStsRpt>
	</Document>
</BusMsgEnvlp>`;
    this.refreshLineCount();
  }

  renderFIId(tag: string, bic: string, clr: string, mmb: string, lei: string, ind: number) {
    let fi = '';
    if (bic) fi += this.leaf('BICFI', bic, ind + 3);
    if (clr || mmb) {
      let cid = '';
      if (clr) cid += this.branch('ClrSysId', this.leaf('Cd', clr, ind + 5), ind + 4);
      if (mmb) cid += this.leaf('MmbId', mmb, ind + 4);
      fi += this.branch('ClrSysMmbId', cid, ind + 3);
    }
    if (lei) fi += this.leaf('LEI', lei, ind + 3);
    if (!fi) return '';
    return this.branch(tag, this.branch('FIId', this.branch('FinInstnId', fi, ind + 2), ind + 1), ind);
  }

  renderAgent(tag: string, a: any, ind: number) {
    let fi = '';
    if (a.bic) fi += this.leaf('BICFI', a.bic, ind + 2);
    if (a.clrSys || a.mmbId) {
      let cid = '';
      if (a.clrSys) cid += this.branch('ClrSysId', this.leaf('Cd', a.clrSys, ind + 4), ind + 3);
      if (a.mmbId) cid += this.leaf('MmbId', a.mmbId, ind + 3);
      fi += this.branch('ClrSysMmbId', cid, ind + 2);
    }
    if (a.lei) fi += this.leaf('LEI', a.lei, ind + 2);
    if (!fi) return '';
    return this.branch(tag, this.branch('FinInstnId', fi, ind + 1), ind);
  }

  renderParty(tag: string, p: any, ind: number) {
    let inner = '';
    if (tag !== 'InitgPty' && p.name) inner += this.leaf('Nm', p.name, ind + 1);
    if (tag !== 'InitgPty' && p.postal) inner += this.renderPostal(p.postal, ind + 1);
    let org = '';
    if (p.orgAnyBic) org += this.leaf('AnyBIC', p.orgAnyBic, ind + 4);
    if (p.orgLei) org += this.leaf('LEI', p.orgLei, ind + 4);
    if (p.orgId) {
      let o = this.leaf('Id', p.orgId, ind + 5);
      if (p.orgScheme || p.orgPrtry) {
        let sn = '';
        if (p.orgScheme) sn += this.leaf('Cd', p.orgScheme, ind + 7);
        else if (p.orgPrtry) sn += this.leaf('Prtry', p.orgPrtry, ind + 7);
        o += this.branch('SchmeNm', sn, ind + 6);
      }
      if (p.orgIssr) o += this.leaf('Issr', p.orgIssr, ind + 5);
      org += this.branch('Othr', o, ind + 4);
    }
    let prvt = '';
    if (p.prvtBirthDt || p.prvtCity || p.prvtCtry || p.prvtProv) {
      let dt = '';
      if (p.prvtBirthDt) dt += this.leaf('BirthDt', p.prvtBirthDt.split('T')[0], ind + 5);
      if (p.prvtProv) dt += this.leaf('PrvcOfBirth', p.prvtProv, ind + 5);
      if (p.prvtCity) dt += this.leaf('CityOfBirth', p.prvtCity, ind + 5);
      if (p.prvtCtry) dt += this.leaf('CtryOfBirth', p.prvtCtry, ind + 5);
      prvt += this.branch('DtAndPlcOfBirth', dt, ind + 4);
    }
    if (p.prvtId) {
      let o = this.leaf('Id', p.prvtId, ind + 5);
      if (p.prvtScheme || p.prvtPrtry) {
        let sn = '';
        if (p.prvtScheme) sn += this.leaf('Cd', p.prvtScheme, ind + 7);
        else if (p.prvtPrtry) sn += this.leaf('Prtry', p.prvtPrtry, ind + 7);
        o += this.branch('SchmeNm', sn, ind + 6);
      }
      if (p.prvtIssr) o += this.leaf('Issr', p.prvtIssr, ind + 5);
      prvt += this.branch('Othr', o, ind + 4);
    }
    let id = '';
    if (p.idType === 'org' && org) {
      id = this.branch('OrgId', org, ind + 3);
    } else if (p.idType === 'prvt' && prvt) {
      id = this.branch('PrvtId', prvt, ind + 3);
    }
    if (id) inner += this.branch('Id', id, ind + 2);
    if (tag !== 'InitgPty' && p.ctryOfRes) inner += this.leaf('CtryOfRes', p.ctryOfRes, ind + 1);
    if (!inner) return '';
    return this.branch(tag, inner, ind);
  }

  renderPostal(pa: any, ind: number) {
    if (!pa || pa.addrType === 'none') return '';
    let a = '';
    const t = ind + 1;
    if (['structured', 'hybrid'].includes(pa.addrType)) {
      if (pa.dept) a += this.leaf('Dept', pa.dept, t);
      if (pa.subDept) a += this.leaf('SubDept', pa.subDept, t);
      if (pa.street) a += this.leaf('StrtNm', pa.street, t);
      if (pa.bldgNb) a += this.leaf('BldgNb', pa.bldgNb, t);
      if (pa.bldgNm) a += this.leaf('BldgNm', pa.bldgNm, t);
      if (pa.floor) a += this.leaf('Flr', pa.floor, t);
      if (pa.pstBx) a += this.leaf('PstBx', pa.pstBx, t);
      if (pa.room) a += this.leaf('Room', pa.room, t);
      if (pa.pstCd) a += this.leaf('PstCd', pa.pstCd, t);
    }
    if (pa.town) a += this.leaf('TwnNm', pa.town, t);
    if (pa.townLctn) a += this.leaf('TwnLctnNm', pa.townLctn, t);
    if (pa.district) a += this.leaf('DstrctNm', pa.district, t);
    if (pa.ctrySub) a += this.leaf('CtrySubDvsn', pa.ctrySub, t);
    if (pa.ctry) a += this.leaf('Ctry', pa.ctry, t);
    if (['unstructured', 'hybrid'].includes(pa.addrType)) {
      if (pa.addrLines) pa.addrLines.forEach((l: string) => { if (l) a += this.leaf('AdrLine', l, t); });
    }
    return this.branch('PstlAdr', a, ind);
  }

  leaf(t: string, v: any, i: number) { return v ? `${'\t'.repeat(i)}<${t}>${v}</${t}>\n` : ''; }
  branch(t: string, c: string, i: number) { return c.trim() ? `${'\t'.repeat(i)}<${t}>\n${c.trimEnd()}\n${'\t'.repeat(i)}</${t}>\n` : ''; }

  refreshLineCount() { this.editorLineCount = Array.from({ length: (this.generatedXml || '').split('\n').length }, (_, i) => i + 1); }
  syncScroll(e: any, g: any) { g.scrollTop = e.scrollTop; }
  pushHistory() { this.xmlHistoryIdx++; this.xmlHistory[this.xmlHistoryIdx] = this.generatedXml; }
  undoXml() { if (this.xmlHistoryIdx > 0) { this.xmlHistoryIdx--; this.generatedXml = this.xmlHistory[this.xmlHistoryIdx]; this.refreshLineCount(); } }
  redoXml() { if (this.xmlHistoryIdx < this.xmlHistory.length - 1) { this.xmlHistoryIdx++; this.generatedXml = this.xmlHistory[this.xmlHistoryIdx]; this.refreshLineCount(); } }
  canUndoXml() { return this.xmlHistoryIdx > 0; }
  canRedoXml() { return this.xmlHistoryIdx < this.xmlHistory.length - 1; }
  copyToClipboard() { navigator.clipboard.writeText(this.generatedXml); this.snackBar.open('XML Copied!', 'Close', { duration: 2000 }); }
  downloadXml() { const blob = new Blob([this.generatedXml], { type: 'application/xml' }); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = `pain002-${Date.now()}.xml`; a.click(); }
  onEditorChange(e: string) { this.generatedXml = e; this.refreshLineCount(); }

  validateMessage() {
        if (this.bicSameWarning) return;
        this.generateXml();
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      this.snackBar.open('Please fix the errors in the form before validating.', 'Close', { duration: 3000 });
      return;
    }
    this.showValidationModal = true;
    this.validationStatus = 'validating';
    this.http.post(this.config.getApiUrl('/validate'), {
      xml_content: this.generatedXml,
      mode: 'Full 1-3',
      message_type: 'pain.002.001.10',
      store_in_history: true
    }).subscribe({
      next: (data: any) => { this.validationReport = data; this.validationStatus = 'done'; this.clearDraft(); },
      error: (err) => {
        this.validationReport = { status: 'FAIL', errors: 1, warnings: 0, details: [{ severity: 'ERROR', layer: 0, code: 'BACKEND_ERROR', path: '', message: 'Validation failed — ' + (err.error?.detail?.message || 'backend not reachable.'), fix_suggestion: 'Ensure the validation server is running.' }] };
        this.validationStatus = 'done';
      }
    });
  }

  err(path: string) {
    if (this.limitMessages[path]) return this.limitMessages[path];
    if (this.leiValidationMessages[path]) return this.leiValidationMessages[path];
    const c = this.form.get(path);
    if (!c || (c.pristine && !c.touched)) return null;
    if (c.errors?.['required']) return 'Required';
    if (c.errors?.['pattern']) return 'Invalid Format';
    if (c.errors?.['maxlength']) return 'Too long';
    if (c.errors?.['future_date']) return 'Date cannot be in future';
    return null;
  }

  hint(path: string, maxLen: number): string | null {
    if (this.err(path)) return null;
    const c = this.form.get(path);
    if (!c || !c.value) return null;
    const len = c.value.toString().length;
    if (len >= maxLen) return `Maximum ${maxLen} characters reached (${len}/${maxLen})`;
    return null;
  }

  charCount(path: string, max: number) { const v = this.form.get(path)?.value || ''; return `${v.length}/${max}`; }
  isNearLimit(path: string, max: number) { return (this.form.get(path)?.value || '').length > max * 0.8; }
  getValidationLayers() { return Object.keys(this.validationReport?.layer_status || {}).sort(); }
  getLayerName(k: string) { const names: Record<string, string> = { '1': 'Syntax & Format', '2': 'Schema Validation', '3': 'Business Rules' }; return names[k] ?? `Layer ${k}`; }
  getLayerStatus(k: string) { return this.validationReport?.layer_status?.[k]?.status ?? ''; }
  getLayerTime(k: string) { return this.validationReport?.layer_status?.[k]?.time ?? 0; }
  isLayerPass(k: string) { return this.getLayerStatus(k).includes('✅'); }
  isLayerFail(k: string) { return this.getLayerStatus(k).includes('❌'); }
  isLayerWarn(k: string) { const s = this.getLayerStatus(k); return s.includes('⚠') || s.includes('WARNING') || s.includes('WARN'); }
  getValidationIssues() { return this.validationReport?.details ?? []; }
  toggleValidationIssue(issue: any) { this.validationExpandedIssue = this.validationExpandedIssue === issue ? null : issue; }
  closeValidationModal() { this.showValidationModal = false; this.validationReport = null; this.validationStatus = 'idle'; this.validationExpandedIssue = null; }
  copyFix(text: string, e: MouseEvent) { e.stopPropagation(); navigator.clipboard.writeText(text).then(() => this.snackBar.open('Copied!', '', { duration: 1500 })); }
  formatXml() { this.generateXml(); }
  viewXmlModal() { this.closeValidationModal(); }
  editXmlModal() { this.closeValidationModal(); }
  runValidationModal() { this.validateMessage(); }

  openBicSearch(controlName: string, index?: number) {
    const dialogRef = this.dialog.open(BicSearchDialogComponent, { width: '800px', disableClose: true });
    dialogRef.afterClosed().subscribe(result => {
      if (result && result.bic) {
        if (index !== undefined) {
           const grp = this.transactions.at(index) as FormGroup;
           grp.patchValue({ [controlName]: result.bic });
           grp.get(controlName)?.markAsDirty();
        } else {
           this.form.patchValue({ [controlName]: result.bic });
           this.form.get(controlName)?.markAsDirty();
        }
      }
    });
  }

  openBicSearchGroup(controlName: string, group: FormGroup) {
    const dialogRef = this.dialog.open(BicSearchDialogComponent, { width: '800px', disableClose: true });
    dialogRef.afterClosed().subscribe(result => {
      if (result && result.bic) {
        group.patchValue({ [controlName]: result.bic });
        group.get(controlName)?.markAsDirty();
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
