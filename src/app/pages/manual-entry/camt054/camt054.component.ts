import { Component, OnInit, OnDestroy, HostListener } from '@angular/core';
import { FormBuilder, FormGroup, FormArray, Validators, ReactiveFormsModule, FormsModule } from '@angular/forms';
import { CommonModule } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { MatIconModule } from '@angular/material/icon';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
import { BicSearchDialogComponent } from '../bic-search-dialog/bic-search-dialog.component';
import { ConfigService } from '../../../services/config.service';
import { FormattingService } from '../../../services/formatting.service';
import { UetrService } from '../../../services/uetr.service';
import { debounceTime } from 'rxjs/operators';

@Component({
  selector: 'app-camt054',
  templateUrl: './camt054.component.html',
  styleUrls: ['./camt054.component.css'],
  standalone: true,
  imports: [CommonModule, ReactiveFormsModule, FormsModule, MatIconModule, MatSnackBarModule, MatTooltipModule, MatDialogModule]
})
export class Camt054Component implements OnInit, OnDestroy {
  form!: FormGroup;
  generatedXml = '';
  isParsingXml = false;
  editorLineCount: number[] = [];

  // History for Undo/Redo
  private xmlHistory: string[] = [];
  private xmlHistoryIdx = -1;
  private maxHistory = 50;
  private isInternalChange = false;

  // Codelists
  currencies: string[] = [];
  currencyPrecision: { [key: string]: number } = {};
  countries: string[] = [];
  chargeBearers = ['CRED', 'SHAR', 'SLEV'];
  priorities = ['HIGH', 'NORM'];

  // Collapsible sections
  expandedSections: { [key: string]: boolean } = {
    appHdr: true,
    grpHdr: true,
    recipient: true,
    notification: true,
    entries: true,
    summary: true
  };

  // Validation state for modal
  showValidationModal = false;
  validationStatus: 'idle' | 'validating' | 'done' = 'idle';
  validationReport: any = null;
  validationExpandedIssue: any = null;

  warningTimeouts: { [key: string]: any } = {};
  showMaxLenWarning: { [key: string]: boolean } = {};

  private readonly DRAFT_KEY = 'draft_camt054';
  private draftSaveTimer: ReturnType<typeof setTimeout> | null = null;
  showDraftBanner = false;
  isClearingDraft = false;

  constructor(
    private fb: FormBuilder,
    private http: HttpClient,
    private config: ConfigService,
    private snackBar: MatSnackBar,
    private formatting: FormattingService,
    private uetr: UetrService,
    private dialog: MatDialog
  ) { }

  ngOnInit() {
    this.fetchCodelists();
    this.buildForm();
    this.generateXml();
    this.pushHistory();

    const hadDraft = this.loadDraft();
    if (hadDraft) {
      this.showDraftBanner = true;
      this.generateXml();
    }

    this.form.valueChanges.pipe(debounceTime(300)).subscribe(() => {
      this.scheduleDraftSave();
      this.generateXml();
    });
  }

  fetchCodelists() {
    this.http.get<any>(this.config.getApiUrl('/codelists/currency')).subscribe({
      next: (res) => {
        if (res && res.codes) {
          this.currencies = res.codes;
          this.currencyPrecision = res.currencies || {};
        }
      },
      error: (err) => console.error('Failed to load currencies', err)
    });
    this.http.get<any>(this.config.getApiUrl('/codelists/country')).subscribe({
      next: (res) => {
        if (res && res.codes) this.countries = res.codes;
      },
      error: (err) => console.error('Failed to load countries', err)
    });
  }

  private buildForm() {
    const BIC_REG = /^[A-Z0-9]{8,11}$/;
    const IBAN_REG = /^[A-Z]{2}[0-9]{2}[A-Z0-9]{1,30}$/;

    this.form = this.fb.group({
      // 3. BUSINESS APPLICATION HEADER
      fromBIC: ['SNDRBEBBXXX', [Validators.required, Validators.pattern(BIC_REG)]],
      fromClrSysIdCd: ['', [Validators.maxLength(35)]],
      fromMmbId: ['', [Validators.maxLength(35)]],
      fromLEI: ['', [Validators.maxLength(20)]],
      toBIC: ['RCVRBEBBXXX', [Validators.required, Validators.pattern(BIC_REG)]],
      toClrSysIdCd: ['', [Validators.maxLength(35)]],
      toMmbId: ['', [Validators.maxLength(35)]],
      toLEI: ['', [Validators.maxLength(20)]],
      businessMsgId: ['B' + Date.now().toString().slice(-13), [Validators.required, Validators.maxLength(16)]],
      msgDefId: ['camt.054.001.08', [Validators.required]],
      creationDate: [this.isoNow(), [Validators.required]],
      copyDuplicate: [''],
      possibleDuplicate: [''],
      priority: ['NORM'],
      charSet: [''],
      marketPractice: [''],
      marketPracticeId: [''],

      // 4. GROUP HEADER
      msgId: ['MSG' + Date.now().toString().slice(-13), [Validators.required, Validators.maxLength(16)]],
      creationDateTime: [this.isoNow(), [Validators.required]],
      originalBusinessQuery: ['', [Validators.maxLength(35)]],
      additionalInformation: ['', [Validators.maxLength(500)]],

      // 5. MESSAGE RECIPIENT
      rcptName: ['', [Validators.maxLength(140)]],
      rcptCtry: ['', [Validators.pattern(/^[A-Z]{2}$/)]],
      rcptAdrLine1: ['', [Validators.maxLength(70)]],
      rcptAdrLine2: ['', [Validators.maxLength(70)]],
      rcptOrgIdAnyBIC: ['', [Validators.maxLength(11)]],
      rcptPrvtIdBirthDt: [''],
      rcptPrvtIdCityOfBirth: ['', [Validators.maxLength(35)]],
      rcptPrvtIdCtryOfBirth: ['', [Validators.pattern(/^[A-Z]{2}$/)]],
      rcptContactNm: ['', [Validators.maxLength(140)]],

      // 6. NOTIFICATION
      notificationId: ['NTF' + Date.now().toString().slice(-13), [Validators.required, Validators.maxLength(16)]],
      pageNumber: [''],
      lastPageInd: [false],
      creationDateTimeNtf: [this.isoNow(), [Validators.required]], // Unique name to avoid clash with GH
      electronicSequenceNumber: ['', [Validators.pattern(/^\d{1,18}$/)]],
      reportingSequence: ['', [Validators.pattern(/^\d{1,18}$/)]],
      legalSeqNb: ['', [Validators.pattern(/^\d{1,18}$/)]],
      fromDateTm: [this.isoNow()],
      toDateTm: [this.isoNow()],
      copyDuplicateIndicatorNtf: [''], // COPY or DUPL
      reportingSource: [''],
      accountIBAN: ['GB29NWBK60161331926819', [Validators.required, Validators.maxLength(34), Validators.pattern(IBAN_REG)]],
      accountTypeCd: ['', [Validators.maxLength(4)]],
      accountName: ['', [Validators.maxLength(70)]],
      accountOwnerName: ['', [Validators.maxLength(140)]],
      accountOwnerCtry: ['', [Validators.pattern(/^[A-Z]{2}$/)]],
      accountProxyId: ['', [Validators.maxLength(34)]],
      accountServicerBic: ['', [Validators.pattern(/^[A-Z0-9]{8,11}$/)]],
      currency: ['USD', [Validators.required, Validators.pattern(/^[A-Z]{3}$/)]],
      relatedAccountIBAN: ['', [Validators.maxLength(34)]],
      additionalNotificationInfo: ['', [Validators.maxLength(500)]],

      // 7. ENTRIES
      entries: this.fb.array([this.createEntryGroup()]),

      // 8. TRANSACTION SUMMARY
      totalEntries: [''],
      totalCreditEntries: [''],
      totalDebitEntries: ['']
    });

    this.updateTotals();
  }

  createEntryGroup(): FormGroup {
    return this.fb.group({
      entryReference: ['REF' + Date.now().toString().slice(-13), [Validators.required, Validators.maxLength(16)]],
      amount: ['1000.00', [Validators.required, Validators.pattern(/^\d{1,18}(\.\d{1,5})?$/)]],
      creditDebitIndicator: ['CRDT', [Validators.required]],
      status: ['BOOK', [Validators.required]],
      bookingDate: [this.isoNow(), [Validators.required]],
      valueDate: [this.isoNow()],
      accountServicerRef: ['', [Validators.maxLength(35)]],
      bankTxnDomain: ['PMNT', [Validators.required, Validators.maxLength(4)]],
      bankTxnFamily: ['RDTX', [Validators.required, Validators.maxLength(4)]],
      bankTxnCode: ['PMNT', [Validators.required, Validators.maxLength(4)]],
      charges: ['', [Validators.pattern(/^\d{1,18}(\.\d{1,5})?$/)]],
      uetr: [this.uetr.generate(), [Validators.pattern(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)]],
      endToEndId: ['E2E' + Date.now().toString().slice(-13), [Validators.maxLength(16)]],
      instructionId: ['INS' + Date.now().toString().slice(-13), [Validators.maxLength(16)]],
      dbtrNm: ['JOHN DOE SENDER', [Validators.maxLength(140)]],
      dbtrAddrType: ['hybrid'],
      dbtrStrtNm: ['123 Business Street', [Validators.maxLength(70)]],
      dbtrTwnNm: ['New York', [Validators.maxLength(35)]],
      dbtrCtry: ['US', [Validators.pattern(/^[A-Z]{2}$/)]],
      dbtrAdrLine1: ['123 Business Street, New York', [Validators.maxLength(70)]],
      dbtrAgtBic: ['SNDRBEBBXXX', [Validators.pattern(/^[A-Z0-9]{8,11}$/)]],
      cdtrNm: ['JANE DOE RECEIVER', [Validators.maxLength(140)]],
      cdtrAddrType: ['hybrid'],
      cdtrStrtNm: ['456 Commerce Avenue', [Validators.maxLength(70)]],
      cdtrTwnNm: ['London', [Validators.maxLength(35)]],
      cdtrCtry: ['GB', [Validators.pattern(/^[A-Z]{2}$/)]],
      cdtrAdrLine1: ['456 Commerce Avenue, London', [Validators.maxLength(70)]],
      cdtrAgtBic: ['RCVRBEBBXXX', [Validators.pattern(/^[A-Z0-9]{8,11}$/)]],
      ultmtDbtrNm: ['', [Validators.maxLength(140)]],
      ultmtCdtrNm: ['', [Validators.maxLength(140)]],
      remittanceInfo: ['INV-2026-101 PAYMENT', [Validators.maxLength(140)]],
      purposeCode: ['OTHR', [Validators.maxLength(4)]],
      reversalIndicator: [false],
      waiverIndicator: [false],
      additionalEntryInfo: ['', [Validators.maxLength(500)]],
      instructedAmount: ['', [Validators.pattern(/^\d{1,18}(\.\d{1,5})?$/)]],
    });
  }

  get entries(): FormArray {
    return this.form.get('entries') as FormArray;
  }

  addEntry() {
    if (this.entries.length < 99) {
      this.entries.push(this.createEntryGroup());
      this.updateTotals();
    }
  }

  removeEntry(index: number) {
    if (this.entries.length > 1) {
      this.entries.removeAt(index);
      this.updateTotals();
    }
  }

  refreshUetr(index: number) {
    const entryGrp = this.entries.at(index);
    if (entryGrp) {
        entryGrp.get('uetr')?.setValue(this.uetr.generate());
    }
  }

  updateTotals() {
    const count = this.entries.length;
    let credits = 0;
    let debits = 0;
    
    this.entries.controls.forEach(c => {
      const amt = parseFloat(c.get('amount')?.value) || 0;
      if (c.get('creditDebitIndicator')?.value === 'CRDT') credits += amt;
      else debits += amt;
    });

    this.form.patchValue({
      totalEntries: count.toString(),
      totalCreditEntries: credits.toFixed(2),
      totalDebitEntries: debits.toFixed(2)
    }, { emitEvent: false });
  }

  today(): string {
    return new Date().toISOString().split('T')[0];
  }

  isoNow(): string {
    return new Date().toISOString().split('.')[0] + '+00:00';
  }

  isoNowZ(): string {
    return new Date().toISOString().split('.')[0] + 'Z';
  }

  toggleSection(section: string) {
    this.expandedSections[section] = !this.expandedSections[section];
  }

  onEditorChange(content: string, fromForm = false) {
    if (!this.isInternalChange && !fromForm) {
      this.pushHistory();
      this.parseXmlToForm(content);
    }
    this.generatedXml = content;
    this.refreshLineCount();
  }

  generateXml() {
    if (this.isParsingXml) return;
    const v = this.form.value;
    const t = (n: number) => '  '.repeat(n);

    let xml = `<?xml version="1.0" encoding="UTF-8"?>\n`;
    xml += `<BusMsgEnvlp xmlns="urn:swift:xsd:envelope">\n`;
    
    // AppHdr (Dynamic)
    xml += t(1) + `<AppHdr xmlns="urn:iso:std:iso:20022:tech:xsd:head.001.001.02">\n`;
    if (v.charSet) xml += t(2) + `<CharSet>${this.e(v.charSet)}</CharSet>\n`;
    
    // Fr
    xml += t(2) + `<Fr>\n` + t(3) + `<FIId>\n` + t(4) + `<FinInstnId>\n` + t(5) + `<BICFI>${this.e(v.fromBIC)}</BICFI>\n`;
    if (v.fromClrSysIdCd || v.fromMmbId) {
      xml += t(5) + `<ClrSysMmbId>\n`;
      if (v.fromClrSysIdCd) xml += t(6) + `<ClrSysId>\n` + t(7) + `<Cd>${this.e(v.fromClrSysIdCd)}</Cd>\n` + t(6) + `</ClrSysId>\n`;
      if (v.fromMmbId) xml += t(6) + `<MmbId>${this.e(v.fromMmbId)}</MmbId>\n`;
      xml += t(5) + `</ClrSysMmbId>\n`;
    }
    if (v.fromLEI) xml += t(5) + `<LEI>${this.e(v.fromLEI)}</LEI>\n`;
    xml += t(4) + `</FinInstnId>\n` + t(3) + `</FIId>\n` + t(2) + `</Fr>\n`;
    
    // To
    xml += t(2) + `<To>\n` + t(3) + `<FIId>\n` + t(4) + `<FinInstnId>\n` + t(5) + `<BICFI>${this.e(v.toBIC)}</BICFI>\n`;
    if (v.toClrSysIdCd || v.toMmbId) {
      xml += t(5) + `<ClrSysMmbId>\n`;
      if (v.toClrSysIdCd) xml += t(6) + `<ClrSysId>\n` + t(7) + `<Cd>${this.e(v.toClrSysIdCd)}</Cd>\n` + t(6) + `</ClrSysId>\n`;
      if (v.toMmbId) xml += t(6) + `<MmbId>${this.e(v.toMmbId)}</MmbId>\n`;
      xml += t(5) + `</ClrSysMmbId>\n`;
    }
    if (v.toLEI) xml += t(5) + `<LEI>${this.e(v.toLEI)}</LEI>\n`;
    xml += t(4) + `</FinInstnId>\n` + t(3) + `</FIId>\n` + t(2) + `</To>\n`;
    
    xml += t(2) + `<BizMsgIdr>${this.e(v.businessMsgId)}</BizMsgIdr>\n`;
    xml += t(2) + `<MsgDefIdr>${this.e(v.msgDefId)}</MsgDefIdr>\n`;
    xml += t(2) + `<BizSvc>swift.cbprplus.02</BizSvc>\n`;
    if (v.marketPractice || v.marketPracticeId) {
      xml += t(2) + `<MktPrctc>\n`;
      if (v.marketPractice) xml += t(3) + `<Regy>${this.e(v.marketPractice)}</Regy>\n`;
      if (v.marketPracticeId) xml += t(3) + `<Id>${this.e(v.marketPracticeId)}</Id>\n`;
      xml += t(2) + `</MktPrctc>\n`;
    }
    xml += t(2) + `<CreDt>${this.e(v.creationDate).replace('Z', '+00:00')}</CreDt>\n`;
    if (v.copyDuplicate) xml += t(2) + `<CpyDplct>${this.e(v.copyDuplicate)}</CpyDplct>\n`;
    if (v.possibleDuplicate) xml += t(2) + `<PssblDplct>${this.e(v.possibleDuplicate)}</PssblDplct>\n`;
    if (v.priority) xml += t(2) + `<Prty>${this.e(v.priority)}</Prty>\n`;
    
    if (v.copyDuplicate) {
      xml += t(2) + `<Rltd>\n` + t(3) + `<Document>\n` + t(4) + `<BkToCstmrDbtCdtNtfctn/>\n` + t(3) + `</Document>\n` + t(2) + `</Rltd>\n`;
    }
    xml += t(1) + `</AppHdr>\n`;

    // Document
    xml += t(1) + `<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.054.001.08">\n`;
    xml += t(2) + `<BkToCstmrDbtCdtNtfctn>\n`;
    
    // Group Header
    xml += t(3) + `<GrpHdr>\n`;
    xml += t(4) + `<MsgId>${this.e(v.msgId)}</MsgId>\n`;
    xml += t(4) + `<CreDtTm>${this.e(v.creationDateTime).replace('Z', '+00:00')}</CreDtTm>\n`;
    
    // Recipient (MsgRcpt) moved to GrpHdr
    if (v.rcptName || v.rcptCtry || v.rcptAdrLine1 || v.rcptOrgIdAnyBIC || v.rcptPrvtIdBirthDt || v.rcptContactNm) {
      xml += t(4) + `<MsgRcpt>\n`;
      if (v.rcptName) xml += t(5) + `<Nm>${this.e(v.rcptName)}</Nm>\n`;
      if (v.rcptCtry || v.rcptAdrLine1) {
        xml += t(5) + `<PstlAdr>\n`;
        if (v.rcptCtry) xml += t(6) + `<Ctry>${this.e(v.rcptCtry)}</Ctry>\n`;
        if (v.rcptAdrLine1) xml += t(6) + `<AdrLine>${this.e(v.rcptAdrLine1)}</AdrLine>\n`;
        if (v.rcptAdrLine2) xml += t(6) + `<AdrLine>${this.e(v.rcptAdrLine2)}</AdrLine>\n`;
        xml += t(5) + `</PstlAdr>\n`;
      }
      if (v.rcptOrgIdAnyBIC || v.rcptPrvtIdBirthDt) {
          xml += t(5) + `<Id>\n`;
          if (v.rcptOrgIdAnyBIC) {
              xml += t(6) + `<OrgId>\n` + t(7) + `<AnyBIC>${this.e(v.rcptOrgIdAnyBIC)}</AnyBIC>\n` + t(6) + `</OrgId>\n`;
          } else if (v.rcptPrvtIdBirthDt) {
              xml += t(6) + `<PrvtId>\n` + t(7) + `<DtAndPlcOfBirth>\n` + t(8) + `<BirthDt>${this.e(v.rcptPrvtIdBirthDt)}</BirthDt>\n`;
              if (v.rcptPrvtIdCityOfBirth) xml += t(8) + `<CityOfBirth>${this.e(v.rcptPrvtIdCityOfBirth)}</CityOfBirth>\n`;
              if (v.rcptPrvtIdCtryOfBirth) xml += t(8) + `<CtryOfBirth>${this.e(v.rcptPrvtIdCtryOfBirth)}</CtryOfBirth>\n`;
              xml += t(7) + `</DtAndPlcOfBirth>\n` + t(6) + `</PrvtId>\n`;
          }
          xml += t(5) + `</Id>\n`;
      }
      if (v.rcptContactNm) {
          xml += t(5) + `<CtctDtls>\n` + t(6) + `<Nm>${this.e(v.rcptContactNm)}</Nm>\n` + t(5) + `</CtctDtls>\n`;
      }
      xml += t(4) + `</MsgRcpt>\n`;
    }

    if (v.originalBusinessQuery) {
      xml += t(4) + `<OrgnlBizQry>\n` + t(5) + `<MsgId>${this.e(v.originalBusinessQuery)}</MsgId>\n` + t(4) + `</OrgnlBizQry>\n`;
    }
    if (v.additionalInformation) {
      xml += t(4) + `<AddtlInf>${this.e(v.additionalInformation)}</AddtlInf>\n`;
    }
    xml += t(3) + `</GrpHdr>\n`;

    // Notification
    xml += t(3) + `<Ntfctn>\n`;
    xml += t(4) + `<Id>${this.e(v.notificationId)}</Id>\n`;
    
    if (v.pageNumber) {
      xml += t(4) + `<NtfctnPgntn>\n` + t(5) + `<PgNb>${this.e(v.pageNumber)}</PgNb>\n` + t(5) + `<LastPgInd>${v.lastPageInd ? 'true' : 'false'}</LastPgInd>\n` + t(4) + `</NtfctnPgntn>\n`;
    }
    
    if (v.electronicSequenceNumber) xml += t(4) + `<ElctrncSeqNb>${this.e(v.electronicSequenceNumber)}</ElctrncSeqNb>\n`;
    if (v.reportingSequence) xml += t(4) + `<RptgSeq>${this.e(v.reportingSequence)}</RptgSeq>\n`;
    if (v.legalSeqNb) xml += t(4) + `<LglSeqNb>${this.e(v.legalSeqNb)}</LglSeqNb>\n`;
    xml += t(4) + `<CreDtTm>${this.e(v.creationDateTimeNtf).replace('Z', '+00:00')}</CreDtTm>\n`;
    
    if (v.fromDateTm || v.toDateTm) {
      xml += t(4) + `<FrToDt>\n`;
      if (v.fromDateTm) xml += t(5) + `<FrDtTm>${this.e(v.fromDateTm).replace('Z', '+00:00')}</FrDtTm>\n`;
      if (v.toDateTm) xml += t(5) + `<ToDtTm>${this.e(v.toDateTm).replace('Z', '+00:00')}</ToDtTm>\n`;
      xml += t(4) + `</FrToDt>\n`;
    }
    
    if (v.copyDuplicateIndicatorNtf) xml += t(4) + `<CpyDplctInd>${this.e(v.copyDuplicateIndicatorNtf)}</CpyDplctInd>\n`;
    if (v.reportingSource) xml += t(4) + `<RptgSrc>\n` + t(5) + `<Prtry>${this.e(v.reportingSource)}</Prtry>\n` + t(4) + `</RptgSrc>\n`;

    // Account
    xml += t(4) + `<Acct>\n` + t(5) + `<Id>\n` + t(6) + `<IBAN>${this.e(v.accountIBAN)}</IBAN>\n` + t(5) + `</Id>\n`;
    if (v.accountTypeCd) xml += t(5) + `<Tp>\n` + t(6) + `<Cd>${this.e(v.accountTypeCd)}</Cd>\n` + t(5) + `</Tp>\n`;
    xml += t(5) + `<Ccy>${this.e(v.currency)}</Ccy>\n`;
    if (v.accountName) xml += t(5) + `<Nm>${this.e(v.accountName)}</Nm>\n`;
    if (v.accountProxyId) xml += t(5) + `<Prxy>\n` + t(6) + `<Id>${this.e(v.accountProxyId)}</Id>\n` + t(5) + `</Prxy>\n`;
    if (v.accountOwnerName) {
        xml += t(5) + `<Ownr>\n` + t(6) + `<Nm>${this.e(v.accountOwnerName)}</Nm>\n`;
        if (v.accountOwnerCtry) xml += t(6) + `<PstlAdr>\n` + t(7) + `<Ctry>${this.e(v.accountOwnerCtry)}</Ctry>\n` + t(6) + `</PstlAdr>\n`;
        xml += t(5) + `</Ownr>\n`;
    }
    if (v.accountServicerBic) {
      xml += t(5) + `<Svcr>\n` + t(6) + `<FinInstnId>\n` + t(7) + `<BICFI>${this.e(v.accountServicerBic)}</BICFI>\n` + t(6) + `</FinInstnId>\n` + t(5) + `</Svcr>\n`;
    }
    xml += t(4) + `</Acct>\n`;
    
    if (v.relatedAccountIBAN) {
      xml += t(4) + `<RltdAcct>\n` + t(5) + `<Id>\n` + t(6) + `<IBAN>${this.e(v.relatedAccountIBAN)}</IBAN>\n` + t(5) + `</Id>\n` + t(4) + `</RltdAcct>\n`;
    }

    // Transaction Summary (TxsSummry)
    if (v.totalEntries) {
      xml += t(4) + `<TxsSummry>\n`;
      xml += t(5) + `<TtlNtries>\n` + t(6) + `<NbOfNtries>${this.e(v.totalEntries)}</NbOfNtries>\n`;
      xml += t(6) + `<Sum>${this.formatting.formatAmount(v.totalCreditEntries || '0', v.currency)}</Sum>\n`;
      xml += t(5) + `</TtlNtries>\n`;
      xml += t(5) + `<TtlCdtNtries>\n` + t(6) + `<NbOfNtries>${this.entries.length}</NbOfNtries>\n` + t(6) + `<Sum>${this.formatting.formatAmount(v.totalCreditEntries || '0', v.currency)}</Sum>\n` + t(5) + `</TtlCdtNtries>\n`;
      xml += t(5) + `<TtlDbtNtries>\n` + t(6) + `<NbOfNtries>0</NbOfNtries>\n` + t(6) + `<Sum>0.00</Sum>\n` + t(5) + `</TtlDbtNtries>\n`;
      xml += t(4) + `</TxsSummry>\n`;
    }

      // AddtlNtfctnInf
      if (v.additionalNotificationInfo) xml += t(4) + `<AddtlNtfctnInf>${this.e(v.additionalNotificationInfo)}</AddtlNtfctnInf>\n`;

      // Entries (Ntry)
    let credits = 0;
    let debits = 0;
    
    v.entries.forEach((ntry: any) => {
      const amt = parseFloat(ntry.amount) || 0;
      if (ntry.creditDebitIndicator === 'CRDT') credits += amt;
      else debits += amt;

      xml += t(4) + `<Ntry>\n`;
      xml += t(5) + `<NtryRef>${this.e(ntry.entryReference)}</NtryRef>\n`;
      xml += t(5) + `<Amt Ccy="${this.e(v.currency)}">${this.formatting.formatAmount(ntry.amount, v.currency)}</Amt>\n`;
      xml += t(5) + `<CdtDbtInd>${this.e(ntry.creditDebitIndicator)}</CdtDbtInd>\n`;
      if (ntry.reversalIndicator) xml += t(5) + `<RvslInd>true</RvslInd>\n`;
      xml += t(5) + `<Sts>\n` + t(6) + `<Cd>${this.e(ntry.status)}</Cd>\n` + t(5) + `</Sts>\n`;
      xml += t(5) + `<BookgDt>\n` + t(6) + `<DtTm>${this.e(ntry.bookingDate).replace('Z', '+00:00')}</DtTm>\n` + t(5) + `</BookgDt>\n`;
      if (ntry.valueDate) xml += t(5) + `<ValDt>\n` + t(6) + `<DtTm>${this.e(ntry.valueDate).replace('Z', '+00:00')}</DtTm>\n` + t(5) + `</ValDt>\n`;
      if (ntry.accountServicerRef) xml += t(5) + `<AcctSvcrRef>${this.e(ntry.accountServicerRef)}</AcctSvcrRef>\n`;
      
       // Bank Transaction Code (Dynamic)
      xml += t(5) + `<BkTxCd>\n` + t(6) + `<Domn>\n` + t(7) + `<Cd>${this.e(ntry.bankTxnDomain)}</Cd>\n` + t(7) + `<Fmly>\n` + t(8) + `<Cd>${this.e(ntry.bankTxnFamily)}</Cd>\n` + t(8) + `<SubFmlyCd>${this.e(ntry.bankTxnCode)}</SubFmlyCd>\n` + t(7) + `</Fmly>\n` + t(6) + `</Domn>\n` + t(5) + `</BkTxCd>\n`;
      
      if (ntry.charges) {
        xml += t(5) + `<Chrgs>\n` + t(6) + `<TtlChrgsAndTaxAmt Ccy="${this.e(v.currency)}">${this.formatting.formatAmount(ntry.charges, v.currency)}</TtlChrgsAndTaxAmt>\n` + t(5) + `</Chrgs>\n`;
      }

      // Entry Details (NtryDtls)
      xml += t(5) + `<NtryDtls>\n` + t(6) + `<TxDtls>\n`;
      
      // Refs
      xml += t(7) + `<Refs>\n`;
      if (ntry.instructionId) xml += t(8) + `<InstrId>${this.e(ntry.instructionId)}</InstrId>\n`;
      if (ntry.endToEndId) xml += t(8) + `<EndToEndId>${this.e(ntry.endToEndId)}</EndToEndId>\n`;
      if (ntry.uetr) xml += t(8) + `<UETR>${this.e(ntry.uetr)}</UETR>\n`;
      xml += t(7) + `</Refs>\n`;

      // Amount inside TxDtls
      xml += t(7) + `<Amt Ccy="${this.e(v.currency)}">${this.formatting.formatAmount(ntry.amount, v.currency)}</Amt>\n`;
      xml += t(7) + `<CdtDbtInd>${this.e(ntry.creditDebitIndicator)}</CdtDbtInd>\n`;

      // AmtDtls (Instructed Amt)
      if (ntry.instructedAmount) {
        xml += t(7) + `<AmtDtls>\n` + t(8) + `<InstdAmt>\n` + t(9) + `<Amt Ccy="${this.e(v.currency)}">${this.formatting.formatAmount(ntry.instructedAmount, v.currency)}</Amt>\n` + t(8) + `</InstdAmt>\n` + t(7) + `</AmtDtls>\n`;
      }

      // Related Parties
      if (ntry.dbtrNm || ntry.cdtrNm) {
        const buildPtyAddr = (addrType: string, strtNm: string, twnNm: string, ctry: string, adrLine1: string, ind: number) => {
          if (!addrType || addrType === 'none' || (!strtNm && !twnNm && !ctry && !adrLine1)) return '';
          let a = t(ind) + `<PstlAdr>\n`;
          if ((addrType === 'structured' || addrType === 'hybrid') && strtNm) a += t(ind+1) + `<StrtNm>${this.e(strtNm)}</StrtNm>\n`;
          if ((addrType === 'structured' || addrType === 'hybrid') && twnNm) a += t(ind+1) + `<TwnNm>${this.e(twnNm)}</TwnNm>\n`;
          if (ctry) a += t(ind+1) + `<Ctry>${this.e(ctry)}</Ctry>\n`;
          if ((addrType === 'unstructured' || addrType === 'hybrid') && adrLine1) a += t(ind+1) + `<AdrLine>${this.e(adrLine1)}</AdrLine>\n`;
          return a + t(ind) + `</PstlAdr>\n`;
        };
        xml += t(7) + `<RltdPties>\n`;
        if (ntry.dbtrNm) {
          xml += t(8) + `<Dbtr>\n` + t(9) + `<Pty>\n` + t(10) + `<Nm>${this.e(ntry.dbtrNm)}</Nm>\n`;
          xml += buildPtyAddr(ntry.dbtrAddrType, ntry.dbtrStrtNm, ntry.dbtrTwnNm, ntry.dbtrCtry, ntry.dbtrAdrLine1, 10);
          xml += t(9) + `</Pty>\n` + t(8) + `</Dbtr>\n`;
        }
        if (ntry.ultmtDbtrNm) xml += t(8) + `<UltmtDbtr>\n` + t(9) + `<Pty>\n` + t(10) + `<Nm>${this.e(ntry.ultmtDbtrNm)}</Nm>\n` + t(9) + `</Pty>\n` + t(8) + `</UltmtDbtr>\n`;
        if (ntry.cdtrNm) {
          xml += t(8) + `<Cdtr>\n` + t(9) + `<Pty>\n` + t(10) + `<Nm>${this.e(ntry.cdtrNm)}</Nm>\n`;
          xml += buildPtyAddr(ntry.cdtrAddrType, ntry.cdtrStrtNm, ntry.cdtrTwnNm, ntry.cdtrCtry, ntry.cdtrAdrLine1, 10);
          xml += t(9) + `</Pty>\n` + t(8) + `</Cdtr>\n`;
        }
        if (ntry.ultmtCdtrNm) xml += t(8) + `<UltmtCdtr>\n` + t(9) + `<Pty>\n` + t(10) + `<Nm>${this.e(ntry.ultmtCdtrNm)}</Nm>\n` + t(9) + `</Pty>\n` + t(8) + `</UltmtCdtr>\n`;
        xml += t(7) + `</RltdPties>\n`;
      }

      // Related Agents
      if (ntry.dbtrAgtBic || ntry.cdtrAgtBic) {
        xml += t(7) + `<RltdAgts>\n`;
        if (ntry.dbtrAgtBic) xml += t(8) + `<DbtrAgt>\n` + t(9) + `<FinInstnId>\n` + t(10) + `<BICFI>${this.e(ntry.dbtrAgtBic)}</BICFI>\n` + t(9) + `</FinInstnId>\n` + t(8) + `</DbtrAgt>\n`;
        if (ntry.cdtrAgtBic) xml += t(8) + `<CdtrAgt>\n` + t(9) + `<FinInstnId>\n` + t(10) + `<BICFI>${this.e(ntry.cdtrAgtBic)}</BICFI>\n` + t(9) + `</FinInstnId>\n` + t(8) + `</CdtrAgt>\n`;
        xml += t(7) + `</RltdAgts>\n`;
      }

      // Purpose Code
      if (ntry.purposeCode) xml += t(7) + `<Purp>\n` + t(8) + `<Cd>${this.e(ntry.purposeCode)}</Cd>\n` + t(7) + `</Purp>\n`;

      // Remittance Info
      if (ntry.remittanceInfo) {
        xml += t(7) + `<RmtInf>\n` + t(8) + `<Ustrd>${this.e(ntry.remittanceInfo)}</Ustrd>\n` + t(7) + `</RmtInf>\n`;
      }

      // Related Dates
      xml += t(7) + `<RltdDts>\n`;
      xml += t(8) + `<AccptncDtTm>${this.e(ntry.bookingDate).replace('Z', '+00:00')}</AccptncDtTm>\n`;
      xml += t(7) + `</RltdDts>\n`;

      xml += t(6) + `</TxDtls>\n`;
      xml += t(5) + `</NtryDtls>\n`;

      if (ntry.waiverIndicator) xml += t(5) + `<ComssnWvrInd>true</ComssnWvrInd>\n`;
      if (ntry.additionalEntryInfo) xml += t(5) + `<AddtlNtryInf>${this.e(ntry.additionalEntryInfo)}</AddtlNtryInf>\n`;

      xml += t(4) + `</Ntry>\n`;
    });

    // Update form values for summary without emitting event
    this.form.patchValue({
      totalEntries: v.entries.length.toString(),
      totalCreditEntries: credits.toFixed(2),
      totalDebitEntries: debits.toFixed(2)
    }, { emitEvent: false });


    xml += t(3) + `</Ntfctn>\n`;
    xml += t(2) + `</BkToCstmrDbtCdtNtfctn>\n`;
    xml += t(1) + `</Document>\n`;
    xml += `</BusMsgEnvlp>`;

    this.generatedXml = xml;
    this.formatXml(false);
  }

  private e(v: any): string {
    if (v === null || v === undefined || v === '') return '';
    return v.toString().replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  private refreshLineCount() {
    const lines = (this.generatedXml || '').split('\n').length;
    this.editorLineCount = Array.from({ length: lines }, (_, i) => i + 1);
  }

  @HostListener('input', ['$event'])
  onInput(event: any) {
    const target = event.target as HTMLInputElement;
    if (!target) return;
    const name = target.getAttribute('formControlName') || target.getAttribute('id');
    if (!name) return;

    if (name.toLowerCase().includes('bic') || name.toLowerCase().includes('iban')) {
      const up = target.value.toUpperCase();
      if (target.value !== up) {
        target.value = up;
        const control = this.form.get(name);
        if (control) control.patchValue(up, { emitEvent: false });
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

  err(f: string, group?: any): string | null {
    const c = group ? group.get(f) : this.form.get(f);
    if (!c || !c.touched || c.valid) return null;
    if (c.errors?.['required']) return 'Required field.';
    if (c.errors?.['maxlength']) return `Max ${c.errors['maxlength'].requiredLength} chars.`;
    if (c.errors?.['pattern']) {
      const fl = f.toLowerCase();
      if (fl.includes('bic')) return 'Valid 8 or 11-char BIC required.';
      if (fl.includes('iban')) return 'Valid 34-char IBAN required.';
      if (fl.includes('uetr')) return 'Invalid UETR format';
      if (fl.includes('lei')) return 'Must be 20-char LEI.';
      if (fl.includes('ctry') || fl.includes('country')) return '2-letter ISO code required.';
      if (fl.includes('amount') || fl.includes('amt')) return 'Max 18 digits, up to 5 decimals.';
      if (fl.includes('bldgnb') || fl.includes('pstcd') || fl.includes('pstbx')) return 'Invalid character. Only ISO 20022 MX allowed characters permitted.';
      if (fl.includes('name') || fl.includes('nm') || fl.includes('strtnm') || fl.includes('twnnm') || fl.includes('dept') || fl.includes('flr') || fl.includes('room') || fl.includes('adrline')) return 'Invalid characters. Only ISO 20022 MX allowed characters permitted.';
      return 'Invalid format.';
    }
    return 'Invalid value.';
  }

  hint(f: string, maxLen: number, group?: any): string | null {
    if (!this.showMaxLenWarning[f]) return null;
    if (this.err(f, group)) return null;
    const c = group ? group.get(f) : this.form.get(f);
    if (!c || !c.value) return null;
    const len = c.value.toString().length;
    if (len >= maxLen) return `Maximum ${maxLen} characters reached (${len}/${maxLen})`;
    return null;
  }

  copyToClipboard() {
    navigator.clipboard.writeText(this.generatedXml).then(() => {
      this.snackBar.open('Copied to clipboard!', 'Close', { duration: 3000 });
    });
  }

  downloadXml() {
    const b = new Blob([this.generatedXml], { type: 'application/xml' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(b);
    a.download = `camt054-${Date.now()}.xml`;
    a.click();
  }

  validateMessage() {
    this.showValidationModal = true;
    this.validationStatus = 'validating';
    this.validationReport = null;
    this.validationExpandedIssue = null;

    this.http.post(this.config.getApiUrl('/validate'), {
      xml_content: this.generatedXml,
      message_type: 'camt.054.001.08',
      mode: 'Full 1-3'
    }).subscribe({
      next: (res: any) => {
        this.validationReport = res;
        this.clearDraft();
        this.validationStatus = 'done';
      },
      error: (err) => {
        this.validationReport = {
          status: 'FAIL', errors: 1, warnings: 0,
          message: 'camt.054.001.08', total_time_ms: 0,
          layer_status: {},
          details: [{
            severity: 'ERROR', layer: 0, code: 'SERVER_ERROR',
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

  copyFix(text: string, e: MouseEvent) {
    e.stopPropagation();
    navigator.clipboard.writeText(text).then(() => {
      this.snackBar.open('Copied!', '', { duration: 1500 });
    });
  }

  runValidationModal() {
    this.validateMessage();
  }

  private pushHistory() {
    if (this.xmlHistoryIdx < this.xmlHistory.length - 1) {
      this.xmlHistory.splice(this.xmlHistoryIdx + 1);
    }
    this.xmlHistory.push(this.generatedXml);
    if (this.xmlHistory.length > this.maxHistory) this.xmlHistory.shift();
    else this.xmlHistoryIdx++;
  }

  undoXml() {
    if (this.xmlHistoryIdx > 0) {
      this.xmlHistoryIdx--;
      this.generatedXml = this.xmlHistory[this.xmlHistoryIdx];
      this.refreshLineCount();
    }
  }

  redoXml() {
    if (this.xmlHistoryIdx < this.xmlHistory.length - 1) {
      this.xmlHistoryIdx++;
      this.generatedXml = this.xmlHistory[this.xmlHistoryIdx];
      this.refreshLineCount();
    }
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

  syncScroll(editor: any, gutter: any) {
    gutter.scrollTop = editor.scrollTop;
  }

  parseXmlToForm(xml: string) {
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
      const setVal = (f: string, v: string) => { if (v) patch[f] = v; };

      // 1. AppHdr
      const appHdr = getT('AppHdr');
      if (appHdr) {
        setVal('businessMsgId', tval('BizMsgIdr', appHdr));
        setVal('msgDefId', tval('MsgDefIdr', appHdr));
        setVal('creationDate', tval('CreDt', appHdr).replace('+00:00', '').replace('Z', ''));
        setVal('charSet', tval('CharSet', appHdr));
        setVal('copyDuplicate', tval('CpyDplct', appHdr));
        setVal('priority', tval('Prty', appHdr));
        setVal('possibleDuplicate', tval('PssblDplct', appHdr));
        const mktPrctc = getT('MktPrctc', appHdr);
        if (mktPrctc) {
          setVal('marketPractice', tval('Regy', mktPrctc));
          setVal('marketPracticeId', tval('Id', mktPrctc));
        }

        const mapPartyHead = (p: Element | null, prefix: string) => {
          if (!p) return;
          const fi = getT('FinInstnId', p);
          if (fi) {
            setVal(prefix + 'BIC', tval('BICFI', fi));
            setVal(prefix + 'LEI', tval('LEI', fi));
            const clr = getT('ClrSysMmbId', fi);
            if (clr) {
              setVal(prefix + 'MmbId', tval('MmbId', clr));
              setVal(prefix + 'ClrSysIdCd', tval('Cd', getT('ClrSysId', clr) || clr));
            }
          }
        };
        mapPartyHead(getT('Fr', appHdr), 'from');
        mapPartyHead(getT('To', appHdr), 'to');
      }

      // 2. GrpHdr
      const grpHdr = getT('GrpHdr');
      if (grpHdr) {
        setVal('msgId', tval('MsgId', grpHdr));
        setVal('creationDateTime', tval('CreDtTm', grpHdr).replace('+00:00', '').replace('Z', ''));
        const rcpt = getT('MsgRcpt', grpHdr);
        if (rcpt) {
            setVal('rcptName', tval('Nm', rcpt));
            const adr = getT('PstlAdr', rcpt);
            if (adr) {
                setVal('rcptCtry', tval('Ctry', adr));
                const lines = adr.getElementsByTagName('AdrLine');
                if (lines.length > 0) setVal('rcptAdrLine1', lines[0].textContent?.trim() || '');
                if (lines.length > 1) setVal('rcptAdrLine2', lines[1].textContent?.trim() || '');
            }
            const id = getT('Id', rcpt);
            if (id) {
                setVal('rcptOrgIdAnyBIC', tval('AnyBIC', getT('OrgId', id) || id));
                const prvt = getT('PrvtId', id);
                if (prvt) {
                    const dtPlc = getT('DtAndPlcOfBirth', prvt);
                    if (dtPlc) {
                        setVal('rcptPrvtIdBirthDt', tval('BirthDt', dtPlc));
                        setVal('rcptPrvtIdCityOfBirth', tval('CityOfBirth', dtPlc));
                        setVal('rcptPrvtIdCtryOfBirth', tval('CtryOfBirth', dtPlc));
                    }
                }
            }
            setVal('rcptContactNm', tval('Nm', getT('CtctDtls', rcpt) || rcpt));
        }
        setVal('originalBusinessQuery', tval('MsgId', getT('OrgnlBizQry', grpHdr) || grpHdr));
        setVal('additionalInformation', tval('AddtlInf', grpHdr));
      }

      // 3. Notification
      const ntf = getT('Ntfctn');
      if (ntf) {
        setVal('notificationId', tval('Id', ntf));
        const ntfPgn = getT('NtfctnPgntn', ntf);
        if (ntfPgn) {
          setVal('pageNumber', tval('PgNb', ntfPgn));
          patch.lastPageInd = tval('LastPgInd', ntfPgn) === 'true';
        }
        setVal('electronicSequenceNumber', tval('ElctrncSeqNb', ntf));
        setVal('reportingSequence', tval('RptgSeq', ntf));
        setVal('legalSeqNb', tval('LglSeqNb', ntf));
        setVal('creationDateTimeNtf', tval('CreDtTm', ntf).replace('+00:00', '').replace('Z', ''));
        
        const frToDt = getT('FrToDt', ntf);
        if (frToDt) {
          setVal('fromDateTm', tval('FrDtTm', frToDt).replace('+00:00', '').replace('Z', ''));
          setVal('toDateTm', tval('ToDtTm', frToDt).replace('+00:00', '').replace('Z', ''));
        }
        setVal('copyDuplicateIndicatorNtf', tval('CpyDplctInd', ntf));
        setVal('reportingSource', tval('Prtry', getT('RptgSrc', ntf) || ntf));

        // Account
        const acct = getT('Acct', ntf);
        if (acct) {
          setVal('accountIBAN', tval('IBAN', getT('Id', acct) || acct));
          setVal('accountTypeCd', tval('Cd', getT('Tp', acct) || acct));
          setVal('currency', tval('Ccy', acct));
          setVal('accountName', tval('Nm', acct));
          setVal('accountProxyId', tval('Id', getT('Prxy', acct) || acct));
          const ownr = getT('Ownr', acct);
          if (ownr) {
              setVal('accountOwnerName', tval('Nm', ownr));
              setVal('accountOwnerCtry', tval('Ctry', getT('PstlAdr', ownr) || ownr));
          }
          const svcr = getT('Svcr', acct);
          if (svcr) setVal('accountServicerBic', tval('BICFI', getT('FinInstnId', svcr) || svcr));
        }

        setVal('relatedAccountIBAN', tval('IBAN', getT('Id', getT('RltdAcct', ntf) || ntf) || ntf));
        setVal('additionalNotificationInfo', tval('AddtlNtfctnInf', ntf));

        // TxsSummry
        const summ = getT('TxsSummry', ntf);
        if (summ) {
            setVal('totalEntries', tval('NbOfNtries', getT('TtlNtries', summ) || summ));
            setVal('totalCreditEntries', tval('Sum', getT('TtlCdtNtries', summ) || summ));
            setVal('totalDebitEntries', tval('Sum', getT('TtlDbtNtries', summ) || summ));
        }

        // Entries
        const ntryEls = Array.from(ntf.querySelectorAll(':scope > Ntry'));
        if (ntryEls.length > 0) {
          this.entries.clear();
          ntryEls.forEach(el => {
            const g = this.createEntryGroup();
            const p: any = {};
            const tv = (t: string, parent: any = el) => getT(t, parent)?.textContent?.trim() || '';
            const sv = (f: string, v: string) => { if (v) p[f] = v; };

            sv('entryReference', tv('NtryRef'));
            sv('amount', tv('Amt'));
            sv('creditDebitIndicator', tv('CdtDbtInd'));
            p.reversalIndicator = tv('RvslInd') === 'true';
            sv('status', tv('Cd', getT('Sts', el) || el));
            sv('bookingDate', tv('DtTm', getT('BookgDt', el) || el).replace('+00:00', '').replace('Z', ''));
            sv('valueDate', tv('DtTm', getT('ValDt', el) || el).replace('+00:00', '').replace('Z', ''));
            sv('accountServicerRef', tv('AcctSvcrRef'));
            
            const bkTx = getT('BkTxCd', el);
            if (bkTx) {
                const domn = getT('Domn', bkTx);
                if (domn) {
                    sv('bankTxnDomain', tv('Cd', domn));
                    const fmly = getT('Fmly', domn);
                    if (fmly) {
                        sv('bankTxnFamily', tv('Cd', fmly));
                        sv('bankTxnCode', tv('SubFmlyCd', fmly));
                    }
                }
            }
            sv('charges', tv('TtlChrgsAndTaxAmt', getT('Chrgs', el) || el));

            const ntryDtls = getT('NtryDtls', el);
            if (ntryDtls) {
                const txDtls = getT('TxDtls', ntryDtls);
                if (txDtls) {
                    const refs = getT('Refs', txDtls);
                    if (refs) {
                        sv('instructionId', tv('InstrId', refs));
                        sv('endToEndId', tv('EndToEndId', refs));
                        sv('uetr', tv('UETR', refs));
                    }
                    sv('instructedAmount', tv('Amt', getT('InstdAmt', getT('AmtDtls', txDtls) || txDtls) || txDtls));
                    
                    const pties = getT('RltdPties', txDtls);
                    if (pties) {
                        sv('dbtrNm', tv('Nm', getT('Pty', getT('Dbtr', pties) || pties) || pties));
                        sv('ultmtDbtrNm', tv('Nm', getT('Pty', getT('UltmtDbtr', pties) || pties) || pties));
                        sv('cdtrNm', tv('Nm', getT('Pty', getT('Cdtr', pties) || pties) || pties));
                        sv('ultmtCdtrNm', tv('Nm', getT('Pty', getT('UltmtCdtr', pties) || pties) || pties));
                    }
                    const agts = getT('RltdAgts', txDtls);
                    if (agts) {
                        sv('dbtrAgtBic', tv('BICFI', getT('FinInstnId', getT('DbtrAgt', agts) || agts) || agts));
                        sv('cdtrAgtBic', tv('BICFI', getT('FinInstnId', getT('CdtrAgt', agts) || agts) || agts));
                    }
                    sv('purposeCode', tv('Cd', getT('Purp', txDtls) || txDtls));
                    sv('remittanceInfo', tv('Ustrd', getT('RmtInf', txDtls) || txDtls));
                }
            }
            p.waiverIndicator = tv('ComssnWvrInd') === 'true';
            sv('additionalEntryInfo', tv('AddtlNtryInf'));

            g.patchValue(p);
            this.entries.push(g);
          });
        }
      }

      this.form.patchValue(patch, { emitEvent: false });
    } catch (e) {
      console.error('Error parsing camt.054 XML:', e);
    } finally {
      this.isParsingXml = false;
    }
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
            formArray.at(index).patchValue(result.bic);
            formArray.at(index).markAsDirty();
          }
        } else {
          this.form.get(controlName)?.patchValue(result.bic);
          this.form.get(controlName)?.markAsDirty();
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

        targetGroup.get(controlName)?.patchValue(result.bic);
        targetGroup.get(controlName)?.markAsDirty();
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
  canUndoXml(): boolean { return this.xmlHistoryIdx > 0; }
  canRedoXml(): boolean { return this.xmlHistoryIdx < this.xmlHistory.length - 1; }
  viewXmlModal() { this.showValidationModal = false; }
  editXmlModal() { this.showValidationModal = false; }
}