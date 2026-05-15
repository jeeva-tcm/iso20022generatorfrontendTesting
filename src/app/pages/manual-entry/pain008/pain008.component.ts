import { BicSearchDialogComponent } from '../bic-search-dialog/bic-search-dialog.component';
import { MatDialog } from '@angular/material/dialog';
import { Component, OnInit, OnDestroy, HostListener } from '@angular/core';
import { FormBuilder, FormGroup, FormArray, Validators, ReactiveFormsModule, FormsModule } from '@angular/forms';
import { CommonModule } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { MatIconModule } from '@angular/material/icon';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { ConfigService } from '../../../services/config.service';
import { FormattingService } from '../../../services/formatting.service';
import { debounceTime } from 'rxjs/operators';

@Component({
  selector: 'app-pain008',
  templateUrl: './pain008.component.html',
  styleUrls: ['./pain008.component.css'],
  standalone: true,
  imports: [CommonModule, ReactiveFormsModule, FormsModule, MatIconModule, MatSnackBarModule, MatTooltipModule]
})
export class Pain008Component implements OnInit, OnDestroy {
  form!: FormGroup;
  generatedXml = '';
  isParsingXml = false;
  editorLineCount: number[] = [];

  private xmlHistory: string[] = [];
  private xmlHistoryIdx = -1;
  private maxHistory = 50;
  private isInternalChange = false;

  // Codelists
  currencies = ['USD', 'EUR', 'GBP', 'JPY', 'AUD', 'CAD', 'CHF', 'CNY', 'HKD', 'NZD'];
  chargeBearers = ['CRED', 'DEBT', 'SHAR'];
  priorities = ['HIGH', 'NORM'];
  sequenceTypes = ['FRST', 'RCUR', 'FNAL', 'OOFF', 'RPRE'];
  authCodes = ['AUTH', 'FDET', 'FSUM', 'ILEV'];
  copyDuplicates = ['COPY', 'CODU', 'DUPL'];
  frequencyTypes = ['ADHO', 'YEAR', 'DAIL', 'FRTN', 'INDA', 'MNTH', 'QURT', 'MIAN', 'WEEK'];
  dbtCdtRptgInd = ['BOTH', 'CRED', 'DEBT'];
  taxPeriodTypes = ['MM01','MM02','MM03','MM04','MM05','MM06','MM07','MM08','MM09','MM10','MM11','MM12','QTR1','QTR2','QTR3','QTR4','HLF1','HLF2'];
  rmtMethods = ['EMAL', 'EDIC', 'FAXI', 'POST', 'SMSM', 'URID'];
  rfrdDocCodes = ['AROI','BOLD','CMCN','CINV','CREN','CNFA','DEBN','DNFA','DISP','HIRI','MSIN','PUOR','SBIN','SOAC','TSUT','VCHR'];
  cdtrRefCodes = ['DISP','FXDR','PUOR','RPIN','RADM','SCOR'];
  cdtDbtInds = ['CRDT', 'DBIT'];
  addrTypeCodes = ['ADDR', 'BIZZ', 'DLVY', 'HOME', 'MLTO', 'PBOX'];
  nmPrefixes = ['DOCT', 'MIKS', 'MADM', 'MISS', 'MIST'];
  prefrdMethods = ['MAIL', 'FAXX', 'LETT', 'CELL', 'PHON'];

  // Validation state
  showValidationModal = false;
  validationStatus: 'idle' | 'validating' | 'done' = 'idle';
  validationReport: any = null;
  validationExpandedIssue: any = null;
  warningTimeouts: { [key: string]: any } = {};
  showMaxLenWarning: { [key: string]: boolean } = {};

  private readonly DRAFT_KEY = 'draft_pain008';
  private draftSaveTimer: ReturnType<typeof setTimeout> | null = null;
  showDraftBanner = false;
  isClearingDraft = false;

  constructor(
    private dialog: MatDialog,
    private fb: FormBuilder,
    private http: HttpClient,
    private config: ConfigService,
    private snackBar: MatSnackBar,
    private formatting: FormattingService
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
    this.form.valueChanges.pipe(debounceTime(300)).subscribe(() => { this.updateConditionalValidators(); this.generateXml(); this.scheduleDraftSave(); });
    this.updateConditionalValidators();
  }

  private updateConditionalValidators() {
    const ADDR_PAT = Validators.pattern(/^[a-zA-Z0-9\/\-\?:\(\)\.,\+' ]+$/);
    ['initgPty', 'cdtr', 'dbtr'].forEach(p => {
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
      // === AppHdr ===
      fromBic: ['BANCGB2LXXX', [Validators.required, Validators.pattern(/^[A-Z0-9]{8,11}$/)]],
      fromClrSysCd: [''],
      fromMmbId: [''],
      fromLei: [''],
      toBic: ['BANCGB2LXXX', [Validators.required, Validators.pattern(/^[A-Z0-9]{8,11}$/)]],
      toClrSysCd: [''],
      toMmbId: [''],
      toLei: [''],
      bizMsgId: ['BMS-' + Date.now(), [Validators.required, Validators.maxLength(35)]],
      msgDefIdr: ['pain.008.001.08'],
      bizSvc: ['swift.cbprplus.03'],
      mktPrctcRegy: [''],
      mktPrctcId: [''],
      creDt: [this.isoNow(), Validators.required],
      cpyDplct: [''],
      pssblDplct: [''],
      prty: ['NORM'],
      charSet: ['UTF-8'],
      // Rltd
      rltdCharSet: ['UTF-8'],
      rltdFrBic: ['SNDRUS33XXX'],
      rltdFrClrSysCd: ['USABA'],
      rltdFrMmbId: ['123456789'],
      rltdFrLei: ['12345678901234567890'],
      rltdToBic: ['RCVRUS33XXX'],
      rltdToClrSysCd: ['USABA'],
      rltdToMmbId: ['987654321'],
      rltdToLei: ['09876543210987654321'],
      rltdBizMsgIdr: ['RLTD-BMS-001'],
      rltdMsgDefIdr: ['pain.008.001.08'],
      rltdBizSvc: ['swift.cbprplus.03'],
      rltdCreDt: [this.isoNow()],
      rltdCpyDplct: ['COPY'],
      rltdPrty: ['NORM'],

      // === GrpHdr ===
      msgId: ['PAIN008-MSG-' + Date.now(), [Validators.required, Validators.maxLength(35)]],
      creDtTm: [this.isoNow(), Validators.required],
      authsnCd: ['AUTH'],
      authsnPrtry: [''],
      nbOfTxs: ['1'],
      initgPtyName: ['Initiating Party', [Validators.required, Validators.maxLength(140)]],
      initgPtyId: ['', [Validators.maxLength(35)]],
      initgPtyCtryOfRes: ['US'],
      initgPtyAddrType: ['structured'],
      initgPtyDept: ['Treasury'],
      initgPtySubDept: ['Payments'],
      initgPtyStrtNm: ['Main Street'],
      initgPtyBldgNb: ['100'],
      initgPtyBldgNm: [''],
      initgPtyFlr: [''],
      initgPtyPstBx: [''],
      initgPtyRoom: [''],
      initgPtyPstCd: ['10001'],
      initgPtyTwnNm: ['New York'],
      initgPtyTwnLctnNm: [''],
      initgPtyDstrctNm: [''],
      initgPtyCtrySubDvsn: [''],
      initgPtyCtry: ['US'],
      initgPtyAdrLine1: [''],
      initgPtyAdrLine2: [''],
      fwdgAgtBic: ['FWDGUS33XXX'],
      fwdgAgtClrSysCd: [''],
      fwdgAgtMmbId: [''],
      fwdgAgtLei: [''],

      // === PmtInf ===
      pmtInfId: ['PMTINF-' + Date.now(), [Validators.required, Validators.maxLength(35)]],
      pmtMtd: ['DD'],
      btchBookg: ['true'],
      reqdColltnDt: [this.isoNowDate(), Validators.required],

      // Creditor (PmtInf level)
      cdtrName: ['Creditor Name', [Validators.required, Validators.maxLength(140)]],
      cdtrCtryOfRes: ['US'],
      cdtrAddrType: ['hybrid'],
      cdtrDept: [''],
      cdtrSubDept: [''],
      cdtrStrtNm: ['Market Street'],
      cdtrBldgNb: ['200'],
      cdtrBldgNm: [''],
      cdtrFlr: [''],
      cdtrPstBx: [''],
      cdtrRoom: [''],
      cdtrPstCd: ['94105'],
      cdtrTwnNm: ['San Francisco'],
      cdtrTwnLctnNm: [''],
      cdtrDstrctNm: [''],
      cdtrCtrySubDvsn: [''],
      cdtrCtry: ['US'],
      cdtrAdrLine1: ['Floor 5'],
      cdtrAdrLine2: ['Suite 500'],
      cdtrIban: ['GB82WEST12345698765432', [Validators.required, Validators.maxLength(34)]],
      cdtrAcctOthrId: [''],
      cdtrAcctCcy: [''],
      cdtrAcctNm: [''],
      cdtrAcctTpCd: [''],

      // Creditor Agent
      cdtrAgtBic: ['BANCGB2LXXX', [Validators.required, Validators.maxLength(11)]],
      cdtrAgtClrSysCd: ['GBDSC'],
      cdtrAgtMmbId: ['112233'],
      cdtrAgtLei: ['549300V6YF7100J0J012'],
      cdtrAgtNm: [''],
      // CdtrAgtAcct
      cdtrAgtAcctIban: ['GB33BUKB20201555555555'],
      cdtrAgtAcctOthrId: [''],
      cdtrAgtAcctCcy: ['GBP'],

      // Charges Account
      chrgsAcctIban: ['GB15MIDL40051512345678'],
      chrgsAcctOthrId: [''],
      chrgsAcctCcy: ['GBP'],

      // Charges Account Agent
      chrgsAcctAgtBic: ['BANCGB2LXXX'],
      chrgsAcctAgtMmbId: ['112233'],
      chrgsAcctAgtLei: ['549300V6YF7100J0J012'],

      // Transactions
      transactions: this.fb.array([this.createTxGroup()])
    });
  }

  private createTxGroup(): FormGroup {
    return this.fb.group({
      // PmtId
      instrId: ['INSTR-' + Date.now(), [Validators.required, Validators.maxLength(35)]],
      endToEndId: ['E2E-' + Date.now(), [Validators.required, Validators.maxLength(35)]],
      uetr: [crypto.randomUUID ? crypto.randomUUID() : '550e8400-e29b-41d4-a716-446655440000', [Validators.required]],

      // PmtTpInf
      instrPrty: ['NORM'],
      svcLvlCd: ['SEPA'],
      svcLvlPrtry: [''],
      lclInstrmCd: ['CORE'],
      lclInstrmPrtry: [''],
      seqTp: ['FRST'],
      ctgyPurpCd: ['CASH'],
      ctgyPurpPrtry: [''],

      // InstdAmt
      amount: ['100.00', [Validators.required, Validators.pattern(/^\d{1,18}(\.\d{1,5})?$/)]],
      currency: ['GBP', Validators.required],

      // ChrgBr
      chrgBr: ['SHAR'],

      // DrctDbtTx / MndtRltdInf
      mndtId: ['MNDT-001', [Validators.required, Validators.maxLength(35)]],
      dtOfSgntr: [this.isoNowDate()],
      amdmntInd: ['true'],
      orgnlMndtId: ['MNDT-ORG-001'],
      // AmdmntInfDtls expanded
      orgnlCdtrSchmeIdNm: ['Old Creditor Scheme'],
      orgnlCdtrSchmeIdBic: ['OLDCCU33XXX'],
      orgnlCdtrAgtBic: ['OLDCAU33XXX'],
      orgnlDbtrNm: ['Original Debtor Name'],
      orgnlDbtrAcctIban: ['GB94BARC20201530093459'],
      orgnlDbtrAgtBic: ['OLDDAU33XXX'],
      orgnlFnlColltnDt: [this.isoNowDate()],
      orgnlFrqcyTp: ['YEAR'],
      orgnlRsnCd: ['MD01'],
      orgnlRsnPrtry: [''],
      orgnlTrckgDays: ['05'],
      elctrncSgntr: ['ELECTRONIC-SIGNATURE-DATA'],
      frstColltnDt: [this.isoNowDate()],
      fnlColltnDt: [this.isoNowDate()],
      frqcyTp: ['MNTH'],
      frqcyPrdTp: ['MNTH'],
      frqcyPrdCntPerPrd: ['1'],
      rsnCd: ['MD01'],
      rsnPrtry: [''],
      trckgDays: ['03'],

      // CdtrSchmeId
      cdtrSchmeIdNm: ['Creditor Scheme Name'],
      cdtrSchmeIdOthrId: ['SCHEME-ID-001'],
      cdtrSchmeIdOthrSchmeNmCd: [''],
      cdtrSchmeIdOthrSchmeNmPrtry: ['SEPA'],
      cdtrSchmeIdOthrIssr: ['ISSUER-X'],

      // PreNtfctn
      preNtfctnId: ['PRE-NTF-001'],
      preNtfctnDt: [this.isoNowDate()],

      // UltmtCdtr
      ultmtCdtrName: [''],

      // Debtor Agent
      dbtrAgtBic: ['DEUTDEFFXXX', [Validators.required, Validators.maxLength(11)]],
      dbtrAgtClrSysCd: ['DEBCC'],
      dbtrAgtMmbId: ['445566'],
      dbtrAgtLei: ['12345678901234567891'],
      // DbtrAgtAcct
      dbtrAgtAcctIban: ['GB82WEST12345698765432'],
      dbtrAgtAcctOthrId: [''],

      // Debtor
      dbtrName: ['Debtor Name', [Validators.required, Validators.maxLength(140)]],
      dbtrCtryOfRes: ['GB'],
      dbtrAddrType: ['unstructured'],
      dbtrDept: [''],
      dbtrSubDept: [''],
      dbtrStrtNm: [''],
      dbtrBldgNb: [''],
      dbtrBldgNm: [''],
      dbtrFlr: [''],
      dbtrPstBx: [''],
      dbtrRoom: [''],
      dbtrPstCd: [''],
      dbtrTwnNm: ['London'],
      dbtrTwnLctnNm: [''],
      dbtrDstrctNm: [''],
      dbtrCtrySubDvsn: [''],
      dbtrCtry: ['GB'],
      dbtrAdrLine1: ['10 Downing Street'],
      dbtrAdrLine2: ['Westminster'],
      dbtrOrgIdAnyBic: ['DEUTDEFFXXX'],
      dbtrOrgIdLei: ['12345678901234567892'],
      dbtrOrgIdOthrId: ['ORG-ID-001'],
      dbtrOrgIdOthrSchmeNmCd: ['VAT'],
      dbtrOrgIdOthrIssr: ['ISSUER-Y'],
      dbtrPrvtIdBirthDt: ['1980-01-01'],
      dbtrPrvtIdCityOfBirth: ['Berlin'],
      dbtrPrvtIdCtryOfBirth: ['DE'],
      dbtrPrvtIdOthrId: ['PRVT-ID-001'],
      dbtrPrvtIdOthrSchmeNmCd: ['NIDN'],
      dbtrPrvtIdOthrIssr: ['ISSUER-Z'],

      // Debtor Account
      dbtrIban: ['GB33BUKB20201555555555', [Validators.required, Validators.maxLength(34)]],
      dbtrAcctOthrId: [''],
      dbtrAcctCcy: [''],
      dbtrAcctNm: [''],
      dbtrAcctTpCd: [''],

      // UltmtDbtr
      ultmtDbtrName: [''],

      // InstrForCdtrAgt
      instrForCdtrAgt: ['Instruction for creditor agent text'],

      // Purpose
      purpCd: ['CASH'],
      purpPrtry: [''],

      // RgltryRptg
      rgltryRptgInd: ['CRED'],
      rgltryRptgAuthrtyNm: ['Central Bank'],
      rgltryRptgAuthrtyCtry: ['DE'],
      rgltryRptgDtlsTp: ['TAX-REPORT'],
      rgltryRptgDtlsDt: [this.isoNowDate()],
      rgltryRptgDtlsCd: ['REG-001'],
      rgltryRptgDtlsCtry: ['DE'],
      rgltryRptgDtlsAmt: ['100.00'],
      rgltryRptgDtlsAmtCcy: ['EUR'],
      rgltryRptgDtlsInf: ['Regulatory details info'],

      // Tax
      taxCdtrTaxId: ['TX-CDTR-001'],
      taxCdtrRegnId: ['REG-CDTR-001'],
      taxCdtrTaxTp: ['VAT'],
      taxDbtrTaxId: ['TX-DBTR-001'],
      taxDbtrRegnId: ['REG-DBTR-001'],
      taxDbtrTaxTp: ['VAT'],
      taxAuthsnTitl: [''],
      taxAuthsnNm: [''],
      taxAdmstnZone: ['Zone A'],
      taxRefNb: ['REF-TAX-001'],
      taxMtd: ['MTD-01'],
      taxTtlTaxblBaseAmt: ['500.00'],
      taxTtlTaxblBaseAmtCcy: ['EUR'],
      taxTtlTaxAmt: ['100.00'],
      taxTtlTaxAmtCcy: ['EUR'],
      taxDt: [this.isoNowDate()],
      taxSeqNb: ['1'],

      // RemittanceInfo
      rmtInfUstrd: ['', [Validators.maxLength(140)]],
      // Strd > RfrdDocInf
      rmtInfStrdRfrdDocCd: ['CINV'],
      rmtInfStrdRfrdDocPrtry: [''],
      rmtInfStrdRfrdDocIssr: ['ISSUER-DOC'],
      rmtInfStrdRfrdDocNb: ['INV-001'],
      rmtInfStrdRfrdDocRltdDt: [this.isoNowDate()],
      rmtInfStrdRfrdDocLineDtlsDesc: [''],
      rmtInfStrdRfrdDocLineDtlsDuePyblAmt: [''],
      rmtInfStrdRfrdDocLineDtlsDuePyblAmtCcy: [''],
      rmtInfStrdRfrdDocLineDtlsCdtNoteAmt: [''],
      rmtInfStrdRfrdDocLineDtlsCdtNoteAmtCcy: [''],
      rmtInfStrdRfrdDocLineDtlsRmtdAmt: [''],
      rmtInfStrdRfrdDocLineDtlsRmtdAmtCcy: [''],
      // Strd > RfrdDocAmt
      rmtInfStrdRfrdDocAmtDuePyblAmt: [''],
      rmtInfStrdRfrdDocAmtDuePyblAmtCcy: [''],
      rmtInfStrdRfrdDocAmtDscntApldAmtTpCd: [''],
      rmtInfStrdRfrdDocAmtDscntApldAmt: [''],
      rmtInfStrdRfrdDocAmtDscntApldAmtCcy: [''],
      rmtInfStrdRfrdDocAmtCdtNoteAmt: [''],
      rmtInfStrdRfrdDocAmtCdtNoteAmtCcy: [''],
      rmtInfStrdRfrdDocAmtTaxAmtTpCd: [''],
      rmtInfStrdRfrdDocAmtTaxAmt: [''],
      rmtInfStrdRfrdDocAmtTaxAmtCcy: [''],
      rmtInfStrdRfrdDocAmtAdjRsn: [''],
      rmtInfStrdRfrdDocAmtAdjAmt: [''],
      rmtInfStrdRfrdDocAmtAdjAmtCcy: [''],
      rmtInfStrdRfrdDocAmtAdjCdtDbtInd: [''],
      rmtInfStrdRfrdDocAmtAdjAddtlInf: [''],
      rmtInfStrdRfrdDocAmtRmtdAmt: [''],
      rmtInfStrdRfrdDocAmtRmtdAmtCcy: [''],
      // Strd > CdtrRefInf
      rmtInfStrdCdtrRefCd: ['SCOR'],
      rmtInfStrdCdtrRefPrtry: [''],
      rmtInfStrdCdtrRefIssr: ['ISSUER-REF'],
      rmtInfStrdCdtrRefRef: ['CRED-REF-001'],
      // Strd > Invcr
      rmtInfStrdInvcrNm: ['Invoicer Name'],
      rmtInfStrdInvcrTwnNm: ['Berlin'],
      rmtInfStrdInvcrCtry: ['DE'],
      // Strd > Invcee
      rmtInfStrdInvceeNm: ['Invoicee Name'],
      rmtInfStrdInvceeTwnNm: ['London'],
      rmtInfStrdInvceeCtry: ['GB'],
      // Strd > TaxRmt
      rmtInfStrdTaxRmtCdtrTaxId: ['TX-CDTR-99'],
      rmtInfStrdTaxRmtCdtrRegnId: ['REG-CDTR-99'],
      rmtInfStrdTaxRmtCdtrTaxTp: ['VAT'],
      rmtInfStrdTaxRmtDbtrTaxId: ['TX-DBTR-99'],
      rmtInfStrdTaxRmtDbtrRegnId: ['REG-DBTR-99'],
      rmtInfStrdTaxRmtDbtrTaxTp: ['VAT'],
      rmtInfStrdTaxRmtUltmtDbtrTaxId: ['TX-ULT-99'],
      rmtInfStrdTaxRmtUltmtDbtrRegnId: ['REG-ULT-99'],
      rmtInfStrdTaxRmtUltmtDbtrTaxTp: ['VAT'],
      rmtInfStrdTaxRmtAdmstnZone: ['Zone 1'],
      rmtInfStrdTaxRmtRefNb: ['REF-TAX-99'],
      rmtInfStrdTaxRmtTtlTaxAmt: ['40.00'],
      rmtInfStrdTaxRmtTtlTaxAmtCcy: ['EUR'],
      // Strd > GrnshmtRmt
      rmtInfStrdGrnshmtTpCd: ['G001'],
      rmtInfStrdGrnshmtTpPrtry: [''],
      rmtInfStrdGrnshmtGrnsheeNm: ['Garnishee Name'],
      rmtInfStrdGrnshmtGrnshmtAdmstrNm: ['Administrator Name'],
      rmtInfStrdGrnshmtRefNb: ['REF-GRN-001'],
      rmtInfStrdGrnshmtDt: [this.isoNowDate()],
      rmtInfStrdGrnshmtRmtdAmt: ['50.00'],
      rmtInfStrdGrnshmtRmtdAmtCcy: ['EUR'],
      rmtInfStrdGrnshmtFmlyMdclInsrncInd: ['true'],
      rmtInfStrdGrnshmtMplyeeTermntnInd: ['false'],
      // Strd > AddtlRmtInf
      rmtInfStrdAddtlRmtInf: [''],

      // RltdRmtInf
      rltdRmtInfRmtId: ['RLTD-RMT-001'],
      rltdRmtInfMtd: ['EDIC'],
      rltdRmtInfElctrncAdr: ['remittance@example.com'],
    });
  }

  get transactions(): FormArray {
    return this.form.get('transactions') as FormArray;
  }

  addTransaction() {
    this.transactions.push(this.createTxGroup());
    this.updateTotals();
  }

  removeTransaction(i: number) {
    if (this.transactions.length > 1) {
      this.transactions.removeAt(i);
      this.updateTotals();
    }
  }

  private updateTotals() {
    const count = this.transactions.length;
    let sum = 0;
    this.transactions.controls.forEach(c => sum += (parseFloat(c.get('amount')?.value) || 0));
    this.form.patchValue({ nbOfTxs: count.toString() }, { emitEvent: false });
  }

  isoNow(): string { return new Date().toISOString().split('.')[0] + '+00:00'; }
  isoNowDate(): string { return new Date().toISOString().split('T')[0]; }

  get bicSameWarning(): string | null {
    const from = (this.form.get('fromBic')?.value || '').trim().toUpperCase();
    const to = (this.form.get('toBic')?.value || '').trim().toUpperCase();
    if (!from || !to) return null;
    return from === to
      ? 'Sender BIC and Receiver BIC are identical. The instructing and instructed agents must represent different financial institutions.'
      : null;
  }

  generateXml() {
    if (this.isParsingXml) return;
    const v = this.form.value;

    // ── AppHdr ──
    const frFinInstnId = this.el('BICFI', v.fromBic, 5)
      + (v.fromClrSysCd || v.fromMmbId ? this.tag('ClrSysMmbId',
          (v.fromClrSysCd ? this.tag('ClrSysId', this.el('Cd', v.fromClrSysCd, 7), 6) : '')
          + this.el('MmbId', v.fromMmbId, 6), 5) : '')
      + this.el('LEI', v.fromLei, 5);
    const toFinInstnId = this.el('BICFI', v.toBic, 5)
      + (v.toClrSysCd || v.toMmbId ? this.tag('ClrSysMmbId',
          (v.toClrSysCd ? this.tag('ClrSysId', this.el('Cd', v.toClrSysCd, 7), 6) : '')
          + this.el('MmbId', v.toMmbId, 6), 5) : '')
      + this.el('LEI', v.toLei, 5);

    const bah = this.el('CharSet', v.charSet, 2)
      + this.tag('Fr', this.tag('FIId', this.tag('FinInstnId', frFinInstnId, 4), 3), 2)
      + this.tag('To', this.tag('FIId', this.tag('FinInstnId', toFinInstnId, 4), 3), 2)
      + this.el('BizMsgIdr', v.bizMsgId, 2)
      + this.el('MsgDefIdr', v.msgDefIdr || 'pain.008.001.08', 2)
      + this.el('BizSvc', v.bizSvc, 2)
      + (v.mktPrctcRegy || v.mktPrctcId ? this.tag('MktPrctc', this.el('Regy', v.mktPrctcRegy, 3) + this.el('Id', v.mktPrctcId, 3), 2) : '')
      + this.el('CreDt', v.creDt, 2)
      + this.el('CpyDplct', v.cpyDplct, 2)
      + this.el('PssblDplct', v.pssblDplct, 2)
      + this.el('Prty', v.prty, 2)
      + this.buildRltd(v);

    // ── GrpHdr ──
    const authsn = v.authsnCd || v.authsnPrtry ? this.tag('Authstn', (v.authsnCd ? this.el('Cd', v.authsnCd, 5) : this.el('Prtry', v.authsnPrtry, 5)), 4) : '';
    const initgPtyId = v.initgPtyId ? this.tag('Id', this.tag('OrgId', this.tag('Othr', this.el('Id', v.initgPtyId, 7), 6), 5), 4) : '';
    const fwdgAgt = v.fwdgAgtBic || v.fwdgAgtLei ? this.tag('FwdgAgt', this.tag('FinInstnId',
      this.el('BICFI', v.fwdgAgtBic, 6)
      + (v.fwdgAgtClrSysCd || v.fwdgAgtMmbId ? this.tag('ClrSysMmbId', (v.fwdgAgtClrSysCd ? this.tag('ClrSysId', this.el('Cd', v.fwdgAgtClrSysCd, 8), 7) : '') + this.el('MmbId', v.fwdgAgtMmbId, 7), 6) : '')
      + this.el('LEI', v.fwdgAgtLei, 6), 5), 4) : '';

    // InitgPty PstlAdr
    const initgPtyAddr = this.buildAddr(v, 'initgPty', 5);
    const grpHdr = this.tag('GrpHdr',
      this.el('MsgId', v.msgId, 4)
      + this.el('CreDtTm', v.creDtTm, 4)
      + authsn
      + this.el('NbOfTxs', v.nbOfTxs, 4)
      + this.tag('InitgPty', this.el('Nm', v.initgPtyName, 5) + initgPtyAddr + initgPtyId + this.el('CtryOfRes', v.initgPtyCtryOfRes, 5), 4)
      + fwdgAgt, 3);

    // ── PmtInf level Creditor & CdtrAgt ──
    const cdtrAcctId = v.cdtrIban ? this.tag('Id', this.el('IBAN', v.cdtrIban, 6), 5) :
      (v.cdtrAcctOthrId ? this.tag('Id', this.tag('Othr', this.el('Id', v.cdtrAcctOthrId, 7), 6), 5) : '');
    const cdtrAcct = cdtrAcctId ? this.tag('CdtrAcct',
      cdtrAcctId + this.el('Ccy', v.cdtrAcctCcy, 5) + this.el('Nm', v.cdtrAcctNm, 5)
      + (v.cdtrAcctTpCd ? this.tag('Tp', this.el('Cd', v.cdtrAcctTpCd, 6), 5) : ''), 4) : '';

    const cdtrAgt = v.cdtrAgtBic || v.cdtrAgtLei ? this.tag('CdtrAgt', this.tag('FinInstnId',
      this.el('BICFI', v.cdtrAgtBic, 6)
      + (v.cdtrAgtClrSysCd || v.cdtrAgtMmbId ? this.tag('ClrSysMmbId', (v.cdtrAgtClrSysCd ? this.tag('ClrSysId', this.el('Cd', v.cdtrAgtClrSysCd, 8), 7) : '') + this.el('MmbId', v.cdtrAgtMmbId, 7), 6) : '')
      + this.el('LEI', v.cdtrAgtLei, 6), 5)
      + this.el('Nm', v.cdtrAgtNm, 5), 4) : '';

    const cdtrAgtAcct = v.cdtrAgtAcctIban || v.cdtrAgtAcctOthrId ? this.tag('CdtrAgtAcct', this.tag('Id',
      v.cdtrAgtAcctIban ? this.el('IBAN', v.cdtrAgtAcctIban, 6) : this.tag('Othr', this.el('Id', v.cdtrAgtAcctOthrId, 7), 6), 5)
      + this.el('Ccy', v.cdtrAgtAcctCcy, 5), 4) : '';

    const chrgsAcct = v.chrgsAcctIban || v.chrgsAcctOthrId ? this.tag('ChrgsAcct', this.tag('Id',
      this.el('IBAN', v.chrgsAcctIban, 6) + (v.chrgsAcctOthrId ? this.tag('Othr', this.el('Id', v.chrgsAcctOthrId, 7), 6) : ''), 5)
      + this.el('Ccy', v.chrgsAcctCcy, 5), 4) : '';

    const chrgsAcctAgt = v.chrgsAcctAgtBic ? this.tag('ChrgsAcctAgt', this.tag('FinInstnId',
      this.el('BICFI', v.chrgsAcctAgtBic, 6)
      + this.el('LEI', v.chrgsAcctAgtLei, 6), 5), 4) : '';

    // ── Transactions (DrctDbtTxInf) ──
    let txsXml = '';
    v.transactions.forEach((tx: any) => {
      const amt = this.formatting.formatAmount(tx.amount || 0, tx.currency);
      const pmtId = this.tag('PmtId', this.el('InstrId', tx.instrId, 6) + this.el('EndToEndId', tx.endToEndId, 6) + this.el('UETR', tx.uetr, 6), 5);

      const pmtTpInf = (tx.instrPrty || tx.svcLvlCd || tx.svcLvlPrtry || tx.lclInstrmCd || tx.lclInstrmPrtry || tx.seqTp || tx.ctgyPurpCd || tx.ctgyPurpPrtry) ?
        this.tag('PmtTpInf',
          this.el('InstrPrty', tx.instrPrty, 6)
          + (tx.svcLvlCd || tx.svcLvlPrtry ? this.tag('SvcLvl', this.el('Cd', tx.svcLvlCd, 7) + this.el('Prtry', tx.svcLvlPrtry, 7), 6) : '')
          + (tx.lclInstrmCd || tx.lclInstrmPrtry ? this.tag('LclInstrm', this.el('Cd', tx.lclInstrmCd, 7) + this.el('Prtry', tx.lclInstrmPrtry, 7), 6) : '')
          + this.el('SeqTp', tx.seqTp, 6)
          + (tx.ctgyPurpCd || tx.ctgyPurpPrtry ? this.tag('CtgyPurp', this.el('Cd', tx.ctgyPurpCd, 7) + this.el('Prtry', tx.ctgyPurpPrtry, 7), 6) : ''), 5) : '';

      const instdAmt = `${this.tabs(5)}<InstdAmt Ccy="${this.e(tx.currency)}">${amt}</InstdAmt>\n`;

      // MndtRltdInf
      const amdmntInfDtls = tx.orgnlMndtId || tx.orgnlCdtrSchmeIdNm || tx.orgnlCdtrAgtBic || tx.orgnlDbtrNm || tx.orgnlDbtrAcctIban || tx.orgnlDbtrAgtBic || tx.orgnlFnlColltnDt || tx.orgnlFrqcyTp || tx.orgnlRsnCd || tx.orgnlRsnPrtry || tx.orgnlTrckgDays ?
        this.tag('AmdmntInfDtls',
          this.el('OrgnlMndtId', tx.orgnlMndtId, 8)
          + (tx.orgnlCdtrSchmeIdNm || tx.orgnlCdtrSchmeIdBic ? this.tag('OrgnlCdtrSchmeId', this.el('Nm', tx.orgnlCdtrSchmeIdNm, 9)
            + (tx.orgnlCdtrSchmeIdBic ? this.tag('Id', this.tag('OrgId', this.el('AnyBIC', tx.orgnlCdtrSchmeIdBic, 11), 10), 9) : ''), 8) : '')
          + (tx.orgnlCdtrAgtBic ? this.tag('OrgnlCdtrAgt', this.tag('FinInstnId', this.el('BICFI', tx.orgnlCdtrAgtBic, 10), 9), 8) : '')
          + (tx.orgnlDbtrNm ? this.tag('OrgnlDbtr', this.el('Nm', tx.orgnlDbtrNm, 9), 8) : '')
          + (tx.orgnlDbtrAcctIban ? this.tag('OrgnlDbtrAcct', this.tag('Id', this.el('IBAN', tx.orgnlDbtrAcctIban, 10), 9), 8) : '')
          + (tx.orgnlDbtrAgtBic ? this.tag('OrgnlDbtrAgt', this.tag('FinInstnId', this.el('BICFI', tx.orgnlDbtrAgtBic, 10), 9), 8) : '')
          + this.el('OrgnlFnlColltnDt', tx.orgnlFnlColltnDt, 8)
          + (tx.orgnlFrqcyTp ? this.tag('OrgnlFrqcy', this.el('Tp', tx.orgnlFrqcyTp, 9), 8) : '')
          + (tx.orgnlRsnCd || tx.orgnlRsnPrtry ? this.tag('OrgnlRsn', this.el('Cd', tx.orgnlRsnCd, 9) + this.el('Prtry', tx.orgnlRsnPrtry, 9), 8) : '')
          + this.el('OrgnlTrckgDays', tx.orgnlTrckgDays, 8), 7) : '';
      const frqcy = tx.frqcyTp ? (tx.frqcyPrdTp ? this.tag('Frqcy', this.tag('Prd', this.el('Tp', tx.frqcyPrdTp, 9) + this.el('CntPerPrd', tx.frqcyPrdCntPerPrd, 9), 8), 7) : this.tag('Frqcy', this.tag('Tp', this.el('Cd', tx.frqcyTp, 10), 9), 7)) : '';
      const rsn = tx.rsnCd || tx.rsnPrtry ? this.tag('Rsn', (tx.rsnCd ? this.el('Cd', tx.rsnCd, 8) : this.el('Prtry', tx.rsnPrtry, 8)), 7) : '';

      const mndtRltdInf = this.tag('MndtRltdInf',
        this.el('MndtId', tx.mndtId, 7)
        + this.el('DtOfSgntr', tx.dtOfSgntr, 7)
        + this.el('AmdmntInd', tx.amdmntInd, 7)
        + amdmntInfDtls
        + this.el('ElctrncSgntr', tx.elctrncSgntr, 7)
        + this.el('FrstColltnDt', tx.frstColltnDt, 7)
        + this.el('FnlColltnDt', tx.fnlColltnDt, 7)
        + frqcy + rsn
        + this.el('TrckgDays', tx.trckgDays, 7), 6);

      // CdtrSchmeId
      const cdtrSchmeId = tx.cdtrSchmeIdNm || tx.cdtrSchmeIdOthrId ? this.tag('CdtrSchmeId',
        this.el('Nm', tx.cdtrSchmeIdNm, 7)
        + (tx.cdtrSchmeIdOthrId ? this.tag('Id', this.tag('PrvtId', this.tag('Othr',
          this.el('Id', tx.cdtrSchmeIdOthrId, 10)
          + (tx.cdtrSchmeIdOthrSchmeNmCd || tx.cdtrSchmeIdOthrSchmeNmPrtry ? this.tag('SchmeNm', this.el('Cd', tx.cdtrSchmeIdOthrSchmeNmCd, 11) + this.el('Prtry', tx.cdtrSchmeIdOthrSchmeNmPrtry, 11), 10) : '')
          + this.el('Issr', tx.cdtrSchmeIdOthrIssr, 10), 9), 8), 7) : ''), 6) : '';

      const drctDbtTx = this.tag('DrctDbtTx', mndtRltdInf + cdtrSchmeId
        + this.el('PreNtfctnId', tx.preNtfctnId, 6)
        + this.el('PreNtfctnDt', tx.preNtfctnDt, 6), 5);

      const ultmtCdtr = tx.ultmtCdtrName ? this.tag('UltmtCdtr', this.el('Nm', tx.ultmtCdtrName, 6), 5) : '';

      // DbtrAgt
      const dbtrAgt = tx.dbtrAgtBic || tx.dbtrAgtLei ? this.tag('DbtrAgt', this.tag('FinInstnId',
        this.el('BICFI', tx.dbtrAgtBic, 7)
        + (tx.dbtrAgtClrSysCd || tx.dbtrAgtMmbId ? this.tag('ClrSysMmbId', (tx.dbtrAgtClrSysCd ? this.tag('ClrSysId', this.el('Cd', tx.dbtrAgtClrSysCd, 9), 8) : '') + this.el('MmbId', tx.dbtrAgtMmbId, 8), 7) : '')
        + this.el('LEI', tx.dbtrAgtLei, 7), 6), 5) : '';

      const dbtrAgtAcct = tx.dbtrAgtAcctIban || tx.dbtrAgtAcctOthrId ? this.tag('DbtrAgtAcct', this.tag('Id',
        tx.dbtrAgtAcctIban ? this.el('IBAN', tx.dbtrAgtAcctIban, 7) : this.tag('Othr', this.el('Id', tx.dbtrAgtAcctOthrId, 8), 7), 6), 5) : '';

      // Dbtr
      const dbtrId = tx.dbtrOrgIdAnyBic || tx.dbtrOrgIdLei || tx.dbtrOrgIdOthrId || tx.dbtrPrvtIdBirthDt || tx.dbtrPrvtIdOthrId ?
        this.tag('Id',
          (tx.dbtrOrgIdAnyBic || tx.dbtrOrgIdLei || tx.dbtrOrgIdOthrId ? this.tag('OrgId',
            this.el('AnyBIC', tx.dbtrOrgIdAnyBic, 8) + this.el('LEI', tx.dbtrOrgIdLei, 8)
            + (tx.dbtrOrgIdOthrId ? this.tag('Othr', this.el('Id', tx.dbtrOrgIdOthrId, 9) + (tx.dbtrOrgIdOthrSchmeNmCd ? this.tag('SchmeNm', this.el('Cd', tx.dbtrOrgIdOthrSchmeNmCd, 11), 10) : '') + this.el('Issr', tx.dbtrOrgIdOthrIssr, 9), 8) : ''), 7) :
          (tx.dbtrPrvtIdBirthDt || tx.dbtrPrvtIdOthrId ? this.tag('PrvtId',
            (tx.dbtrPrvtIdBirthDt ? this.tag('DtAndPlcOfBirth', this.el('BirthDt', tx.dbtrPrvtIdBirthDt, 9) + this.el('CityOfBirth', tx.dbtrPrvtIdCityOfBirth, 9) + this.el('CtryOfBirth', tx.dbtrPrvtIdCtryOfBirth, 9), 8) : '')
            + (tx.dbtrPrvtIdOthrId ? this.tag('Othr', this.el('Id', tx.dbtrPrvtIdOthrId, 9) + (tx.dbtrPrvtIdOthrSchmeNmCd ? this.tag('SchmeNm', this.el('Cd', tx.dbtrPrvtIdOthrSchmeNmCd, 11), 10) : '') + this.el('Issr', tx.dbtrPrvtIdOthrIssr, 9), 8) : ''), 7) : '')), 6) : '';

      const dbtr = this.tag('Dbtr', this.el('Nm', tx.dbtrName, 6) + this.buildAddr(tx, 'dbtr', 6) + dbtrId + this.el('CtryOfRes', tx.dbtrCtryOfRes, 6), 5);

      // DbtrAcct
      const dbtrAcctId = tx.dbtrIban ? this.tag('Id', this.el('IBAN', tx.dbtrIban, 7), 6) :
        (tx.dbtrAcctOthrId ? this.tag('Id', this.tag('Othr', this.el('Id', tx.dbtrAcctOthrId, 8), 7), 6) : '');
      const dbtrAcct = dbtrAcctId ? this.tag('DbtrAcct', dbtrAcctId
        + (tx.dbtrAcctTpCd ? this.tag('Tp', (tx.dbtrAcctTpCd.length <= 4 ? this.el('Cd', tx.dbtrAcctTpCd, 7) : this.el('Prtry', tx.dbtrAcctTpCd, 7)), 6) : '')
        + this.el('Ccy', tx.dbtrAcctCcy, 6) + this.el('Nm', tx.dbtrAcctNm, 6), 5) : '';

      const ultmtDbtr = tx.ultmtDbtrName ? this.tag('UltmtDbtr', this.el('Nm', tx.ultmtDbtrName, 6), 5) : '';

      const purp = tx.purpCd || tx.purpPrtry ? this.tag('Purp', this.el('Cd', tx.purpCd, 6) + this.el('Prtry', tx.purpPrtry, 6), 5) : '';

      // RgltryRptg
      const rgltryRptg = tx.rgltryRptgInd || tx.rgltryRptgAuthrtyNm || tx.rgltryRptgDtlsCd ?
        this.tag('RgltryRptg',
          this.el('DbtCdtRptgInd', tx.rgltryRptgInd, 6)
          + (tx.rgltryRptgAuthrtyNm || tx.rgltryRptgAuthrtyCtry ? this.tag('Authrty', this.el('Nm', tx.rgltryRptgAuthrtyNm, 7) + this.el('Ctry', tx.rgltryRptgAuthrtyCtry, 7), 6) : '')
          + (tx.rgltryRptgDtlsTp || tx.rgltryRptgDtlsCd || tx.rgltryRptgDtlsCtry || tx.rgltryRptgDtlsInf || tx.rgltryRptgDtlsDt || tx.rgltryRptgDtlsAmt ?
            this.tag('Dtls', this.el('Tp', tx.rgltryRptgDtlsTp, 7) + this.el('Dt', tx.rgltryRptgDtlsDt, 7) + this.el('Ctry', tx.rgltryRptgDtlsCtry, 7) + (tx.rgltryRptgDtlsCd ? this.el('Cd', tx.rgltryRptgDtlsCd, 7) : '')
            + (tx.rgltryRptgDtlsAmt ? `${this.tabs(7)}<Amt Ccy="${this.e(tx.rgltryRptgDtlsAmtCcy || 'EUR')}">${this.e(tx.rgltryRptgDtlsAmt)}</Amt>\n` : '')
            + this.el('Inf', tx.rgltryRptgDtlsInf, 7), 6) : ''), 5) : '';

      // Tax
      const tax = tx.taxCdtrTaxId || tx.taxDbtrTaxId || tx.taxRefNb || tx.taxTtlTaxAmt || tx.taxAuthsnTitl ?
        this.tag('Tax',
          (tx.taxCdtrTaxId || tx.taxCdtrRegnId || tx.taxCdtrTaxTp ? this.tag('Cdtr', this.el('TaxId', tx.taxCdtrTaxId, 7) + this.el('RegnId', tx.taxCdtrRegnId, 7) + this.el('TaxTp', tx.taxCdtrTaxTp, 7), 6) : '')
          + (tx.taxDbtrTaxId || tx.taxDbtrRegnId || tx.taxDbtrTaxTp ? this.tag('Dbtr', this.el('TaxId', tx.taxDbtrTaxId, 7) + this.el('RegnId', tx.taxDbtrRegnId, 7) + this.el('TaxTp', tx.taxDbtrTaxTp, 7), 6) : '')
          + this.el('AdmstnZone', tx.taxAdmstnZone, 6)
          + this.el('RefNb', tx.taxRefNb, 6) + this.el('Mtd', tx.taxMtd, 6)
          + (tx.taxTtlTaxblBaseAmt ? `${this.tabs(6)}<TtlTaxblBaseAmt Ccy="${this.e(tx.taxTtlTaxblBaseAmtCcy || 'EUR')}">${this.e(tx.taxTtlTaxblBaseAmt)}</TtlTaxblBaseAmt>\n` : '')
          + (tx.taxTtlTaxAmt ? `${this.tabs(6)}<TtlTaxAmt Ccy="${this.e(tx.taxTtlTaxAmtCcy || 'EUR')}">${this.e(tx.taxTtlTaxAmt)}</TtlTaxAmt>\n` : '')
          + this.el('Dt', tx.taxDt, 6) + this.el('SeqNb', tx.taxSeqNb, 6), 5) : '';

      // RltdRmtInf
      const rltdRmt = tx.rltdRmtInfRmtId || tx.rltdRmtInfMtd ? this.tag('RltdRmtInf',
        this.el('RmtId', tx.rltdRmtInfRmtId, 6)
        + (tx.rltdRmtInfMtd || tx.rltdRmtInfElctrncAdr ? this.tag('RmtLctnDtls', this.el('Mtd', tx.rltdRmtInfMtd, 7) + this.el('ElctrncAdr', tx.rltdRmtInfElctrncAdr, 7), 6) : ''), 5) : '';

      // RmtInf - Full Structured section
      let rmtInfContent = this.el('Ustrd', tx.rmtInfUstrd, 6);
      const hasStrd = tx.rmtInfStrdRfrdDocCd || tx.rmtInfStrdRfrdDocNb || tx.rmtInfStrdCdtrRefCd || tx.rmtInfStrdCdtrRefRef
        || tx.rmtInfStrdInvcrNm || tx.rmtInfStrdInvceeNm || tx.rmtInfStrdTaxRmtCdtrTaxId || tx.rmtInfStrdTaxRmtRefNb
        || tx.rmtInfStrdGrnshmtTpCd || tx.rmtInfStrdGrnshmtGrnsheeNm || tx.rmtInfStrdAddtlRmtInf
        || tx.rmtInfStrdRfrdDocAmtDuePyblAmt || tx.rmtInfStrdRfrdDocAmtRmtdAmt;
      if (hasStrd) {
        let strd = '';
        // RfrdDocInf
        if (tx.rmtInfStrdRfrdDocCd || tx.rmtInfStrdRfrdDocPrtry || tx.rmtInfStrdRfrdDocNb) {
          let rfrdLineDtls = '';
          if (tx.rmtInfStrdRfrdDocLineDtlsDesc || tx.rmtInfStrdRfrdDocLineDtlsDuePyblAmt || tx.rmtInfStrdRfrdDocLineDtlsRmtdAmt) {
            let lineAmt = '';
            if (tx.rmtInfStrdRfrdDocLineDtlsDuePyblAmt) lineAmt += `${this.tabs(9)}<DuePyblAmt Ccy="${this.e(tx.rmtInfStrdRfrdDocLineDtlsDuePyblAmtCcy || 'EUR')}">${this.e(tx.rmtInfStrdRfrdDocLineDtlsDuePyblAmt)}</DuePyblAmt>\n`;
            if (tx.rmtInfStrdRfrdDocLineDtlsCdtNoteAmt) lineAmt += `${this.tabs(9)}<CdtNoteAmt Ccy="${this.e(tx.rmtInfStrdRfrdDocLineDtlsCdtNoteAmtCcy || 'EUR')}">${this.e(tx.rmtInfStrdRfrdDocLineDtlsCdtNoteAmt)}</CdtNoteAmt>\n`;
            if (tx.rmtInfStrdRfrdDocLineDtlsRmtdAmt) lineAmt += `${this.tabs(9)}<RmtdAmt Ccy="${this.e(tx.rmtInfStrdRfrdDocLineDtlsRmtdAmtCcy || 'EUR')}">${this.e(tx.rmtInfStrdRfrdDocLineDtlsRmtdAmt)}</RmtdAmt>\n`;
            rfrdLineDtls = this.tag('LineDtls', this.el('Desc', tx.rmtInfStrdRfrdDocLineDtlsDesc, 8) + (lineAmt ? this.tag('Amt', lineAmt, 8) : ''), 7);
          }
          strd += this.tag('RfrdDocInf',
            this.tag('Tp', (tx.rmtInfStrdRfrdDocCd ? this.tag('CdOrPrtry', this.el('Cd', tx.rmtInfStrdRfrdDocCd, 9), 8) : this.tag('CdOrPrtry', this.el('Prtry', tx.rmtInfStrdRfrdDocPrtry, 9), 8)) + this.el('Issr', tx.rmtInfStrdRfrdDocIssr, 8), 7)
            + this.el('Nb', tx.rmtInfStrdRfrdDocNb, 7) + (tx.rmtInfStrdRfrdDocRltdDt ? this.tag('RltdDt', this.tag('Tp', this.el('Cd', 'ISDT', 9), 8) + this.el('Dt', tx.rmtInfStrdRfrdDocRltdDt, 8), 7) : '') + rfrdLineDtls, 6);
        }
        // RfrdDocAmt
        if (tx.rmtInfStrdRfrdDocAmtDuePyblAmt || tx.rmtInfStrdRfrdDocAmtCdtNoteAmt || tx.rmtInfStrdRfrdDocAmtRmtdAmt || tx.rmtInfStrdRfrdDocAmtDscntApldAmt || tx.rmtInfStrdRfrdDocAmtTaxAmt || tx.rmtInfStrdRfrdDocAmtAdjAmt) {
          let rda = '';
          if (tx.rmtInfStrdRfrdDocAmtDuePyblAmt) rda += `${this.tabs(7)}<DuePyblAmt Ccy="${this.e(tx.rmtInfStrdRfrdDocAmtDuePyblAmtCcy || 'EUR')}">${this.e(tx.rmtInfStrdRfrdDocAmtDuePyblAmt)}</DuePyblAmt>\n`;
          if (tx.rmtInfStrdRfrdDocAmtDscntApldAmt) rda += this.tag('DscntApldAmt', (tx.rmtInfStrdRfrdDocAmtDscntApldAmtTpCd ? this.tag('Tp', this.el('Cd', tx.rmtInfStrdRfrdDocAmtDscntApldAmtTpCd, 9), 8) : '') + `${this.tabs(8)}<Amt Ccy="${this.e(tx.rmtInfStrdRfrdDocAmtDscntApldAmtCcy || 'EUR')}">${this.e(tx.rmtInfStrdRfrdDocAmtDscntApldAmt)}</Amt>\n`, 7);
          if (tx.rmtInfStrdRfrdDocAmtCdtNoteAmt) rda += `${this.tabs(7)}<CdtNoteAmt Ccy="${this.e(tx.rmtInfStrdRfrdDocAmtCdtNoteAmtCcy || 'EUR')}">${this.e(tx.rmtInfStrdRfrdDocAmtCdtNoteAmt)}</CdtNoteAmt>\n`;
          if (tx.rmtInfStrdRfrdDocAmtTaxAmt) rda += this.tag('TaxAmt', (tx.rmtInfStrdRfrdDocAmtTaxAmtTpCd ? this.tag('Tp', this.el('Cd', tx.rmtInfStrdRfrdDocAmtTaxAmtTpCd, 9), 8) : '') + `${this.tabs(8)}<Amt Ccy="${this.e(tx.rmtInfStrdRfrdDocAmtTaxAmtCcy || 'EUR')}">${this.e(tx.rmtInfStrdRfrdDocAmtTaxAmt)}</Amt>\n`, 7);
          if (tx.rmtInfStrdRfrdDocAmtAdjAmt) rda += this.tag('AdjstmntAmtAndRsn', `${this.tabs(8)}<Amt Ccy="${this.e(tx.rmtInfStrdRfrdDocAmtAdjAmtCcy || 'EUR')}">${this.e(tx.rmtInfStrdRfrdDocAmtAdjAmt)}</Amt>\n` + this.el('CdtDbtInd', tx.rmtInfStrdRfrdDocAmtAdjCdtDbtInd, 8) + this.el('Rsn', tx.rmtInfStrdRfrdDocAmtAdjRsn, 8) + this.el('AddtlInf', tx.rmtInfStrdRfrdDocAmtAdjAddtlInf, 8), 7);
          if (tx.rmtInfStrdRfrdDocAmtRmtdAmt) rda += `${this.tabs(7)}<RmtdAmt Ccy="${this.e(tx.rmtInfStrdRfrdDocAmtRmtdAmtCcy || 'EUR')}">${this.e(tx.rmtInfStrdRfrdDocAmtRmtdAmt)}</RmtdAmt>\n`;
          strd += this.tag('RfrdDocAmt', rda, 6);
        }
        // CdtrRefInf
        if (tx.rmtInfStrdCdtrRefCd || tx.rmtInfStrdCdtrRefPrtry || tx.rmtInfStrdCdtrRefRef) {
          strd += this.tag('CdtrRefInf', this.tag('Tp', (tx.rmtInfStrdCdtrRefCd ? this.tag('CdOrPrtry', this.el('Cd', tx.rmtInfStrdCdtrRefCd, 9), 8) : this.tag('CdOrPrtry', this.el('Prtry', tx.rmtInfStrdCdtrRefPrtry, 9), 8)) + this.el('Issr', tx.rmtInfStrdCdtrRefIssr, 8), 7) + this.el('Ref', tx.rmtInfStrdCdtrRefRef, 7), 6);
        }
        // Invcr
        if (tx.rmtInfStrdInvcrNm) {
          strd += this.tag('Invcr', this.el('Nm', tx.rmtInfStrdInvcrNm, 7) + this.tag('PstlAdr', this.el('TwnNm', tx.rmtInfStrdInvcrTwnNm || 'Default Town', 8) + this.el('Ctry', tx.rmtInfStrdInvcrCtry || 'US', 8), 7), 6);
        }
        // Invcee
        if (tx.rmtInfStrdInvceeNm) {
          strd += this.tag('Invcee', this.el('Nm', tx.rmtInfStrdInvceeNm, 7) + this.tag('PstlAdr', this.el('TwnNm', tx.rmtInfStrdInvceeTwnNm || 'Default Town', 8) + this.el('Ctry', tx.rmtInfStrdInvceeCtry || 'US', 8), 7), 6);
        }
        // TaxRmt
        if (tx.rmtInfStrdTaxRmtCdtrTaxId || tx.rmtInfStrdTaxRmtDbtrTaxId || tx.rmtInfStrdTaxRmtRefNb || tx.rmtInfStrdTaxRmtUltmtDbtrTaxId) {
          strd += this.tag('TaxRmt',
            (tx.rmtInfStrdTaxRmtCdtrTaxId || tx.rmtInfStrdTaxRmtCdtrRegnId ? this.tag('Cdtr', this.el('TaxId', tx.rmtInfStrdTaxRmtCdtrTaxId, 8) + this.el('RegnId', tx.rmtInfStrdTaxRmtCdtrRegnId, 8) + this.el('TaxTp', tx.rmtInfStrdTaxRmtCdtrTaxTp, 8), 7) : '')
            + (tx.rmtInfStrdTaxRmtDbtrTaxId || tx.rmtInfStrdTaxRmtDbtrRegnId ? this.tag('Dbtr', this.el('TaxId', tx.rmtInfStrdTaxRmtDbtrTaxId, 8) + this.el('RegnId', tx.rmtInfStrdTaxRmtDbtrRegnId, 8) + this.el('TaxTp', tx.rmtInfStrdTaxRmtDbtrTaxTp, 8), 7) : '')
            + (tx.rmtInfStrdTaxRmtUltmtDbtrTaxId ? this.tag('UltmtDbtr', this.el('TaxId', tx.rmtInfStrdTaxRmtUltmtDbtrTaxId, 8) + this.el('RegnId', tx.rmtInfStrdTaxRmtUltmtDbtrRegnId, 8) + this.el('TaxTp', tx.rmtInfStrdTaxRmtUltmtDbtrTaxTp, 8), 7) : '')
            + this.el('AdmstnZone', tx.rmtInfStrdTaxRmtAdmstnZone, 7) + this.el('RefNb', tx.rmtInfStrdTaxRmtRefNb, 7)
            + (tx.rmtInfStrdTaxRmtTtlTaxAmt ? `${this.tabs(7)}<TtlTaxAmt Ccy="${this.e(tx.rmtInfStrdTaxRmtTtlTaxAmtCcy || 'EUR')}">${this.e(tx.rmtInfStrdTaxRmtTtlTaxAmt)}</TtlTaxAmt>\n` : ''), 6);
        }
        // GrnshmtRmt
        if (tx.rmtInfStrdGrnshmtTpCd || tx.rmtInfStrdGrnshmtGrnsheeNm || tx.rmtInfStrdGrnshmtGrnshmtAdmstrNm || tx.rmtInfStrdGrnshmtRefNb) {
          strd += this.tag('GrnshmtRmt',
            (tx.rmtInfStrdGrnshmtTpCd || tx.rmtInfStrdGrnshmtTpPrtry ? this.tag('Tp', (tx.rmtInfStrdGrnshmtTpCd ? this.tag('CdOrPrtry', this.el('Cd', tx.rmtInfStrdGrnshmtTpCd, 10), 9) : this.tag('CdOrPrtry', this.el('Prtry', tx.rmtInfStrdGrnshmtTpPrtry, 10), 9)), 7) : '')
            + (tx.rmtInfStrdGrnshmtGrnsheeNm ? this.tag('Grnshee', this.el('Nm', tx.rmtInfStrdGrnshmtGrnsheeNm, 8), 7) : '')
            + (tx.rmtInfStrdGrnshmtGrnshmtAdmstrNm ? this.tag('GrnshmtAdmstr', this.el('Nm', tx.rmtInfStrdGrnshmtGrnshmtAdmstrNm, 8), 7) : '')
            + this.el('RefNb', tx.rmtInfStrdGrnshmtRefNb, 7) + this.el('Dt', tx.rmtInfStrdGrnshmtDt, 7)
            + (tx.rmtInfStrdGrnshmtRmtdAmt ? `${this.tabs(7)}<RmtdAmt Ccy="${this.e(tx.rmtInfStrdGrnshmtRmtdAmtCcy || 'EUR')}">${this.e(tx.rmtInfStrdGrnshmtRmtdAmt)}</RmtdAmt>\n` : '')
            + this.el('FmlyMdclInsrncInd', tx.rmtInfStrdGrnshmtFmlyMdclInsrncInd, 7)
            + this.el('MplyeeTermntnInd', tx.rmtInfStrdGrnshmtMplyeeTermntnInd, 7), 6);
        }
        strd += this.el('AddtlRmtInf', tx.rmtInfStrdAddtlRmtInf, 6);
        rmtInfContent += this.tag('Strd', strd, 5);
      }
      const rmtInf = rmtInfContent.trim() ? this.tag('RmtInf', rmtInfContent, 5) : '';

      txsXml += this.tag('DrctDbtTxInf',
        pmtId + pmtTpInf + instdAmt + this.el('ChrgBr', tx.chrgBr, 5)
        + drctDbtTx + ultmtCdtr + dbtrAgt + dbtrAgtAcct + dbtr + dbtrAcct + ultmtDbtr
        + this.el('InstrForCdtrAgt', tx.instrForCdtrAgt, 5)
        + purp + rgltryRptg + tax + rltdRmt + rmtInf, 4);
    });

    const cdtrAddr = this.buildAddr(v, 'cdtr', 5);
    const cdtrAgtAcctTag = v.cdtrAgtAcctIban || v.cdtrAgtAcctOthrId ? this.tag('CdtrAgtAcct', this.tag('Id',
      v.cdtrAgtAcctIban ? this.el('IBAN', v.cdtrAgtAcctIban, 6) : this.tag('Othr', this.el('Id', v.cdtrAgtAcctOthrId, 7), 6), 5), 4) : '';
    const pmtInf = this.tag('PmtInf',
      this.el('PmtInfId', v.pmtInfId, 4)
      + this.el('PmtMtd', v.pmtMtd, 4)
      + this.el('BtchBookg', v.btchBookg, 4)
      + this.el('ReqdColltnDt', v.reqdColltnDt, 4)
      + this.tag('Cdtr', this.el('Nm', v.cdtrName, 5) + cdtrAddr + this.el('CtryOfRes', v.cdtrCtryOfRes, 5), 4)
      + cdtrAcct + cdtrAgt + cdtrAgtAcctTag + chrgsAcct + chrgsAcctAgt
      + txsXml, 3);

    this.generatedXml = `<?xml version="1.0" encoding="UTF-8"?>
<BusMsgEnvlp xmlns="urn:swift:xsd:envelope">
\t<AppHdr xmlns="urn:iso:std:iso:20022:tech:xsd:head.001.001.02">
${bah}\t</AppHdr>
\t<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pain.008.001.08">
\t\t<CstmrDrctDbtInitn>
${grpHdr}${pmtInf}\t\t</CstmrDrctDbtInitn>
\t</Document>
</BusMsgEnvlp>`;

    this.onEditorChange(this.generatedXml, true);
  }

  // XML Helpers
  private e(v: any): string {
    if (v === null || v === undefined || v === '') return '';
    return v.toString().replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  private tabs(n: number): string { return '\t'.repeat(n); }
  private el(tag: string, val: any, indent: number): string {
    if (val === undefined || val === null || val === '') return '';
    return `${this.tabs(indent)}<${tag}>${this.e(val)}</${tag}>\n`;
  }
  private tag(tag: string, content: string, indent: number): string {
    if (!content || !content.trim()) return '';
    return `${this.tabs(indent)}<${tag}>\n${content}${this.tabs(indent)}</${tag}>\n`;
  }

  private buildAddr(v: any, prefix: string, indent: number): string {
    const type = v[prefix + 'AddrType']; if (!type || type === 'none') return '';
    const lines: string[] = []; const t = this.tabs(indent + 1);
    if (type === 'structured' || type === 'hybrid') {
      if (v[prefix + 'Dept']) lines.push(`${t}<Dept>${this.e(v[prefix + 'Dept'])}</Dept>`);
      if (v[prefix + 'SubDept']) lines.push(`${t}<SubDept>${this.e(v[prefix + 'SubDept'])}</SubDept>`);
      if (v[prefix + 'StrtNm']) lines.push(`${t}<StrtNm>${this.e(v[prefix + 'StrtNm'])}</StrtNm>`);
      if (v[prefix + 'BldgNb']) lines.push(`${t}<BldgNb>${this.e(v[prefix + 'BldgNb'])}</BldgNb>`);
      if (v[prefix + 'BldgNm']) lines.push(`${t}<BldgNm>${this.e(v[prefix + 'BldgNm'])}</BldgNm>`);
      if (v[prefix + 'Flr']) lines.push(`${t}<Flr>${this.e(v[prefix + 'Flr'])}</Flr>`);
      if (v[prefix + 'PstBx']) lines.push(`${t}<PstBx>${this.e(v[prefix + 'PstBx'])}</PstBx>`);
      if (v[prefix + 'Room']) lines.push(`${t}<Room>${this.e(v[prefix + 'Room'])}</Room>`);
      if (v[prefix + 'PstCd']) lines.push(`${t}<PstCd>${this.e(v[prefix + 'PstCd'])}</PstCd>`);
      if (v[prefix + 'TwnLctnNm']) lines.push(`${t}<TwnLctnNm>${this.e(v[prefix + 'TwnLctnNm'])}</TwnLctnNm>`);
      if (v[prefix + 'DstrctNm']) lines.push(`${t}<DstrctNm>${this.e(v[prefix + 'DstrctNm'])}</DstrctNm>`);
      if (v[prefix + 'CtrySubDvsn']) lines.push(`${t}<CtrySubDvsn>${this.e(v[prefix + 'CtrySubDvsn'])}</CtrySubDvsn>`);
    }
    if (v[prefix + 'TwnNm']) lines.push(`${t}<TwnNm>${this.e(v[prefix + 'TwnNm'])}</TwnNm>`);
    if (v[prefix + 'Ctry']) lines.push(`${t}<Ctry>${this.e(v[prefix + 'Ctry'])}</Ctry>`);
    if (type === 'unstructured' || type === 'hybrid') {
      if (v[prefix + 'AdrLine1']) lines.push(`${t}<AdrLine>${this.e(v[prefix + 'AdrLine1'])}</AdrLine>`);
      if (v[prefix + 'AdrLine2']) lines.push(`${t}<AdrLine>${this.e(v[prefix + 'AdrLine2'])}</AdrLine>`);
    }
    if (!lines.length) return '';
    return `${this.tabs(indent)}<PstlAdr>\n${lines.join('\n')}\n${this.tabs(indent)}</PstlAdr>\n`;
  }

  private buildRltd(v: any): string {
    const hasRltd = v.rltdFrBic || v.rltdToBic || v.rltdBizMsgIdr || v.rltdMsgDefIdr || v.rltdCreDt;
    if (!hasRltd) return '';
    const rFr = v.rltdFrBic ? this.tag('Fr', this.tag('FIId', this.tag('FinInstnId',
      this.el('BICFI', v.rltdFrBic, 6)
      + (v.rltdFrClrSysCd || v.rltdFrMmbId ? this.tag('ClrSysMmbId', (v.rltdFrClrSysCd ? this.tag('ClrSysId', this.el('Cd', v.rltdFrClrSysCd, 8), 7) : '') + this.el('MmbId', v.rltdFrMmbId, 7), 6) : '')
      + this.el('LEI', v.rltdFrLei, 6), 5), 4), 3) : '';
    const rTo = v.rltdToBic ? this.tag('To', this.tag('FIId', this.tag('FinInstnId',
      this.el('BICFI', v.rltdToBic, 6)
      + (v.rltdToClrSysCd || v.rltdToMmbId ? this.tag('ClrSysMmbId', (v.rltdToClrSysCd ? this.tag('ClrSysId', this.el('Cd', v.rltdToClrSysCd, 8), 7) : '') + this.el('MmbId', v.rltdToMmbId, 7), 6) : '')
      + this.el('LEI', v.rltdToLei, 6), 5), 4), 3) : '';
    return this.tag('Rltd',
      this.el('CharSet', v.rltdCharSet, 3) + rFr + rTo
      + this.el('BizMsgIdr', v.rltdBizMsgIdr, 3) + this.el('MsgDefIdr', v.rltdMsgDefIdr, 3) + this.el('BizSvc', v.rltdBizSvc, 3)
      + this.el('CreDt', v.rltdCreDt, 3) + this.el('CpyDplct', v.rltdCpyDplct, 3) + this.el('Prty', v.rltdPrty, 3), 2);
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
      const parser = new DOMParser();
      const doc = parser.parseFromString(xml, 'text/xml');
      const findTag = (tagName: string, parent: any = doc): Element | null => {
        if (!parent) return null;
        const target = tagName.toLowerCase();
        if (parent.localName?.toLowerCase() === target) return parent;
        const els = parent.getElementsByTagName('*');
        for (let i = 0; i < els.length; i++) {
          if (els[i].localName?.toLowerCase() === target) return els[i];
        }
        return null;
      };
      const tval = (tag: string, parent: any = doc) => {
        const el = findTag(tag, parent);
        return el ? el.textContent?.trim() || '' : '';
      };
      const patch: any = {};
      const appHdr = findTag('AppHdr');
      if (appHdr) {
        const fr = findTag('Fr', appHdr);
        if (fr) patch.fromBic = tval('BICFI', fr);
        const to = findTag('To', appHdr);
        if (to) patch.toBic = tval('BICFI', to);
        patch.bizMsgId = tval('BizMsgIdr', appHdr);
      }
      const root = findTag('CstmrDrctDbtInitn');
      if (root) {
        const gh = findTag('GrpHdr', root);
        if (gh) {
          patch.msgId = tval('MsgId', gh);
          patch.creDtTm = tval('CreDtTm', gh);
          patch.nbOfTxs = tval('NbOfTxs', gh);
          const ip = findTag('InitgPty', gh);
          if (ip) patch.initgPtyName = tval('Nm', ip);
        }
        const pi = findTag('PmtInf', root);
        if (pi) {
          patch.pmtInfId = tval('PmtInfId', pi);
          const cdtr = findTag('Cdtr', pi);
          if (cdtr) patch.cdtrName = tval('Nm', cdtr);
          const cdtrAcct = findTag('CdtrAcct', pi);
          if (cdtrAcct) patch.cdtrIban = tval('IBAN', cdtrAcct);
          const cdtrAgt = findTag('CdtrAgt', pi);
          if (cdtrAgt) patch.cdtrAgtBic = tval('BICFI', cdtrAgt);
        }
      }
      this.form.patchValue(patch, { emitEvent: false });
    } catch (e) { console.warn('XML Parse failed', e); }
    finally { setTimeout(() => this.isParsingXml = false, 50); }
  }

  @HostListener('keydown', ['$event'])
  onKeydown(event: KeyboardEvent) {
    if (event.ctrlKey || event.metaKey) {
      if (document.activeElement?.classList.contains('code-editor')) {
        switch (event.key.toLowerCase()) {
          case 'z': event.preventDefault(); this.undoXml(); return;
          case 'y': event.preventDefault(); this.redoXml(); return;
          case 's': event.preventDefault(); this.formatXml(); return;
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
      }
    }
    const max = target.maxLength;
    if (max > 0 && target.value.length >= max) {
      this.showMaxLenWarning[name] = true;
      if (this.warningTimeouts[name]) clearTimeout(this.warningTimeouts[name]);
      this.warningTimeouts[name] = setTimeout(() => this.showMaxLenWarning[name] = false, 3000);
    } else { this.showMaxLenWarning[name] = false; }
  }

  hint(f: string, max: number, group?: any): string | null {
    if (!this.showMaxLenWarning[f]) return null;
    const c = group ? group.get(f) : this.form.get(f);
    return `Maximum ${max} characters reached (${c?.value?.length || 0}/${max})`;
  }

  err(f: string, group?: any): string | null {
    const c = group ? group.get(f) : this.form.get(f);
    if (!c || c.valid) return null;
    if (c.errors?.['required']) return 'Required field.';
    if (c.errors?.['maxlength']) return `Max ${c.errors['maxlength'].requiredLength} chars.`;
    if (c.errors?.['pattern']) {
      const fl = f.toLowerCase();
      if (fl.includes('bic')) return 'Valid 8 or 11-char BIC required.';
      if (fl.includes('iban')) return 'Valid IBAN required.';
      if (fl.includes('uetr')) return 'Invalid UETR format (UUID v4).';
      if (fl.includes('amount') || fl.includes('amt')) return 'Numbers only, up to 5 decimals.';
      return 'Invalid format.';
    }
    return 'Invalid value.';
  }

  copyToClipboard() { navigator.clipboard.writeText(this.generatedXml); this.snackBar.open('Copied!', 'Close', { duration: 3000 }); }
  downloadXml() { const b = new Blob([this.generatedXml], { type: 'application/xml' }); const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = `pain008-${Date.now()}.xml`; a.click(); }

  validateMessage() {
        if (this.bicSameWarning) return;
        this.showValidationModal = true;
    this.validationStatus = 'validating';
    this.validationReport = null;
    this.validationExpandedIssue = null;
    this.http.post(this.config.getApiUrl('/validate'), {
      xml_content: this.generatedXml, message_type: 'pain.008.001.08', mode: 'Full 1-3'
    }).subscribe({
      next: (res: any) => { this.validationReport = res; this.validationStatus = 'done'; this.clearDraft(); },
      error: (err) => {
        this.validationReport = {
          status: 'FAIL', errors: 1, warnings: 0, message: 'pain.008.001.08', total_time_ms: 0,
          layer_status: {},
          details: [{ severity: 'ERROR', layer: 0, code: 'BACKEND_ERROR', path: '', message: 'Validation failed — ' + (err.error?.detail?.message || 'backend not reachable.'), fix_suggestion: 'Ensure the validation server is running.' }]
        };
        this.validationStatus = 'done';
      }
    });
  }

  closeValidationModal() { this.showValidationModal = false; this.validationReport = null; this.validationStatus = 'idle'; this.validationExpandedIssue = null; }
  getValidationLayers(): string[] { return this.validationReport?.layer_status ? Object.keys(this.validationReport.layer_status).sort() : []; }
  getLayerName(k: string): string { const n: Record<string, string> = { '1': 'Syntax & Format', '2': 'Schema Validation', '3': 'Business Rules' }; return n[k] ?? `Layer ${k}`; }
  getLayerStatus(k: string): string { return this.validationReport?.layer_status?.[k]?.status ?? ''; }
  getLayerTime(k: string): number { return this.validationReport?.layer_status?.[k]?.time ?? 0; }
  isLayerPass(k: string) { return this.getLayerStatus(k).includes('✅'); }
  isLayerFail(k: string) { return this.getLayerStatus(k).includes('❌'); }
  isLayerWarn(k: string) { const s = this.getLayerStatus(k); return s.includes('⚠') || s.includes('WARNING'); }
  getValidationIssues(): any[] { return this.validationReport?.details ?? []; }
  toggleValidationIssue(issue: any) { this.validationExpandedIssue = this.validationExpandedIssue === issue ? null : issue; }
  copyFix(text: string, e: MouseEvent) { e.stopPropagation(); navigator.clipboard.writeText(text).then(() => this.snackBar.open('Copied!', '', { duration: 1500 })); }

  syncScroll(editor: HTMLTextAreaElement, gutter: HTMLDivElement) { gutter.scrollTop = editor.scrollTop; }

  private pushHistory() {
    const val = this.generatedXml;
    if (this.xmlHistoryIdx >= 0 && this.xmlHistory[this.xmlHistoryIdx] === val) return;
    if (this.xmlHistoryIdx < this.xmlHistory.length - 1) this.xmlHistory.splice(this.xmlHistoryIdx + 1);
    this.xmlHistory.push(val);
    if (this.xmlHistory.length > this.maxHistory) this.xmlHistory.shift();
    else this.xmlHistoryIdx++;
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
  private refreshLineCount() { const l = (this.generatedXml || '').split('\n').length; this.editorLineCount = Array.from({ length: l }, (_, i) => i + 1); }

  formatXml() {
    if (!this.generatedXml?.trim()) return;
    this.pushHistory();
    try {
      const tab = '    ';
      let formatted = '';
      let indent = '';
      let xml = this.generatedXml.replace(/>\s+</g, '><').trim();
      const reg = /(<[^/!?][^>]*>[^<]*<\/[^>]+>)|(<[^>]+\/>)|(<[^>]+>)|(<!--[\s\S]*?-->)|([^<]+)/g;
      const nodes = xml.match(reg) || [];
      nodes.forEach(node => {
        const trimmed = node.trim();
        if (!trimmed) return;
        if (trimmed.startsWith('</')) { if (indent.length >= tab.length) indent = indent.substring(tab.length); formatted += indent + trimmed + '\r\n'; }
        else if ((trimmed.startsWith('<') && trimmed.includes('</')) || trimmed.endsWith('/>')) { formatted += indent + trimmed + '\r\n'; }
        else if (trimmed.startsWith('<') && !trimmed.startsWith('<?')) { formatted += indent + trimmed + '\r\n'; indent += tab; }
        else { formatted += indent + trimmed + '\r\n'; }
      });
      this.generatedXml = formatted.trim();
      this.refreshLineCount();
      this.snackBar.open('XML Formatted', '', { duration: 1500 });
    } catch (e) { this.snackBar.open('Unable to format XML', '', { duration: 3000 }); }
  }

  openBicSearch(controlName: string, index?: number) {
    const dialogRef = this.dialog.open(BicSearchDialogComponent, {
      width: '800px',
      disableClose: true
    });

    dialogRef.afterClosed().subscribe(result => {
      if (result && result.bic) {
        const group = index !== undefined
          ? this.transactions.controls[index] as FormGroup
          : this.form;
        group.get(controlName)?.patchValue(result.bic);
        group.get(controlName)?.markAsDirty();
      }
    });
  }

  openBicSearchGroup(controlName: string, group: FormGroup) {
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
