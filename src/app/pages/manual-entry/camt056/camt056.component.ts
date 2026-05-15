import { Component, OnInit, OnDestroy, HostListener } from '@angular/core';
import { FormBuilder, FormGroup, FormArray, Validators, ReactiveFormsModule, FormsModule } from '@angular/forms';
import { CommonModule } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { MatIconModule } from '@angular/material/icon';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { ConfigService } from '../../../services/config.service';
import { FormattingService } from '../../../services/formatting.service';
import { UetrService } from '../../../services/uetr.service';

import { MatDialog, MatDialogModule } from '@angular/material/dialog';
import { BicSearchDialogComponent } from '../bic-search-dialog/bic-search-dialog.component';
import { debounceTime } from 'rxjs/operators';

@Component({
  selector: 'app-camt056',
  templateUrl: './camt056.component.html',
  styleUrls: ['./camt056.component.css'],
  standalone: true,
  imports: [CommonModule, ReactiveFormsModule, FormsModule, MatIconModule, MatSnackBarModule, MatTooltipModule, MatDialogModule]
})
export class Camt056Component implements OnInit, OnDestroy {
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
  // CBPR+ Specific Reasons
  cancellationReasons: string[] = ['DUPL', 'CUTA', 'UPAY', 'CUST', 'CURR', 'AGNT', 'TECH', 'FRAD', 'COVR', 'AM09', 'NARR'];

  // Collapsible sections
  expandedSections: { [key: string]: boolean } = {
    appHdr: true,
    assgnmt: true,
    underlying: true
  };

  // Validation state for modal
  showValidationModal = false;
  validationStatus: 'idle' | 'validating' | 'done' = 'idle';
  validationReport: any = null;
  validationExpandedIssue: any = null;

  showMaxLenWarning: { [key: string]: boolean } = {};

  private readonly DRAFT_KEY = 'draft_camt056';
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
    const hadDraft = this.loadDraft();
    if (hadDraft) {
      this.showDraftBanner = true;
      this.generateXml();
    }
    this.generateXml();
    this.pushHistory();

    this.form.valueChanges.pipe(debounceTime(300)).subscribe(() => {
      this.generateXml();
      this.scheduleDraftSave();
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
    const LEI_REG = /^[A-Z0-9]{18,18}[0-9]{2,2}$/;
    const UETR_REG = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

    this.form = this.fb.group({
      // BUSINESS APPLICATION HEADER
      fromBIC: ['SNDRBEBBXXX', [Validators.required, Validators.pattern(BIC_REG)]],
      fromLEI: ['', [Validators.pattern(LEI_REG)]],
      toBIC: ['RCVRBEBBXXX', [Validators.required, Validators.pattern(BIC_REG)]],
      toLEI: ['', [Validators.pattern(LEI_REG)]],
      businessMsgId: ['B' + Date.now().toString().slice(-13), [Validators.required, Validators.maxLength(35)]],
      msgDefId: ['camt.056.001.08', [Validators.required]],
      bizSvc: ['swift.cbprplus.02', [Validators.required]],
      creationDate: [this.isoNowWithTZ(), [Validators.required]],
      priority: ['NORM'],
      cpyDplct: [''], // [COPY, CODU, DUPL]
      pssblDplct: [false],
      mktPrctcRegy: [''],
      mktPrctcId: [''],
      
      // Clearing System Member IDs
      fromClrSysId: [''],
      fromMmbId: ['', [Validators.maxLength(35)]],
      toClrSysId: [''],
      toMmbId: ['', [Validators.maxLength(35)]],

      // Related Header
      rltdFromBIC: ['', [Validators.pattern(BIC_REG)]],
      rltdFromLEI: ['', [Validators.pattern(LEI_REG)]],
      rltdFromClrSysId: [''],
      rltdFromMmbId: ['', [Validators.maxLength(35)]],
      rltdToBIC: ['', [Validators.pattern(BIC_REG)]],
      rltdToLEI: ['', [Validators.pattern(LEI_REG)]],
      rltdToClrSysId: [''],
      rltdToMmbId: ['', [Validators.maxLength(35)]],
      rltdBizMsgIdr: ['', [Validators.maxLength(35)]],
      rltdMsgDefIdr: [''],
      rltdBizSvc: [''],
      rltdCreDt: [''],
      rltdCpyDplct: [''],
      rltdPrty: [''],

      // Assignment
      assgnmtId: ['ASG' + Date.now(), [Validators.required, Validators.maxLength(16)]],
      assgnrBic: ['SNDRBEBBXXX', [Validators.required, Validators.pattern(BIC_REG)]],
      assgnrClrSysId: [''],
      assgnrMmbId: ['', [Validators.maxLength(35)]],
      assgnrLEI: ['', [Validators.pattern(LEI_REG)]],
      assgneBic: ['RCVRBEBBXXX', [Validators.required, Validators.pattern(BIC_REG)]],
      assgneClrSysId: [''],
      assgneMmbId: ['', [Validators.maxLength(35)]],
      assgneLEI: ['', [Validators.pattern(LEI_REG)]],
      assgnmtCreDtTm: [this.isoNowWithTZ(), [Validators.required]],

      // Underlying Transaction (Strictly 1 for CBPR+)
      txInf: this.fb.group({
        cxlId: ['CXL' + Date.now(), [Validators.maxLength(16)]],
        
        // Case (Required)
        caseId: ['CAS' + Date.now(), [Validators.required, Validators.maxLength(16)]],
        caseCretrType: ['AGENT'], // AGENT or PARTY
        caseCretrAgtBic: ['SNDRBEBBXXX', [Validators.pattern(BIC_REG)]],
        caseCretrAgtClrSysId: [''],
        caseCretrAgtMmbId: ['', [Validators.maxLength(35)]],
        caseCretrAgtNm: [''],
        caseCretrAgtLEI: ['', [Validators.pattern(LEI_REG)]],
        caseCretrAgtAdrType: ['UNSTRUCTURED'], // STRUCTURED, UNSTRUCTURED, HYBRID
        caseCretrAgtBldgNb: [''],
        caseCretrAgtBldgNm: [''],
        caseCretrAgtStrtNm: [''],
        caseCretrAgtPstCd: [''],
        caseCretrAgtTwnNm: [''],
        caseCretrAgtCtry: [''],
        caseCretrAgtAdrLine1: [''],
        caseCretrAgtAdrLine2: [''],
        caseCretrPtyNm: [''],
        caseCretrPtyBic: [''],
        caseCretrPtyLei: ['', [Validators.pattern(LEI_REG)]],
        caseCretrPtyAdrType: ['UNSTRUCTURED'],
        caseCretrPtyBldgNb: [''],
        caseCretrPtyBldgNm: [''],
        caseCretrPtyStrtNm: [''],
        caseCretrPtyPstCd: [''],
        caseCretrPtyTwnNm: [''],
        caseCretrPtyCtry: [''],
        caseCretrPtyAdrLine1: [''],
        caseCretrPtyAdrLine2: [''],
        
        // Original Group Info (Required)
        orgnlMsgId: ['MSG' + Date.now().toString().slice(-13), [Validators.required, Validators.maxLength(35)]],
        orgnlMsgNmId: ['pacs.008.001.08', [Validators.required, Validators.maxLength(35)]],
        orgnlCreDtTm: [this.isoNowWithTZ()],
        
        // Transaction Reference
        orgnlInstrId: ['', [Validators.maxLength(35)]],
        orgnlEndToEndId: ['E2E' + Date.now().toString().slice(-13), [Validators.required, Validators.maxLength(35)]],
        orgnlTxId: ['', [Validators.maxLength(35)]],
        orgnlUetr: [this.uetr.generate(), [Validators.required, Validators.pattern(UETR_REG)]],
        orgnlClrSysRef: ['', [Validators.maxLength(35)]],
        
        // Movement Details
        orgnlIntrBkSttlmAmt: ['1000.00', [Validators.required, Validators.pattern(/^\d{1,14}(\.\d{1,5})?$/)]],
        orgnlIntrBkSttlmCcy: ['USD', [Validators.required, Validators.pattern(/^[A-Z]{3}$/)]],
        orgnlIntrBkSttlmDt: [this.isoDateToday(), [Validators.required]],
        
        // Cancellation Reason Originator
        cxlOrgtrNm: [''],
        cxlOrgtrIdType: ['ORG'], // ORG or PRVT
        // Org ID
        cxlOrgtrBic: [''],
        cxlOrgtrLei: ['', [Validators.pattern(LEI_REG)]],
        cxlOrgtrOrgOthrId: [''],
        cxlOrgtrOrgOthrSchme: [''],
        cxlOrgtrOrgOthrPrtry: [''],
        cxlOrgtrOrgOthrIssr: [''],
        // Prvt ID
        cxlOrgtrBirthDt: [''],
        cxlOrgtrPrvcOfBirth: [''],
        cxlOrgtrCityOfBirth: [''],
        cxlOrgtrCtryOfBirth: [''],
        cxlOrgtrPrvtOthrId: [''],
        cxlOrgtrPrvtOthrSchme: [''],
        cxlOrgtrPrvtOthrPrtry: [''],
        cxlOrgtrPrvtOthrIssr: [''],
        // Address
        cxlOrgtrAdrType: ['UNSTRUCTURED'],
        cxlOrgtrBldgNb: [''],
        cxlOrgtrBldgNm: [''],
        cxlOrgtrStrtNm: [''],
        cxlOrgtrPstCd: [''],
        cxlOrgtrTwnNm: [''],
        cxlOrgtrCtry: [''],
        cxlOrgtrAdrLine1: [''],
        cxlOrgtrAdrLine2: [''],
        cxlOrgtrCtryOfRes: [''],
        
        // Cancellation Reason (Required)
        cxlRsnCd: ['DUPL', [Validators.required]],
        cxlRsnAddtlInf: ['']
      })
    });
  }

  isoNowWithTZ(): string {
    const d = new Date();
    const iso = d.toISOString().split('.')[0];
    return iso + '+00:00';
  }

  isoDateToday(): string {
    return new Date().toISOString().split('T')[0];
  }

  refreshUetr() {
    this.form.get('txInf.orgnlUetr')?.setValue(this.uetr.generate());
  }

  toggleSection(section: string) {
    this.expandedSections[section] = !this.expandedSections[section];
  }

  onEditorChange(content: string, fromForm = false) {
    if (!this.isInternalChange && !fromForm) {
      this.pushHistory();
      // parseXmlToForm(content); // Implement if needed
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
    
    // AppHdr
    xml += t(1) + `<AppHdr xmlns="urn:iso:std:iso:20022:tech:xsd:head.001.001.02">\n`;
    xml += t(2) + `<Fr>\n` + t(3) + `<FIId>\n` + t(4) + `<FinInstnId>\n` + t(5) + `<BICFI>${this.e(v.fromBIC)}</BICFI>\n`;
    if (v.fromClrSysId || v.fromMmbId) {
      xml += t(5) + `<ClrSysMmbId>\n` + t(6) + `<ClrSysId>\n` + t(7) + `<Cd>${this.e(v.fromClrSysId)}</Cd>\n` + t(6) + `</ClrSysId>\n` + t(6) + `<MmbId>${this.e(v.fromMmbId)}</MmbId>\n` + t(5) + `</ClrSysMmbId>\n`;
    }
    if (v.fromLEI) xml += t(5) + `<LEI>${this.e(v.fromLEI)}</LEI>\n`;
    xml += t(4) + `</FinInstnId>\n` + t(3) + `</FIId>\n` + t(2) + `</Fr>\n`;
    
    xml += t(2) + `<To>\n` + t(3) + `<FIId>\n` + t(4) + `<FinInstnId>\n` + t(5) + `<BICFI>${this.e(v.toBIC)}</BICFI>\n`;
    if (v.toClrSysId || v.toMmbId) {
      xml += t(5) + `<ClrSysMmbId>\n` + t(6) + `<ClrSysId>\n` + t(7) + `<Cd>${this.e(v.toClrSysId)}</Cd>\n` + t(6) + `</ClrSysId>\n` + t(6) + `<MmbId>${this.e(v.toMmbId)}</MmbId>\n` + t(5) + `</ClrSysMmbId>\n`;
    }
    if (v.toLEI) xml += t(5) + `<LEI>${this.e(v.toLEI)}</LEI>\n`;
    xml += t(4) + `</FinInstnId>\n` + t(3) + `</FIId>\n` + t(2) + `</To>\n`;
    
    xml += t(2) + `<BizMsgIdr>${this.e(v.businessMsgId)}</BizMsgIdr>\n`;
    xml += t(2) + `<MsgDefIdr>${this.e(v.msgDefId)}</MsgDefIdr>\n`;
    xml += t(2) + `<BizSvc>${this.e(v.bizSvc)}</BizSvc>\n`;
    if (v.mktPrctcRegy && v.mktPrctcId) {
      xml += t(2) + `<MktPrctc>\n` + t(3) + `<Regy>${this.e(v.mktPrctcRegy)}</Regy>\n` + t(3) + `<Id>${this.e(v.mktPrctcId)}</Id>\n` + t(2) + `</MktPrctc>\n`;
    }
    xml += t(2) + `<CreDt>${this.e(v.creationDate)}</CreDt>\n`;
    if (v.cpyDplct) xml += t(2) + `<CpyDplct>${this.e(v.cpyDplct)}</CpyDplct>\n`;
    if (v.pssblDplct) xml += t(2) + `<PssblDplct>true</PssblDplct>\n`;
    if (v.priority) xml += t(2) + `<Prty>${this.e(v.priority)}</Prty>\n`;
    
    // Rltd
    if (v.rltdFromBIC || v.rltdToBIC || v.rltdFromMmbId || v.rltdToMmbId) {
      xml += t(2) + `<Rltd>\n`;
      xml += t(3) + `<Fr>\n` + t(4) + `<FIId>\n` + t(5) + `<FinInstnId>\n`;
      if (v.rltdFromBIC) xml += t(6) + `<BICFI>${this.e(v.rltdFromBIC)}</BICFI>\n`;
      if (v.rltdFromClrSysId || v.rltdFromMmbId) {
        xml += t(6) + `<ClrSysMmbId>\n` + t(7) + `<ClrSysId>\n` + t(8) + `<Cd>${this.e(v.rltdFromClrSysId)}</Cd>\n` + t(7) + `</ClrSysId>\n` + t(7) + `<MmbId>${this.e(v.rltdFromMmbId)}</MmbId>\n` + t(6) + `</ClrSysMmbId>\n`;
      }
      if (v.rltdFromLEI) xml += t(6) + `<LEI>${this.e(v.rltdFromLEI)}</LEI>\n`;
      xml += t(5) + `</FinInstnId>\n` + t(4) + `</FIId>\n` + t(3) + `</Fr>\n`;
      
      xml += t(3) + `<To>\n` + t(4) + `<FIId>\n` + t(5) + `<FinInstnId>\n`;
      if (v.rltdToBIC) xml += t(6) + `<BICFI>${this.e(v.rltdToBIC)}</BICFI>\n`;
      if (v.rltdToClrSysId || v.rltdToMmbId) {
        xml += t(6) + `<ClrSysMmbId>\n` + t(7) + `<ClrSysId>\n` + t(8) + `<Cd>${this.e(v.rltdToClrSysId)}</Cd>\n` + t(7) + `</ClrSysId>\n` + t(7) + `<MmbId>${this.e(v.rltdToMmbId)}</MmbId>\n` + t(6) + `</ClrSysMmbId>\n`;
      }
      if (v.rltdToLEI) xml += t(6) + `<LEI>${this.e(v.rltdToLEI)}</LEI>\n`;
      xml += t(5) + `</FinInstnId>\n` + t(4) + `</FIId>\n` + t(3) + `</To>\n`;
      
      if (v.rltdBizMsgIdr) xml += t(3) + `<BizMsgIdr>${this.e(v.rltdBizMsgIdr)}</BizMsgIdr>\n`;
      if (v.rltdMsgDefIdr) xml += t(3) + `<MsgDefIdr>${this.e(v.rltdMsgDefIdr)}</MsgDefIdr>\n`;
      if (v.rltdBizSvc) xml += t(3) + `<BizSvc>${this.e(v.rltdBizSvc)}</BizSvc>\n`;
      if (v.rltdCreDt) xml += t(3) + `<CreDt>${this.e(v.rltdCreDt)}</CreDt>\n`;
      if (v.rltdCpyDplct) xml += t(3) + `<CpyDplct>${this.e(v.rltdCpyDplct)}</CpyDplct>\n`;
      if (v.rltdPrty) xml += t(3) + `<Prty>${this.e(v.rltdPrty)}</Prty>\n`;
      
      xml += t(2) + `</Rltd>\n`;
    }

    xml += t(1) + `</AppHdr>\n`;

    // Document
    xml += t(1) + `<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.056.001.08">\n`;
    xml += t(2) + `<FIToFIPmtCxlReq>\n`;
    
    // Assignment
    xml += t(2) + `<Assgnmt>\n`;
    xml += t(3) + `<Id>${this.e(v.assgnmtId)}</Id>\n`;
    xml += t(3) + `<Assgnr>\n` + t(4) + `<Agt>\n` + t(5) + `<FinInstnId>\n` + t(6) + `<BICFI>${this.e(v.assgnrBic)}</BICFI>\n`;
    if (v.assgnrClrSysId || v.assgnrMmbId) {
      xml += t(6) + `<ClrSysMmbId>\n` + t(7) + `<ClrSysId>\n` + t(8) + `<Cd>${this.e(v.assgnrClrSysId)}</Cd>\n` + t(7) + `</ClrSysId>\n` + t(7) + `<MmbId>${this.e(v.assgnrMmbId)}</MmbId>\n` + t(6) + `</ClrSysMmbId>\n`;
    }
    if (v.assgnrLEI) xml += t(6) + `<LEI>${this.e(v.assgnrLEI)}</LEI>\n`;
    xml += t(5) + `</FinInstnId>\n` + t(4) + `</Agt>\n` + t(3) + `</Assgnr>\n`;
    
    xml += t(3) + `<Assgne>\n` + t(4) + `<Agt>\n` + t(5) + `<FinInstnId>\n` + t(6) + `<BICFI>${this.e(v.assgneBic)}</BICFI>\n`;
    if (v.assgneClrSysId || v.assgneMmbId) {
      xml += t(6) + `<ClrSysMmbId>\n` + t(7) + `<ClrSysId>\n` + t(8) + `<Cd>${this.e(v.assgneClrSysId)}</Cd>\n` + t(7) + `</ClrSysId>\n` + t(7) + `<MmbId>${this.e(v.assgneMmbId)}</MmbId>\n` + t(6) + `</ClrSysMmbId>\n`;
    }
    if (v.assgneLEI) xml += t(6) + `<LEI>${this.e(v.assgneLEI)}</LEI>\n`;
    xml += t(5) + `</FinInstnId>\n` + t(4) + `</Agt>\n` + t(3) + `</Assgne>\n`;
    
    xml += t(3) + `<CreDtTm>${this.e(v.assgnmtCreDtTm)}</CreDtTm>\n`;
    xml += t(2) + `</Assgnmt>\n`;

    // Underlying
    const tx = v.txInf;
    xml += t(3) + `<Undrlyg>\n`;
    xml += t(4) + `<TxInf>\n`;
    if (tx.cxlId) xml += t(5) + `<CxlId>${this.e(tx.cxlId)}</CxlId>\n`;
    
    // Case
    xml += t(4) + `<Case>\n`;
    xml += t(5) + `<Id>${this.e(tx.caseId)}</Id>\n`;
    xml += t(5) + `<Cretr>\n`;
    if (tx.caseCretrType === 'AGENT') {
      xml += t(5) + `<Agt>\n` + t(6) + `<FinInstnId>\n`;
      if (tx.caseCretrAgtBic) xml += t(7) + `<BICFI>${this.e(tx.caseCretrAgtBic)}</BICFI>\n`;
      if (tx.caseCretrAgtClrSysId || tx.caseCretrAgtMmbId) {
        xml += t(7) + `<ClrSysMmbId>\n` + t(8) + `<ClrSysId>\n` + t(9) + `<Cd>${this.e(tx.caseCretrAgtClrSysId)}</Cd>\n` + t(8) + `</ClrSysId>\n` + t(8) + `<MmbId>${this.e(tx.caseCretrAgtMmbId)}</MmbId>\n` + t(7) + `</ClrSysMmbId>\n`;
      }
      if (tx.caseCretrAgtLEI) xml += t(7) + `<LEI>${this.e(tx.caseCretrAgtLEI)}</LEI>\n`;
      if (tx.caseCretrAgtNm) xml += t(7) + `<Nm>${this.e(tx.caseCretrAgtNm)}</Nm>\n`;
      if (tx.caseCretrAgtCtry || tx.caseCretrAgtAdrLine1) {
        xml += t(7) + `<PstlAdr>\n`;
        const type = tx.caseCretrAgtAdrType;
        if (type === 'STRUCTURED' || type === 'HYBRID') {
          if (tx.caseCretrAgtStrtNm) xml += t(8) + `<StrtNm>${this.e(tx.caseCretrAgtStrtNm)}</StrtNm>\n`;
          if (tx.caseCretrAgtBldgNb) xml += t(8) + `<BldgNb>${this.e(tx.caseCretrAgtBldgNb)}</BldgNb>\n`;
          if (tx.caseCretrAgtBldgNm) xml += t(8) + `<BldgNm>${this.e(tx.caseCretrAgtBldgNm)}</BldgNm>\n`;
          if (tx.caseCretrAgtPstCd) xml += t(8) + `<PstCd>${this.e(tx.caseCretrAgtPstCd)}</PstCd>\n`;
          if (tx.caseCretrAgtTwnNm) xml += t(8) + `<TwnNm>${this.e(tx.caseCretrAgtTwnNm)}</TwnNm>\n`;
        }
        if (tx.caseCretrAgtCtry) xml += t(8) + `<Ctry>${this.e(tx.caseCretrAgtCtry)}</Ctry>\n`;
        if (type === 'UNSTRUCTURED' || type === 'HYBRID') {
          if (tx.caseCretrAgtAdrLine1) xml += t(8) + `<AdrLine>${this.e(tx.caseCretrAgtAdrLine1)}</AdrLine>\n`;
          if (tx.caseCretrAgtAdrLine2) xml += t(8) + `<AdrLine>${this.e(tx.caseCretrAgtAdrLine2)}</AdrLine>\n`;
        }
        xml += t(7) + `</PstlAdr>\n`;
      }
      xml += t(6) + `</FinInstnId>\n` + t(5) + `</Agt>\n`;
    } else {
      xml += t(5) + `<Pty>\n`;
      if (tx.caseCretrPtyNm) xml += t(6) + `<Nm>${this.e(tx.caseCretrPtyNm)}</Nm>\n`;
      if (tx.caseCretrPtyCtry || tx.caseCretrPtyAdrLine1) {
        xml += t(6) + `<PstlAdr>\n`;
        const type = tx.caseCretrPtyAdrType;
        if (type === 'STRUCTURED' || type === 'HYBRID') {
          if (tx.caseCretrPtyStrtNm) xml += t(7) + `<StrtNm>${this.e(tx.caseCretrPtyStrtNm)}</StrtNm>\n`;
          if (tx.caseCretrPtyBldgNb) xml += t(7) + `<BldgNb>${this.e(tx.caseCretrPtyBldgNb)}</BldgNb>\n`;
          if (tx.caseCretrPtyBldgNm) xml += t(7) + `<BldgNm>${this.e(tx.caseCretrPtyBldgNm)}</BldgNm>\n`;
          if (tx.caseCretrPtyPstCd) xml += t(7) + `<PstCd>${this.e(tx.caseCretrPtyPstCd)}</PstCd>\n`;
          if (tx.caseCretrPtyTwnNm) xml += t(7) + `<TwnNm>${this.e(tx.caseCretrPtyTwnNm)}</TwnNm>\n`;
        }
        if (tx.caseCretrPtyCtry) xml += t(7) + `<Ctry>${this.e(tx.caseCretrPtyCtry)}</Ctry>\n`;
        if (type === 'UNSTRUCTURED' || type === 'HYBRID') {
          if (tx.caseCretrPtyAdrLine1) xml += t(7) + `<AdrLine>${this.e(tx.caseCretrPtyAdrLine1)}</AdrLine>\n`;
          if (tx.caseCretrPtyAdrLine2) xml += t(7) + `<AdrLine>${this.e(tx.caseCretrPtyAdrLine2)}</AdrLine>\n`;
        }
        xml += t(6) + `</PstlAdr>\n`;
      }
      if (tx.caseCretrPtyBic || tx.caseCretrPtyLei) {
        xml += t(6) + `<Id>\n` + t(7) + `<OrgId>\n`;
        if (tx.caseCretrPtyLei) xml += t(8) + `<LEI>${this.e(tx.caseCretrPtyLei)}</LEI>\n`;
        xml += t(8) + `</OrgId>\n` + t(7) + `</Id>\n`;
      }
      xml += t(6) + `</Pty>\n`;
    }
    xml += t(5) + `</Cretr>\n`;
    xml += t(4) + `</Case>\n`;

    // Original Group Info
    xml += t(5) + `<OrgnlGrpInf>\n`;
    xml += t(6) + `<OrgnlMsgId>${this.e(tx.orgnlMsgId)}</OrgnlMsgId>\n`;
    xml += t(6) + `<OrgnlMsgNmId>${this.e(tx.orgnlMsgNmId)}</OrgnlMsgNmId>\n`;
    if (tx.orgnlCreDtTm) xml += t(6) + `<OrgnlCreDtTm>${this.e(tx.orgnlCreDtTm)}</OrgnlCreDtTm>\n`;
    xml += t(5) + `</OrgnlGrpInf>\n`;

    if (tx.orgnlInstrId) xml += t(5) + `<OrgnlInstrId>${this.e(tx.orgnlInstrId)}</OrgnlInstrId>\n`;
    xml += t(5) + `<OrgnlEndToEndId>${this.e(tx.orgnlEndToEndId)}</OrgnlEndToEndId>\n`;
    if (tx.orgnlTxId) xml += t(5) + `<OrgnlTxId>${this.e(tx.orgnlTxId)}</OrgnlTxId>\n`;
    xml += t(5) + `<OrgnlUETR>${this.e(tx.orgnlUetr)}</OrgnlUETR>\n`;
    if (tx.orgnlClrSysRef) xml += t(5) + `<OrgnlClrSysRef>${this.e(tx.orgnlClrSysRef)}</OrgnlClrSysRef>\n`;

    xml += t(5) + `<OrgnlIntrBkSttlmAmt Ccy="${this.e(tx.orgnlIntrBkSttlmCcy)}">${this.formatting.formatAmount(tx.orgnlIntrBkSttlmAmt, tx.orgnlIntrBkSttlmCcy)}</OrgnlIntrBkSttlmAmt>\n`;
    xml += t(5) + `<OrgnlIntrBkSttlmDt>${this.e(tx.orgnlIntrBkSttlmDt)}</OrgnlIntrBkSttlmDt>\n`;

    // Cancellation Reason
    xml += t(5) + `<CxlRsnInf>\n`;
    if (tx.cxlOrgtrNm || tx.cxlOrgtrBic || tx.cxlOrgtrLei || tx.cxlOrgtrCtry) {
      xml += t(6) + `<Orgtr>\n`;
      if (tx.cxlOrgtrNm) xml += t(7) + `<Nm>${this.e(tx.cxlOrgtrNm)}</Nm>\n`;
      
      if (tx.cxlOrgtrCtry || tx.cxlOrgtrAdrLine1) {
        xml += t(7) + `<PstlAdr>\n`;
        const type = tx.cxlOrgtrAdrType;
        if (type === 'STRUCTURED' || type === 'HYBRID') {
          if (tx.cxlOrgtrStrtNm) xml += t(8) + `<StrtNm>${this.e(tx.cxlOrgtrStrtNm)}</StrtNm>\n`;
          if (tx.cxlOrgtrBldgNb) xml += t(8) + `<BldgNb>${this.e(tx.cxlOrgtrBldgNb)}</BldgNb>\n`;
          if (tx.cxlOrgtrBldgNm) xml += t(8) + `<BldgNm>${this.e(tx.cxlOrgtrBldgNm)}</BldgNm>\n`;
          if (tx.cxlOrgtrPstCd) xml += t(8) + `<PstCd>${this.e(tx.cxlOrgtrPstCd)}</PstCd>\n`;
          if (tx.cxlOrgtrTwnNm) xml += t(8) + `<TwnNm>${this.e(tx.cxlOrgtrTwnNm)}</TwnNm>\n`;
        }
        if (tx.cxlOrgtrCtry) xml += t(8) + `<Ctry>${this.e(tx.cxlOrgtrCtry)}</Ctry>\n`;
        if (type === 'UNSTRUCTURED' || type === 'HYBRID') {
          if (tx.cxlOrgtrAdrLine1) xml += t(8) + `<AdrLine>${this.e(tx.cxlOrgtrAdrLine1)}</AdrLine>\n`;
          if (tx.cxlOrgtrAdrLine2) xml += t(8) + `<AdrLine>${this.e(tx.cxlOrgtrAdrLine2)}</AdrLine>\n`;
        }
        xml += t(7) + `</PstlAdr>\n`;
      }

      if (tx.cxlOrgtrBic || tx.cxlOrgtrLei || tx.cxlOrgtrOrgOthrId || tx.cxlOrgtrBirthDt || tx.cxlOrgtrPrvtOthrId) {
        xml += t(7) + `<Id>\n`;
        if (tx.cxlOrgtrIdType === 'ORG') {
          xml += t(8) + `<OrgId>\n`;
          if (tx.cxlOrgtrBic) xml += t(9) + `<AnyBIC>${this.e(tx.cxlOrgtrBic)}</AnyBIC>\n`;
          if (tx.cxlOrgtrLei) xml += t(9) + `<LEI>${this.e(tx.cxlOrgtrLei)}</LEI>\n`;
          if (tx.cxlOrgtrOrgOthrId) {
            xml += t(9) + `<Othr>\n` + t(10) + `<Id>${this.e(tx.cxlOrgtrOrgOthrId)}</Id>\n`;
            if (tx.cxlOrgtrOrgOthrSchme || tx.cxlOrgtrOrgOthrPrtry) {
              xml += t(10) + `<SchmeNm>\n`;
              if (tx.cxlOrgtrOrgOthrSchme) xml += t(11) + `<Cd>${this.e(tx.cxlOrgtrOrgOthrSchme)}</Cd>\n`;
              if (tx.cxlOrgtrOrgOthrPrtry) xml += t(11) + `<Prtry>${this.e(tx.cxlOrgtrOrgOthrPrtry)}</Prtry>\n`;
              xml += t(10) + `</SchmeNm>\n`;
            }
            if (tx.cxlOrgtrOrgOthrIssr) xml += t(10) + `<Issr>${this.e(tx.cxlOrgtrOrgOthrIssr)}</Issr>\n`;
            xml += t(9) + `</Othr>\n`;
          }
          xml += t(8) + `</OrgId>\n`;
        } else {
          xml += t(8) + `<PrvtId>\n`;
          if (tx.cxlOrgtrBirthDt || tx.cxlOrgtrPrvcOfBirth || tx.cxlOrgtrCityOfBirth || tx.cxlOrgtrCtryOfBirth) {
            xml += t(9) + `<DtAndPlcOfBirth>\n`;
            if (tx.cxlOrgtrBirthDt) xml += t(10) + `<BirthDt>${this.e(tx.cxlOrgtrBirthDt)}</BirthDt>\n`;
            if (tx.cxlOrgtrPrvcOfBirth) xml += t(10) + `<PrvcOfBirth>${this.e(tx.cxlOrgtrPrvcOfBirth)}</PrvcOfBirth>\n`;
            if (tx.cxlOrgtrCityOfBirth) xml += t(10) + `<CityOfBirth>${this.e(tx.cxlOrgtrCityOfBirth)}</CityOfBirth>\n`;
            if (tx.cxlOrgtrCtryOfBirth) xml += t(10) + `<CtryOfBirth>${this.e(tx.cxlOrgtrCtryOfBirth)}</CtryOfBirth>\n`;
            xml += t(9) + `</DtAndPlcOfBirth>\n`;
          }
          if (tx.cxlOrgtrPrvtOthrId) {
            xml += t(9) + `<Othr>\n` + t(10) + `<Id>${this.e(tx.cxlOrgtrPrvtOthrId)}</Id>\n`;
            if (tx.cxlOrgtrPrvtOthrSchme || tx.cxlOrgtrPrvtOthrPrtry) {
              xml += t(10) + `<SchmeNm>\n`;
              if (tx.cxlOrgtrPrvtOthrSchme) xml += t(11) + `<Cd>${this.e(tx.cxlOrgtrPrvtOthrSchme)}</Cd>\n`;
              if (tx.cxlOrgtrPrvtOthrPrtry) xml += t(11) + `<Prtry>${this.e(tx.cxlOrgtrPrvtOthrPrtry)}</Prtry>\n`;
              xml += t(10) + `</SchmeNm>\n`;
            }
            if (tx.cxlOrgtrPrvtOthrIssr) xml += t(10) + `<Issr>${this.e(tx.cxlOrgtrPrvtOthrIssr)}</Issr>\n`;
            xml += t(9) + `</Othr>\n`;
          }
          xml += t(8) + `</PrvtId>\n`;
        }
        xml += t(7) + `</Id>\n`;
      }
      if (tx.cxlOrgtrCtryOfRes) xml += t(7) + `<CtryOfRes>${this.e(tx.cxlOrgtrCtryOfRes)}</CtryOfRes>\n`;
      xml += t(6) + `</Orgtr>\n`;
    }
    xml += t(6) + `<Rsn>\n` + t(7) + `<Cd>${this.e(tx.cxlRsnCd)}</Cd>\n` + t(6) + `</Rsn>\n`;
    if (tx.cxlRsnAddtlInf) xml += t(6) + `<AddtlInf>${this.e(tx.cxlRsnAddtlInf)}</AddtlInf>\n`;
    xml += t(5) + `</CxlRsnInf>\n`;

    xml += t(4) + `</TxInf>\n`;
    xml += t(3) + `</Undrlyg>\n`;

    xml += t(2) + `</FIToFIPmtCxlReq>\n`;
    xml += t(1) + `</Document>\n`;
    xml += `</BusMsgEnvlp>`;

    this.generatedXml = xml;
    this.refreshLineCount();
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

    if (name.toLowerCase().includes('bic')) {
      const up = target.value.toUpperCase();
      if (target.value !== up) {
        target.value = up;
        const control = this.form.get(name);
        if (control) control.patchValue(up, { emitEvent: false });
      }
    }
  }

  err(f: string, group?: any): string | null {
    const c = group ? group.get(f) : this.form.get(f);
    if (!c || c.valid) return null;
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
    a.download = `camt056-${Date.now()}.xml`;
    a.click();
  }

  validateMessage() {
    this.showValidationModal = true;
    this.validationStatus = 'validating';
    this.validationReport = null;
    this.validationExpandedIssue = null;

    this.http.post(this.config.getApiUrl('/validate'), {
      xml_content: this.generatedXml,
      message_type: 'camt.056.001.08',
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
          message: 'camt.056.001.08', total_time_ms: 0,
          layer_status: {},
          details: [{
            severity: 'ERROR', layer: 0, code: 'SERVER_ERROR',
            path: '', message: 'Validation failed.'
          }]
        };
        this.validationStatus = 'done';
      }
    });
  }

  closeValidationModal() {
    this.showValidationModal = false;
  }

  getValidationLayers(): string[] {
    if (!this.validationReport?.layer_status) return [];
    return Object.keys(this.validationReport.layer_status).sort();
  }

  getLayerName(k: string): string {
    const names: Record<string, string> = { '1': 'Syntax & Format', '2': 'Schema Validation', '3': 'Business Rules' };
    return names[k] ?? `Layer ${k}`;
  }

  getSimplifiedLayerName(k: string): string {
    const names: Record<string, string> = { '1': 'Syntax & Format', '2': 'Schema Validation', '3': 'Business Rules' };
    return names[k] ?? `Layer ${k}`;
  }

  getLayerStatus(k: string): string { return this.validationReport?.layer_status?.[k]?.status ?? ''; }
  getLayerTime(k: string): number { return this.validationReport?.layer_status?.[k]?.time ?? 0; }
  isLayerPass(k: string) { return this.getLayerStatus(k).includes('✅'); }
  isLayerFail(k: string) { return this.getLayerStatus(k).includes('❌'); }
  isLayerWarn(k: string) { return this.getLayerStatus(k).includes('⚠'); }
  getValidationIssues(): any[] { return this.validationReport?.details ?? []; }
  toggleValidationIssue(issue: any) { this.validationExpandedIssue = this.validationExpandedIssue === issue ? null : issue; }
  copyFix(text: string, e: MouseEvent) {
    e.stopPropagation();
    navigator.clipboard.writeText(text).then(() => { this.snackBar.open('Copied!', '', { duration: 1500 }); });
  }

  private pushHistory() {
    if (this.xmlHistoryIdx < this.xmlHistory.length - 1) this.xmlHistory.splice(this.xmlHistoryIdx + 1);
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
      this.snackBar.open('Format Error', '', { duration: 3000 });
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
        group.get(controlName)?.patchValue(result.bic);
        group.get(controlName)?.markAsDirty();
      }
    });
  }

  syncScroll(editor: any, gutter: any) {
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
