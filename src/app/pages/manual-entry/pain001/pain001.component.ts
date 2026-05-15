import { Component, OnInit, OnDestroy, HostListener } from '@angular/core';
import { AbstractControl, FormBuilder, FormGroup, FormArray, Validators, ReactiveFormsModule, FormsModule } from '@angular/forms';
import { CommonModule } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { MatIconModule } from '@angular/material/icon';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
import { ConfigService } from '../../../services/config.service';
import { FormattingService } from '../../../services/formatting.service';
import { BicSearchDialogComponent } from '../bic-search-dialog/bic-search-dialog.component';
import { debounceTime } from 'rxjs/operators';

@Component({
  selector: 'app-pain001',
  templateUrl: './pain001.component.html',
  styleUrls: ['./pain001.component.css'],
  standalone: true,
  imports: [CommonModule, ReactiveFormsModule, FormsModule, MatIconModule, MatSnackBarModule, MatTooltipModule, MatDialogModule]
})
export class Pain001Component implements OnInit, OnDestroy {
  form!: FormGroup;
  generatedXml = '';
  currentTab: 'form' | 'preview' = 'form';
  isParsingXml = false;
  editorLineCount: number[] = [];

  // History for Undo/Redo
  private xmlHistory: string[] = [];
  private xmlHistoryIdx = -1;
  private maxHistory = 50;
  private isInternalChange = false;

  // Codelists
  currencies = ['USD', 'EUR', 'GBP', 'JPY', 'AUD', 'CAD', 'CHF', 'CNY', 'HKD', 'NZD'];
  chargeBearers = ['CRED', 'SHAR', 'SLEV'];
  priorities = ['HIGH', 'NORM'];
  paymentMethods = ['TRF', 'CHK'];
  countries = ['US', 'GB', 'DE', 'FR', 'IT', 'CH', 'CA', 'AU', 'JP', 'IN', 'SG', 'HK', 'NZ'];

  // Validation state
  showValidationModal = false;
  validationStatus: 'idle' | 'validating' | 'done' = 'idle';
  validationReport: any = null;
  validationExpandedIssue: any = null;
  expandedLayers = new Set<string>(['2', '3']); // Default L2 and L3 to open if they have errors
  
  warningTimeouts: { [key: string]: any } = {};
  showMaxLenWarning: { [key: string]: boolean } = {};

  private readonly DRAFT_KEY = 'draft_pain001';
  private draftSaveTimer: ReturnType<typeof setTimeout> | null = null;
  showDraftBanner = false;
  isClearingDraft = false;

  constructor(
    private fb: FormBuilder,
    private http: HttpClient,
    private config: ConfigService,
    private snackBar: MatSnackBar,
    private formatting: FormattingService,
    private dialog: MatDialog
  ) { }

  ngOnInit() {
    this.buildForm();
    const hadDraft = this.loadDraft();
    if (hadDraft) {
      this.showDraftBanner = true;
      this.generateXml();
    }
    this.generateXml();
    this.pushHistory();

    this.form.valueChanges.pipe(debounceTime(300)).subscribe(() => {
      this.updateConditionalValidators();
      this.generateXml();
      this.scheduleDraftSave();
    });

    this.updateConditionalValidators();
  }

  private updateConditionalValidators() {
    const ADDR_PAT = Validators.pattern(/^[a-zA-Z0-9\/\-\?:\(\)\.,\+' ]+$/);
    ['dbtr', 'dbtrAgt', 'cdtrAgt', 'cdtr'].forEach(p => {
      const addrType = this.form.get(p + 'AddrType')?.value;
      const ctry = this.form.get(p + 'Ctry');
      const twnNm = this.form.get(p + 'TwnNm');
      if (!ctry || !twnNm) return;

      if (addrType && addrType !== 'none') {
        ctry.setValidators([Validators.required, Validators.pattern(/^[A-Z]{2,2}$/)]);
      } else {
        ctry.setValidators([Validators.pattern(/^[A-Z]{2,2}$/)]);
      }
      ctry.updateValueAndValidity({ emitEvent: false });

      if (addrType === 'structured' || addrType === 'hybrid') {
        twnNm.setValidators([Validators.required, Validators.maxLength(35), ADDR_PAT]);
      } else {
        twnNm.setValidators([Validators.maxLength(35), ADDR_PAT]);
      }
      twnNm.updateValueAndValidity({ emitEvent: false });
    });
  }

  private buildForm() {
    this.form = this.fb.group({
      // BAH (head.001.001.02)
      head_charSet: ['UTF-8', [Validators.maxLength(2048)]],
      head_fromBic: ['BANCUS33XXX', [Validators.required, Validators.pattern(/^([A-Z0-9]{8}|[A-Z0-9]{11})$/)]],
      head_fromClrSysId: ['USABA', [Validators.maxLength(5)]],
      head_fromMmbId: ['123456789', [Validators.maxLength(35)]],
      head_fromLei: ['W22LROWBR70L5U3S5244', [Validators.pattern(/^[A-Z0-9]{18}[0-9]{2}$/)]],
      head_toBic: ['BANCGB2LXXX', [Validators.required, Validators.pattern(/^([A-Z0-9]{8}|[A-Z0-9]{11})$/)]],
      head_toClrSysId: ['GBFPS', [Validators.maxLength(5)]],
      head_toMmbId: ['200000', [Validators.maxLength(35)]],
      head_toLei: ['EBMRY7N10NRY5NCY5Y71', [Validators.pattern(/^[A-Z0-9]{18}[0-9]{2}$/)]],
      head_bizMsgIdr: ['BMS-' + Date.now(), [Validators.required, Validators.maxLength(35)]],
      head_msgDefIdr: ['pain.001.001.09', [Validators.required]],
      head_bizSvc: ['swift.cbprplus.03', Validators.required],
      head_creDt: [this.isoNowDate(), Validators.required],
      head_mktPrctcRegy: ['', [Validators.maxLength(35)]],
      head_mktPrctcId: ['', [Validators.maxLength(35)]],
      head_cpyDplct: [''],
      head_pssblDplct: [''],
      head_prty: [''],
      head_rltdBizMsgIdr: ['', [Validators.maxLength(35)]],
      
      // Group Header (pain.001.001.09)
      msgId: ['PAIN001-MSG-' + Date.now(), [Validators.required, Validators.maxLength(35)]],
      creDtTm: [this.isoNow(), Validators.required],
      authstnCd: ['AUTH'],
      authstnPrtry: ['File pre-authorised at origin'],
      nbOfTxs: ['1', [Validators.required]],
      ctrlSum: ['0.00', [Validators.pattern(/^\d{1,18}(\.\d{1,5})?$/)]],
      initgPtyName: ['Global Solutions Corp', [Validators.required, Validators.maxLength(140)]],
      initgPtyBic: ['GBSOLUS33XX', [Validators.pattern(/^([A-Z0-9]{8}|[A-Z0-9]{11})$/)]],
      initgPtyId: ['GS-ID-9988'],
      initgPtyCtry: ['GB'],
      initgPtyTwnNm: ['London'],
      initgPtyStrtNm: ['Main Street'],
      initgPtyBldgNb: ['10'],
      initgPtyPstCd: ['EC1A 1BB'],
      initgPtyDept: ['Treasury'],
      initgPtySubDept: ['Payments'],

      // Payment Information
      pmtInfId: ['PMT-INF-' + Date.now(), [Validators.required, Validators.maxLength(35)]],
      pmtMtd: ['TRF', Validators.required],
      btchBookg: [false],
      pmtNbOfTxs: ['1', [Validators.required]],
      pmtCtrlSum: ['0.00', [Validators.pattern(/^\d{1,18}(\.\d{1,5})?$/)]],
      instrPrty: ['NORM', Validators.required],
      poolgAdjstmntDt: [this.isoNowDate()],
      svcLvl: ['SEPA', [Validators.maxLength(5)]],
      lclInstrm: ['INST', [Validators.maxLength(35)]],
      ctgyPurp: ['CASH', [Validators.maxLength(5)]],
      reqdExctnDt: [this.isoNowDate(), Validators.required],
      fwdgAgtBic: ['FWDGUS33XXX', [Validators.maxLength(11)]],
      initnSrc: ['ERP-X-SYSTEM'],
      dbtrName: ['Holding Account One', [Validators.required, Validators.maxLength(140)]],
      dbtrIban: ['60161331926819', [Validators.required, Validators.maxLength(34)]],
      dbtrAddrType: ['structured'],
      dbtrCtry: ['US', [Validators.required, Validators.pattern(/^[A-Z]{2,2}$/)]],
      dbtrTwnNm: ['New York', [Validators.maxLength(35)]],
      dbtrBldgNb: ['270', [Validators.maxLength(16)]],
      dbtrBldgNm: ['Chase Tower'],
      dbtrStrtNm: ['Park Avenue', [Validators.maxLength(70)]],
      dbtrPstCd: ['10017', [Validators.maxLength(16)]],
      dbtrDept: [''],
      dbtrSubDept: [''],
      dbtrFlr: ['50'],
      dbtrAdrLine1: ['270 Park Avenue', [Validators.maxLength(70)]],
      dbtrAdrLine2: ['Suite 500', [Validators.maxLength(70)]],
      dbtrAgtAcctIban: ['11112222333344', [Validators.maxLength(34)]],
      dbtrAgtBic: ['CHASUS33XXX', [Validators.maxLength(11)]],
      dbtrAgtClrSysCd: ['USABA', [Validators.maxLength(5)]],
      dbtrAgtClrSysMmbId: ['021000021', [Validators.maxLength(35)]],
      dbtrAgtLei: ['54930068N2K3Y9N1F719', [Validators.pattern(/^[A-Z0-9]{18}[0-9]{2}$/)]],
      dbtrAgtName: ['JP Morgan Chase Bank N.A.'],
      dbtrAgtAddrType: ['structured'],
      dbtrAgtCtry: ['US', [Validators.pattern(/^[A-Z]{2,2}$/)]],
      dbtrAgtTwnNm: ['New York', [Validators.maxLength(35)]],
      dbtrAgtStrtNm: ['Park Avenue', [Validators.maxLength(70)]],
      dbtrAgtPstCd: ['10017', [Validators.maxLength(16)]],
      dbtrAgtAdrLine1: ['270 Park Avenue', [Validators.maxLength(70)]],
      dbtrAgtAdrLine2: ['Floor 10', [Validators.maxLength(70)]],
      chrgBr: ['SHAR', Validators.required],
      dbtrAgtBldgNb: ['270'],
      dbtrAgtBldgNm: ['Chase Tower'],
      dbtrOrgIdAnyBic: ['GBSOLUS33XX', [Validators.pattern(/^([A-Z0-9]{8}|[A-Z0-9]{11})$/)]],
      dbtrOrgIdLei: ['W22LROWBR70L5U3S5244', [Validators.pattern(/^[A-Z0-9]{18}[0-9]{2}$/)]],
      dbtrPrvtIdBirthDt: [''],
      dbtrPrvtIdCityOfBirth: ['', [Validators.maxLength(35)]],
      dbtrPrvtIdCtryOfBirth: ['', [Validators.pattern(/^[A-Z]{2,2}$/)]],
      ultmtDbtrName: ['Global Management LLC'],
      relMsgId: ['REL-' + Date.now()],
      chrgsAcctIban: ['US12345678901231'],
      chrgsAcctAgtBic: ['CHASUS33XXX'],

      // Transactions
      transactions: this.fb.array([this.createTransactionGroup()])
    });
  }

  private createTransactionGroup(): FormGroup {
    const BIC = [Validators.required, Validators.pattern(/^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$/)];
    const BIC_OPT = [Validators.pattern(/^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$/)];
    const LEI = [Validators.pattern(/^[A-Z0-9]{18}[0-9]{2}$/)];

    return this.fb.group({
      instrId: ['INSTR-' + Date.now(), [Validators.required, Validators.maxLength(35)]],
      endToEndId: ['E2E-' + Date.now(), [Validators.required, Validators.maxLength(35)]],
      uetr: [crypto.randomUUID ? crypto.randomUUID() : '550e8400-e29b-41d4-a716-446655440000', [Validators.required, Validators.pattern(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)]],
      amount: ['12500.00', [Validators.required, Validators.pattern(/^\d{1,18}(\.\d{1,5})?$/)]],
      currency: ['USD', Validators.required],
      xchgRate: [''],
      xchgRateTp: ['SPOT'],
      xchgUnitCcy: [''],
      xchgCtrctId: [''],
      chqInstr: [''],
      chqTp: [''],
      chqMtrtyDt: [''],
      mndtId: [''],
      txSvcLvl: ['NURG', [Validators.maxLength(5)]],
      txLclInstrm: ['INST', [Validators.maxLength(35)]],
      txCtgyPurp: ['SALA', [Validators.maxLength(5)]],
      
      intrmyAgt1Bic: ['', BIC_OPT],
      intrmyAgt1Lei: ['', LEI],
      intrmyAgt1Name: ['Citibank N.A.', Validators.maxLength(140)],
      intrmyAgt1Ctry: ['US', [Validators.pattern(/^[A-Z]{2,2}$/)]],
      intrmyAgt1TwnNm: ['New York', [Validators.maxLength(35)]],
      intrmyAgt1ClrSysCd: ['', Validators.maxLength(5)],
      intrmyAgt1ClrSysMmbId: ['', Validators.maxLength(35)],
      intrmyAgt1Acct: ['', [Validators.maxLength(34)]],

      intrmyAgt2Bic: ['', BIC_OPT],
      intrmyAgt2Lei: ['', LEI],
      intrmyAgt2Name: ['HSBC Bank PLC', Validators.maxLength(140)],
      intrmyAgt2Ctry: ['GB', [Validators.pattern(/^[A-Z]{2,2}$/)]],
      intrmyAgt2TwnNm: ['London', [Validators.maxLength(35)]],
      intrmyAgt2ClrSysCd: ['', Validators.maxLength(5)],
      intrmyAgt2ClrSysMmbId: ['', Validators.maxLength(35)],
      intrmyAgt2Acct: ['', [Validators.maxLength(34)]],

      intrmyAgt3Bic: ['', BIC_OPT],
      intrmyAgt3Lei: ['', LEI],
      intrmyAgt3Name: ['Standard Chartered Bank', Validators.maxLength(140)],
      intrmyAgt3Ctry: ['SG', [Validators.pattern(/^[A-Z]{2,2}$/)]],
      intrmyAgt3TwnNm: ['Singapore', [Validators.maxLength(35)]],
      intrmyAgt3ClrSysCd: ['', Validators.maxLength(5)],
      intrmyAgt3ClrSysMmbId: ['', Validators.maxLength(35)],
      intrmyAgt3Acct: ['', [Validators.maxLength(34)]],

      cdtrAgtBic: ['BANCGB2LXXX', [Validators.maxLength(11)]],
      cdtrAgtLei: ['', LEI],
      cdtrAgtName: ['Barclays Bank UK PLC', Validators.maxLength(140)],
      cdtrAgtCtry: ['GB', [Validators.pattern(/^[A-Z]{2,2}$/)]],
      cdtrAgtTwnNm: ['London', [Validators.maxLength(35)]],
      cdtrAgtStrtNm: ['Churchill Place', [Validators.maxLength(70)]],
      cdtrAgtPstCd: ['E14 5HP', [Validators.maxLength(16)]],
      cdtrAgtAddrType: ['structured'],
      cdtrAgtClrSysCd: ['', Validators.maxLength(5)],
      cdtrAgtClrSysMmbId: ['', Validators.maxLength(35)],
      cdtrAgtAcct: ['GB73BARC20000012345678'],
      cdtrName: ['Precision Engineering Ltd', [Validators.required, Validators.maxLength(140)]],
      cdtrIban: ['GB73BARC20000012345678', [Validators.required, Validators.maxLength(34)]],
      cdtrAddrType: ['structured'],
      cdtrCtry: ['GB', [Validators.required, Validators.pattern(/^[A-Z]{2,2}$/)]],
      cdtrTwnNm: ['Manchester', [Validators.maxLength(135)]],
      cdtrAdrLine1: ['10 Industrial Way', [Validators.maxLength(70)]],
      cdtrAdrLine2: ['Block B', [Validators.maxLength(70)]],
      cdtrDept: [''],
      cdtrSubDept: [''],
      cdtrFlr: [''],
      ultmtDbtrName: ['Sub-Group Treasury'],
      ultmtCdtrName: ['Final Vendor Corp'],
      purpCd: ['SALA'],
      taxId: [''],
      taxAmt: [''],
      rgltryRptg: ['Statutory Salary Payment Q1'],
      rmtInf: ['Invoice Ref INV-2024-456', [Validators.maxLength(140)]],
      rltdRmtInfUrl: ['']
    });
  }

  get transactions(): FormArray {
    return this.form.get('transactions') as FormArray;
  }

  addTransaction() {
    this.transactions.push(this.createTransactionGroup());
    this.updateTotals();
  }

  removeTransaction(index: number) {
    if (this.transactions.length > 1) {
      this.transactions.removeAt(index);
      this.updateTotals();
    }
  }

  private updateTotals() {
    const count = this.transactions.length;
    let sum = 0;
    this.transactions.controls.forEach(c => sum += (parseFloat(c.get('amount')?.value) || 0));
    
    this.form.patchValue({
      nbOfTxs: count.toString(),
      pmtNbOfTxs: count.toString(),
      ctrlSum: sum.toFixed(2),
      pmtCtrlSum: sum.toFixed(2)
    }, { emitEvent: false });
  }

  isoNow(): string {
    const d = new Date(), p = (n: number) => n.toString().padStart(2, '0');
    const off = -d.getTimezoneOffset(), s = off >= 0 ? '+' : '-';
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}${s}${p(Math.floor(Math.abs(off) / 60))}:${p(Math.abs(off) % 60)}`;
  }

  isoNowDate(): string { 
    return new Date().toISOString().split('T')[0]; 
  }

  fdt(dt: string): string {
    if (!dt) return dt;
    let s = dt.trim();
    if (s.length === 10) s += 'T00:00:00';
    s = s.replace(/\.\d+/, '').replace('Z', '+00:00');
    if (s && !/([+-]\d{2}:\d{2})$/.test(s)) s += '+00:00';
    return s;
  }

  get bicSameWarning(): string | null {
    const from = (this.form.get('head_fromBic')?.value || '').trim().toUpperCase();
    const to = (this.form.get('head_toBic')?.value || '').trim().toUpperCase();
    if (!from || !to) return null;
    return from === to
      ? 'Sender BIC and Receiver BIC are identical. The instructing and instructed agents must represent different financial institutions.'
      : null;
  }

  generateXml() {
    if (this.isParsingXml) return;
    const v = this.form.getRawValue();
    const creDtTm = v.creDtTm || this.isoNow();

    // BAH (AppHdr)
    let bah = (v.head_charSet ? this.el('CharSet', v.head_charSet, 2) : '');
    
    // Fr
    let frFi = '';
    if (v.head_fromBic) frFi += this.el('BICFI', v.head_fromBic, 5);
    if (v.head_fromMmbId) {
      let clr = '';
      if (v.head_fromClrSysId) clr += this.tag('ClrSysId', this.el('Cd', v.head_fromClrSysId, 8), 7);
      clr += this.el('MmbId', v.head_fromMmbId, 7);
      frFi += this.tag('ClrSysMmbId', clr, 6);
    }
    if (v.head_fromLei) frFi += this.el('LEI', v.head_fromLei, 5);
    if (frFi) bah += this.tag('Fr', this.tag('FIId', this.tag('FinInstnId', frFi, 4), 3), 2);

    // To
    let toFi = '';
    if (v.head_toBic) toFi += this.el('BICFI', v.head_toBic, 5);
    if (v.head_toMmbId) {
      let clr = '';
      if (v.head_toClrSysId) clr += this.tag('ClrSysId', this.el('Cd', v.head_toClrSysId, 8), 7);
      clr += this.el('MmbId', v.head_toMmbId, 7);
      toFi += this.tag('ClrSysMmbId', clr, 6);
    }
    if (v.head_toLei) toFi += this.el('LEI', v.head_toLei, 5);
    if (toFi) bah += this.tag('To', this.tag('FIId', this.tag('FinInstnId', toFi, 4), 3), 2);

    bah += this.el('BizMsgIdr', v.head_bizMsgIdr, 2);
    bah += this.el('MsgDefIdr', v.head_msgDefIdr, 2);
    bah += this.el('BizSvc', v.head_bizSvc || 'swift.cbprplus.03', 2);
    bah += this.el('CreDt', this.fdt(v.head_creDt || creDtTm), 2);
    if (v.head_cpyDplct) bah += this.el('CpyDplct', v.head_cpyDplct, 2);
    if (v.head_pssblDplct) bah += this.el('PssblDplct', v.head_pssblDplct, 2);
    if (v.head_prty) bah += this.el('Prty', v.head_prty, 2);
    if (v.head_rltdBizMsgIdr) bah += this.el('Rltd', this.el('BizMsgIdr', v.head_rltdBizMsgIdr, 4), 2);

    // Group Header
    const grpHdr = this.tag('GrpHdr',
      this.el('MsgId', v.msgId, 4) +
      this.el('CreDtTm', creDtTm, 4) +
      this.tag('Authstn', v.authstnCd ? this.el('Cd', v.authstnCd, 6) : this.el('Prtry', v.authstnPrtry, 6), 5) +
      this.el('NbOfTxs', v.nbOfTxs, 4) +
      (v.ctrlSum && v.ctrlSum !== '0.00' ? this.el('CtrlSum', v.ctrlSum, 4) : '') +
      this.partyXml('InitgPty', 'initgPty', v, 4) +
      this.agtXml('FwdgAgt', 'fwdgAgt', v, 4),
      3
    );

    // Payment Information
    let pmtInfContent = this.el('PmtInfId', v.pmtInfId, 4) +
                        this.el('PmtMtd', v.pmtMtd, 4) +
                        (v.btchBookg ? this.el('BtchBookg', 'true', 4) : '');

    if (v.pmtCtrlSum && v.pmtCtrlSum !== '0.00') pmtInfContent += this.el('PmtCtrlSum', v.pmtCtrlSum, 4);

    // XOR logic for PmtTpInf
    const hasGlobalPmtTp = !!(v.svcLvl || v.lclInstrm || v.ctgyPurp);
    if (hasGlobalPmtTp) {
      pmtInfContent += this.tag('PmtTpInf',
        (v.svcLvl ? this.tag('SvcLvl', this.el('Cd', v.svcLvl, 7), 6) : '') +
        (v.lclInstrm ? this.tag('LclInstrm', this.el('Cd', v.lclInstrm, 7), 6) : '') +
        (v.ctgyPurp ? this.tag('CtgyPurp', this.el('Cd', v.ctgyPurp, 7), 6) : ''), 4);
    }

    pmtInfContent += (v.reqdExctnDt ? this.tag('ReqdExctnDt', this.el('Dt', v.reqdExctnDt, 6), 5) : '');
    if (v.poolgAdjstmntDt) pmtInfContent += this.el('PoolgAdjstmntDt', v.poolgAdjstmntDt, 4);

    pmtInfContent += this.partyXml('Dbtr', 'dbtr', v, 4);
    if (v.dbtrIban) pmtInfContent += this.tag('DbtrAcct', this.acctXml(v.dbtrIban, 6), 4);
    pmtInfContent += this.agtXml('DbtrAgt', 'dbtrAgt', v, 4);
    if (v.dbtrAgtAcctIban) pmtInfContent += this.tag('DbtrAgtAcct', this.acctXml(v.dbtrAgtAcctIban, 6), 4);
    
    // XOR logic for UltmtDbtr
    const hasGlobalUltmtDbtr = !!v.ultmtDbtrName;
    if (hasGlobalUltmtDbtr) pmtInfContent += this.partyXml('UltmtDbtr', 'ultmtDbtr', v, 4);
    
    pmtInfContent += this.el('ChrgBr', v.chrgBr, 4);
    if (v.chrgsAcctIban) pmtInfContent += this.tag('ChrgsAcct', this.acctXml(v.chrgsAcctIban, 6), 4);
    if (v.chrgsAcctAgtBic) pmtInfContent += this.tag('ChrgsAcctAgt', this.tag('FinInstnId', this.el('BICFI', v.chrgsAcctAgtBic, 7), 6), 5);

    // Transactions loop
    let txsXml = '';
    v.transactions.forEach((tx: any) => {
      const amt = this.formatting.formatAmount(tx.amount || 0, tx.currency);
      let txContent = this.tag('PmtId', this.el('InstrId', tx.instrId, 6) + this.el('EndToEndId', tx.endToEndId, 6) + this.el('UETR', tx.uetr, 6), 5);
      
      // Only add PmtTpInf if not at global level
      if (!hasGlobalPmtTp && (tx.txSvcLvl || tx.txLclInstrm || tx.txCtgyPurp)) {
        let tpInf = '';
        if (tx.txSvcLvl) tpInf += this.tag('SvcLvl', this.el('Cd', tx.txSvcLvl, 8), 7);
        if (tx.txLclInstrm) tpInf += this.tag('LclInstrm', this.el('Cd', tx.txLclInstrm, 8), 7);
        if (tx.txCtgyPurp) tpInf += this.tag('CtgyPurp', this.el('Cd', tx.txCtgyPurp, 8), 7);
        txContent += this.tag('PmtTpInf', tpInf, 6);
      }

      txContent += this.tag('Amt', this.el('InstdAmt', amt, 6, ` Ccy="${this.e(tx.currency)}"`), 5);
      if (tx.xchgRate || tx.xchgCtrctId || tx.xchgUnitCcy) {
        let xchg = this.el('UnitCcy', tx.xchgUnitCcy, 7);
        if (tx.xchgRate) xchg += this.el('XchgRate', tx.xchgRate, 7);
        if (tx.xchgRateTp) xchg += this.el('RateTp', tx.xchgRateTp, 7);
        if (tx.xchgCtrctId) xchg += this.el('CtrctId', tx.xchgCtrctId, 7);
        txContent += this.tag('XchgRateInf', xchg, 6);
      }

      if (tx.chqInstr || tx.chqTp) {
        let chq = this.el('ChqNb', tx.chqInstr, 7);
        if (tx.chqTp) chq += this.el('ChqTp', tx.chqTp, 7);
        if (tx.chqMtrtyDt) chq += this.tag('ChqMtrtyDt', this.el('Dt', tx.chqMtrtyDt, 9), 7);
        txContent += this.tag('ChqInstr', chq, 6);
      }

      if (tx.mndtId) txContent += this.el('MndtId', tx.mndtId, 6);
      if (!hasGlobalUltmtDbtr) txContent += this.partyXml('UltmtDbtr', 'ultmtDbtr', tx, 6);

      // Intermediary Agents
      txContent += this.agtXml('IntrmyAgt1', 'intrmyAgt1', tx, 6);
      txContent += this.agtXml('IntrmyAgt2', 'intrmyAgt2', tx, 6);
      txContent += this.agtXml('IntrmyAgt3', 'intrmyAgt3', tx, 6);

      txContent += this.agtXml('CdtrAgt', 'cdtrAgt', tx, 5);
      txContent += this.partyXml('Cdtr', 'cdtr', tx, 5);
      if (tx.cdtrIban) txContent += this.tag('CdtrAcct', this.acctXml(tx.cdtrIban, 6), 5);
      txContent += this.partyXml('UltmtCdtr', 'ultmtCdtr', tx, 6);
      if (tx.purpCd) txContent += this.tag('Purp', this.el('Cd', tx.purpCd, 7), 6);
      
      if (tx.taxAmt || tx.taxId) {
        let tax = '';
        if (tx.taxId) tax += this.el('Id', tx.taxId, 7);
        if (tx.taxAmt) tax += this.tag('Amt', this.el('InstdAmt', tx.taxAmt, 8, ` Ccy="${this.e(tx.currency)}"`), 7);
        txContent += this.tag('Tax', tax, 6);
      }
      if (tx.rltdRmtInfUrl) txContent += this.tag('RltdRmtInf', this.el('URL', tx.rltdRmtInfUrl, 7), 6);
      if (tx.rgltryRptg) txContent += this.tag('RgltryRptg', this.tag('Dtls', this.el('Inf', tx.rgltryRptg, 8), 7), 6);
      if (tx.rmtInf) txContent += this.tag('RmtInf', this.el('Ustrd', tx.rmtInf, 6), 5);

      txsXml += this.tag('CdtTrfTxInf', txContent, 4);
    });

    pmtInfContent += txsXml;
    const pmtInf = this.tag('PmtInf', pmtInfContent, 3);

    this.generatedXml = `<?xml version="1.0" encoding="UTF-8"?>
<BusMsgEnvlp xmlns="urn:swift:xsd:envelope">
\t<AppHdr xmlns="urn:iso:std:iso:20022:tech:xsd:head.001.001.02">
${bah}\t</AppHdr>
\t<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pain.001.001.09">
\t\t<CstmrCdtTrfInitn>
${grpHdr}${pmtInf}\t\t</CstmrCdtTrfInitn>
\t</Document>
</BusMsgEnvlp>`;

    this.onEditorChange(this.generatedXml, true);
  }

  mapAddrToForm(p: Element | null, prefix: string, patch: any) {
    if (!p) return;
    const ptyNode = p.getElementsByTagName('Pty')[0] || p;
    const finNode = p.getElementsByTagName('FinInstnId')[0];

    if (ptyNode && ptyNode.nodeName !== 'FinInstnId') {
      const nm = ptyNode.getElementsByTagName('Nm')[0]?.textContent?.trim();
      if (nm) patch[prefix + 'Name'] = nm;

      const pstl = ptyNode.getElementsByTagName('PstlAdr')[0];
      if (pstl) {
        const getV = (t: string) => pstl.getElementsByTagName(t)[0]?.textContent?.trim();
        const setV = (f: string, t: string) => { const v = getV(t); if (v) patch[prefix + f] = v; };
        setV('Ctry', 'Ctry');
        setV('TwnNm', 'TwnNm');
        setV('StrtNm', 'StrtNm');
        setV('BldgNb', 'BldgNb');
        setV('BldgNm', 'BldgNm');
        setV('PstCd', 'PstCd');
        setV('Dept', 'Dept');
        setV('SubDept', 'SubDept');
        setV('Flr', 'Flr');
        setV('PstBx', 'PstBx');
        setV('Room', 'Room');
        const lines = Array.from(pstl.getElementsByTagName('AdrLine'));
        if (lines.length > 0) patch[prefix + 'AdrLine1'] = lines[0].textContent?.trim() || '';
        if (lines.length > 1) patch[prefix + 'AdrLine2'] = lines[1].textContent?.trim() || '';
        patch[prefix + 'AddrType'] = lines.length > 0 ? 'unstructured' : 'structured';
      }

      const id = ptyNode.getElementsByTagName('Id')[0];
      if (id) {
        const orgId = id.getElementsByTagName('OrgId')[0];
        if (orgId) {
          const bic = orgId.getElementsByTagName('AnyBIC')[0]?.textContent?.trim();
          if (bic) patch[prefix + 'OrgIdAnyBic'] = bic;
          const lei = orgId.getElementsByTagName('LEI')[0]?.textContent?.trim();
          if (lei) patch[prefix + 'OrgIdLei'] = lei;
          const othr = orgId.getElementsByTagName('Othr')[0];
          if (othr) {
            const othrId = othr.getElementsByTagName('Id')[0]?.textContent?.trim();
            if (othrId) patch[prefix + 'Id'] = othrId;
          }
        }
        const prvtId = id.getElementsByTagName('PrvtId')[0];
        if (prvtId) {
          const dobNode = prvtId.getElementsByTagName('DtAndPlcOfBirth')[0];
          if (dobNode) {
            const dob = dobNode.getElementsByTagName('BirthDt')[0]?.textContent?.trim();
            if (dob) patch[prefix + 'PrvtIdBirthDt'] = dob;
            const city = dobNode.getElementsByTagName('CityOfBirth')[0]?.textContent?.trim();
            if (city) patch[prefix + 'PrvtIdCityOfBirth'] = city;
            const ctry = dobNode.getElementsByTagName('CtryOfBirth')[0]?.textContent?.trim();
            if (ctry) patch[prefix + 'PrvtIdCtryOfBirth'] = ctry;
          }
        }
      }
    }

    if (finNode) {
      const bic = finNode.getElementsByTagName('BICFI')[0]?.textContent?.trim();
      if (bic) patch[prefix + 'Bic'] = bic;
      const lei = finNode.getElementsByTagName('LEI')[0]?.textContent?.trim();
      if (lei) patch[prefix + 'Lei'] = lei;
      const nm = finNode.getElementsByTagName('Nm')[0]?.textContent?.trim();
      if (nm) patch[prefix + 'Name'] = nm;
      const clr = finNode.getElementsByTagName('ClrSysMmbId')[0];
      if (clr) {
        const mid = clr.getElementsByTagName('MmbId')[0]?.textContent?.trim();
        if (mid) patch[prefix + 'ClrSysMmbId'] = mid;
        const cid = clr.getElementsByTagName('Cd')[0]?.textContent?.trim() || clr.getElementsByTagName('Prtry')[0]?.textContent?.trim();
        if (cid) {
          if (prefix.startsWith('head_')) patch[prefix + 'ClrSysId'] = cid;
          else patch[prefix + 'ClrSysCd'] = cid;
        }
      }
    }
  }

  agtXml(tag: string, pref: string, v: any, indent: number): string {
    const bic = v[pref + 'Bic'];
    const lei = v[pref + 'Lei'];
    const nm = v[pref + 'Name'];
    const clrCd = v[pref + 'ClrSysCd'] || v[pref + 'ClrSysId'];
    const clrMmb = v[pref + 'ClrSysMmbId'];
    const acct = v[pref + 'Acct'];

    if (!bic && !lei && !nm && !clrMmb && !acct) return '';

    let fiId = '';
    if (bic) fiId += this.el('BICFI', bic, indent + 3);
    if (clrMmb) {
      let clrMmbContent = '';
      if (clrCd) {
        const isCd = clrCd.length <= 5; // Heuristic
        clrMmbContent += this.tag('ClrSysId', isCd ? this.el('Cd', clrCd, indent + 5) : this.el('Prtry', clrCd, indent + 5), indent + 4);
      }
      clrMmbContent += this.el('MmbId', clrMmb, indent + 4);
      fiId += this.tag('ClrSysMmbId', clrMmbContent, indent + 3);
    }
    if (lei) fiId += this.el('LEI', lei, indent + 3);
    if (nm) {
      fiId += this.el('Nm', nm, indent + 3);
      fiId += this.addrXml(v, pref, indent + 3);
    }
    
    let inner = '';
    if (fiId) inner += this.tag('FinInstnId', fiId, indent + 2);
    
    let res = this.tag(tag, inner, indent);
    if (acct) {
      const acctTag = tag + 'Acct';
      res += this.tag(acctTag, this.acctXml(acct, indent + 2), indent);
    }
    return res;
  }

  // XML Helpers
  private e(v: any): string { 
    if (v === null || v === undefined || v === '') return '';
    return v.toString().replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  private tabs(n: number): string { return '\t'.repeat(n); }
  private el(tag: string, val: any, indent: number, attrs = ''): string {
    if (val === undefined || val === null || val === '') return '';
    return `${this.tabs(indent)}<${tag}${attrs}>${this.e(val)}</${tag}>\n`;
  }
  private tag(tag: string, content: string, indent: number): string {
    if (!content || !content.trim()) return '';
    return `${this.tabs(indent)}<${tag}>\n${content}${this.tabs(indent)}</${tag}>\n`;
  }

  partyXml(tag: string, p: string, v: any, indent: number): string {
    const nm = v[p + 'Name'];
    const idXml = this.partyIdXml(v, p, indent);
    if (!nm && !idXml && !this.hasAddr(v, p)) return '';
    
    let content = this.el('Nm', nm || 'DEFAULT NAME', indent + 1);
    content += this.addrXml(v, p, indent + 1);
    content += idXml;
    return this.tag(tag, content, indent);
  }

  private hasAddr(v: any, p: string): boolean {
    return !!(v[p + 'Ctry'] || v[p + 'TwnNm'] || v[p + 'AdrLine1'] || v[p + 'StrtNm']);
  }

  addrXml(v: any, p: string, indent = 4): string {
    let type = v[p + 'AddrType'];
    if (!type || type === 'none') type = 'structured';
    const t = this.tabs(indent + 1);
    let lines: string[] = [];
    const isStrd = ['structured', 'hybrid'].includes(type);
    const isUstrd = ['unstructured', 'hybrid'].includes(type);

    if (isStrd) {
      if (v[p + 'Dept']) lines.push(`${t}<Dept>${this.e(v[p + 'Dept'])}</Dept>`);
      if (v[p + 'SubDept']) lines.push(`${t}<SubDept>${this.e(v[p + 'SubDept'])}</SubDept>`);
      if (v[p + 'StrtNm']) lines.push(`${t}<StrtNm>${this.e(v[p + 'StrtNm'])}</StrtNm>`);
      if (v[p + 'BldgNb']) lines.push(`${t}<BldgNb>${this.e(v[p + 'BldgNb'])}</BldgNb>`);
      if (v[p + 'BldgNm']) lines.push(`${t}<BldgNm>${this.e(v[p + 'BldgNm'])}</BldgNm>`);
      if (v[p + 'Flr']) lines.push(`${t}<Flr>${this.e(v[p + 'Flr'])}</Flr>`);
      if (v[p + 'PstBx']) lines.push(`${t}<PstBx>${this.e(v[p + 'PstBx'])}</PstBx>`);
      if (v[p + 'Room']) lines.push(`${t}<Room>${this.e(v[p + 'Room'])}</Room>`);
      if (v[p + 'PstCd']) lines.push(`${t}<PstCd>${this.e(v[p + 'PstCd'])}</PstCd>`);
      lines.push(`${t}<TwnNm>${this.e(v[p + 'TwnNm'] || 'London')}</TwnNm>`);
      lines.push(`${t}<Ctry>${this.e(v[p + 'Ctry'] || 'GB')}</Ctry>`);
    } else if (v[p + 'Ctry']) {
      lines.push(`${t}<Ctry>${this.e(v[p + 'Ctry'])}</Ctry>`);
    }

    if (isUstrd) {
      if (v[p + 'AdrLine1']) lines.push(`${t}<AdrLine>${this.e(v[p + 'AdrLine1'])}</AdrLine>`);
      if (v[p + 'AdrLine2']) lines.push(`${t}<AdrLine>${this.e(v[p + 'AdrLine2'])}</AdrLine>`);
    }
    if (!lines.length) return '';
    return `${this.tabs(indent)}<PstlAdr>\n${lines.join('\n')}\n${this.tabs(indent)}</PstlAdr>\n`;
  }

  partyIdXml(v: any, p: string, indent = 4): string {
    let idContent = '';
    if (v[p + 'OrgIdAnyBic'] || v[p + 'OrgIdLei'] || v[p + 'Id']) {
      let orgId = '';
      if (v[p + 'OrgIdAnyBic']) orgId += this.el('AnyBIC', v[p + 'OrgIdAnyBic'], indent + 3);
      if (v[p + 'OrgIdLei']) orgId += this.el('LEI', v[p + 'OrgIdLei'], indent + 3);
      if (v[p + 'Id']) orgId += this.tag('Othr', this.el('Id', v[p + 'Id'], indent + 5), indent + 3);
      idContent = this.tag('OrgId', orgId, indent + 2);
    } else if (v[p + 'PrvtIdBirthDt']) {
      let dob = this.el('BirthDt', v[p + 'PrvtIdBirthDt'], indent + 4);
      if (v[p + 'PrvtIdCityOfBirth']) dob += this.el('CityOfBirth', v[p + 'PrvtIdCityOfBirth'], indent + 4);
      if (v[p + 'PrvtIdCtryOfBirth']) dob += this.el('CtryOfBirth', v[p + 'PrvtIdCtryOfBirth'], indent + 4);
      idContent = this.tag('PrvtId', this.tag('DtAndPlcOfBirth', dob, indent + 3), indent + 2);
    }
    return idContent ? this.tag('Id', idContent, indent + 1) : '';
  }

  private acctXml(acc: string, indent: number): string {
    if (!acc) return '';
    const id = this.tag('Othr', this.el('Id', acc.replace(/\s/g, ''), indent + 3), indent + 2);
    return this.tag('Id', id, indent);
  }

  onEditorChange(content: string, fromForm = false) {
    if (!this.isInternalChange && !fromForm) {
      this.pushHistory();
      this.parseXmlToForm(content);
    }

    this.generatedXml = content;
    this.refreshLineCount();
  }

  private parseXmlToForm(xml: string) {
    if (!xml || xml.length < 50) return;
    try {
      this.isParsingXml = true;
      const cleanXml = xml.replace(/<(\/?)(?:[\w]+:)/g, '<$1');
      const doc = new DOMParser().parseFromString(cleanXml, 'text/xml');
      if (doc.querySelector('parsererror')) {
        this.isParsingXml = false;
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
      const setV = (f: string, v: string) => { if (v !== undefined && v !== null && v !== '') patch[f] = v; };

      // 1. AppHdr (BAH)
      const head = getT('AppHdr');
      if (head) {
        setV('head_charSet', tval('CharSet', head));
        this.mapAddrToForm(getT('Fr', head), 'head_from', patch);
        this.mapAddrToForm(getT('To', head), 'head_to', patch);
        setV('head_bizMsgIdr', tval('BizMsgIdr', head));
        setV('head_msgDefIdr', tval('MsgDefIdr', head));
        setV('head_bizSvc', tval('BizSvc', head));
        setV('head_creDt', tval('CreDt', head).substring(0, 10));
        const mkt = getT('MktPrctc', head);
        if (mkt) {
          setV('head_mktPrctcRegy', tval('Regy', mkt));
          setV('head_mktPrctcId', tval('Id', mkt));
        }
        setV('head_cpyDplct', tval('CpyDplct', head));
        setV('head_pssblDplct', tval('PssblDplct', head));
        setV('head_prty', tval('Prty', head));
        const rltd = getT('Rltd', head);
        if (rltd) setV('head_rltdBizMsgIdr', tval('BizMsgIdr', rltd));
      }

      // 2. Document
      const root = getT('CstmrCdtTrfInitn');
      if (root) {
        const grpHdr = getT('GrpHdr', root);
        if (grpHdr) {
          setV('msgId', tval('MsgId', grpHdr));
          setV('creDtTm', tval('CreDtTm', grpHdr).replace('Z', ''));
          const auth = getT('Authstn', grpHdr);
          if (auth) {
            setV('authstnCd', tval('Cd', auth));
            setV('authstnPrtry', tval('Prtry', auth));
          }
          setV('nbOfTxs', tval('NbOfTxs', grpHdr));
          setV('ctrlSum', tval('CtrlSum', grpHdr));
          this.mapAddrToForm(getT('InitgPty', grpHdr), 'initgPty', patch);
          this.mapAddrToForm(getT('FwdgAgt', grpHdr), 'fwdgAgt', patch);
        }

        const pmtInf = getT('PmtInf', root);
        if (pmtInf) {
          setV('pmtInfId', tval('PmtInfId', pmtInf));
          setV('pmtMtd', tval('PmtMtd', pmtInf));
          patch.btchBookg = tval('BtchBookg', pmtInf) === 'true';
          setV('pmtNbOfTxs', tval('NbOfTxs', pmtInf));
          setV('pmtCtrlSum', tval('CtrlSum', pmtInf));
          
          const tp = getT('PmtTpInf', pmtInf);
          if (tp) {
            setV('instrPrty', tval('InstrPrty', tp));
            setV('svcLvl', tval('Cd', getT('SvcLvl', tp) || tp));
            setV('lclInstrm', tval('Cd', getT('LclInstrm', tp) || tp));
            setV('ctgyPurp', tval('Cd', getT('CtgyPurp', tp) || tp));
          }
          setV('reqdExctnDt', tval('Dt', getT('ReqdExctnDt', pmtInf) || pmtInf).substring(0, 10));
          setV('poolgAdjstmntDt', tval('PoolgAdjstmntDt', pmtInf));

          this.mapAddrToForm(getT('Dbtr', pmtInf), 'dbtr', patch);
          const dbtrAcct = getT('DbtrAcct', pmtInf);
          if (dbtrAcct) setV('dbtrIban', tval('Id', getT('Othr', getT('Id', dbtrAcct) || dbtrAcct) || (getT('Id', dbtrAcct) || dbtrAcct)));
          
          this.mapAddrToForm(getT('DbtrAgt', pmtInf), 'dbtrAgt', patch);
          const dbtrAgtAcct = getT('DbtrAgtAcct', pmtInf);
          if (dbtrAgtAcct) setV('dbtrAgtAcctIban', tval('Id', getT('Othr', getT('Id', dbtrAgtAcct) || dbtrAgtAcct) || (getT('Id', dbtrAgtAcct) || dbtrAgtAcct)));
          
          this.mapAddrToForm(getT('UltmtDbtr', pmtInf), 'ultmtDbtr', patch);
          setV('chrgBr', tval('ChrgBr', pmtInf));
          
          const chrgsAcct = getT('ChrgsAcct', pmtInf);
          if (chrgsAcct) setV('chrgsAcctIban', tval('Id', getT('Othr', getT('Id', chrgsAcct) || chrgsAcct) || (getT('Id', chrgsAcct) || chrgsAcct)));
          
          const chrgsAgt = getT('ChrgsAcctAgt', pmtInf);
          if (chrgsAgt) {
             const fi = getT('FinInstnId', chrgsAgt);
             if (fi) setV('chrgsAcctAgtBic', tval('BICFI', fi));
          }

          // Transactions
          const txs = root.querySelectorAll('CdtTrfTxInf');
          if (txs.length > 0) {
            this.transactions.clear();
            txs.forEach(t => {
              const g = this.createTransactionGroup();
              const tp: any = {};
              const tv = (tagName: string, parent: any = t) => getT(tagName, parent)?.textContent?.trim() || '';
              const sv = (f: string, v: string) => { if (v !== undefined && v !== null && v !== '') tp[f] = v; };

              const pmtId = getT('PmtId', t);
              if (pmtId) {
                sv('instrId', tv('InstrId', pmtId));
                sv('endToEndId', tv('EndToEndId', pmtId));
                sv('uetr', tv('UETR', pmtId));
              }
              const pmtTp = getT('PmtTpInf', t);
              if (pmtTp) {
                sv('txSvcLvl', tv('Cd', getT('SvcLvl', pmtTp) || pmtTp));
                sv('txLclInstrm', tv('Cd', getT('LclInstrm', pmtTp) || pmtTp));
                sv('txCtgyPurp', tv('Cd', getT('CtgyPurp', pmtTp) || pmtTp));
              }
              const amt = getT('Amt', t);
              if (amt) {
                const instd = getT('InstdAmt', amt);
                if (instd) {
                  sv('amount', instd.textContent?.trim() || '');
                  sv('currency', instd.getAttribute('Ccy') || '');
                }
              }
              const xchg = getT('XchgRateInf', t);
              if (xchg) {
                sv('xchgRate', tv('XchgRate', xchg));
                sv('xchgRateTp', tv('RateTp', xchg));
                sv('xchgUnitCcy', tv('UnitCcy', xchg));
                sv('xchgCtrctId', tv('CtrctId', xchg));
              }
              const chq = getT('ChqInstr', t);
              if (chq) {
                sv('chqInstr', tv('ChqNb', chq));
                sv('chqTp', tv('ChqTp', chq));
                sv('chqMtrtyDt', tv('Dt', getT('ChqMtrtyDt', chq) || chq));
              }
              sv('mndtId', tv('MndtId', t));

              this.mapAddrToForm(getT('UltmtDbtr', t), 'ultmtDbtr', tp);
              this.mapAddrToForm(getT('IntrmyAgt1', t), 'intrmyAgt1', tp);
              const i1acct = getT('IntrmyAgt1Acct', t);
              if (i1acct) sv('intrmyAgt1Acct', tval('Id', getT('Othr', getT('Id', i1acct) || i1acct) || (getT('Id', i1acct) || i1acct)));
              
              this.mapAddrToForm(getT('IntrmyAgt2', t), 'intrmyAgt2', tp);
              const i2acct = getT('IntrmyAgt2Acct', t);
               if (i2acct) sv('intrmyAgt2Acct', tval('Id', getT('Othr', getT('Id', i2acct) || i2acct) || (getT('Id', i2acct) || i2acct)));

              this.mapAddrToForm(getT('IntrmyAgt3', t), 'intrmyAgt3', tp);
              const i3acct = getT('IntrmyAgt3Acct', t);
               if (i3acct) sv('intrmyAgt3Acct', tval('Id', getT('Othr', getT('Id', i3acct) || i3acct) || (getT('Id', i3acct) || i3acct)));

              this.mapAddrToForm(getT('CdtrAgt', t), 'cdtrAgt', tp);
              const cagtAcct = getT('CdtrAgtAcct', t);
              if (cagtAcct) sv('cdtrAgtAcct', tval('Id', getT('Othr', getT('Id', cagtAcct) || cagtAcct) || (getT('Id', cagtAcct) || cagtAcct)));

              this.mapAddrToForm(getT('Cdtr', t), 'cdtr', tp);
              const cdtrAcct = getT('CdtrAcct', t);
              if (cdtrAcct) sv('cdtrIban', tval('Id', getT('Othr', getT('Id', cdtrAcct) || cdtrAcct) || (getT('Id', cdtrAcct) || cdtrAcct)));

              this.mapAddrToForm(getT('UltmtCdtr', t), 'ultmtCdtr', tp);
              sv('purpCd', tv('Cd', getT('Purp', t) || t));
              const tax = getT('Tax', t);
              if (tax) {
                sv('taxId', tv('Id', tax));
                sv('taxAmt', tv('InstdAmt', getT('Amt', tax) || tax));
              }
              sv('rltdRmtInfUrl', tv('URL', getT('RltdRmtInf', t) || t));
              sv('rgltryRptg', tv('Inf', getT('Dtls', getT('RgltryRptg', t) || t)));
              sv('rmtInf', tv('Ustrd', getT('RmtInf', t) || t));

              g.patchValue(tp);
              this.transactions.push(g);
            });
          }
        }
      }
      this.form.patchValue(patch, { emitEvent: false });
    } catch (e) {
      console.error('Error parsing pain.001 XML:', e);
    } finally {
      this.isParsingXml = false;
    }
  }


  openBicSearchGroup(controlName: string, group: AbstractControl) {
    const dialogRef = this.dialog.open(BicSearchDialogComponent, {
      width: '800px',
      disableClose: true
    });

    dialogRef.afterClosed().subscribe(result => {
      if (result && result.bic) {
        group.get(controlName)?.patchValue(result.bic);
        group.get(controlName)?.markAsDirty();
      }
    });
  }

  @HostListener('keydown', ['$event'])
  onKeydown(event: KeyboardEvent) {
    // History & Formatting Shortcuts (Ctrl+Z, Ctrl+Y, Ctrl+S)
    if (event.ctrlKey || event.metaKey) {
      if (document.activeElement?.classList.contains('code-editor')) {
        switch (event.key.toLowerCase()) {
          case 'z':
            event.preventDefault();
            this.undoXml();
            return;
          case 'y':
            event.preventDefault();
            this.redoXml();
            return;
          case 's':
            event.preventDefault();
            this.formatXml();
            return;
          case '/':
            event.preventDefault();
            this.toggleCommentXml();
            return;
        }
      }
    }
  }

  @HostListener('input', ['$event'])
  onInput(event: any) {
    const target = event.target as HTMLInputElement;
    if (!target) return;
    const name = target.getAttribute('formControlName');
    if (!name) return;

    if (name.toLowerCase().includes('bic') || name.toLowerCase().includes('iban')) {
        const start = target.selectionStart;
        const end = target.selectionEnd;
        const up = target.value.toUpperCase();
        if (target.value !== up) {
          target.value = up;
          if (start !== null) target.setSelectionRange(start, end);
          this.form.get(name)?.patchValue(up, { emitEvent: false });
        }
    }
    
    const max = target.maxLength;
    if (max > 0 && target.value.length >= max) {
      this.showMaxLenWarning[name] = true;
      if (this.warningTimeouts[name]) clearTimeout(this.warningTimeouts[name]);
      this.warningTimeouts[name] = setTimeout(() => this.showMaxLenWarning[name] = false, 3000);
    } else {
      this.showMaxLenWarning[name] = false;
    }
  }

  hint(f: string, max: number, group?: any): string | null {
    if (!this.showMaxLenWarning[f]) return null;
    const c = group ? group.get(f) : this.form.get(f);
    const len = c?.value?.length || 0;
    return `Maximum ${max} characters reached (${len}/${max})`;
  }

  copyToClipboard() { navigator.clipboard.writeText(this.generatedXml); this.snackBar.open('Copied!', 'Close', { duration: 3000 }); }
  downloadXml() { const b = new Blob([this.generatedXml], { type: 'application/xml' }); const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = `pain001-${Date.now()}.xml`; a.click(); }

  validateMessage() {
        if (this.bicSameWarning) return;
        this.showValidationModal = true;
    this.validationStatus = 'validating';
    this.validationReport = null;
    this.validationExpandedIssue = null;

    this.http.post(this.config.getApiUrl('/validate'), {
      xml_content: this.generatedXml,
      message_type: 'pain.001.001.09', // Kept as pain.001.001.09 for this component
      mode: 'Full 1-3'
    }).subscribe({
      next: (res: any) => {
        this.validationReport = res;
        this.validationStatus = 'done';
        this.clearDraft();
      },
      error: (err) => { 
        this.validationReport = {
          status: 'FAIL', errors: 1, warnings: 0,
          message: 'pain.001.001.09', // Kept as pain.001.001.09 for this component
          total_time_ms: 0,
          layer_status: {},
          details: [{
            severity: 'ERROR', layer: 0, code: 'BACKEND_ERROR',
            path: '', message: 'Validation failed — ' + (err.error?.detail?.message || 'backend not reachable.'),
            fix_suggestion: 'Ensure the validation server is running.'
          }]
        };
        this.validationStatus = 'done'; 
      }
    });
  }

  closeValidationModal() { 
    this.showValidationModal = false; 
    this.validationReport = null;
    this.validationStatus = 'idle';
    this.validationExpandedIssue = null;
  }

  getValidationLayers(): string[] {
    if (!this.validationReport?.layer_status) return [];
    return Object.keys(this.validationReport.layer_status).sort();
  }

  getLayerName(k: string): string {
    const names: Record<string, string> = { '1': 'Syntax & Format', '2': 'Schema Validation', '3': 'Business Rules' };
    return names[k] ?? `Layer ${k}`;
  }

  getLayerStatus(k: string): string { return this.validationReport?.layer_status?.[k]?.status ?? ''; }
  getLayerTime(k: string): number { return this.validationReport?.layer_status?.[k]?.time ?? 0; }
  isLayerPass(k: string) { return this.getLayerStatus(k).includes('✅'); }
  isLayerFail(k: string) { return this.getLayerStatus(k).includes('❌'); }
  isLayerWarn(k: string) {
    const s = this.getLayerStatus(k);
    return s.includes('⚠') || s.includes('WARNING') || s.includes('WARN');
  }

  getValidationIssues(): any[] { return this.validationReport?.details ?? []; }
  toggleValidationIssue(issue: any) {
    this.validationExpandedIssue = this.validationExpandedIssue === issue ? null : issue;
  }

  getIssuesByLayer(layer: string): any[] {
    return this.getValidationIssues().filter(i => i.layer.toString() === layer);
  }

  toggleLayer(layer: string, e: MouseEvent) {
    e.stopPropagation();
    if (this.expandedLayers.has(layer)) {
      this.expandedLayers.delete(layer);
    } else {
      this.expandedLayers.add(layer);
    }
  }

  getLayerErrorCount(layer: string): number {
    return this.getIssuesByLayer(layer).filter(i => i.severity === 'ERROR').length;
  }

  getLayerWarningCount(layer: string): number {
    return this.getIssuesByLayer(layer).filter(i => i.severity === 'WARNING').length;
  }
  copyFix(text: string, e: MouseEvent) {
    e.stopPropagation();
    navigator.clipboard.writeText(text).then(() => {
      this.snackBar.open('Copied!', '', { duration: 1500 });
    });
  }

  viewXmlModal() { this.showValidationModal = false; }
  runValidationModal() { this.validateMessage(); }

  private pushHistory() {
    const val = this.generatedXml;
    if (this.xmlHistoryIdx >= 0 && this.xmlHistory[this.xmlHistoryIdx] === val) return;

    if (this.xmlHistoryIdx < this.xmlHistory.length - 1) {
      this.xmlHistory.splice(this.xmlHistoryIdx + 1);
    }

    this.xmlHistory.push(val);
    if (this.xmlHistory.length > this.maxHistory) {
      this.xmlHistory.shift();
    } else {
      this.xmlHistoryIdx++;
    }
  }

  undoXml() {
    if (this.xmlHistoryIdx > 0) {
      this.xmlHistoryIdx--;
      this.isInternalChange = true;
      this.generatedXml = this.xmlHistory[this.xmlHistoryIdx];
      this.parseXmlToForm(this.generatedXml);
      this.refreshLineCount();
      setTimeout(() => this.isInternalChange = false, 10);
    }
  }

  redoXml() {
    if (this.xmlHistoryIdx < this.xmlHistory.length - 1) {
      this.xmlHistoryIdx++;
      this.isInternalChange = true;
      this.generatedXml = this.xmlHistory[this.xmlHistoryIdx];
      this.parseXmlToForm(this.generatedXml);
      this.refreshLineCount();
      setTimeout(() => this.isInternalChange = false, 10);
    }
  }

  canUndoXml(): boolean { return this.xmlHistoryIdx > 0; }
  canRedoXml(): boolean { return this.xmlHistoryIdx < this.xmlHistory.length - 1; }

  private refreshLineCount() {
    const lines = (this.generatedXml || '').split('\n').length;
    this.editorLineCount = Array.from({ length: lines }, (_, i) => i + 1);
  }

  formatXml() {
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
      this.snackBar.open('XML Formatted', '', { duration: 1500 });
    } catch (e) {
      this.snackBar.open('Unable to format XML', '', { duration: 3000 });
    }
  }

  toggleCommentXml() {
    if (!this.generatedXml) return;
    const textarea = document.querySelector('.code-editor') as HTMLTextAreaElement;
    if (!textarea) return;

    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const value = textarea.value;

    this.isInternalChange = true;
    this.pushHistory();

    let lineStart = value.lastIndexOf('\n', start - 1) + 1;
    let lineEnd = value.indexOf('\n', end);
    if (lineEnd === -1) lineEnd = value.length;

    const selection = value.substring(lineStart, lineEnd);
    const before = value.substring(0, lineStart);
    const after = value.substring(lineEnd);

    let newResult = '';
    const trimmed = selection.trim();

    if (trimmed.startsWith('<!--') && trimmed.endsWith('-->')) {
      newResult = selection.replace('<!--', '').replace('-->', '');
    } else {
      newResult = `<!-- ${selection} -->`;
    }

    this.generatedXml = before + newResult + after;
    this.parseXmlToForm(this.generatedXml);
    this.refreshLineCount();

    setTimeout(() => {
      textarea.focus();
      textarea.setSelectionRange(lineStart, lineStart + newResult.length);
      this.isInternalChange = false;
    }, 0);
  }

  err(f: string, group?: any): string | null {
    const c = group ? group.get(f) : this.form.get(f);
    if (!c || c.valid) return null;

    if (c.errors?.['required']) return 'Required field.';
    if (c.errors?.['maxlength']) return `Max ${c.errors['maxlength'].requiredLength} chars.`;
    if (c.errors?.['pattern']) {
      if (this.showMaxLenWarning[f]) {
        const val = c.value?.toString() || '';
        const limitError = c.errors?.['maxlength']?.requiredLength;
        if (limitError && val.length >= limitError) return null;
        if (f.toLowerCase().includes('bic') && val.length >= 11) return null;
        if (f === 'uetr' && val.length >= 36) return null;
      }

      const fl = f.toLowerCase();
      if (fl.includes('bic')) return 'Valid 8 or 11-char BIC required.';
      if (fl.includes('iban')) return 'Valid MOD-97 IBAN required.';
      if (fl.includes('uetr')) return 'Invalid UETR format (UUID v4).';
      if (fl.includes('amount') || fl.includes('amt')) return 'Numbers only, up to 5 decimals.';
      if (fl.includes('lei')) return 'Must be 20-char LEI.';
      if (fl.includes('id') && !fl.includes('uetr')) return 'Invalid format (Alpha-numeric, max 35 chars).';
      if (fl.includes('name') || fl.includes('nm')) return "Invalid characters. Only letters, numbers, spaces and . , ( ) ' - are allowed.";
      
      return 'Invalid format.';
    }
    return 'Invalid value.';
  }

  syncScroll(editor: HTMLTextAreaElement, gutter: HTMLDivElement) {
    gutter.scrollTop = editor.scrollTop;
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
