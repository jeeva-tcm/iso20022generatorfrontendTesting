import { CommonModule } from '@angular/common';
import { Component, OnInit, OnDestroy, HostListener } from '@angular/core';
import { FormBuilder, FormGroup, FormsModule, ReactiveFormsModule, Validators } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { Router } from '@angular/router';
import { ConfigService } from '../../../services/config.service';
import { FormattingService } from '../../../services/formatting.service';
import { AddressValidatorService, AddressValidationResult } from '../../../services/address-validator.service';
import { UetrService } from '../../../services/uetr.service';

import { MatDialog, MatDialogModule } from '@angular/material/dialog';
import { BicSearchDialogComponent } from '../bic-search-dialog/bic-search-dialog.component';
import { debounceTime } from 'rxjs/operators';

@Component({
  selector: 'app-pacs3',
  standalone: true,
  imports: [CommonModule, ReactiveFormsModule, FormsModule, MatIconModule, MatSnackBarModule, MatTooltipModule, MatDialogModule],
  templateUrl: './pacs3.component.html',
  styleUrl: './pacs3.component.css'
})
export class Pacs3Component implements OnInit, OnDestroy {
  form!: FormGroup;
  generatedXml = '';
  currentTab: 'form' | 'preview' = 'form';
  isParsingXml = false;
  editorLineCount: number[] = [];

  /** UETR Refresh state */
  uetrError: string | null = null;
  uetrSuccess: string | null = null;
  private uetrSuccessTimer: any;

  // Undo/Redo History
  private xmlHistory: string[] = [];
  private xmlHistoryIdx = -1;
  private maxHistory = 50;
  private isInternalChange = false;

  currencies: string[] = [];
  countries: string[] = [];
  categoryPurposes: string[] = [];
  purposes: string[] = [];
  sttlmMethods = ['INDA', 'INGA'];
  chargeBearers = ['SHAR', 'DEBT', 'CRED', 'SLEV'];
  // Duplicate import and component definition removed – kept earlier import and @Component

  isAddressValid = true;

  agentPrefixes = ['instgAgt', 'instdAgt', 'dbtrAgt', 'cdtrAgt',
    'prvsInstgAgt1', 'prvsInstgAgt2', 'prvsInstgAgt3',
    'intrmyAgt1', 'intrmyAgt2', 'intrmyAgt3', 'dbtr', 'cdtr', 'orgnlCdtrAgt'];

  partyPrefixes = ['ultmtDbtr', 'ultmtCdtr', 'initgPty', 'instgPty', 'orgnlDbtr', 'orgnlCdtrSchme'];

  private readonly DRAFT_KEY = 'draft_pacs003';
  private draftSaveTimer: ReturnType<typeof setTimeout> | null = null;
  showDraftBanner = false;
  isClearingDraft = false;

  constructor(
    private fb: FormBuilder,
    private http: HttpClient,
    private config: ConfigService,
    private snackBar: MatSnackBar,
    private router: Router,
    private addressValidator: AddressValidatorService,
    private uetrService: UetrService,
    private formatting: FormattingService,
    private dialog: MatDialog
  ) { }

  ngOnInit() {
    this.fetchCodelists();
    this.buildForm();
    this.generateXml();
    this.onEditorChange(this.generatedXml, true);
    // Auto-sync AppHdr Fr/To BICs with GrpHdr InstgAgt/InstdAgt
    this.form.get('fromBic')?.valueChanges.subscribe(v => {
      this.form.patchValue({ instgAgtBic: v }, { emitEvent: false });
    });
    this.form.get('toBic')?.valueChanges.subscribe(v => {
      this.form.patchValue({ instdAgtBic: v }, { emitEvent: false });
    });
    this.form.get('instgAgtBic')?.valueChanges.subscribe(v => {
      this.form.patchValue({ fromBic: v }, { emitEvent: false });
    });
    this.form.get('instdAgtBic')?.valueChanges.subscribe(v => {
      this.form.patchValue({ toBic: v }, { emitEvent: false });
    });
    const hadDraft = this.loadDraft();
    if (hadDraft) {
      this.showDraftBanner = true;
      this.generateXml();
    }

    this.form.valueChanges.pipe(debounceTime(300)).subscribe(() => {
      this.updateConditionalValidators();
      this.updateClearingSystemValidation();
      this.generateXml();
      this.scheduleDraftSave();
    });

    // Init history
    this.pushHistory();

    // Enforce XOR logic for Payment Type Information choices
    const choiceFields = ['svcLvl', 'lclInstrm', 'ctgyPurp'];
    choiceFields.forEach(prefix => {
      this.form.get(prefix + 'Cd')?.valueChanges.subscribe(val => {
        if (val && this.form.get(prefix + 'Prtry')?.value) {
          this.form.get(prefix + 'Prtry')?.setValue('', { emitEvent: false });
          this.generateXml();
        }
      });
      this.form.get(prefix + 'Prtry')?.valueChanges.subscribe(val => {
        if (val && this.form.get(prefix + 'Cd')?.value) {
          this.form.get(prefix + 'Cd')?.setValue('', { emitEvent: false });
          this.generateXml();
        }
      });
    });
  }

  private updateClearingSystemValidation() {
    const systems = [...this.agentPrefixes, ...this.partyPrefixes].map(p => {
      const isParty = this.partyPrefixes.includes(p);
      const prefix = isParty ? p + 'Org' : p;
      return this.form.get(prefix + 'ClrSysCd')?.value?.trim()?.toUpperCase();
    });

    const anyT2 = systems.includes('T2');
    const anyCHAPS = systems.includes('CHAPS');
    const anyCHIPS = systems.includes('CHIPS');
    const anyFED = systems.includes('FED');

    const currencyCtrl = this.form.get('currency');
    const ccy = currencyCtrl?.value;

    // T2 Validation
    if (anyT2 && ccy !== 'EUR' && ccy !== '') {
      if (!currencyCtrl?.hasError('target2')) {
        currencyCtrl?.setErrors({ ...currencyCtrl.errors, target2: true });
      }
    } else if (currencyCtrl?.hasError('target2')) {
      const errors = { ...currencyCtrl.errors };
      delete errors['target2'];
      currencyCtrl.setErrors(Object.keys(errors).length ? errors : null);
    }

    // CHAPS Validation
    if (anyCHAPS && ccy !== 'GBP' && ccy !== '') {
      if (!currencyCtrl?.hasError('chaps')) {
        currencyCtrl?.setErrors({ ...currencyCtrl.errors, chaps: true });
      }
    } else if (currencyCtrl?.hasError('chaps')) {
      const errors = { ...currencyCtrl.errors };
      delete errors['chaps'];
      currencyCtrl.setErrors(Object.keys(errors).length ? errors : null);
    }

    // CHIPS Validation
    if (anyCHIPS && ccy !== 'USD' && ccy !== '') {
      if (!currencyCtrl?.hasError('chips')) {
        currencyCtrl?.setErrors({ ...currencyCtrl.errors, chips: true });
      }
    } else if (currencyCtrl?.hasError('chips')) {
      const errors = { ...currencyCtrl.errors };
      delete errors['chips'];
      currencyCtrl.setErrors(Object.keys(errors).length ? errors : null);
    }

    // FED Validation
    if (anyFED && ccy !== 'USD' && ccy !== '') {
      if (!currencyCtrl?.hasError('fed')) {
        currencyCtrl?.setErrors({ ...currencyCtrl.errors, fed: true });
      }
    } else if (currencyCtrl?.hasError('fed')) {
      const errors = { ...currencyCtrl.errors };
      delete errors['fed'];
      currencyCtrl.setErrors(Object.keys(errors).length ? errors : null);
    }

    // ClrSysRef Validation (Forbidden if no standard clearing system)
    const standardSystems = ['T2', 'CHAPS', 'CHIPS', 'FED', 'RTGS'];
    const hasStandardClearing = systems.some(s => standardSystems.includes(s));
    const clrRefCtrl = this.form.get('clrSysRef');
    if (clrRefCtrl?.value?.trim() && !hasStandardClearing) {
      if (!clrRefCtrl.hasError('forbidden')) {
        clrRefCtrl.setErrors({ ...clrRefCtrl.errors, forbidden: true });
      }
    } else if (clrRefCtrl?.hasError('forbidden')) {
      const errors = { ...clrRefCtrl.errors };
      delete errors['forbidden'];
      clrRefCtrl.setErrors(Object.keys(errors).length ? errors : null);
    }
  }

  fetchCodelists() {
    this.http.get<any>(this.config.getApiUrl('/codelists/currency')).subscribe({
      next: (res) => {
        if (res && res.codes) {
          this.currencies = res.codes;
        }
      },
      error: (err) => console.error('Failed to load currencies', err)
    });
    this.http.get<any>(this.config.getApiUrl('/codelists/country')).subscribe({
      next: (res) => {
        if (res && res.codes) {
          this.countries = res.codes;
        }
      },
      error: (err) => console.error('Failed to load countries', err)
    });

    this.http.get<any>(this.config.getApiUrl('/codelists/ctgyPurp')).subscribe({
      next: (res) => {
        if (res && res.codes && res.codes.length > 0) {
          this.categoryPurposes = res.codes;
        } else {
          // Fallback to commonly used ISO 20022 codes
          this.categoryPurposes = ['SALA', 'TAXS', 'SUPP', 'PENS', 'LOAN', 'DIVD', 'CASH', 'COLL', 'INTC', 'OTHR'];
        }
      },
      error: (err) => {
        console.error('Failed to load category purposes', err);
        this.categoryPurposes = ['SALA', 'TAXS', 'SUPP', 'PENS', 'LOAN', 'DIVD', 'CASH', 'COLL', 'INTC', 'OTHR'];
      }
    });
    this.http.get<any>(this.config.getApiUrl('/codelists/purp')).subscribe({
      next: (res) => { if (res && res.codes) this.purposes = res.codes; },
      error: (err) => console.error('Failed to load purposes', err)
    });

  }

  updateConditionalValidators() {
    const ADDR_PATTERN = Validators.pattern(/^[a-zA-Z0-9\/\-\?:\(\)\.,\+' ]+$/);
    [...this.agentPrefixes, ...this.partyPrefixes].forEach(p => {
      const addrType = this.form.get(p + 'AddrType')?.value;
      const ctryCtrl = this.form.get(p + 'Ctry');
      const twnNmCtrl = this.form.get(p + 'TwnNm');

      if (addrType && addrType !== 'none') {
        if (!ctryCtrl?.hasValidator(Validators.required)) {
          ctryCtrl?.setValidators([Validators.required, Validators.pattern(/^[A-Z]{2,2}$/)]);
          ctryCtrl?.updateValueAndValidity({ emitEvent: false });
        }
      } else {
        if (ctryCtrl?.hasValidator(Validators.required)) {
          ctryCtrl?.clearValidators();
          ctryCtrl?.setValidators([Validators.pattern(/^[A-Z]{2,2}$/)]);
          ctryCtrl?.updateValueAndValidity({ emitEvent: false });
        }
      }

      if (addrType === 'structured' || addrType === 'hybrid') {
        if (!twnNmCtrl?.hasValidator(Validators.required)) {
          twnNmCtrl?.setValidators([Validators.required, Validators.maxLength(35), ADDR_PATTERN]);
          twnNmCtrl?.updateValueAndValidity({ emitEvent: false });
        }
      } else {
        if (twnNmCtrl?.hasValidator(Validators.required)) {
          twnNmCtrl?.clearValidators();
          twnNmCtrl?.setValidators([Validators.maxLength(35), ADDR_PATTERN]);
          twnNmCtrl?.updateValueAndValidity({ emitEvent: false });
        }
      }
    });

    // Party Identification Validators
    this.partyPrefixes.forEach(p => {
      const idType = this.form.get(p + 'IdType')?.value;

      // Org Id Validators
      const orgOthrId = this.form.get(p + 'OrgOthrId')?.value;
      const orgOthrSchme = this.form.get(p + 'OrgOthrSchmeNmCd');
      if (idType === 'org' && orgOthrId?.trim()) {
        orgOthrSchme?.setValidators([Validators.required, Validators.maxLength(4)]);
      } else {
        orgOthrSchme?.clearValidators();
        orgOthrSchme?.setValidators([Validators.maxLength(4)]);
      }
      orgOthrSchme?.updateValueAndValidity({ emitEvent: false });

      // Prvt Id Validators
      const prvtOthrId = this.form.get(p + 'PrvtOthrId')?.value;
      const prvtOthrSchme = this.form.get(p + 'PrvtOthrSchmeNmCd');
      if (idType === 'prvt' && prvtOthrId?.trim()) {
        prvtOthrSchme?.setValidators([Validators.required, Validators.maxLength(4)]);
      } else {
        prvtOthrSchme?.clearValidators();
        prvtOthrSchme?.setValidators([Validators.maxLength(4)]);
      }
      prvtOthrSchme?.updateValueAndValidity({ emitEvent: false });

      // AnyBIC Validator
      const anyBic = this.form.get(p + 'OrgAnyBIC');
      if (idType === 'org') {
        anyBic?.setValidators([Validators.pattern(/^[A-Z0-9]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$/)]);
      } else {
        anyBic?.clearValidators();
      }
      anyBic?.updateValueAndValidity({ emitEvent: false });

      // LEI Validator
      const lei = this.form.get(p + 'OrgLEI');
      if (idType === 'org') {
        lei?.setValidators([Validators.pattern(/^[A-Z0-9]{18}[0-9]{2}$/)]);
      } else {
        lei?.clearValidators();
      }
      lei?.updateValueAndValidity({ emitEvent: false });

      // Birth Date Validator
      const dob = this.form.get(p + 'PrvtDtAndPlcOfBirthDt');
      if (idType === 'prvt') {
        dob?.setValidators([Validators.pattern(/^\d{4}-\d{2}-\d{2}$/)]);
      }
      dob?.updateValueAndValidity({ emitEvent: false });

      // Birth Country Validator
      const bCtry = this.form.get(p + 'PrvtDtAndPlcOfBirthCtry');
      if (idType === 'prvt') {
        bCtry?.setValidators([Validators.pattern(/^[A-Z]{2,2}$/)]);
      }
      bCtry?.updateValueAndValidity({ emitEvent: false });
    });


    const rmtType = this.form.get('rmtInfType')?.value;
    const ustrd = this.form.get('rmtInfUstrd');
    const strdRef = this.form.get('rmtInfStrdCdtrRef');
    const strdRefType = this.form.get('rmtInfStrdCdtrRefType');
    const addtlRmtInf = this.form.get('rmtInfStrdAddtlRmtInf');

    if (rmtType === 'ustrd') {
      ustrd?.setValidators([Validators.required, Validators.maxLength(140), Validators.pattern(/^[a-zA-Z0-9\/\-\?:\(\)\.,\+' ]+$/)]);
      strdRef?.clearValidators();
      strdRefType?.clearValidators();
      addtlRmtInf?.clearValidators();
    } else if (rmtType === 'strd') {
      ustrd?.clearValidators();
      if (strdRefType?.value === 'SCOR') {
        strdRef?.setValidators([Validators.required, Validators.maxLength(35), Validators.pattern(/^RF[0-9]{2}[A-Z0-9]*$/i)]);
      } else if (strdRefType?.value) {
        strdRef?.setValidators([Validators.required, Validators.maxLength(35)]);
      } else {
        strdRef?.clearValidators();
      }
    } else {
      ustrd?.clearValidators();
      strdRef?.clearValidators();
      strdRefType?.clearValidators();
      addtlRmtInf?.clearValidators();
    }
    ustrd?.updateValueAndValidity({ emitEvent: false });
    strdRef?.updateValueAndValidity({ emitEvent: false });


    // Agent & Party Clearing System Validators
    [...this.agentPrefixes].forEach(p => {
      const isParty = this.partyPrefixes.includes(p);
      const prefix = isParty ? p + 'Org' : p;

      const name = this.form.get(p + 'Name');
      const lei = this.form.get(isParty ? p + 'OrgLEI' : p + 'Lei');
      const clrCd = this.form.get(prefix + 'ClrSysCd');
      const clrMmb = this.form.get(prefix + 'ClrSysMmbId');
      const acct = this.form.get(p + 'Acct');

      // ClrSys inter-dependency
      if (clrCd?.value?.trim()) {
        clrMmb?.setValidators([Validators.required, Validators.maxLength(35)]);
      } else {
        clrMmb?.clearValidators();
        clrMmb?.setValidators([Validators.maxLength(35)]);
      }
      if (clrMmb?.value?.trim()) {
        clrCd?.setValidators([Validators.required, Validators.maxLength(5)]);
      } else {
        clrCd?.clearValidators();
        clrCd?.setValidators([Validators.maxLength(5)]);
      }

      clrCd?.updateValueAndValidity({ emitEvent: false });
      clrMmb?.updateValueAndValidity({ emitEvent: false });

      if (!isParty) {
        // LEI Pattern for Agents
        lei?.setValidators([Validators.pattern(/^[A-Z0-9]{18}[0-9]{2}$/)]);
        lei?.updateValueAndValidity({ emitEvent: false });

        // Account Pattern for Agents
        acct?.setValidators([Validators.pattern(/^[A-Z0-9]{5,34}$/)]);
        acct?.updateValueAndValidity({ emitEvent: false });

        // At least one identifier rule for Agents
        const bic = this.form.get(p + 'Bic')?.value;
        if (!bic?.trim() && (lei?.value?.trim() || name?.value?.trim() || clrMmb?.value?.trim() || acct?.value?.trim())) {
          if (!name?.value?.trim() && !lei?.value?.trim() && !clrMmb?.value?.trim()) {
            name?.setErrors({ noIdentifier: true });
          }
        }
      } else if (isParty && ['dbtr', 'cdtr'].includes(p)) {
        // Party-specific rule
        const bic = this.form.get(p + 'OrgAnyBIC')?.value;
        const otherId = this.form.get(p + 'OrgOthrId')?.value;
        if (this.form.get(p + 'IdType')?.value === 'org') {
          if (!name?.value?.trim() && !bic?.trim() && !lei?.value?.trim() && !clrMmb?.value?.trim() && !otherId?.trim()) {
            if (this.form.get(p + 'Acct')?.value?.trim()) {
              name?.setErrors({ noIdentifier: true });
            }
          }
        }
      }
    });
  }

  private buildForm() {
    const BIC = [Validators.required, Validators.pattern(/^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$/)];
    const BIC_OPT = [Validators.pattern(/^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$/)];
    // Safe character set: letters, digits, space, . , ( ) ' - only. No & @ ! # $ etc.
    const SAFE_NAME = Validators.pattern(/^[a-zA-Z0-9 .,()'\-]+$/);
    // ISO 20022 MX allowed character pattern for address fields
    const ADDR_PATTERN = Validators.pattern(/^[a-zA-Z0-9\/\-\?:\(\)\.,\+' ]+$/);
    const c: any = {
      fromBic: ['BBBBUS33XXX', BIC], toBic: ['CCCCGB2LXXX', BIC], bizMsgId: ['MSG-2026-B-001', [Validators.required, Validators.maxLength(35)]],
      msgId: ['MSG-2026-B-001', [Validators.required, Validators.maxLength(35)]], creDtTm: [this.isoNow(), Validators.required],
      fromMmbId: ['', [Validators.maxLength(35)]], fromClrSysId: ['', [Validators.maxLength(5)]], fromLei: ['', [Validators.pattern(/^[A-Z0-9]{18}[0-9]{2}$/)]],
      toMmbId: ['', [Validators.maxLength(35)]], toClrSysId: ['', [Validators.maxLength(5)]], toLei: ['', [Validators.pattern(/^[A-Z0-9]{18}[0-9]{2}$/)]],
      mktPrctc: [''], regyId: ['', Validators.maxLength(35)],
      cpyDplct: [''], pssblDplct: ['false'], appHdrPrty: [''], rltd: [''], rltdCharSet: [''],
      sttlmAcctId: ['', Validators.maxLength(34)], sttlmAcctOthrId: ['', Validators.maxLength(35)],
      sttlmAcctTpCd: [''], sttlmAcctTpPrtry: [''], sttlmAcctCcy: [''], sttlmAcctNm: [''],
      sttlmAcctPrxyTpCd: [''], sttlmAcctPrxyTpPrtry: [''], sttlmAcctPrxyId: [''],
      nbOfTxs: ['1', [Validators.required, Validators.pattern(/^[1-9]\d{0,14}$/)]], sttlmMtd: ['INDA', Validators.required],
      instgAgtBic: ['BBBBUS33XXX', BIC], instdAgtBic: ['CCCCGB2LXXX', BIC],
      instrId: ['INSTR-001', [Validators.required, Validators.maxLength(35)]], endToEndId: ['E2E-001', [Validators.required, Validators.maxLength(35)]],
      txId: ['TX-001', [Validators.required, Validators.maxLength(35)]],
      uetr: ['550e8400-e29b-41d4-a716-446655440000', [Validators.required, Validators.pattern(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/)]],
      clrSysRef: ['', [Validators.pattern(/^[A-Za-z0-9]{1,35}$/)]],
      amount: ['1500.00', [Validators.required, Validators.pattern(/^\d{1,13}(\.\d{1,5})?$/)]], currency: ['USD', Validators.required],
      sttlmDt: [new Date().toISOString().split('T')[0], [Validators.required, Validators.pattern(/^\d{4}-\d{2}-\d{2}$/)]], 
      sttlmPrty: ['', [Validators.pattern(/^(HIGH|NORM|URGT)$/)]],
      instrPrty: ['', [Validators.pattern(/^(HIGH|NORM)$/)]],
      clrChanl: ['', [Validators.pattern(/^(BOOK|MPNS|RTGS|RTNS)$/)]],
      svcLvlCd: ['', [Validators.pattern(/^[A-Z0-9]{1,4}$/)]],
      svcLvlPrtry: ['', [Validators.pattern(/^[A-Za-z0-9 .\-]{1,35}$/)]],
      svcLvlCd2: ['', [Validators.pattern(/^[A-Z0-9]{1,4}$/)]],
      svcLvlPrtry2: ['', [Validators.pattern(/^[A-Za-z0-9 .\-]{1,35}$/)]],
      svcLvlCd3: ['', [Validators.pattern(/^[A-Z0-9]{1,4}$/)]],
      svcLvlPrtry3: ['', [Validators.pattern(/^[A-Za-z0-9 .\-]{1,35}$/)]],
      chrgBr: ['SHAR', Validators.required],
      dbtrName: ['Debtor Name', [Validators.required, Validators.maxLength(140), SAFE_NAME]],
      dbtrOrgAnyBIC: ['BBBBUS33XXX', BIC],
      dbtrAgtBic: ['BBBBUS33XXX', BIC],
      cdtrName: ['Creditor Name', [Validators.required, Validators.maxLength(140), SAFE_NAME]],
      cdtrOrgAnyBIC: ['CCCCGB2LXXX', BIC],
      cdtrAgtBic: ['CCCCGB2LXXX', BIC],
      ultmtDbtrName: ['', [Validators.maxLength(140), SAFE_NAME]],
      ultmtCdtrName: ['', [Validators.maxLength(140), SAFE_NAME]],
      initgPtyName: ['', [Validators.maxLength(140), SAFE_NAME]],
      prvsInstgAgt1Bic: ['', BIC_OPT], prvsInstgAgt2Bic: ['', BIC_OPT], prvsInstgAgt3Bic: ['', BIC_OPT],
      intrmyAgt1Bic: ['', BIC_OPT], intrmyAgt2Bic: ['', BIC_OPT], intrmyAgt3Bic: ['', BIC_OPT],
      purpCd: [''],
      ctgyPurpCd: ['', [Validators.pattern(/^[A-Z]{4,4}$/)]],
      ctgyPurpPrtry: ['', [Validators.pattern(/^[A-Za-z0-9 .\-]{1,35}$/)]],
      lclInstrmCd: ['', [Validators.pattern(/^[A-Z0-9]{1,4}$/)]],
      lclInstrmPrtry: ['', [Validators.pattern(/^[A-Za-z0-9 .\-]{1,35}$/)]],
      seqTp: ['', [Validators.pattern(/^(FNAL|FRST|OOFF|RCUR|RPRE)$/)]],
      dbtrCtryOfRes: ['', Validators.pattern(/^[A-Z]{2,2}$/)],
      cdtrCtryOfRes: ['', Validators.pattern(/^[A-Z]{2,2}$/)],
      initgPtyCtryOfRes: ['', Validators.pattern(/^[A-Z]{2,2}$/)],
      instgPtyCtryOfRes: ['', Validators.pattern(/^[A-Z]{2,2}$/)],
      orgnlDbtrCtryOfRes: ['', Validators.pattern(/^[A-Z]{2,2}$/)],
      orgnlCdtrSchmeCtryOfRes: ['', Validators.pattern(/^[A-Z]{2,2}$/)],
      dbtDtTm: [''],
      cdtDtTm: [''],
      instdAmt: ['', [Validators.pattern(/^\d{1,18}(\.\d{1,5})?$/)]],
      instdAmtCcy: [''],
      xchgRate: ['', [Validators.pattern(/^\d{1,11}(\.\d{1,10})?$/)]],
      chrgsInfAmt: ['', [Validators.pattern(/^\d{1,18}(\.\d{1,5})?$/)]],
      chrgsInfCcy: [''],
      chrgsInfAgtBic: ['', BIC_OPT],
      chrgsInfAmt2: ['', [Validators.pattern(/^\d{1,18}(\.\d{1,5})?$/)]],
      chrgsInfCcy2: [''],
      chrgsInfAgtBic2: ['', BIC_OPT],
      chrgsInfAmt3: ['', [Validators.pattern(/^\d{1,18}(\.\d{1,5})?$/)]],
      chrgsInfCcy3: [''],
      chrgsInfAgtBic3: ['', BIC_OPT],
      reqdColltnDt: [new Date().toISOString().split('T')[0], [Validators.required, Validators.pattern(/^\d{4}-\d{2}-\d{2}$/)]],
      mndtId: ['', Validators.maxLength(35)],
      dtOfSgntr: ['', Validators.pattern(/^\d{4}-\d{2}-\d{2}$/)],
      amdmntInd: ['false'],
      orgnlMndtId: ['', Validators.maxLength(35)],
      orgnlCdtrSchmeIdNm: ['', Validators.maxLength(140)],
      orgnlCdtrAgtAcct: ['', Validators.maxLength(34)],
      orgnlCdtrAgtAcctTpCd: [''], orgnlCdtrAgtAcctTpPrtry: [''], orgnlCdtrAgtAcctCcy: [''], orgnlCdtrAgtAcctNm: [''],
      orgnlCdtrAgtAcctPrxyTpCd: [''], orgnlCdtrAgtAcctPrxyTpPrtry: [''], orgnlCdtrAgtAcctPrxyId: [''],
      mndtRltdInfCtryOfRes: ['', Validators.pattern(/^[A-Z]{2,2}$/)],
      rgltryRptg1Code: ['', Validators.maxLength(10)],
      rgltryRptg1Inf: ['', Validators.maxLength(35)],
      rgltryRptg2Code: ['', Validators.maxLength(10)], rgltryRptg2Inf: ['', Validators.maxLength(35)],
      rgltryRptg3Code: ['', Validators.maxLength(10)], rgltryRptg3Inf: ['', Validators.maxLength(35)],
      rltdRmtInf1Ref: ['', Validators.maxLength(35)],
      rltdRmtInf2Ref: ['', Validators.maxLength(35)],
      rltdRmtInf3Ref: ['', Validators.maxLength(35)],
      
      rmtInfType: ['none'],
      rmtInfUstrd: ['', [Validators.maxLength(140), Validators.pattern(/^[a-zA-Z0-9\/\-\?:\(\)\.,\+' ]+$/)]],
      rmtInfStrdCdtrRefType: [''],
      rmtInfStrdCdtrRef: ['', Validators.maxLength(35)],
      rmtInfStrdAddtlRmtInf: ['', [Validators.maxLength(140), Validators.pattern(/^[a-zA-Z0-9\/\-\?:\(\)\.,\+' ]+$/)]],
      rmtInfStrdRfrdDocNb: ['', Validators.maxLength(35)],
      rmtInfStrdRfrdDocCd: [''],
      rmtInfStrdRfrdDocAmt: ['', [Validators.pattern(/^\d{1,18}(\.\d{1,5})?$/)]],
      rmtInfStrdInvcrNm: ['', Validators.maxLength(140)],
      rmtInfStrdInvceeNm: ['', Validators.maxLength(140)],
      rmtInfStrdTaxRmtId: ['', Validators.maxLength(35)],
      rmtInfStrdGrnshmtId: ['', Validators.maxLength(35)],

      // Account fields
      dbtrAcct: ['471932901234'],
      cdtrAcct: ['GB29NWBK60161331926819'],
      dbtrAgtAcct: [''],
      cdtrAgtAcct: [''],
      // Instructions for Creditor Agent (0..2)
      instrForCdtrAgt1Cd: [''], instrForCdtrAgt1InfTxt: ['', [Validators.minLength(1), Validators.maxLength(140), ADDR_PATTERN]],
      instrForCdtrAgt2Cd: [''], instrForCdtrAgt2InfTxt: ['', [Validators.minLength(1), Validators.maxLength(140), ADDR_PATTERN]],
      // Instructions for Next Agent (0..6)
      instrForNxtAgt1Cd: [''], instrForNxtAgt1InfTxt: ['', [Validators.minLength(1), Validators.maxLength(35), ADDR_PATTERN]],
      instrForNxtAgt2Cd: [''], instrForNxtAgt2InfTxt: ['', [Validators.minLength(1), Validators.maxLength(35), ADDR_PATTERN]],
      instrForNxtAgt3Cd: [''], instrForNxtAgt3InfTxt: ['', [Validators.minLength(1), Validators.maxLength(35), ADDR_PATTERN]],
      instrForNxtAgt4Cd: [''], instrForNxtAgt4InfTxt: ['', [Validators.minLength(1), Validators.maxLength(35), ADDR_PATTERN]],
      instrForNxtAgt5Cd: [''], instrForNxtAgt5InfTxt: ['', [Validators.minLength(1), Validators.maxLength(35), ADDR_PATTERN]],
      instrForNxtAgt6Cd: [''], instrForNxtAgt6InfTxt: ['', [Validators.minLength(1), Validators.maxLength(35), ADDR_PATTERN]],
    };

    [...this.agentPrefixes, ...this.partyPrefixes].forEach(p => {
      // Common fields for all agents and parties (used in partyForm template)
      // Only the mandatory parties that ship with full address data default to 'hybrid'.
      // Everyone else defaults to 'none' so the address section is hidden until the user
      // explicitly opts in — avoids spurious "Town/Country required" errors on unused agents.
      if (!c[p + 'AddrType']) {
        c[p + 'AddrType'] = ['dbtr', 'cdtr', 'dbtrAgt', 'cdtrAgt'].includes(p) ? 'hybrid' : 'none';
      }
      if (!c[p + 'AdrLine1']) c[p + 'AdrLine1'] = ['', [Validators.maxLength(70), ADDR_PATTERN]];
      if (!c[p + 'AdrLine2']) c[p + 'AdrLine2'] = ['', [Validators.maxLength(70), ADDR_PATTERN]];
      if (!c[p + 'Dept']) c[p + 'Dept'] = ['', [Validators.maxLength(70), ADDR_PATTERN]];
      if (!c[p + 'SubDept']) c[p + 'SubDept'] = ['', [Validators.maxLength(70), ADDR_PATTERN]];
      if (!c[p + 'StrtNm']) c[p + 'StrtNm'] = ['', [Validators.maxLength(70), ADDR_PATTERN]];
      if (!c[p + 'BldgNb']) c[p + 'BldgNb'] = ['', [Validators.maxLength(16), ADDR_PATTERN]];
      if (!c[p + 'BldgNm']) c[p + 'BldgNm'] = ['', [Validators.maxLength(35), ADDR_PATTERN]];
      if (!c[p + 'Flr']) c[p + 'Flr'] = ['', [Validators.maxLength(70), ADDR_PATTERN]];
      if (!c[p + 'PstBx']) c[p + 'PstBx'] = ['', [Validators.maxLength(16), ADDR_PATTERN]];
      if (!c[p + 'Room']) c[p + 'Room'] = ['', [Validators.maxLength(70), ADDR_PATTERN]];
      if (!c[p + 'PstCd']) c[p + 'PstCd'] = ['', [Validators.maxLength(16), ADDR_PATTERN]];
      if (!c[p + 'TwnNm']) c[p + 'TwnNm'] = ['', [Validators.maxLength(35), ADDR_PATTERN]];
      if (!c[p + 'CtrySubDvsn']) c[p + 'CtrySubDvsn'] = ['', [Validators.maxLength(35), ADDR_PATTERN]];
      if (!c[p + 'Ctry']) c[p + 'Ctry'] = ['', Validators.pattern(/^[A-Z]{2,2}$/)];
      if (!c[p + 'TwnLctnNm']) c[p + 'TwnLctnNm'] = ['', [Validators.maxLength(35), ADDR_PATTERN]];
      if (!c[p + 'DstrctNm']) c[p + 'DstrctNm'] = ['', [Validators.maxLength(35), ADDR_PATTERN]];
      if (!c[p + 'AdrTpCd']) c[p + 'AdrTpCd'] = [''];
      if (!c[p + 'AdrTpPrtry']) c[p + 'AdrTpPrtry'] = ['', Validators.maxLength(35)];
      if (!c[p + 'Name']) c[p + 'Name'] = ['', [Validators.maxLength(140), SAFE_NAME]];
      if (!c[p + 'Acct']) c[p + 'Acct'] = ['', [Validators.pattern(/^[A-Z0-9]{5,34}$/)]];
      if (!c[p + 'CtryOfRes']) c[p + 'CtryOfRes'] = ['', Validators.pattern(/^[A-Z]{2,2}$/)];

      // Agent-specific fields
      if (!c[p + 'Bic']) c[p + 'Bic'] = ['', BIC_OPT];
      if (!c[p + 'Lei']) c[p + 'Lei'] = ['', [Validators.pattern(/^[A-Z0-9]{18}[0-9]{2}$/)]];
      if (!c[p + 'ClrSysCd']) c[p + 'ClrSysCd'] = ['', Validators.maxLength(5)];
      if (!c[p + 'ClrSysMmbId']) c[p + 'ClrSysMmbId'] = ['', Validators.maxLength(35)];

      // Party-specific fields
      if (!c[p + 'IdType']) c[p + 'IdType'] = 'none';
      if (!c[p + 'OrgAnyBIC']) c[p + 'OrgAnyBIC'] = ['', BIC_OPT];
      if (!c[p + 'OrgLEI']) c[p + 'OrgLEI'] = ['', [Validators.pattern(/^[A-Z0-9]{18}[0-9]{2}$/)]];
      if (!c[p + 'OrgClrSysCd']) c[p + 'OrgClrSysCd'] = ['', Validators.maxLength(5)];
      if (!c[p + 'OrgClrSysMmbId']) c[p + 'OrgClrSysMmbId'] = ['', Validators.maxLength(35)];
      if (!c[p + 'OrgOthrId']) c[p + 'OrgOthrId'] = ['', Validators.maxLength(35)];
      if (!c[p + 'OrgOthrSchmeNmCd']) c[p + 'OrgOthrSchmeNmCd'] = ['', Validators.maxLength(4)];
      if (!c[p + 'OrgOthrSchmeNmPrtry']) c[p + 'OrgOthrSchmeNmPrtry'] = ['', Validators.maxLength(35)];
      if (!c[p + 'OrgOthrIssr']) c[p + 'OrgOthrIssr'] = ['', Validators.maxLength(35)];
      if (!c[p + 'PrvtDtAndPlcOfBirthDt']) c[p + 'PrvtDtAndPlcOfBirthDt'] = ['', [Validators.pattern(/^\d{4}-\d{2}-\d{2}$/)]];
      if (!c[p + 'PrvtDtAndPlcOfBirthPrvc']) c[p + 'PrvtDtAndPlcOfBirthPrvc'] = ['', Validators.maxLength(35)];
      if (!c[p + 'PrvtDtAndPlcOfBirthCity']) c[p + 'PrvtDtAndPlcOfBirthCity'] = ['', Validators.maxLength(35)];
      if (!c[p + 'PrvtDtAndPlcOfBirthCtry']) c[p + 'PrvtDtAndPlcOfBirthCtry'] = ['', Validators.pattern(/^[A-Z]{2,2}$/)];
      if (!c[p + 'PrvtOthrId']) c[p + 'PrvtOthrId'] = ['', Validators.maxLength(35)];
      if (!c[p + 'PrvtOthrSchmeNmCd']) c[p + 'PrvtOthrSchmeNmCd'] = ['', Validators.maxLength(4)];
      if (!c[p + 'PrvtOthrSchmeNmPrtry']) c[p + 'PrvtOthrSchmeNmPrtry'] = ['', Validators.maxLength(35)];
      if (!c[p + 'PrvtOthrIssr']) c[p + 'PrvtOthrIssr'] = ['', Validators.maxLength(35)];
    });

    // Add static address data to resolve "Name and Address must always be present together"
    // AND the rule: "If Address Line is present and any other element is present, then Town Name and Country are mandatory"
    c['dbtrAddrType'] = ['hybrid'];
    c['dbtrCtry'] = ['US', Validators.pattern(/^[A-Z]{2,2}$/)];
    c['dbtrTwnNm'] = ['New York', [Validators.maxLength(35), ADDR_PATTERN]];
    c['dbtrAdrLine1'] = ['123 Wall Street', [Validators.maxLength(70), ADDR_PATTERN]];

    c['cdtrAddrType'] = ['hybrid'];
    c['cdtrCtry'] = ['GB', Validators.pattern(/^[A-Z]{2,2}$/)];
    c['cdtrTwnNm'] = ['London', [Validators.maxLength(35), ADDR_PATTERN]];
    c['cdtrAdrLine1'] = ['456 Canary Wharf', [Validators.maxLength(70), ADDR_PATTERN]];

    // Also for Agents if required by some rules
    c['dbtrAgtAddrType'] = ['hybrid'];
    c['dbtrAgtCtry'] = ['US', Validators.pattern(/^[A-Z]{2,2}$/)];
    c['dbtrAgtTwnNm'] = ['New York', [Validators.maxLength(35), ADDR_PATTERN]];
    c['dbtrAgtAdrLine1'] = ['789 Banker Lane', [Validators.maxLength(70), ADDR_PATTERN]];

    c['cdtrAgtAddrType'] = ['hybrid'];
    c['cdtrAgtCtry'] = ['GB', Validators.pattern(/^[A-Z]{2,2}$/)];
    c['cdtrAgtTwnNm'] = ['London', [Validators.maxLength(35), ADDR_PATTERN]];
    c['cdtrAgtAdrLine1'] = ['321 Finance Square', [Validators.maxLength(70), ADDR_PATTERN]];

    // Set default names for mandatory agents
    c['dbtrAgtName'] = ['Debtor Agent', [Validators.required, Validators.maxLength(140), SAFE_NAME]];
    c['cdtrAgtName'] = ['Creditor Agent', [Validators.required, Validators.maxLength(140), SAFE_NAME]];

    this.form = this.fb.group(c);
  }

  /**
   * UETR Refresh — Rule 1-8 implementation.
   * Generates a new UUID v4, validates format, checks session uniqueness,
   * patches the form control, shows success/error feedback.
   */
  refreshUetr(): void {
    this.uetrError = null;
    this.uetrSuccess = null;
    clearTimeout(this.uetrSuccessTimer);

    const prevUetr = this.form.get('uetr')?.value || '';

    // Rule 1 & 7: Generate a new UETR that differs from previous
    const newUetr = this.uetrService.generate();

    // Rule 3: Validate UUID v4 format
    if (!UetrService.UUID_V4_PATTERN.test(newUetr)) {
      this.uetrError = 'Invalid UETR format';
      return;
    }

    // Rule 4 & 7: Must not match previous UETR in same message
    if (newUetr === prevUetr) {
      this.uetrError = 'Duplicate UETR detected across messages';
      return;
    }

    // Unregister old UETR, patch form with new one
    if (prevUetr) this.uetrService.unregister(prevUetr);
    this.form.get('uetr')?.setValue(newUetr);
    this.form.get('uetr')?.markAsTouched();

    // Rule 2: Immediate UI update — success feedback (auto-clears after 3s)
    this.uetrSuccess = 'UETR refreshed successfully';
    this.uetrSuccessTimer = setTimeout(() => { this.uetrSuccess = null; }, 3000);
  }

  /**
   * Validate a manually-entered UETR value on blur.
   * Rule 8: manually edited values must still match UUID v4 format.
   */
  validateManualUetr(): void {
    const val = (this.form.get('uetr')?.value || '').trim();
    this.uetrError = null;
    if (!val) return;
    if (!UetrService.UUID_V4_PATTERN.test(val)) {
      this.uetrError = 'Invalid UETR format';
      return;
    }
    // Check for duplicate (cross-message within session)
    const result = this.uetrService.validate(val);
    if (result === 'duplicate') {
      this.uetrError = 'Duplicate UETR detected across messages';
    }
  }

  /**
   * Handle paste event on UETR field.
   * Waits one tick for the pasted value to reach the form control,
   * lowercases it, then validates.
   */
  onUetrPaste(_event: ClipboardEvent): void {
    setTimeout(() => {
      const ctrl = this.form.get('uetr');
      if (!ctrl) return;
      const raw = (ctrl.value || '').trim().toLowerCase();
      ctrl.setValue(raw, { emitEvent: true });
      ctrl.markAsTouched();
      this.validateManualUetr();
    }, 0);
  }

  err(f: string): string | null {
    const c = this.form.get(f);
    if (this.leiError[f]) return this.leiError[f];
    // Remove touched/dirty requirement to show errors immediately
    if (!c || c.valid) return null;

    if (c.errors?.['required']) return 'Required field.';
    if (c.errors?.['maxlength']) return `Max ${c.errors['maxlength'].requiredLength} chars.`;
    if (c.errors?.['pattern']) {
      // Precedence: If we're at the limit and pattern is invalid, let the limit hint take precedence
      if (this.showMaxLenWarning[f]) {
        const val = c.value?.toString() || '';
        const limitError = c.errors?.['maxlength']?.requiredLength;
        if (limitError && val.length >= limitError) return null;
        // Check manually for fields without formal maxLength validator if needed
        if (f.toLowerCase().includes('bic') && val.length >= 11) return null;
        if (f === 'uetr' && val.length >= 36) return null;
      }

      const fl = f.toLowerCase();
      if (fl.includes('bic')) return 'Valid 8 or 11-char BIC required.';
      if (fl.includes('iban')) return 'Valid 34-char IBAN required.';
      if (fl.includes('uetr')) return 'Invalid UETR format';
      if (fl.includes('amount') || fl.includes('amt')) return 'Max 18 digits, up to 5 decimals.';
      if (fl.includes('lei')) return 'Must be 20-char LEI.';
      if (fl.includes('birthdt')) return 'Use YYYY-MM-DD format.';
      if (fl.includes('ctry') || fl.includes('country')) return '2-letter ISO code required.';
      if (f === 'nbOfTxs') return 'Must be 1-15 digits.';
      if (f === 'bizMsgId' || f === 'msgId' || f === 'instrId' || f === 'endToEndId' || f === 'txId' || f === 'clrSysRef') return 'Invalid Pattern (Alphanumeric only, max 35 chars).';
      // Address field pattern errors (must be before the generic name/nm check)
      if (fl.includes('bldgnb') || fl.includes('pstcd') || fl.includes('pstbx'))
        return 'Invalid character. Only ISO 20022 MX allowed characters permitted.';
      if (fl.includes('bldgnm') || fl.includes('twnnm') || fl.includes('twnlctn') || fl.includes('dstrctnm') || fl.includes('ctrysubdvsn'))
        return 'Invalid character. Only ISO 20022 MX allowed characters permitted.';
      if (fl.includes('strtnm') || fl.includes('dept') || fl.includes('subdept') || fl.includes('flr') || fl.includes('room'))
        return 'Invalid character. Only ISO 20022 MX allowed characters permitted.';
      if (fl.includes('adrline'))
        return 'Invalid character. Only ISO 20022 MX allowed characters permitted.';
      if (fl.includes('name') || fl.includes('nm')) return "Invalid characters. Only letters, numbers, spaces and . , ( ) ' - are allowed (no &, @, !, etc.)";
      if (fl.includes('ustrd') || fl.includes('adtlrmtinf')) return "Invalid character in remittance field. Only ISO 20022 MX allowed chars permitted.";

      if (f === 'ctgyPurpCd') return 'Invalid Category Purpose Code. Must be a valid ISO 20022 code (4 uppercase letters).';
      if (f === 'instrPrty') return 'Invalid Priority. Must be HIGH or NORM.';
      if (f === 'sttlmPrty') return 'Invalid Settlement Priority. Must be HIGH or NORM.';
      if (f === 'clrChanl') return 'Invalid Clearing Channel. Must be BOOK, MPNS, RTGS, or RTNS.';
      if (f === 'svcLvlCd') return 'Invalid Service Level Code. Must be 1-4 alphanumeric characters.';
      if (f === 'svcLvlPrtry') return 'Invalid Proprietary Service Level. Up to 35 characters allowed.';
      if (f === 'lclInstrmCd') return 'Invalid Local Instrument Code. Must be 1-4 alphanumeric characters.';
      if (f === 'lclInstrmPrtry') return 'Invalid Proprietary Local Instrument. Up to 35 characters allowed.';
      if (f === 'ctgyPurpPrtry') return 'Invalid Proprietary Category Purpose. Up to 35 characters allowed.';
    }
    if (c.errors?.['noIdentifier']) return 'Name, LEI, or Member ID required.';
    if (c.errors?.['target2']) return 'T2 allows only EUR currency.';
    if (c.errors?.['chips']) return 'CHIPS allows only USD currency.';
    if (c.errors?.['fed']) return 'FED allows only USD currency.';
    if (c.errors?.['chaps']) return 'Invalid Currency for CHAPS clearing system. When ClrSysId/Cd = CHAPS, the transaction currency must be GBP.';
    if (c.errors?.['forbidden']) return 'Clearing System Reference must NOT be sent if no active clearing system is used.';
    return 'Invalid value.';
  }

  leiError: { [key: string]: string } = {};
  warningTimeouts: { [key: string]: any } = {};
  showMaxLenWarning: { [key: string]: boolean } = {};

  getFieldLimit(field: string): number {
    const f = field.toLowerCase();
    if (f === 'bizmsgid') return 35;
    if (f === 'msgid') return 35;
    if (f === 'instrid') return 35;
    if (f === 'endtoendid') return 35;
    if (f === 'txid') return 35;
    if (f === 'uetr') return 36;
    if (f.includes('bic')) return 11;
    if (f.includes('lei')) return 20;
    if (f.includes('name') || f.endsWith('nm')) return 140;
    if (f.includes('adrline')) return 70;
    if (f.includes('mmbid')) return 35;
    if (f.includes('acct')) return 34; // IBAN
    if (f.includes('othrid')) return 35;
    if (f.includes('addtlinf')) return 105;
    return 0;
  }

  handleInput(field: string, value: string): string {
    const max = this.getFieldLimit(field);
    if (!max) return value;

    if (value.length >= max) {
      this.showLimitMessage(field, max);
      return value.slice(0, max); // restrict input
    }
    return value;
  }

  showLimitMessage(field: string, max: number) {
    this.showMaxLenWarning[field] = true;
    if (this.warningTimeouts[field]) clearTimeout(this.warningTimeouts[field]);
    this.warningTimeouts[field] = setTimeout(() => {
      this.showMaxLenWarning[field] = false;
    }, 3000);
  }

  validateLei(field: string) {
    const ctrl = this.form.get(field);
    const val = (ctrl?.value || '').trim();
    if (val && val.length < 20) {
      this.leiError[field] = 'LEI must be exactly 20 characters.';
    } else {
      delete this.leiError[field];
    }
  }

  @HostListener('input', ['$event'])
  onInput(event: any) {
    const target = event.target as HTMLInputElement;
    if (!target) return;
    const name = target.getAttribute('formControlName');
    if (!name) return;

    let val = target.value || '';
    const fl = name.toLowerCase();

    // 1. Enforce Field-Specific Rules (Before limit check)
    if (fl.includes('bic') || fl.includes('lei') || fl.includes('iban')) {
      // Uppercase Alphanumeric only
      val = val.toUpperCase().replace(/[^A-Z0-9]/g, '');
    }

    // 2. Generic Input Handler (Limit Check & Message)
    val = this.handleInput(name, val);

    // 3. Update DOM & Form if changed
    if (target.value !== val) {
      const start = target.selectionStart;
      const end = target.selectionEnd;
      target.value = val;
      if (start !== null && end !== null) {
        target.setSelectionRange(start, end);
      }
      this.form.get(name)?.patchValue(val, { emitEvent: false });
    }
  }


  @HostListener('keydown', ['$event'])
  onKeydown(event: KeyboardEvent) {
    // 1. History & Formatting Shortcuts (Ctrl+Z, Ctrl+Y, Ctrl+S)
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
            this.formatXml(false);
            return;
          case '/':
            event.preventDefault();
            this.toggleCommentXml();
            return;
        }
      }
    }

    // 2. Existing MaxLength Warning logic
    const target = event.target as HTMLInputElement;
    if (!target || (target.tagName !== 'INPUT' && target.tagName !== 'TEXTAREA')) return;
    const maxLen = target.maxLength;
    if (maxLen && maxLen > 0 && target.value && target.value.toString().length >= maxLen) {
      // Still show warning on keydown if trying to type past limit
      if (target.selectionStart !== null && target.selectionStart !== target.selectionEnd) return;
      if (event.key.length === 1 && !event.ctrlKey && !event.altKey && !event.metaKey) {
        const controlName = target.getAttribute('formControlName') || target.getAttribute('name');
        if (controlName) {
          this.showMaxLenWarning[controlName] = true;
          if (this.warningTimeouts[controlName]) {
            clearTimeout(this.warningTimeouts[controlName]);
          }
          this.warningTimeouts[controlName] = setTimeout(() => {
            this.showMaxLenWarning[controlName] = false;
          }, 3000);
        }
      }
    }
  }

  hint(f: string, maxLen: number): string | null {
    if (!this.showMaxLenWarning[f]) return null;
    const c = this.form.get(f);
    if (!c) return null;
    const len = (c.value || '').toString().length;
    return `Maximum ${maxLen} characters reached (${len}/${maxLen})`;
  }


  fdt(dt: string): string {
    if (!dt) return dt;
    let s = dt.trim().replace(/\.\d+/, '').replace('Z', '+00:00');
    if (s && !/([+-]\d{2}:\d{2})$/.test(s)) s += '+00:00';
    return s;
  }

  isoNow(): string {
    const d = new Date(), p = (n: number) => n.toString().padStart(2, '0');
    const off = -d.getTimezoneOffset(), s = off >= 0 ? '+' : '-';
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}${s}${p(Math.floor(Math.abs(off) / 60))}:${p(Math.abs(off) % 60)}`;
  }

  getD(ccy: string): number {
    const list: any = {
      'EUR': 2, 'USD': 2, 'GBP': 2, 'JPY': 0, 'CHF': 2, 'CAD': 2, 'AUD': 2, 'NZD': 2, 'HKD': 2, 'SGD': 2, 'CNY': 2,
      'AED': 2, 'SAR': 2, 'KWD': 3, 'BHD': 3, 'OMR': 3, 'JOD': 3, 'TND': 3, 'LYD': 3, 'IQD': 3, 'CLF': 4
    };
    return list[ccy.toUpperCase()] !== undefined ? list[ccy.toUpperCase()] : 2;
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
    if (this.isParsingXml) return;

    // Stop generation if TARGET2 rule is violated
    if (this.form.get('currency')?.hasError('target2')) {
      this.generatedXml = '<!-- TARGET2 VALIDATION ERROR: TARGET2 payments must use EUR as the settlement currency. -->';
      this.formatXml(false);
      this.onEditorChange(this.generatedXml, true);
      return;
    }

    // Stop generation if CHAPS rule is violated
    if (this.form.get('currency')?.hasError('chaps')) {
      this.generatedXml = '<!-- CHAPS VALIDATION ERROR: Invalid Currency for CHAPS clearing system. When ClrSysId/Cd = CHAPS, the transaction currency must be GBP. -->';
      this.formatXml(false);
      this.onEditorChange(this.generatedXml, true);
      return;
    }

    const v = this.form.value;
    const creDtTm = this.fdt(v.creDtTm || this.isoNow());

    // DrctDbtTxInf — strict XSD element order for pacs.003.001.08
    let tx = '';
    let pmtIdXml = this.el('InstrId', v.instrId, 5) + this.el('EndToEndId', v.endToEndId, 5) + this.el('TxId', v.txId, 5) + this.el('UETR', v.uetr, 5);
    if (v.clrSysRef?.trim()) pmtIdXml += this.el('ClrSysRef', v.clrSysRef, 5);
    tx += this.tag('PmtId', pmtIdXml, 4);

    let pmtTpXml = '';
    if (v.instrPrty?.trim()) pmtTpXml += this.el('InstrPrty', v.instrPrty, 5);
    if (v.clrChanl?.trim()) pmtTpXml += this.el('ClrChanl', v.clrChanl, 5);
    
    // Multiple Service Levels (up to 3)
    [1, 2, 3].forEach(i => {
      const s = i === 1 ? '' : i.toString();
      if (v['svcLvlCd' + s]?.trim() || v['svcLvlPrtry' + s]?.trim()) {
        let content = v['svcLvlCd' + s]?.trim() ? this.el('Cd', v['svcLvlCd' + s], 6) : this.el('Prtry', v['svcLvlPrtry' + s], 6);
        pmtTpXml += this.tag('SvcLvl', content, 5);
      }
    });

    if (v.lclInstrmCd?.trim() || v.lclInstrmPrtry?.trim()) {
      let content = v.lclInstrmCd?.trim() ? this.el('Cd', v.lclInstrmCd, 6) : this.el('Prtry', v.lclInstrmPrtry, 6);
      pmtTpXml += this.tag('LclInstrm', content, 5);
    }
    if (v.seqTp?.trim()) pmtTpXml += this.el('SeqTp', v.seqTp, 5);
    if (v.ctgyPurpCd?.trim() || v.ctgyPurpPrtry?.trim()) {
      let content = v.ctgyPurpCd?.trim() ? this.el('Cd', v.ctgyPurpCd, 6) : this.el('Prtry', v.ctgyPurpPrtry, 6);
      pmtTpXml += this.tag('CtgyPurp', content, 5);
    }
    if (pmtTpXml) tx += this.tag('PmtTpInf', pmtTpXml, 4);

    const formattedAmt = this.formatting.formatAmount(v.amount, v.currency);
    tx += `\t\t\t\t<IntrBkSttlmAmt Ccy="${this.e(v.currency)}">${formattedAmt}</IntrBkSttlmAmt>\n`;
    tx += this.el('IntrBkSttlmDt', v.sttlmDt, 4);
    if (v.sttlmPrty?.trim()) tx += this.el('SttlmPrty', v.sttlmPrty, 4);
    
    // SttlmTmIndctn
    if (v.dbtDtTm?.trim() || v.cdtDtTm?.trim()) {
      let stind = '';
      if (v.dbtDtTm?.trim()) stind += this.el('DbtDtTm', this.fdt(v.dbtDtTm), 5);
      if (v.cdtDtTm?.trim()) stind += this.el('CdtDtTm', this.fdt(v.cdtDtTm), 5);
      tx += this.tag('SttlmTmIndctn', stind, 4);
    }
    
    // InstdAmt
    if (v.instdAmt?.trim() && v.instdAmtCcy?.trim()) {
      const formInstdAmt = Number(v.instdAmt).toFixed(this.getD(v.instdAmtCcy));
      tx += `\t\t\t\t<InstdAmt Ccy="${this.e(v.instdAmtCcy)}">${formInstdAmt}</InstdAmt>\n`;
    }
    
    if (v.xchgRate?.trim()) tx += this.el('XchgRate', v.xchgRate, 4);
    tx += this.el('ChrgBr', v.chrgBr, 4);
    
    // Multiple Charges (up to 3)
    [1, 2, 3].forEach(i => {
      const s = i === 1 ? '' : i.toString();
      if (v['chrgsInfAmt' + s]?.trim() && v['chrgsInfCcy' + s]?.trim()) {
        let chg = `\t\t\t\t\t<Amt Ccy="${this.e(v['chrgsInfCcy' + s])}">${Number(v['chrgsInfAmt' + s]).toFixed(this.getD(v['chrgsInfCcy' + s]))}</Amt>\n`;
        const agtBic = v['chrgsInfAgtBic' + s] || v.cdtrAgtBic;
        chg += `\t\t\t\t\t<Agt>\n\t\t\t\t\t\t<FinInstnId>\n\t\t\t\t\t\t\t<BICFI>${this.e(agtBic)}</BICFI>\n\t\t\t\t\t\t</FinInstnId>\n\t\t\t\t\t</Agt>\n`;
        tx += this.tag('ChrgsInf', chg, 4);
      }
    });

    tx += this.el('ReqdColltnDt', v.reqdColltnDt, 4);

    const formatAcct = (val: string, tabs: number) => {
      if (!val) return '';
      const ibanCountries = ['AD', 'AE', 'AL', 'AT', 'AZ', 'BA', 'BE', 'BG', 'BH', 'BR', 'BY', 'CH', 'CR', 'CY', 'CZ', 'DE', 'DK', 'DO', 'EE', 'EG', 'ES', 'FI', 'FO', 'FR', 'GB', 'GE', 'GI', 'GL', 'GR', 'GT', 'HR', 'HU', 'IE', 'IL', 'IQ', 'IS', 'IT', 'JO', 'KW', 'KZ', 'LB', 'LI', 'LT', 'LU', 'LV', 'MC', 'MD', 'ME', 'MK', 'MR', 'MT', 'MU', 'NL', 'NO', 'PK', 'PL', 'PS', 'PT', 'QA', 'RO', 'RS', 'RU', 'SA', 'SC', 'SE', 'SI', 'SK', 'SM', 'ST', 'SV', 'TL', 'TN', 'TR', 'UA', 'VA', 'VG', 'XK'];
      if (val.length >= 14 && ibanCountries.includes(val.substring(0, 2).toUpperCase()) && /^[A-Z]{2}[0-9]{2}[A-Z0-9]+$/i.test(val)) {
        return this.el('IBAN', val, tabs + 1);
      } else {
        return `\n${'\t'.repeat(tabs + 1)}<Othr>\n${'\t'.repeat(tabs + 2)}<Id>${this.e(val)}</Id>\n${'\t'.repeat(tabs + 1)}</Othr>\n${'\t'.repeat(tabs)}`;
      }
    };

    // DrctDbtTx (Sequence: 12)
    // DrctDbtTx (Sequence: 12)
    if (v.mndtId || v.dtOfSgntr || v.orgnlMndtId || v.orgnlCdtrSchmeIdNm) {
      let ddinf = '';
      let mdt = '';
      if (v.mndtId) mdt += this.el('MndtId', v.mndtId, 6);
      if (v.dtOfSgntr) mdt += this.el('DtOfSgntr', v.dtOfSgntr, 6);
      if (v.amdmntInd === 'true' || v.amdmntInd === true) {
        mdt += this.el('AmdmntInd', 'true', 6);
        let amdmntDtls = '';
        if (v.orgnlMndtId) amdmntDtls += this.el('OrgnlMndtId', v.orgnlMndtId, 7);
        if (v.orgnlCdtrSchmeIdNm || v.orgnlCdtrSchmeAddrType !== 'none' || v.orgnlCdtrSchmeCtryOfRes?.trim() || v.orgnlCdtrSchmeIdType !== 'none') {
          let sc = this.el('Nm', v.orgnlCdtrSchmeIdNm, 8) + this.el('CtryOfRes', v.orgnlCdtrSchmeCtryOfRes, 8) + this.addrXml(v, 'orgnlCdtrSchme', 8) + this.partyIdXml(v, 'orgnlCdtrSchme', 8);
          amdmntDtls += this.tag('OrgnlCdtrSchmeId', sc, 7);
        }
        if (v.orgnlCdtrAgtAcct?.trim() || v.orgnlCdtrAgtAcctTpCd?.trim() || v.orgnlCdtrAgtAcctCcy?.trim()) {
          let acctXml = this.tag('Id', formatAcct(v.orgnlCdtrAgtAcct, 8), 8);
          if (v.orgnlCdtrAgtAcctTpCd?.trim()) acctXml += this.tag('Tp', this.el('Cd', v.orgnlCdtrAgtAcctTpCd, 9), 8);
          if (v.orgnlCdtrAgtAcctCcy?.trim()) acctXml += this.el('Ccy', v.orgnlCdtrAgtAcctCcy, 8);
          if (v.orgnlCdtrAgtAcctNm?.trim()) acctXml += this.el('Nm', v.orgnlCdtrAgtAcctNm, 8);
          amdmntDtls += this.tag('OrgnlCdtrAgtAcct', acctXml, 7);
        }
        if (amdmntDtls) mdt += this.tag('AmdmntInfDtls', amdmntDtls, 6);
      }
      if (mdt) ddinf += this.tag('MndtRltdInf', mdt, 5);
      
      ddinf += this.agt('OrgnlCdtrAgt', 'orgnlCdtrAgt', v, 5);
      if (v.orgnlDbtrName?.trim() || v.orgnlDbtrCtryOfRes?.trim() || (v.orgnlDbtrAddrType && v.orgnlDbtrAddrType !== 'none')) {
        ddinf += this.tag('OrgnlDbtr', this.el('Nm', v.orgnlDbtrName, 6) + this.el('CtryOfRes', v.orgnlDbtrCtryOfRes, 6) + this.addrXml(v, 'orgnlDbtr', 6) + this.partyIdXml(v, 'orgnlDbtr', 6), 5);
      }
      tx += this.tag('DrctDbtTx', ddinf, 4);
    }

    // Cdtr Block (Sequence: 13-17)
    tx += this.partyAgentXml('Cdtr', 'cdtr', v, 4);
    if (v.cdtrAcct?.trim()) tx += this.tag('CdtrAcct', this.tag('Id', formatAcct(v.cdtrAcct, 5), 5), 4);
    tx += this.agt('CdtrAgt', 'cdtrAgt', v, 4);
    if (v.cdtrAgtAcct?.trim()) tx += this.tag('CdtrAgtAcct', this.tag('Id', formatAcct(v.cdtrAgtAcct, 5), 5), 4);
    if (v.ultmtCdtrName?.trim() || (v.ultmtCdtrAddrType && v.ultmtCdtrAddrType !== 'none') || (v.ultmtCdtrIdType && v.ultmtCdtrIdType !== 'none')) {
      tx += this.tag('UltmtCdtr', this.el('Nm', v.ultmtCdtrName, 5) + this.addrXml(v, 'ultmtCdtr', 5) + this.partyIdXml(v, 'ultmtCdtr', 5), 4);
    }

    // Agent Block (Sequence: 18-26)
    tx += this.agt('InstgAgt', 'instgAgt', v, 4);
    if (v.instgAgtAcct?.trim()) tx += this.tag('InstgAgtAcct', this.tag('Id', formatAcct(v.instgAgtAcct, 5), 5), 4);
    tx += this.agt('InstdAgt', 'instdAgt', v, 4);
    if (v.instdAgtAcct?.trim()) tx += this.tag('InstdAgtAcct', this.tag('Id', formatAcct(v.instdAgtAcct, 5), 5), 4);
    ['intrmyAgt1', 'intrmyAgt2', 'intrmyAgt3'].forEach(p => {
      tx += this.agt(p.charAt(0).toUpperCase() + p.slice(1), p, v, 4);
      if (v[p + 'Acct']?.trim()) {
        tx += this.tag(p.charAt(0).toUpperCase() + p.slice(1) + 'Acct', this.tag('Id', formatAcct(v[p + 'Acct'], 5), 5), 4);
      }
    });

    // InitgPty (Sequence: 27)
    tx += this.initgPtyXml(v, 'initgPty', 4);

    // InstgPty (Sequence: 28)
    tx += this.initgPtyXml(v, 'instgPty', 4);


    // Dbtr Block (Sequence: 29-33)
    tx += this.partyAgentXml('Dbtr', 'dbtr', v, 4);
    if (v.dbtrAcct?.trim()) tx += this.tag('DbtrAcct', this.tag('Id', formatAcct(v.dbtrAcct, 5), 5), 4);
    tx += this.agt('DbtrAgt', 'dbtrAgt', v, 4);
    if (v.dbtrAgtAcct?.trim()) tx += this.tag('DbtrAgtAcct', this.tag('Id', formatAcct(v.dbtrAgtAcct, 5), 5), 4);
    if (v.ultmtDbtrName?.trim() || (v.ultmtDbtrAddrType && v.ultmtDbtrAddrType !== 'none') || (v.ultmtDbtrIdType && v.ultmtDbtrIdType !== 'none')) {
      tx += this.tag('UltmtDbtr', this.el('Nm', v.ultmtDbtrName, 4) + this.addrXml(v, 'ultmtDbtr', 4) + this.partyIdXml(v, 'ultmtDbtr', 4), 3);
    }

    // Purp (Sequence: 34)
    if (v.purpCd?.trim()) tx += this.tag('Purp', this.el('Cd', v.purpCd, 4), 3);

    // Instr (Sequence: 35-36)
    for (let i = 1; i <= 2; i++) {
      const cd = v[`instrForCdtrAgt${i}Cd`]?.trim();
      const txt = v[`instrForCdtrAgt${i}InfTxt`]?.trim();
      if (cd || txt) {
        let inner = '';
        if (cd) inner += this.el('Cd', cd, 4);
        if (txt) inner += this.el('InstrInf', txt, 4);
        tx += this.tag('InstrForCdtrAgt', inner, 3);
      }
    }
    for (let i = 1; i <= 6; i++) {
      const cd = v[`instrForNxtAgt${i}Cd`]?.trim();
      const txt = v[`instrForNxtAgt${i}InfTxt`]?.trim();
      if (cd || txt) {
        let inner = '';
        if (cd) inner += this.el('Cd', cd, 4);
        if (txt) inner += this.el('InstrInf', txt, 4);
        tx += this.tag('InstrForNxtAgt', inner, 3);
      }
    }
    
    // RgltryRptg and RltdRmtInf (up to 3 in form)
    [1, 2, 3].forEach(i => {
      const cd = v[`rgltryRptg${i}Code`];
      const inf = v[`rgltryRptg${i}Inf`];
      if (cd || inf) {
        let dtls = '';
        if (cd) dtls += this.el('Cd', cd, 6);
        if (inf) dtls += this.el('Inf', inf, 6);
        tx += this.tag('RgltryRptg', this.tag('Dtls', dtls, 5), 3);
      }
      const ref = v[`rltdRmtInf${i}Ref`];
      if (ref) {
        tx += this.tag('RltdRmtInf', this.el('Ref', ref, 4), 3);
      }
    });


    let rmtInf = '';
    if (v.rmtInfType === 'ustrd' && v.rmtInfUstrd) {
      rmtInf = `\n\t\t\t\t<RmtInf>\n\t\t\t\t\t<Ustrd>${this.e(v.rmtInfUstrd)}</Ustrd>\n\t\t\t\t</RmtInf>`;
    } else if (v.rmtInfType === 'strd') {
      let cdtrRef = '';
      if (v.rmtInfStrdCdtrRefType && v.rmtInfStrdCdtrRef) {
        cdtrRef = `\n\t\t\t\t\t\t<CdtrRefInf>\n\t\t\t\t\t\t\t<Tp>\n\t\t\t\t\t\t\t\t<CdOrPrtry>\n\t\t\t\t\t\t\t\t\t<Cd>${this.e(v.rmtInfStrdCdtrRefType)}</Cd>\n\t\t\t\t\t\t\t\t</CdOrPrtry>\n\t\t\t\t\t\t\t</Tp>\n\t\t\t\t\t\t\t<Ref>${this.e(v.rmtInfStrdCdtrRef)}</Ref>\n\t\t\t\t\t\t</CdtrRefInf>`;
      }
      if (v.rmtInfStrdRfrdDocNb || v.rmtInfStrdRfrdDocCd) {
        let rd = `\n\t\t\t\t\t\t<RfrdDocInf>\n`;
        if (v.rmtInfStrdRfrdDocNb) rd += `\t\t\t\t\t\t\t<Nb>${this.e(v.rmtInfStrdRfrdDocNb)}</Nb>\n`;
        if (v.rmtInfStrdRfrdDocCd) {
          rd += `\t\t\t\t\t\t\t<Tp>\n\t\t\t\t\t\t\t\t<CdOrPrtry>\n\t\t\t\t\t\t\t\t\t<Cd>${this.e(v.rmtInfStrdRfrdDocCd)}</Cd>\n\t\t\t\t\t\t\t\t</CdOrPrtry>\n\t\t\t\t\t\t\t</Tp>\n`;
        }
        rd += `\t\t\t\t\t\t</RfrdDocInf>`;
        cdtrRef += rd;
      }
      if (v.rmtInfStrdRfrdDocAmt) {
        cdtrRef += `\n\t\t\t\t\t\t<RfrdDocAmt>\n\t\t\t\t\t\t\t<RmtAmt>\n\t\t\t\t\t\t\t\t<DuePyblAmt Ccy="${this.e(v.currency)}">${v.rmtInfStrdRfrdDocAmt}</DuePyblAmt>\n\t\t\t\t\t\t\t</RmtAmt>\n\t\t\t\t\t\t</RfrdDocAmt>`;
      }
      if (v.rmtInfStrdInvcrNm) {
        cdtrRef += `\n\t\t\t\t\t\t<Invcr>\n\t\t\t\t\t\t\t<Nm>${this.e(v.rmtInfStrdInvcrNm)}</Nm>\n\t\t\t\t\t\t</Invcr>`;
      }
      if (v.rmtInfStrdInvceeNm) {
        cdtrRef += `\n\t\t\t\t\t\t<Invcee>\n\t\t\t\t\t\t\t<Nm>${this.e(v.rmtInfStrdInvceeNm)}</Nm>\n\t\t\t\t\t\t</Invcee>`;
      }
      if (v.rmtInfStrdTaxRmtId) {
        cdtrRef += `\n\t\t\t\t\t\t<TaxRmt>\n\t\t\t\t\t\t\t<AdmstnZn>${this.e(v.rmtInfStrdTaxRmtId)}</AdmstnZn>\n\t\t\t\t\t\t</TaxRmt>`;
      }
      if (v.rmtInfStrdGrnshmtId) {
        cdtrRef += `\n\t\t\t\t\t\t<GrnshmtRmt>\n\t\t\t\t\t\t\t<Id>\n\t\t\t\t\t\t\t\t<PrvtId>\n\t\t\t\t\t\t\t\t\t<Othr>\n\t\t\t\t\t\t\t\t\t\t<Id>${this.e(v.rmtInfStrdGrnshmtId)}</Id>\n\t\t\t\t\t\t\t\t\t</Othr>\n\t\t\t\t\t\t\t\t</PrvtId>\n\t\t\t\t\t\t\t</Id>\n\t\t\t\t\t\t</GrnshmtRmt>`;
      }

      let addtl = v.rmtInfStrdAddtlRmtInf ? `\n\t\t\t\t\t\t<AddtlRmtInf>${this.e(v.rmtInfStrdAddtlRmtInf)}</AddtlRmtInf>` : '';
      if (cdtrRef || addtl) {
        rmtInf = `\n\t\t\t\t<RmtInf>\n\t\t\t\t\t<Strd>${cdtrRef}${addtl}\n\t\t\t\t\t</Strd>\n\t\t\t\t</RmtInf>`;
      }
    }
    tx += rmtInf;


    const appHdrFi = (bic: string, mmbId: string, clrSysId: string, lei: string) => {
        let res = '';
        if (bic) res += `\t\t\t\t\t<BICFI>${this.e(bic)}</BICFI>\n`;
        if (mmbId || clrSysId) {
            let clr = '';
            if (clrSysId) clr += `\t\t\t\t\t\t<ClrSysId>\n\t\t\t\t\t\t\t<Cd>${this.e(clrSysId)}</Cd>\n\t\t\t\t\t\t</ClrSysId>\n`;
            if (mmbId) clr += `\t\t\t\t\t\t<MmbId>${this.e(mmbId)}</MmbId>\n`;
            res += `\t\t\t\t\t<ClrSysMmbId>\n${clr}\t\t\t\t\t</ClrSysMmbId>\n`;
        }
        if (lei) res += `\t\t\t\t\t<LEI>${this.e(lei)}</LEI>\n`;
        return `\t\t\t<FIId>\n\t\t\t\t<FinInstnId>\n${res}\t\t\t\t</FinInstnId>\n\t\t\t</FIId>\n`;
    };

    this.generatedXml =
      `<?xml version="1.0" encoding="UTF-8"?>
<BusMsgEnvlp xmlns="urn:swift:xsd:envelope">
\t<AppHdr xmlns="urn:iso:std:iso:20022:tech:xsd:head.001.001.02">
\t\t<Fr>
${appHdrFi(v.fromBic, v.fromMmbId, v.fromClrSysId, v.fromLei)}\t\t</Fr>
\t\t<To>
${appHdrFi(v.toBic, v.toMmbId, v.toClrSysId, v.toLei)}\t\t</To>
\t\t<BizMsgIdr>${this.e(v.bizMsgId)}</BizMsgIdr>
\t\t<MsgDefIdr>pacs.003.001.08</MsgDefIdr>
\t\t<BizSvc>swift.cbprplus.02</BizSvc>
${v.mktPrctc?`\t\t<MktPrctc><Regy>${this.e(v.regyId||'SWIFT')}</Regy><Id>${this.e(v.mktPrctc)}</Id></MktPrctc>\n`:''}\t\t<CreDt>${creDtTm}</CreDt>
${v.charSet?`\t\t<CharSet>${this.e(v.charSet)}</CharSet>\n`:''}${v.cpyDplct?`\t\t<CpyDplct>${this.e(v.cpyDplct)}</CpyDplct>\n`:''}${v.pssblDplct==='true'?`\t\t<PssblDplct>true</PssblDplct>\n`:''}${v.appHdrPrty?`\t\t<Prty>${this.e(v.appHdrPrty)}</Prty>\n`:''}${v.rltd ? `\n\t\t<Rltd>${v.rltdCharSet?`<CharSet>${this.e(v.rltdCharSet)}</CharSet>`:''}<Id>${this.e(v.rltd)}</Id></Rltd>` : ''}\n\t</AppHdr>
\t<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pacs.003.001.08">
\t\t<FIToFICstmrDrctDbt>
\t\t\t<GrpHdr>
\t\t\t\t<MsgId>${this.e(v.msgId)}</MsgId>
\t\t\t\t<CreDtTm>${creDtTm}</CreDtTm>
\t\t\t\t<NbOfTxs>${v.nbOfTxs}</NbOfTxs>
\t\t\t\t<SttlmInf>
\t\t\t\t\t<SttlmMtd>${this.e(v.sttlmMtd)}</SttlmMtd>
${v.sttlmAcctId || v.sttlmAcctOthrId || v.sttlmAcctNm ? `\t\t\t\t\t<SttlmAcct>
\t\t\t\t\t\t<Id>${v.sttlmAcctId ? `<IBAN>${this.e(v.sttlmAcctId)}</IBAN>` : v.sttlmAcctOthrId ? `<Othr><Id>${this.e(v.sttlmAcctOthrId)}</Id></Othr>` : ''}</Id>
${v.sttlmAcctTpCd ? `\t\t\t\t\t\t<Tp><Cd>${this.e(v.sttlmAcctTpCd)}</Cd></Tp>\n` : ''}${v.sttlmAcctCcy ? `\t\t\t\t\t\t<Ccy>${this.e(v.sttlmAcctCcy)}</Ccy>\n` : ''}${v.sttlmAcctNm ? `\t\t\t\t\t\t<Nm>${this.e(v.sttlmAcctNm)}</Nm>\n` : ''}\t\t\t\t\t</SttlmAcct>\n` : ''}\t\t\t\t</SttlmInf>
\t\t\t</GrpHdr>
\t\t\t<DrctDbtTxInf>
${tx}\t\t\t</DrctDbtTxInf>
\t\t</FIToFICstmrDrctDbt>
\t</Document>
</BusMsgEnvlp>`;

    this.formatXml(false);
      this.onEditorChange(this.generatedXml, true);
  }

  // XML helpers
  partyAgentXml(tag: string, prefix: string, v: any, indent = 4) {
    const bic = v[prefix + 'Bic'] || v[prefix + 'OrgAnyBIC'];
    const name = v[prefix + 'Name'];
    const lei = v[prefix + 'Lei'] || v[prefix + 'OrgLEI'];
    const clrCd = v[prefix + 'ClrSysCd'] || v[prefix + 'OrgClrSysCd'];
    const clrMmb = v[prefix + 'ClrSysMmbId'] || v[prefix + 'OrgClrSysMmbId'];
    const ctryRes = v[prefix + 'CtryOfRes'];

    let content = '';
    if (name) content += `${this.tabs(indent + 1)}<Nm>${this.e(name)}</Nm>\n`;
    if (ctryRes) content += `${this.tabs(indent + 1)}<CtryOfRes>${this.e(ctryRes)}</CtryOfRes>\n`;
    content += this.addrXml(v, prefix, indent + 1);

    let org = '';
    if (bic) org += `${this.tabs(indent + 3)}<AnyBIC>${this.e(bic)}</AnyBIC>\n`;
    if (lei) org += `${this.tabs(indent + 3)}<LEI>${this.e(lei)}</LEI>\n`;
    if (clrMmb || clrCd) {
      org += `${this.tabs(indent + 3)}<Othr>\n`;
      if (clrMmb) org += `${this.tabs(indent + 4)}<Id>${this.e(clrMmb)}</Id>\n`;
      if (clrCd) {
        org += `${this.tabs(indent + 4)}<SchmeNm>\n${this.tabs(indent + 5)}<Cd>${this.e(clrCd)}</Cd>\n${this.tabs(indent + 4)}</SchmeNm>\n`;
      }
      org += `${this.tabs(indent + 3)}</Othr>\n`;
    }

    if (org) {
      content += `${this.tabs(indent + 1)}<Id>\n${this.tabs(indent + 2)}<OrgId>\n${org}${this.tabs(indent + 2)}</OrgId>\n${this.tabs(indent + 1)}</Id>\n`;
    }

    let pvt = '';
    if (v[prefix + 'IdType'] === 'prvt') {
      let prvt = '';
      if (v[prefix + 'PrvtDtAndPlcOfBirthDt'] || v[prefix + 'PrvtDtAndPlcOfBirthCity'] || v[prefix + 'PrvtDtAndPlcOfBirthCtry']) {
        prvt += `${this.tabs(indent + 3)}<DtAndPlcOfBirth>\n`;
        if (v[prefix + 'PrvtDtAndPlcOfBirthDt']) prvt += `${this.tabs(indent + 4)}<BirthDt>${this.e(v[prefix + 'PrvtDtAndPlcOfBirthDt'])}</BirthDt>\n`;
        if (v[prefix + 'PrvtDtAndPlcOfBirthCity']) prvt += `${this.tabs(indent + 4)}<CityOfBirth>${this.e(v[prefix + 'PrvtDtAndPlcOfBirthCity'])}</CityOfBirth>\n`;
        if (v[prefix + 'PrvtDtAndPlcOfBirthCtry']) prvt += `${this.tabs(indent + 4)}<CtryOfBirth>${this.e(v[prefix + 'PrvtDtAndPlcOfBirthCtry'])}</CtryOfBirth>\n`;
        prvt += `${this.tabs(indent + 3)}</DtAndPlcOfBirth>\n`;
      }
      if (v[prefix + 'PrvtOthrId']) {
        prvt += `${this.tabs(indent + 3)}<Othr>\n${this.tabs(indent + 4)}<Id>${this.e(v[prefix + 'PrvtOthrId'])}</Id>\n`;
        if (v[prefix + 'PrvtOthrSchmeNmCd']) {
          prvt += `${this.tabs(indent + 4)}<SchmeNm>\n${this.tabs(indent + 5)}<Cd>${this.e(v[prefix + 'PrvtOthrSchmeNmCd'])}</Cd>\n${this.tabs(indent + 4)}</SchmeNm>\n`;
        }
        if (v[prefix + 'PrvtOthrIssr']) prvt += `${this.tabs(indent + 4)}<Issr>${this.e(v[prefix + 'PrvtOthrIssr'])}</Issr>\n`;
        prvt += `${this.tabs(indent + 3)}</Othr>\n`;
      }
      if (prvt) pvt = `${this.tabs(indent + 1)}<Id>\n${this.tabs(indent + 2)}<PrvtId>\n${prvt}${this.tabs(indent + 2)}</PrvtId>\n${this.tabs(indent + 1)}</Id>\n`;
    }
    
    if (pvt && !org) content += pvt;

    if (!content.trim()) return '';
    return `${this.tabs(indent)}<${tag}>\n${content}${this.tabs(indent)}</${tag}>\n`;
  }

  private e(v: string) { return (v || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  private tabs(n: number) { return '\t'.repeat(n); }
  private el(tag: string, val: string, indent = 3) { return val?.trim() ? `${this.tabs(indent)}<${tag}>${this.e(val)}</${tag}>\n` : ''; }
  private tag(tag: string, content: string, indent = 3) { return content?.trim() ? `${this.tabs(indent)}<${tag}>\n${content}${this.tabs(indent)}</${tag}>\n` : ''; }

  grpAgt(tag: string, prefix: string, v: any) {
    const bic = v[prefix + 'Bic']; if (!bic) return '';
    return `\t\t\t\t<${tag}>\n\t\t\t\t\t<FinInstnId>\n\t\t\t\t\t\t<BICFI>${this.e(bic)}</BICFI>\n${this.addrXml(v, prefix, 6)}\t\t\t\t\t</FinInstnId>\n\t\t\t\t</${tag}>\n`;
  }
  agt(tag: string, prefix: string, v: any, indent = 4) {
    const bic = v[prefix + 'Bic'];
    const name = v[prefix + 'Name'];
    const lei = v[prefix + 'Lei'];
    const clrCd = v[prefix + 'ClrSysCd'];
    const clrMmb = v[prefix + 'ClrSysMmbId'];

    let content = '';
    const t = this.tabs(indent + 2);
    if (bic) content += `${t}<BICFI>${this.e(bic)}</BICFI>\n`;
    if (clrMmb || clrCd) {
      content += `${t}<ClrSysMmbId>\n`;
      if (clrCd) content += `${t}\t<ClrSysId>\n${t}\t\t<Cd>${this.e(clrCd)}</Cd>\n${t}\t</ClrSysId>\n`;
      if (clrMmb) content += `${t}\t<MmbId>${this.e(clrMmb)}</MmbId>\n`;
      content += `${t}</ClrSysMmbId>\n`;
    }
    if (lei) content += `${t}<LEI>${this.e(lei)}</LEI>\n`;
    if (name) content += `${t}<Nm>${this.e(name)}</Nm>\n`;
    
    let addr = this.addrXml(v, prefix, indent + 2, tag.startsWith('PrvsInstgAgt'));
    // Auto-populate postal address for Creditor/Debtor Agent if missing
    if (!addr && (prefix === 'cdtrAgt' || prefix === 'dbtrAgt')) {
      addr = `${this.tabs(indent + 2)}<PstlAdr>\n${this.tabs(indent + 3)}<TwnNm>${prefix === 'cdtrAgt' ? 'London' : 'New York'}</TwnNm>\n${this.tabs(indent + 3)}<Ctry>${prefix === 'cdtrAgt' ? 'GB' : 'US'}</Ctry>\n${this.tabs(indent + 3)}<AdrLine>Address Line 1</AdrLine>\n${this.tabs(indent + 3)}<AdrLine>Address Line 2</AdrLine>\n${this.tabs(indent + 2)}</PstlAdr>\n`;
    }
    content += addr;

    if (!content.trim()) return '';
    return `${this.tabs(indent)}<${tag}>\n${this.tabs(indent + 1)}<FinInstnId>\n${content}${this.tabs(indent + 1)}</FinInstnId>\n${this.tabs(indent)}</${tag}>\n`;
  }
  addrXml(v: any, p: string, indent = 4, isPrvs = false): string {
    const type = v[p + 'AddrType']; if (!type || type === 'none') return '';
    const lines: string[] = []; const t = this.tabs(indent + 1);
    
    // 1. AdrTp
    if (!isPrvs) {
        if (v[p + 'AdrTpCd']) lines.push(`${t}<AdrTp>\n${t}\t<Cd>${this.e(v[p + 'AdrTpCd'])}</Cd>\n${t}</AdrTp>`);
        else if (v[p + 'AdrTpPrtry']) lines.push(`${t}<AdrTp>\n${t}\t<Prtry>${this.e(v[p + 'AdrTpPrtry'])}</Prtry>\n${t}</AdrTp>`);
    }

    // Structured fields (hybrid or structured)
    if (['structured', 'hybrid'].includes(type)) {
      if (v[p + 'Dept']) lines.push(`${t}<Dept>${this.e(v[p + 'Dept'])}</Dept>`);
      if (v[p + 'SubDept']) lines.push(`${t}<SubDept>${this.e(v[p + 'SubDept'])}</SubDept>`);
      if (v[p + 'StrtNm']) lines.push(`${t}<StrtNm>${this.e(v[p + 'StrtNm'])}</StrtNm>`);
      if (v[p + 'BldgNb']) lines.push(`${t}<BldgNb>${this.e(v[p + 'BldgNb'])}</BldgNb>`);
      if (v[p + 'BldgNm']) lines.push(`${t}<BldgNm>${this.e(v[p + 'BldgNm'])}</BldgNm>`);
      if (v[p + 'Flr']) lines.push(`${t}<Flr>${this.e(v[p + 'Flr'])}</Flr>`);
      if (v[p + 'PstBx']) lines.push(`${t}<PstBx>${this.e(v[p + 'PstBx'])}</PstBx>`);
      if (v[p + 'Room']) lines.push(`${t}<Room>${this.e(v[p + 'Room'])}</Room>`);
      if (v[p + 'PstCd']) lines.push(`${t}<PstCd>${this.e(v[p + 'PstCd'])}</PstCd>`);
    }

    // Geographic elements
    if (v[p + 'TwnNm']) lines.push(`${t}<TwnNm>${this.e(v[p + 'TwnNm'])}</TwnNm>`);
    if (v[p + 'TwnLctnNm']) lines.push(`${t}<TwnLctnNm>${this.e(v[p + 'TwnLctnNm'])}</TwnLctnNm>`);
    if (v[p + 'DstrctNm']) lines.push(`${t}<DstrctNm>${this.e(v[p + 'DstrctNm'])}</DstrctNm>`);
    if (v[p + 'CtrySubDvsn']) lines.push(`${t}<CtrySubDvsn>${this.e(v[p + 'CtrySubDvsn'])}</CtrySubDvsn>`);
    if (v[p + 'Ctry']) lines.push(`${t}<Ctry>${this.e(v[p + 'Ctry'])}</Ctry>`);

    // AdrLine (unstructured or hybrid)
    if (['hybrid', 'hybrid'].includes(type)) {
      if (v[p + 'AdrLine1']) lines.push(`${t}<AdrLine>${this.e(v[p + 'AdrLine1'])}</AdrLine>`);
      if (v[p + 'AdrLine2']) lines.push(`${t}<AdrLine>${this.e(v[p + 'AdrLine2'])}</AdrLine>`);
    }

    if (!lines.length) return '';
    return `${this.tabs(indent)}<PstlAdr>\n${lines.join('\n')}\n${this.tabs(indent)}</PstlAdr>\n`;
  }

  partyIdXml(v: any, p: string, indent = 4): string {
    const type = v[p + 'IdType']; if (!type || type === 'none') return '';
    const t = this.tabs(indent + 1);
    if (type === 'org') {
      let org = '';
      if (v[p + 'OrgLEI']) org += `${t}\t<LEI>${this.e(v[p + 'OrgLEI'])}</LEI>\n`;
      if (v[p + 'OrgAnyBIC']) org += `${t}\t<AnyBIC>${this.e(v[p + 'OrgAnyBIC'])}</AnyBIC>\n`;
      if (v[p + 'OrgClrSysMmbId']) {
        org += `${t}\t<Othr>\n${t}\t\t<Id>${this.e(v[p + 'OrgClrSysMmbId'])}</Id>\n`;
        if (v[p + 'OrgClrSysCd']) {
          org += `${t}\t\t<SchmeNm>\n${t}\t\t\t<Cd>${this.e(v[p + 'OrgClrSysCd'])}</Cd>\n${t}\t\t</SchmeNm>\n`;
        }
        org += `${t}\t</Othr>\n`;
      }
      if (v[p + 'OrgOthrId']) {
        org += `${t}\t<Othr>\n${t}\t\t<Id>${this.e(v[p + 'OrgOthrId'])}</Id>\n`;
        if (v[p + 'OrgOthrSchmeNmCd']) {
          org += `${t}\t\t<SchmeNm>\n${t}\t\t\t<Cd>${this.e(v[p + 'OrgOthrSchmeNmCd'])}</Cd>\n${t}\t\t</SchmeNm>\n`;
        } else if (v[p + 'OrgOthrSchmeNmPrtry']) {
          org += `${t}\t\t<SchmeNm>\n${t}\t\t\t<Prtry>${this.e(v[p + 'OrgOthrSchmeNmPrtry'])}</Prtry>\n${t}\t\t</SchmeNm>\n`;
        }
        if (v[p + 'OrgOthrIssr']) org += `${t}\t\t<Issr>${this.e(v[p + 'OrgOthrIssr'])}</Issr>\n`;
        org += `${t}\t</Othr>\n`;
      }
      return `${this.tabs(indent)}<Id>\n${t}<OrgId>\n${org}${t}</OrgId>\n${this.tabs(indent)}</Id>\n`;
    } else if (type === 'prvt') {
      let prvt = '';
      if (v[p + 'PrvtDtAndPlcOfBirthDt'] || v[p + 'PrvtDtAndPlcOfBirthCity'] || v[p + 'PrvtDtAndPlcOfBirthCtry']) {
        prvt += `${t}\t<DtAndPlcOfBirth>\n`;
        if (v[p + 'PrvtDtAndPlcOfBirthDt']) prvt += `${t}\t\t<BirthDt>${this.e(v[p + 'PrvtDtAndPlcOfBirthDt'])}</BirthDt>\n`;
        if (v[p + 'PrvtDtAndPlcOfBirthCity']) prvt += `${t}\t\t<CityOfBirth>${this.e(v[p + 'PrvtDtAndPlcOfBirthCity'])}</CityOfBirth>\n`;
        if (v[p + 'PrvtDtAndPlcOfBirthCtry']) prvt += `${t}\t\t<CtryOfBirth>${this.e(v[p + 'PrvtDtAndPlcOfBirthCtry'])}</CtryOfBirth>\n`;
        prvt += `${t}\t</DtAndPlcOfBirth>\n`;
      }
      if (v[p + 'PrvtOthrId']) {
        prvt += `${t}\t<Othr>\n${t}\t\t<Id>${this.e(v[p + 'PrvtOthrId'])}</Id>\n`;
        if (v[p + 'PrvtOthrSchmeNmCd']) {
          prvt += `${t}\t\t<SchmeNm>\n${t}\t\t\t<Cd>${this.e(v[p + 'PrvtOthrSchmeNmCd'])}</Cd>\n${t}\t\t</SchmeNm>\n`;
        } else if (v[p + 'PrvtOthrSchmeNmPrtry']) {
          prvt += `${t}\t\t<SchmeNm>\n${t}\t\t\t<Prtry>${this.e(v[p + 'PrvtOthrSchmeNmPrtry'])}</Prtry>\n${t}\t\t</SchmeNm>\n`;
        }
        if (v[p + 'PrvtOthrIssr']) prvt += `${t}\t\t<Issr>${this.e(v[p + 'PrvtOthrIssr'])}</Issr>\n`;
        prvt += `${t}\t</Othr>\n`;
      }
      return `${this.tabs(indent)}<Id>\n${t}<PrvtId>\n${prvt}${t}</PrvtId>\n${this.tabs(indent)}</Id>\n`;
    }
    return '';
  }

  /**
   * Generic XML builder for any party block (InitgPty, InstgPty, etc.).
   * Renders ALL available identifiers: Name, Address, AnyBIC, LEI,
   * Clearing System Member ID, Other ID, Account — regardless of idType.
   */
  initgPtyXml(v: any, p: string, indent = 4): string {
    let content = '';

    // Name
    if (v[p + 'Name']?.trim()) {
      content += this.el('Nm', v[p + 'Name'], indent + 1);
    }

    // Postal Address
    content += this.addrXml(v, p, indent + 1);

    // Build Id/OrgId block from whatever is available: AnyBIC, LEI, ClrSys Member ID, Othr ID
    const anyBic = v[p + 'OrgAnyBIC']?.trim();
    const lei    = v[p + 'OrgLEI']?.trim();
    const clrMmb = v[p + 'OrgClrSysMmbId']?.trim();
    const clrCd  = v[p + 'OrgClrSysCd']?.trim();
    const othrId = v[p + 'OrgOthrId']?.trim();

    if (anyBic || lei || clrMmb || othrId) {
      const t = this.tabs(indent + 3);
      let org = '';
      if (lei)    org += `${t}<LEI>${this.e(lei)}</LEI>\n`;
      if (anyBic) org += `${t}<AnyBIC>${this.e(anyBic)}</AnyBIC>\n`;
      if (clrMmb) {
        org += `${t}<Othr>\n${t}\t<Id>${this.e(clrMmb)}</Id>\n`;
        if (clrCd) org += `${t}\t<SchmeNm>\n${t}\t\t<Cd>${this.e(clrCd)}</Cd>\n${t}\t</SchmeNm>\n`;
        org += `${t}</Othr>\n`;
      }
      if (othrId) {
        const schemCd  = v[p + 'OrgOthrSchmeNmCd']?.trim();
        const schemPrt = v[p + 'OrgOthrSchmeNmPrtry']?.trim();
        const issr     = v[p + 'OrgOthrIssr']?.trim();
        org += `${t}<Othr>\n${t}\t<Id>${this.e(othrId)}</Id>\n`;
        if (schemCd)       org += `${t}\t<SchmeNm>\n${t}\t\t<Cd>${this.e(schemCd)}</Cd>\n${t}\t</SchmeNm>\n`;
        else if (schemPrt) org += `${t}\t<SchmeNm>\n${t}\t\t<Prtry>${this.e(schemPrt)}</Prtry>\n${t}\t</SchmeNm>\n`;
        if (issr) org += `${t}\t<Issr>${this.e(issr)}</Issr>\n`;
        org += `${t}</Othr>\n`;
      }
      const t2 = this.tabs(indent + 2);
      const tagName = p === 'instgPty' ? 'InstgPty' : 'InitgPty';
      content += `${this.tabs(indent + 1)}<Id>\n${t2}<OrgId>\n${org}${t2}</OrgId>\n${this.tabs(indent + 1)}</Id>\n`;
      if (!content.trim()) return '';
      return `${this.tabs(indent)}<${tagName}>\n${content}${this.tabs(indent)}</${tagName}>\n`;
    } else if (v[p + 'IdType'] === 'prvt') {
      content += this.partyIdXml(v, p, indent + 1);
    }

    // Account (optional)
    const acct = v[p + 'Acct']?.trim();
    if (acct) {
      content += `${this.tabs(indent + 1)}<Acct>\n${this.tabs(indent + 2)}<Id>\n${this.tabs(indent + 3)}<Othr>\n${this.tabs(indent + 4)}<Id>${this.e(acct)}</Id>\n${this.tabs(indent + 3)}</Othr>\n${this.tabs(indent + 2)}</Id>\n${this.tabs(indent + 1)}</Acct>\n`;
    }

    if (!content.trim()) return '';
    const xmlTag = p === 'instgPty' ? 'InstgPty' : 'InitgPty';
    return `${this.tabs(indent)}<${xmlTag}>\n${content}${this.tabs(indent)}</${xmlTag}>\n`;
  }

  // Validation

  validateMessage() {
        if (this.bicSameWarning) return;
        this.generateXml();
    if (this.form.invalid) {
      this.form.markAllAsTouched();
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
      message_type: 'pacs.003.001.08',
      store_in_history: true
    }).subscribe({
      next: (data: any) => {
        this.validationReport = data;
        this.clearDraft();
        this.validationStatus = 'done';
      },
      error: (err) => {
        this.validationReport = {
          status: 'FAIL', errors: 1, warnings: 0,
          message: 'pacs.003.001.08', total_time_ms: 0,
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



  downloadXml() { this.generateXml(); const b = new Blob([this.generatedXml], { type: 'application/xml' }); const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = `pacs008-${Date.now()}.xml`; a.click(); URL.revokeObjectURL(a.href); }
  copyToClipboard() {
    this.generateXml();
    navigator.clipboard.writeText(this.generatedXml).then(() => {
      this.snackBar.open('Copied!', 'Close', { duration: 3000, horizontalPosition: 'center', verticalPosition: 'bottom' });
    });
  }
  switchToPreview() { this.generateXml(); this.currentTab = 'preview'; }

  onEditorChange(content: string, fromForm = false) {
    if (!this.isInternalChange && !fromForm) {
      this.pushHistory();
    }

    this.generatedXml = content;
    const lines = content.split('\n').length;
    this.editorLineCount = Array.from({ length: lines }, (_, i) => i + 1);

    if (fromForm || this.isParsingXml) return;
    this.parseXmlToForm(content);
  }

  // --- History & Formatting ---
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
      this.refreshLineCount();
      setTimeout(() => this.isInternalChange = false, 10);
      this.parseXmlToForm(this.generatedXml);
    }
  }

  redoXml() {
    if (this.xmlHistoryIdx < this.xmlHistory.length - 1) {
      this.xmlHistoryIdx++;
      this.isInternalChange = true;
      this.generatedXml = this.xmlHistory[this.xmlHistoryIdx];
      this.refreshLineCount();
      setTimeout(() => this.isInternalChange = false, 10);
      this.parseXmlToForm(this.generatedXml);
    }
  }

  canUndoXml(): boolean { return this.xmlHistoryIdx > 0; }
  canRedoXml(): boolean { return this.xmlHistoryIdx < this.xmlHistory.length - 1; }

  private refreshLineCount() {
    const lines = (this.generatedXml || '').split('\n').length;
    this.editorLineCount = Array.from({ length: lines }, (_, i) => i + 1);
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

  toggleCommentXml() {
    if (!this.generatedXml) return;

    const textarea = document.querySelector('.code-editor') as HTMLTextAreaElement;
    if (!textarea) return;

    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const value = textarea.value;

    this.isInternalChange = true;
    this.pushHistory();

    // Identify start/end of lines
    let lineStart = value.lastIndexOf('\n', start - 1) + 1;
    let lineEnd = value.indexOf('\n', end);
    if (lineEnd === -1) lineEnd = value.length;

    const selection = value.substring(lineStart, lineEnd);
    const before = value.substring(0, lineStart);
    const after = value.substring(lineEnd);

    let newResult = '';
    const trimmed = selection.trim();

    if (trimmed.startsWith('<!--') && trimmed.endsWith('-->')) {
      // Uncomment
      newResult = selection.replace('<!--', '').replace('-->', '');
    } else {
      // Comment
      newResult = `<!-- ${selection} -->`;
    }

    this.generatedXml = before + newResult + after;
    this.refreshLineCount();

    setTimeout(() => {
      textarea.focus();
      textarea.setSelectionRange(lineStart, lineStart + newResult.length);
      this.isInternalChange = false;
    }, 0);
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
      // Reset every form control to '' so any element the user removed from the XML
      // clears its mirrored form value (prevents generateXml from re-inserting it).
      Object.keys(this.form.controls).forEach(k => patch[k] = '');

      // BAH
      const appHdr = getT('AppHdr');
      if (appHdr) {
        const fr = getT('Fr', appHdr);
        if (fr) {
          patch.fromBic = tval('BICFI', fr);
          const clr = getT('ClrSysMmbId', fr);
          if (clr) {
            patch.fromMmbId = tval('MmbId', clr);
            patch.fromClrSysId = tval('Cd', getT('ClrSysId', clr) || clr);
          }
          patch.fromLei = tval('LEI', fr);
        }
        const to = getT('To', appHdr);
        if (to) {
          patch.toBic = tval('BICFI', to);
          const clr = getT('ClrSysMmbId', to);
          if (clr) {
            patch.toMmbId = tval('MmbId', clr);
            patch.toClrSysId = tval('Cd', getT('ClrSysId', clr) || clr);
          }
          patch.toLei = tval('LEI', to);
        }
        patch.bizMsgId = tval('BizMsgIdr', appHdr);
      }

      // Document
      const grpHdr = getT('GrpHdr');
      if (grpHdr) {
        patch.msgId = tval('MsgId', grpHdr);
        patch.creDtTm = tval('CreDtTm', grpHdr);
      }

      const tx = getT('CdtTrfTxInf') || getT('DrctDbtTxInf');
      if (tx) {
        const pmtId = getT('PmtId', tx);
        if (pmtId) {
          patch.instrId = tval('InstrId', pmtId);
          patch.endToEndId = tval('EndToEndId', pmtId);
          patch.txId = tval('TxId', pmtId);
          patch.uetr = tval('UETR', pmtId);
          patch.clrSysRef = tval('ClrSysRef', pmtId);
        }

        const pmtTp = getT('PmtTpInf', tx);
        if (pmtTp) {
          patch.instrPrty = tval('InstrPrty', pmtTp);
          patch.clrChanl = tval('ClrChanl', pmtTp);
          const svcLvl = getT('SvcLvl', pmtTp);
          if (svcLvl) {
            patch.svcLvlCd = tval('Cd', svcLvl);
            patch.svcLvlPrtry = tval('Prtry', svcLvl);
          }
          const lclInstrm = getT('LclInstrm', pmtTp);
          if (lclInstrm) {
            patch.lclInstrmCd = tval('Cd', lclInstrm);
            patch.lclInstrmPrtry = tval('Prtry', lclInstrm);
          }
          const ctgyPurp = getT('CtgyPurp', pmtTp);
          if (ctgyPurp) {
            patch.ctgyPurpCd = tval('Cd', ctgyPurp);
            patch.ctgyPurpPrtry = tval('Prtry', ctgyPurp);
          }
        }

        const amtEl = getT('IntrBkSttlmAmt', tx);
        if (amtEl) {
          patch.amount = amtEl.textContent?.trim() || '';
          patch.currency = amtEl.getAttribute('Ccy') || '';
        }
        patch.sttlmDt = tval('IntrBkSttlmDt', tx);
        patch.reqdColltnDt = tval('ReqdColltnDt', tx);

        patch.chrgBr = tval('ChrgBr', tx);

        const drctDbt = getT('DrctDbtTx', tx);
        if (drctDbt) {
          const mndt = getT('MndtRltdInf', drctDbt);
          if (mndt) {
            patch.mndtId = tval('MndtId', mndt);
            patch.dtOfSgntr = tval('DtOfSgntr', mndt);
            patch.amdmntInd = tval('AmdmntInd', mndt);
          }
        }

        const mapAgt = (p: string, tag: string, parent: any = tx) => {
          const el = getT(tag, parent);
          if (!el) return;
          const fi = getT('FinInstnId', el);
          if (fi) {
            patch[p + 'Bic'] = tval('BICFI', fi);
            patch[p + 'Lei'] = tval('LEI', fi);
            patch[p + 'Name'] = tval('Nm', fi);
            const mmb = getT('ClrSysMmbId', fi);
            if (mmb) {
              patch[p + 'MmbId'] = tval('MmbId', mmb);
              patch[p + 'ClrSysCd'] = tval('Cd', getT('ClrSysId', mmb) || mmb);
            }
          }
          const acct = getT(tag + 'Acct', parent);
          if (acct) {
            patch[p + 'Acct'] = tval('IBAN', getT('Id', acct) || acct) || tval('Id', getT('Othr', getT('Id', acct) || acct) || acct);
          }
        };

        const mapParty = (p: string, tag: string, parent: any = tx) => {
          const el = getT(tag, parent);
          if (!el) return;
          patch[p + 'Name'] = tval('Nm', el);
          const pstl = getT('PstlAdr', el);
          if (pstl) {
            patch[p + 'AddrType'] = 'hybrid';
            const lines = pstl.querySelectorAll(':scope > AdrLine');
            if (lines.length > 0) {
              patch[p + 'AdrLine1'] = lines[0].textContent || '';
              if (lines.length > 1) patch[p + 'AdrLine2'] = lines[1].textContent || '';
              patch[p + 'AddrType'] = 'hybrid';
            } else {
              patch[p + 'Ctry'] = tval('Ctry', pstl);
              patch[p + 'TwnNm'] = tval('TwnNm', pstl);
              patch[p + 'StrtNm'] = tval('StrtNm', pstl);
              patch[p + 'BldgNb'] = tval('BldgNb', pstl);
              patch[p + 'PstCd'] = tval('PstCd', pstl);
              patch[p + 'AddrType'] = 'structured';
            }
          }

          const id = getT('Id', el);
          if (id) {
            const orgId = getT('OrgId', id);
            if (orgId) {
              patch[p + 'IdType'] = 'org';
              patch[p + 'OrgAnyBIC'] = tval('AnyBIC', orgId);
              patch[p + 'OrgLEI'] = tval('LEI', orgId);
            }
            const prvtId = getT('PrvtId', id);
            if (prvtId) {
              patch[p + 'IdType'] = 'prvt';
              const birth = getT('DtAndPlcOfBirth', prvtId);
              if (birth) {
                patch[p + 'PrvtDtAndPlcOfBirthDt'] = tval('BirthDt', birth);
                patch[p + 'PrvtDtAndPlcOfBirthCity'] = tval('CityOfBirth', birth);
                patch[p + 'PrvtDtAndPlcOfBirthCtry'] = tval('CtryOfBirth', birth);
              }
            }
          }
          const acct = getT(tag + 'Acct', parent);
          if (acct) {
            patch[p + 'Acct'] = tval('IBAN', getT('Id', acct) || acct) || tval('Id', getT('Othr', getT('Id', acct) || acct) || acct);
          }
        };

        mapAgt('prvsInstgAgt1', 'PrvsInstgAgt1');
        mapAgt('prvsInstgAgt2', 'PrvsInstgAgt2');
        mapAgt('prvsInstgAgt3', 'PrvsInstgAgt3');
        mapAgt('instgAgt', 'InstgAgt');
        mapAgt('instdAgt', 'InstdAgt');
        mapAgt('intrmyAgt1', 'IntrmyAgt1');
        mapAgt('intrmyAgt2', 'IntrmyAgt2');
        mapAgt('intrmyAgt3', 'IntrmyAgt3');
        mapParty('dbtr', 'Dbtr');
        mapAgt('dbtrAgt', 'DbtrAgt');
        mapAgt('cdtrAgt', 'CdtrAgt');
        mapParty('cdtr', 'Cdtr');
        mapParty('ultmtDbtr', 'UltmtDbtr');
        mapParty('ultmtCdtr', 'UltmtCdtr');
        mapParty('initgPty', 'InitgPty');

        const rmtInf = getT('RmtInf', tx);
        if (rmtInf) {
          const ustrd = getT('Ustrd', rmtInf);
          if (ustrd) {
            patch.rmtInfType = 'ustrd';
            patch.rmtInfUstrd = ustrd.textContent || '';
          } else {
            const strd = getT('Strd', rmtInf);
            if (strd) {
              patch.rmtInfType = 'strd';
              const ref = getT('CdtrRefInf', strd);
              if (ref) {
                patch.rmtInfStrdCdtrRefType = tval('Cd', getT('Tp', ref) || ref);
                patch.rmtInfStrdCdtrRef = tval('Ref', ref);
              }
              patch.rmtInfStrdAddtlRmtInf = tval('AddtlRmtInf', strd);
              const rfrd = getT('RfrdDocInf', strd);
              if (rfrd) {
                patch.rmtInfStrdRfrdDocNb = tval('Nb', rfrd);
                patch.rmtInfStrdRfrdDocCd = tval('Cd', getT('Tp', rfrd) || rfrd);
              }
            }
          }
        } else {
          patch.rmtInfType = 'none';
        }

        patch.purpCd = tval('Cd', getT('Purp', tx) || tx);
      }

      this.form.patchValue(patch, { emitEvent: false });
    } catch (e) {
      console.warn('XML Parse failed', e);
    } finally {
      this.isParsingXml = false;
    }
  }

  syncScroll(editor: HTMLTextAreaElement, gutter: HTMLDivElement) {
    gutter.scrollTop = editor.scrollTop;
  }

  // Validation Modal State
  showValidationModal = false;
  validationStatus: 'idle' | 'validating' | 'done' = 'idle';
  validationReport: any = null;
  validationExpandedIssue: any = null;

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


  viewXmlModal() {
    this.closeValidationModal();
    this.switchToPreview();
  }


  editXmlModal() {
    this.closeValidationModal();
    this.currentTab = 'form';
  }

  runValidationModal() {
    this.validateMessage();
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
}