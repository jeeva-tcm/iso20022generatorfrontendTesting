import { Component, OnInit, OnDestroy, ViewChild, ElementRef, HostListener } from '@angular/core';
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
  selector: 'app-camt055',
  standalone: true,
  imports: [CommonModule, ReactiveFormsModule, FormsModule, MatIconModule, MatDialogModule],
  templateUrl: './camt055.component.html',
  styleUrls: ['./camt055.component.css']
})
export class Camt055Component implements OnInit, OnDestroy {
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

  agentPrefixes = ['assgnr', 'assgne', 'agt'];
  partyPrefixes = ['cretr', 'cxlRsnOrgtr'];
  countries: string[] = [];
  cancellationReasonCodes = [
    { code: 'DUPL', label: 'Duplicate Payment' },
    { code: 'FRAD', label: 'Fraudulent Origin' },
    { code: 'TECH', label: 'Technical Problem' },
    { code: 'CUST', label: 'Requested by Customer' },
    { code: 'UPAY', label: 'Undue Payment' },
    { code: 'CURR', label: 'Incorrect Currency' },
    { code: 'MERI', label: 'Invalid Creditor Account' },
    { code: 'AC03', label: 'Invalid Creditor Account Number' },
    { code: 'AM09', label: 'Wrong Amount' },
    { code: 'BE01', label: 'Inconsistent with End Customer' },
    { code: 'CUTA', label: 'Cancel Upon To Ability' },
    { code: 'AGNT', label: 'Agent Error' },
    { code: 'NARR', label: 'Narrative Reason' }
  ];

  // Form submission validation
  formSubmissionErrors: string[] = [];
  showSubmissionErrors = false;

  // Max-length warning state (uniform with camt054/camt056)
  showMaxLenWarning: { [key: string]: boolean } = {};
  warningTimeouts: { [key: string]: ReturnType<typeof setTimeout> } = {};

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

  copyDplctCodes = ['COPY', 'CODU', 'DUPL'];
  priorityCodes = ['HIGH', 'NORM'];

  orgSchemeCodes = ['LEI', 'DUNS', 'VAT', 'TXID', 'GIIN', 'CRN'];
  prvtSchemeCodes = ['CCPT', 'DRLC', 'NIDN', 'SSSN', 'PASSPORT', 'NATIONALID'];

  private readonly DRAFT_KEY = 'draft_camt055';
  private draftSaveTimer: ReturnType<typeof setTimeout> | null = null;
  showDraftBanner = false;
  isClearingDraft = false;

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
    const hadDraft = this.loadDraft();
    if (hadDraft) {
      this.showDraftBanner = true;
      this.generateXml();
    }
    this.generateXml();
    this.pushHistory();
    this.updateConditionalValidators();
  }

  private updateConditionalValidators() {
    const ADDR_PAT = Validators.pattern(/^[a-zA-Z0-9\/\-\?:\(\)\.,\+' ]+$/);
    [...this.agentPrefixes, ...this.partyPrefixes].forEach(p => {
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

  fetchCountries() {
    this.http.get<any>(this.config.getApiUrl('/codelists/country')).subscribe({
      next: (res) => { if (res && res.codes) this.countries = res.codes; },
      error: (err) => console.error('Failed to load countries', err)
    });
  }

  buildForm() {
    const BIC = [Validators.required, Validators.pattern(/^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$/)];
    const BIC_OPT = [Validators.pattern(/^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$/)];
    const LEI = [Validators.pattern(/^[A-Z0-9]{18}[0-9]{2}$/)];
    const UETR_PATTERN = [Validators.required, Validators.pattern(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/)];
    const CCY = [Validators.required, Validators.pattern(/^[A-Z]{3,3}$/)];
    const SAFE_NAME = Validators.pattern(/^[a-zA-Z0-9\s.,\-\/()]+$/);

    this.form = this.fb.group({
      // AppHdr
      head_charSet: [''],
      head_fromBic: ['BBBBUS33XXX', BIC_OPT],
      head_fromClrSysId: ['', [Validators.maxLength(5)]],
      head_fromMmbId: ['', [Validators.maxLength(35)]],
      head_fromLei: ['', [Validators.pattern(/^[A-Z0-9]{20}$/)]],
      head_toBic: ['CCCCGB2LXXX', BIC_OPT],
      head_toClrSysId: ['', [Validators.maxLength(5)]],
      head_toMmbId: ['', [Validators.maxLength(35)]],
      head_toLei: ['', [Validators.pattern(/^[A-Z0-9]{20}$/)]],
      head_bizMsgIdr: ['CXL-' + Date.now(), [Validators.required, Validators.maxLength(35)]],
      head_msgDefIdr: ['camt.055.001.08', Validators.required],
      head_bizSvc: ['swift.cbprplus.02', Validators.required],
      head_mktPrctcRegy: ['', [Validators.maxLength(35)]],
      head_mktPrctcId: ['', [Validators.maxLength(35)]],
      head_creDt: [this.isoNow(), Validators.required],
      head_cpyDplct: [''],
      head_pssblDplct: [false],
      head_prty: ['NORM'],
      head_rltd_enabled: [false],
      head_rltd_fromBic: ['', BIC_OPT],
      head_rltd_fromClrSysId: ['', [Validators.maxLength(5)]],
      head_rltd_fromMmbId: ['', [Validators.maxLength(35)]],
      head_rltd_fromLei: ['', [Validators.pattern(/^[A-Z0-9]{20}$/)]],
      head_rltd_toBic: ['', BIC_OPT],
      head_rltd_toClrSysId: ['', [Validators.maxLength(5)]],
      head_rltd_toMmbId: ['', [Validators.maxLength(35)]],
      head_rltd_toLei: ['', [Validators.pattern(/^[A-Z0-9]{20}$/)]],
      head_rltd_bizMsgIdr: ['', [Validators.maxLength(35)]],
      head_rltd_msgDefIdr: [''],
      head_rltd_bizSvc: [''],
      head_rltd_creDt: [''],
      head_rltd_cpyDplct: [''],
      head_rltd_prty: [''],
      head_rltd: [''], // Hidden control for backwards compatibility if needed elsewhere

      // Document - Assgnmt
      assgnmt_id: ['ASGN-' + Date.now(), [Validators.required, Validators.maxLength(35)]],
      assgnmt_creDtTm: [this.isoNow(), Validators.required],

      // Underlying - OrgnlPmtInfAndCxl
      orgnlPmtInfId: ['', [Validators.maxLength(35), Validators.pattern(/^(?!\s+$).*/)]],
      orgnlMsgId: ['MSG-ORG-' + Date.now(), [Validators.required, Validators.maxLength(35)]],
      orgnlMsgNmId: ['pacs.008.001.08', Validators.required],
      orgnlCreDtTm: [this.isoNow(), Validators.required],

      // TxInf
      cxlId: ['CXLID-' + Date.now(), [Validators.required, Validators.maxLength(35)]],
      case_id: ['CASE-' + Date.now().toString().slice(-10), [Validators.required, Validators.maxLength(16)]],

      // Original References (OrgnlEndToEndId required before OrgnlUETR per schema)
      orgnlInstrId: ['', Validators.maxLength(35)],
      orgnlEndToEndId: ['E2E-' + Date.now().toString().slice(-10), [Validators.required, Validators.maxLength(35)]],
      orgnlUETR: [this.uetrService.generate(), UETR_PATTERN],

      // Amount (OrgnlInstdAmt required before OrgnlReqdExctnDt per schema)
      orgnlInstdAmt_ccy: ['USD', CCY],
      orgnlInstdAmt_val: ['1000.00', [Validators.required, Validators.pattern(/^\d+(\.\d+)?$/)]],

      // Dates
      orgnlReqdExctnDt: [new Date().toISOString().split('T')[0], [Validators.pattern(/^\d{4}-\d{2}-\d{2}$/)]],
      orgnlReqdExctnDtTm: ['', [Validators.pattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?([+-]\d{2}:\d{2}|Z)?$/)]],
      orgnlReqdColltnDt: ['', [Validators.pattern(/^\d{4}-\d{2}-\d{2}$/)]],

      // Cancellation Reason
      cxlRsnCd: ['CUTA', Validators.required],
      cxlRsnAddtlInf: ['', Validators.maxLength(140)]
    });

    // Add conditional validators for head_from, head_to, head_rltd_from, head_rltd_to
    this.form.addValidators((group: any) => {
      const prefixes = ['head_from', 'head_to', 'head_rltd_from', 'head_rltd_to'];
      let errors: any = null;

      prefixes.forEach(p => {
        // Only validate Rltd if enabled
        if (p.startsWith('head_rltd_') && !group.get('head_rltd_enabled')?.value) return;

        const bic = group.get(p + 'Bic')?.value;
        const cd = group.get(p + 'ClrSysId')?.value;
        const mmb = group.get(p + 'MmbId')?.value;
        const lei = group.get(p + 'Lei')?.value;

        // At least one must exist
        if (!bic && !cd && !mmb && !lei) {
          if (!errors) errors = {};
          errors[p + '_missing_identity'] = true;
        }

        // If ClrSysMmbId is present -> Cd and MmbId both mandatory
        if ((cd || mmb) && (!cd || !mmb)) {
          if (!errors) errors = {};
          errors[p + '_incomplete_clrsys'] = true;
        }
      });

      // Identification Schemes validation
      this.partyPrefixes.forEach(p => {
        const orgId = group.get(p + 'OrgOthrId')?.value;
        const orgCd = group.get(p + 'OrgOthrCd')?.value;
        const prvtId = group.get(p + 'PrvtOthrId')?.value;
        const prvtCd = group.get(p + 'PrvtOthrCd')?.value;

        if (orgCd && !orgId) {
          if (!errors) errors = {};
          errors[p + '_OrgOthrId_required'] = true;
        }
        if (prvtCd && !prvtId) {
          if (!errors) errors = {};
          errors[p + '_PrvtOthrId_required'] = true;
        }

        // Specific pattern validation
        if (orgCd === 'LEI' && orgId && orgId.length !== 20) {
          if (!errors) errors = {};
          errors[p + '_OrgOthrId_lei'] = true;
        }
        if (orgCd === 'DUNS' && orgId && !/^\d{9}$/.test(orgId)) {
          if (!errors) errors = {};
          errors[p + '_OrgOthrId_duns'] = true;
        }
      });

      // OrgnlReqdExctnDt Choice (Dt OR DtTm) - XOR Rule
      if (group.get('orgnlReqdExctnDt')?.value && group.get('orgnlReqdExctnDtTm')?.value) {
        if (!errors) errors = {};
        errors['orgnlReqdExctnDt_duplicate'] = true;
      }

      // OrgnlReqdExctnDt vs OrgnlReqdColltnDt â€” mutually exclusive in camt.055 TxInf
      const hasExctn = !!(group.get('orgnlReqdExctnDt')?.value?.trim() || group.get('orgnlReqdExctnDtTm')?.value?.trim());
      const hasColltn = !!(group.get('orgnlReqdColltnDt')?.value?.trim());
      if (hasExctn && hasColltn) {
        if (!errors) errors = {};
        errors['date_choice_conflict'] = true;
      }

      return errors;
    });

    [...this.agentPrefixes, ...this.partyPrefixes].forEach(p => {
      const isParty = this.partyPrefixes.includes(p);
      const isAssgnAgent = (p === 'assgnr' || p === 'assgne');
      
      if (!isAssgnAgent) {
        this.form.addControl(p + 'Name', this.fb.control('', [Validators.maxLength(140), SAFE_NAME]));
      }

      if (isParty) {
        // IdType toggle: 'org' = Organisation, 'prvt' = Private (mutually exclusive)
        this.form.addControl(p + 'IdType', this.fb.control('org'));

        this.form.addControl(p + 'OrgAnyBIC', this.fb.control('', BIC_OPT));
        this.form.addControl(p + 'OrgLEI', this.fb.control('', Validators.pattern(/^[A-Z0-9]{18}[0-9]{2}$/)));
        
        // Org Othr
        this.form.addControl(p + 'OrgOthrId', this.fb.control('', Validators.maxLength(35)));
        this.form.addControl(p + 'OrgOthrCd', this.fb.control('', Validators.maxLength(35)));
        this.form.addControl(p + 'OrgOthrIssr', this.fb.control('', Validators.maxLength(35)));

        // PrvtId Birth
        this.form.addControl(p + 'PrvtBirthDt', this.fb.control('', [Validators.pattern(/^\d{4}-\d{2}-\d{2}$/), this.futureDateValidator]));
        this.form.addControl(p + 'PrvtPrvcOfBirth', this.fb.control('', Validators.maxLength(35)));
        this.form.addControl(p + 'PrvtCityOfBirth', this.fb.control('', Validators.maxLength(35)));
        this.form.addControl(p + 'PrvtCtryOfBirth', this.fb.control(''));
        
        // PrvtId Othr
        this.form.addControl(p + 'PrvtOthrId', this.fb.control('', Validators.maxLength(35)));
        this.form.addControl(p + 'PrvtOthrCd', this.fb.control('', Validators.maxLength(35)));
        this.form.addControl(p + 'PrvtOthrIssr', this.fb.control('', Validators.maxLength(35)));
      } else {
        this.form.addControl(p + 'Bic', this.fb.control('', BIC_OPT));
        this.form.addControl(p + 'Lei', this.fb.control('', Validators.pattern(/^[A-Z0-9]{18}[0-9]{2}$/)));
        this.form.addControl(p + 'ClrSysCd', this.fb.control('', Validators.maxLength(5)));
        this.form.addControl(p + 'ClrSysMmbId', this.fb.control('', Validators.maxLength(35)));
      }
      this.form.addControl(p + 'Acct', this.fb.control('', Validators.maxLength(34)));

      // Address fields
      this.form.addControl(p + 'AddrType', this.fb.control('none'));
      this.form.addControl(p + 'AdrLine1', this.fb.control('', Validators.maxLength(70)));
      this.form.addControl(p + 'AdrLine2', this.fb.control('', Validators.maxLength(70)));
      this.form.addControl(p + 'AdrLine3', this.fb.control('', Validators.maxLength(70)));
      this.form.addControl(p + 'StrtNm', this.fb.control('', Validators.maxLength(70)));
      this.form.addControl(p + 'BldgNb', this.fb.control('', Validators.maxLength(16)));
      this.form.addControl(p + 'BldgNm', this.fb.control('', Validators.maxLength(35)));
      this.form.addControl(p + 'PstCd', this.fb.control('', Validators.maxLength(16)));
      this.form.addControl(p + 'TwnNm', this.fb.control('', Validators.maxLength(35)));
      this.form.addControl(p + 'Ctry', this.fb.control(''));
      
      if (p === 'cxlRsnOrgtr') {
        this.form.addControl(p + 'CtryOfRes', this.fb.control(''));
      }
    });

    this.form.valueChanges.pipe(debounceTime(300)).subscribe(() => {
      if (!this.isParsingXml && !this.isInternalChange) {
        this.updateConditionalValidators();
        this.generateXml();
        this.pushHistory();
        this.scheduleDraftSave();
        // Clear submission errors on any change
        if (this.showSubmissionErrors) {
          this.showSubmissionErrors = false;
          this.formSubmissionErrors = [];
        }
      }
    });

    // Auto-format: BIC fields â†’ uppercase
    const bicFields = ['head_fromBic', 'head_toBic', 'head_rltd_fromBic', 'head_rltd_toBic'];
    bicFields.forEach(f => {
      this.form.get(f)?.valueChanges.subscribe(val => {
        if (val && val !== val.toUpperCase()) {
          this.form.get(f)?.setValue(val.toUpperCase(), { emitEvent: false });
        }
      });
    });

    // Auto-format: UETR â†’ lowercase
    this.form.get('orgnlUETR')?.valueChanges.subscribe(val => {
      if (val && val !== val.toLowerCase()) {
        this.form.get('orgnlUETR')?.setValue(val.toLowerCase(), { emitEvent: false });
      }
    });

    // Auto-format: Currency â†’ uppercase
    this.form.get('orgnlInstdAmt_ccy')?.valueChanges.subscribe(val => {
      if (val && val !== val.toUpperCase()) {
        this.form.get('orgnlInstdAmt_ccy')?.setValue(val.toUpperCase(), { emitEvent: false });
      }
    });

    // Setup XOR logic for Date/DateTime choices
    // OrgnlReqdExctnDt: Dt vs DtTm are mutually exclusive within that choice field
    this.setupDateXor('orgnlReqdExctnDt', 'orgnlReqdExctnDtTm');

    // OrgnlReqdExctnDt vs OrgnlReqdColltnDt â€” mutually exclusive at TxInf level
    // When any ExctnDt field is filled, clear ColltnDt and vice versa
    const clearColltn = () => {
      if (this.isParsingXml || this.isInternalChange) return;
      const colltn = this.form.get('orgnlReqdColltnDt');
      if (colltn?.value) { this.isInternalChange = true; colltn.setValue('', { emitEvent: false }); this.isInternalChange = false; }
    };
    const clearExctn = () => {
      if (this.isParsingXml || this.isInternalChange) return;
      const dt = this.form.get('orgnlReqdExctnDt');
      const dtTm = this.form.get('orgnlReqdExctnDtTm');
      if (dt?.value) { this.isInternalChange = true; dt.setValue('', { emitEvent: false }); this.isInternalChange = false; }
      if (dtTm?.value) { this.isInternalChange = true; dtTm.setValue('', { emitEvent: false }); this.isInternalChange = false; }
    };
    this.form.get('orgnlReqdExctnDt')?.valueChanges.subscribe(v => { if (v?.trim()) clearColltn(); });
    this.form.get('orgnlReqdExctnDtTm')?.valueChanges.subscribe(v => { if (v?.trim()) clearColltn(); });
    this.form.get('orgnlReqdColltnDt')?.valueChanges.subscribe(v => { if (v?.trim()) clearExctn(); });
  }

  setupDateXor(dtField: string, dtTmField: string) {
    // When Dt changes
    this.form.get(dtField)?.valueChanges.subscribe(val => {
      if (this.isParsingXml || this.isInternalChange) return;
      if (val) {
        const tmCtrl = this.form.get(dtTmField);
        if (tmCtrl?.value) {
          this.isInternalChange = true;
          tmCtrl.setValue('', { emitEvent: false });
          this.isInternalChange = false;
        }
      }
    });

    // When DtTm changes
    this.form.get(dtTmField)?.valueChanges.subscribe(val => {
      if (this.isParsingXml || this.isInternalChange) return;
      if (val) {
        const dtCtrl = this.form.get(dtField);
        if (dtCtrl?.value) {
          this.isInternalChange = true;
          dtCtrl.setValue('', { emitEvent: false });
          this.isInternalChange = false;
        }
      }
    });
  }

  fdt(dt: string): string {
    if (!dt) return dt;
    let s = dt.trim();
    
    // ISO 20022 DateTime (ISODateTime) should have seconds and offset.
    // HTML5 datetime-local returns YYYY-MM-DDTHH:mm or YYYY-MM-DDTHH:mm:ss
    
    // Add seconds if missing
    if (s.includes('T') && !/:[0-9]{2}:[0-9]{2}/.test(s)) {
      if (/:[0-9]{2}/.test(s)) s += ':00';
    }

    // Handle Z or missing offset
    s = s.replace(/\.\d+/, '').replace('Z', '+00:00');
    if (s && s.includes('T') && !/([+-]\d{2}:\d{2})$/.test(s)) {
      s += '+00:00';
    }
    return s;
  }

  futureDateValidator(control: any) {
    if (!control.value) return null;
    const today = new Date();
    today.setHours(0, 0, 0, 0); 
    const selectedDate = new Date(control.value);
    selectedDate.setHours(0, 0, 0, 0);
    return selectedDate > today ? { future_date: true } : null;
  }

  getSchemeGuidance(prefix: string, type: 'Org' | 'Prvt'): string {
    const code = this.form.get(prefix + type + 'OthrCd')?.value;
    if (!code) return '';
    return type === 'Org' ? this.orgSchemeGuidance[code] : this.prvtSchemeGuidance[code];
  }

  isoNow(): string {
    return this.fdt(new Date().toISOString());
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
    const v = this.form.value;
    
    // AppHdr segment
    let appHdr = '';
    appHdr += this.leaf('CharSet', v.head_charSet, 2);
    appHdr += this.buildFIId('Fr', v.head_fromBic, v.head_fromClrSysId, v.head_fromMmbId, v.head_fromLei, 2);
    appHdr += this.buildFIId('To', v.head_toBic, v.head_toClrSysId, v.head_toMmbId, v.head_toLei, 2);
    appHdr += this.leaf('BizMsgIdr', v.head_bizMsgIdr, 2);
    appHdr += this.leaf('MsgDefIdr', v.head_msgDefIdr, 2);
    appHdr += this.leaf('BizSvc', v.head_bizSvc, 2);
    // MktPrctc requires Regy before Id per schema â€” only emit when both are present
    if (v.head_mktPrctcId && v.head_mktPrctcRegy) {
        let mkt = this.leaf('Regy', v.head_mktPrctcRegy, 3);
        mkt += this.leaf('Id', v.head_mktPrctcId, 3);
        appHdr += this.branch('MktPrctc', mkt, 2);
    }
    appHdr += this.leaf('CreDt', this.fdt(v.head_creDt), 2);
    appHdr += this.leaf('CpyDplct', v.head_cpyDplct, 2);
    if (v.head_pssblDplct) appHdr += this.leaf('PssblDplct', 'true', 2);
    appHdr += this.leaf('Prty', v.head_prty, 2);
    
    // Rltd segment
    if (v.head_rltd_enabled) {
        let rltdStr = '';
        rltdStr += this.buildFIId('Fr', v.head_rltd_fromBic, v.head_rltd_fromClrSysId, v.head_rltd_fromMmbId, v.head_rltd_fromLei, 3);
        rltdStr += this.buildFIId('To', v.head_rltd_toBic, v.head_rltd_toClrSysId, v.head_rltd_toMmbId, v.head_rltd_toLei, 3);
        rltdStr += this.leaf('BizMsgIdr', v.head_rltd_bizMsgIdr, 3);
        rltdStr += this.leaf('MsgDefIdr', v.head_rltd_msgDefIdr, 3);
        rltdStr += this.leaf('BizSvc', v.head_rltd_bizSvc, 3);
        if (v.head_rltd_creDt) rltdStr += this.leaf('CreDt', this.fdt(v.head_rltd_creDt), 3);
        if (v.head_rltd_cpyDplct) rltdStr += this.leaf('CpyDplct', v.head_rltd_cpyDplct, 3);
        if (v.head_rltd_prty) rltdStr += this.leaf('Prty', v.head_rltd_prty, 3);
        appHdr += this.branch('Rltd', rltdStr, 2);
    } else if (v.head_rltd) {
        appHdr += this.leaf('Rltd', v.head_rltd, 2);
    }

    // Assgnmt (Order: Id -> Assgnr -> Assgne -> CreDtTm)
    let assgnmt = '';
    assgnmt += this.leaf('Id', v.assgnmt_id, 4);
    // Assgnr and Assgne are mandatory in camt.055
    // BAH "From"/"To" BIC must match Assgnr/Assgne BIC when CopyDuplicate is absent
    const assgnrBic = (v.head_fromBic || '').trim().toUpperCase() || 'SNKRBEBB';
    const assgneBic = (v.head_toBic || '').trim().toUpperCase() || 'ASGNBEBB';
    const assgnrXml = this.partyAgentXml('Assgnr', 'assgnr', v, 4, true);
    assgnmt += assgnrXml || this.branch('Assgnr', this.branch('Agt', this.branch('FinInstnId', this.leaf('BICFI', assgnrBic, 7), 6), 5), 4);

    const assgneXml = this.partyAgentXml('Assgne', 'assgne', v, 4, true);
    assgnmt += assgneXml || this.branch('Assgne', this.branch('Agt', this.branch('FinInstnId', this.leaf('BICFI', assgneBic, 7), 6), 5), 4);
    
    assgnmt += this.leaf('CreDtTm', this.fdt(v.assgnmt_creDtTm), 4);

    // OrgnlGrpInf (inside OrgnlPmtInfAndCxl)
    let orgnlGrpInf = '';
    orgnlGrpInf += this.leaf('OrgnlMsgId', v.orgnlMsgId, 6);
    orgnlGrpInf += this.leaf('OrgnlMsgNmId', v.orgnlMsgNmId, 6);
    orgnlGrpInf += this.leaf('OrgnlCreDtTm', this.fdt(v.orgnlCreDtTm), 6);

    // TxInf (inside OrgnlPmtInfAndCxl)
    let txInf = '';
    txInf += this.leaf('CxlId', v.cxlId, 6);
    
    // Case is strongly required for camt.055 (schema limit: max 16 chars)
    let caseIdVal = (v.case_id || 'CASE-' + Date.now().toString().slice(-10)).substring(0, 16);
    let caseInner = this.leaf('Id', caseIdVal, 7);
    // Cretr must contain ONLY Pty (Agt is NOT allowed under Cretr per ISO 20022)
    // Ensure only ONE <Id> at this level (Case/Id) â€” party Id is nested deeper in Cretr/Pty/Id
    // Nm + PstlAdr (with TwnNm, Ctry, AdrLine x2) must always be present together per CBPR+ rule
    let cretrPty = this.partyAgentXml('Pty', 'cretr', v, 8);
    const cretrFallback = this.branch('Pty',
      this.leaf('Nm', 'UNKNOWN', 10) +
      this.branch('PstlAdr',
        this.leaf('TwnNm', 'Brussels', 11) +
        this.leaf('Ctry', 'BE', 11) +
        this.leaf('AdrLine', 'Address Line 1', 11) +
        this.leaf('AdrLine', 'Address Line 2', 11),
        10),
      9);
    caseInner += this.branch('Cretr', cretrPty || cretrFallback, 7);
    txInf += this.branch('Case', caseInner.trimEnd(), 6);

    // Original References
    txInf += this.leaf('OrgnlInstrId', v.orgnlInstrId, 6);
    txInf += this.leaf('OrgnlEndToEndId', v.orgnlEndToEndId, 6);
    txInf += this.leaf('OrgnlUETR', v.orgnlUETR, 6);
    
    // Amount
    if (v.orgnlInstdAmt_val) {
        const amt = this.roundAmount(v.orgnlInstdAmt_val, v.orgnlInstdAmt_ccy);
        txInf += `\t\t\t\t\t\t<OrgnlInstdAmt Ccy="${v.orgnlInstdAmt_ccy}">${amt}</OrgnlInstdAmt>\n`;
    }

    // Dates
    // OrgnlReqdExctnDt is DateAndDateTime2Choice â€” uses Dt or DtTm child elements
    // OrgnlReqdExctnDt and OrgnlReqdColltnDt are mutually exclusive in camt.055 TxInf.
    // Only ONE of these blocks may appear. Use if/else-if to guarantee this.
    if (v.orgnlReqdExctnDt && v.orgnlReqdExctnDt.trim()) txInf += this.branch('OrgnlReqdExctnDt', this.leaf('Dt', v.orgnlReqdExctnDt.trim(), 7), 6);
    else if (v.orgnlReqdExctnDtTm && v.orgnlReqdExctnDtTm.trim()) txInf += this.branch('OrgnlReqdExctnDt', this.leaf('DtTm', this.fdt(v.orgnlReqdExctnDtTm), 7), 6);
    else if (v.orgnlReqdColltnDt && v.orgnlReqdColltnDt.trim()) txInf += this.leaf('OrgnlReqdColltnDt', v.orgnlReqdColltnDt.trim(), 6);

    // Cancellation Reason
    let cxlRsnInner = '';
    cxlRsnInner += this.partyAgentXml('Orgtr', 'cxlRsnOrgtr', v, 8);
    cxlRsnInner += this.branch('Rsn', this.leaf('Cd', v.cxlRsnCd, 10), 9);
    if (v.cxlRsnAddtlInf) cxlRsnInner += this.leaf('AddtlInf', v.cxlRsnAddtlInf, 9);
    txInf += this.branch('CxlRsnInf', cxlRsnInner.trimEnd(), 6);

    // Construct Final XML
    let xml = `<?xml version="1.0" encoding="UTF-8"?>
<BusMsgEnvlp xmlns="urn:swift:xsd:envelope">
\t<AppHdr xmlns="urn:iso:std:iso:20022:tech:xsd:head.001.001.02">
${appHdr.trimEnd()}
\t</AppHdr>
\t<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.055.001.08">
\t\t<CstmrPmtCxlReq>
\t\t\t<Assgnmt>
${assgnmt.trimEnd()}
\t\t\t</Assgnmt>
\t\t\t<Undrlyg>
\t\t\t\t<OrgnlPmtInfAndCxl>
\t\t\t\t\t<OrgnlPmtInfId>${this.esc(v.orgnlPmtInfId || '')}</OrgnlPmtInfId>
\t\t\t\t\t<OrgnlGrpInf>
${orgnlGrpInf.trimEnd()}
\t\t\t\t\t</OrgnlGrpInf>
\t\t\t\t\t<TxInf>
${txInf.trimEnd()}
\t\t\t\t\t</TxInf>
\t\t\t\t</OrgnlPmtInfAndCxl>
\t\t\t</Undrlyg>
\t\t</CstmrPmtCxlReq>
\t</Document>
</BusMsgEnvlp>`;

    this.generatedXml = xml;
    this.formatXml(false);
  }

  buildFIId(tag: string, bic: string, clrSysId: string, mmbId: string, lei: string, indent: number): string {
    let inner = '';
    if (bic) inner += this.leaf('BICFI', bic, indent + 3);
    if (mmbId || clrSysId) {
        let clrMmb = '';
        if (clrSysId) clrMmb += this.branch('ClrSysId', this.leaf('Cd', clrSysId, indent + 5), indent + 4);
        if (mmbId) clrMmb += this.leaf('MmbId', mmbId, indent + 4);
        inner += this.branch('ClrSysMmbId', clrMmb, indent + 3);
    }
    if (lei) inner += this.leaf('LEI', lei, indent + 3);
    if (!inner) return '';
    return this.branch(tag, this.branch('FIId', this.branch('FinInstnId', inner, indent + 2), indent + 1), indent);
  }

  // XML Generators
  partyAgentXml(tag: string, prefix: string, v: any, indent = 4, isAssgn = false) {
    const isParty = this.partyPrefixes.includes(prefix);
    const bic = isParty ? v[prefix + 'OrgAnyBIC'] : v[prefix + 'Bic'];
    const name = v[prefix + 'Name'];
    const lei = isParty ? v[prefix + 'OrgLEI'] : v[prefix + 'Lei'];
    const clrCd = isParty ? v[prefix + 'OrgClrSysCd'] : v[prefix + 'ClrSysCd'];
    const clrMmb = isParty ? v[prefix + 'OrgClrSysMmbId'] : v[prefix + 'ClrSysMmbId'];

    if (!bic && !name && !lei && !clrMmb && v[prefix + 'AddrType'] === 'none') return '';

    let content = '';
    if (isAssgn) {
        // Agent inside Assgnmt (Agt/FinInstnId)
        let inner = '';
        if (bic) inner += this.leaf('BICFI', bic, indent + 3);
        if (clrMmb) {
            let clr = '';
            if (clrCd) clr += this.branch('ClrSysId', this.leaf('Cd', clrCd, indent + 5), indent + 4);
            clr += this.leaf('MmbId', clrMmb, indent + 4);
            inner += this.branch('ClrSysMmbId', clr, indent + 3);
        }
        if (lei) inner += this.leaf('LEI', lei, indent + 3);
        
        if (prefix !== 'assgnr' && prefix !== 'assgne') {
            if (name) inner += this.leaf('Nm', name, indent + 3);
            inner += this.addrXml(v, prefix, indent + 3);
        }
        content = this.branch('Agt', this.branch('FinInstnId', inner, indent + 2), indent + 1);
    } else if (!isParty) {
        // Agent structure (FinInstnId)
        let inner = '';
        if (bic) inner += this.leaf('BICFI', bic, indent + 2);
        if (clrMmb) {
            let clr = '';
            if (clrCd) clr += this.branch('ClrSysId', this.leaf('Cd', clrCd, indent + 4), indent + 3);
            clr += this.leaf('MmbId', clrMmb, indent + 3);
            inner += this.branch('ClrSysMmbId', clr, indent + 2);
        }
        if (lei) inner += this.leaf('LEI', lei, indent + 2);
        if (name) inner += this.leaf('Nm', name, indent + 2);
        inner += this.addrXml(v, prefix, indent + 2);
        content = this.branch('FinInstnId', inner, indent + 1);
    } else {
        // Party structure (Pty)
        if (name) content += this.leaf('Nm', name, indent + 2);
        content += this.addrXml(v, prefix, indent + 2);
        // NOTE: CtryOfRes is added AFTER idBlock below (ISO 20022 PartyIdentification135 sequence:
        // Nm â†’ PstlAdr â†’ Id â†’ CtryOfRes). Adding it before Id violates schema order.

        let idBlock = '';
        // IdType determines whether OrgId or PrvtId is emitted (mutually exclusive per ISO 20022)
        const idType = v[prefix + 'IdType'] || 'org';
        
        if (idType === 'org') {
            // OrgId ONLY
            let org = '';
            if (bic) org += `${this.tabs(indent + 4)}<AnyBIC>${this.esc(bic)}</AnyBIC>\n`;
            if (lei) org += `${this.tabs(indent + 4)}<LEI>${this.esc(lei)}</LEI>\n`;
            
            if (v[prefix + 'OrgOthrId']) {
                let othr = this.leaf('Id', v[prefix + 'OrgOthrId'], indent + 5);
                if (v[prefix + 'OrgOthrCd']) {
                    othr += this.branch('SchmeNm', this.leaf('Cd', v[prefix + 'OrgOthrCd'], indent + 7), indent + 6);
                }
                if (v[prefix + 'OrgOthrIssr']) {
                    othr += this.leaf('Issr', v[prefix + 'OrgOthrIssr'], indent + 5);
                }
                org += this.branch('Othr', othr, indent + 4);
            }
            
            if (org) {
                idBlock += this.branch('OrgId', org, indent + 3);
            }
        } else {
            // PrvtId ONLY
            let prvt = '';
            if (v[prefix + 'PrvtBirthDt'] || v[prefix + 'PrvtPrvcOfBirth'] || v[prefix + 'PrvtCityOfBirth'] || v[prefix + 'PrvtCtryOfBirth']) {
                let birth = '';
                if (v[prefix + 'PrvtBirthDt']) birth += this.leaf('BirthDt', v[prefix + 'PrvtBirthDt'], indent + 5);
                if (v[prefix + 'PrvtPrvcOfBirth']) birth += this.leaf('PrvcOfBirth', v[prefix + 'PrvtPrvcOfBirth'], indent + 5);
                if (v[prefix + 'PrvtCityOfBirth']) birth += this.leaf('CityOfBirth', v[prefix + 'PrvtCityOfBirth'], indent + 5);
                if (v[prefix + 'PrvtCtryOfBirth']) birth += this.leaf('CtryOfBirth', v[prefix + 'PrvtCtryOfBirth'], indent + 5);
                prvt += this.branch('DtAndPlcOfBirth', birth, indent + 4);
            }
            
            if (v[prefix + 'PrvtOthrId']) {
                let othr = this.leaf('Id', v[prefix + 'PrvtOthrId'], indent + 5);
                if (v[prefix + 'PrvtOthrCd']) {
                    othr += this.branch('SchmeNm', this.leaf('Cd', v[prefix + 'PrvtOthrCd'], indent + 7), indent + 6);
                }
                if (v[prefix + 'PrvtOthrIssr']) {
                    othr += this.leaf('Issr', v[prefix + 'PrvtOthrIssr'], indent + 5);
                }
                prvt += this.branch('Othr', othr, indent + 4);
            }
            
            if (prvt) {
                idBlock += this.branch('PrvtId', prvt, indent + 3);
            }
        }

        if (idBlock) {
            content += this.branch('Id', idBlock, indent + 2);
        }
        // CtryOfRes must follow Id in PartyIdentification135 sequence
        if (tag === 'Orgtr' && v[prefix + 'CtryOfRes']) {
            content += this.leaf('CtryOfRes', v[prefix + 'CtryOfRes'], indent + 2);
        }
        if (tag !== 'Pty' && tag !== 'Orgtr') {
            content = this.branch('Pty', content, indent + 1);
        }
    }

    return this.branch(tag, content.trim(), indent);
  }

  addrXml(v: any, prefix: string, indent = 4) {
    const type = v[prefix + 'AddrType'];
    if (type === 'none') return '';

    let content = `${this.tabs(indent)}<PstlAdr>\n`;
    if (type === 'structured' || type === 'hybrid') {
      content += this.leaf('StrtNm', v[prefix + 'StrtNm'], indent + 1);
      content += this.leaf('BldgNb', v[prefix + 'BldgNb'], indent + 1);
      content += this.leaf('BldgNm', v[prefix + 'BldgNm'], indent + 1);
      content += this.leaf('PstCd', v[prefix + 'PstCd'], indent + 1);
      content += this.leaf('TwnNm', v[prefix + 'TwnNm'], indent + 1);
    }
    content += this.leaf('Ctry', v[prefix + 'Ctry'], indent + 1);
    if (type === 'unstructured' || type === 'hybrid') {
      if (v[prefix + 'AdrLine1']) content += this.leaf('AdrLine', v[prefix + 'AdrLine1'], indent + 1);
      if (v[prefix + 'AdrLine2']) content += this.leaf('AdrLine', v[prefix + 'AdrLine2'], indent + 1);
      if (v[prefix + 'AdrLine3']) content += this.leaf('AdrLine', v[prefix + 'AdrLine3'], indent + 1);
    }
    content += `${this.tabs(indent)}</PstlAdr>\n`;
    return content;
  }

  roundAmount(val: string, ccy: string): string {
    const num = parseFloat(val);
    if (isNaN(num)) return val;
    let decimals = 2;
    const ccy3 = ['BHD', 'IQD', 'JOD', 'KWD', 'LYD', 'OMR', 'TND'];
    const ccy0 = ['JPY', 'KRW', 'CLP', 'VND'];
    if (ccy3.includes(ccy)) decimals = 3;
    else if (ccy0.includes(ccy)) decimals = 0;
    return num.toFixed(decimals);
  }

  tabs(n: number) { return '\t'.repeat(n); }
  esc(v: any): string {
    if (!v) return '';
    return v.toString().replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  leaf(tag: string, val: any, indent = 3): string {
    if (!val || (typeof val === 'string' && !val.trim())) return '';
    return `${this.tabs(indent)}<${tag}>${this.esc(val)}</${tag}>\n`;
  }
  branch(tag: string, content: string, indent = 3): string {
    if (!content?.trim()) return '';
    return `${this.tabs(indent)}<${tag}>\n${content.trimEnd()}\n${this.tabs(indent)}</${tag}>\n`;
  }

  parseXmlToForm(xml: string) {
    if (!xml || xml.length < 50) return;
    try {
      this.isParsingXml = true;
      const parser = new DOMParser();
      const doc = parser.parseFromString(xml, 'application/xml');
      
      const getT = (t: string, p: Element | Document = doc): Element | null => {
        const els = p.getElementsByTagName(t);
        if (els.length > 0) return els[0];
        const all = p.getElementsByTagName('*');
        for (let i = 0; i < all.length; i++) {
          if (all[i].localName === t) return all[i];
        }
        return null;
      };
      const tval = (tag: string, p: Element | Document = doc) => getT(tag, p)?.textContent?.trim() || '';
      
      const patch: any = {};
      // Only patch fields the parser explicitly reads — previously this wiped
      // every control to '' on each XML edit, silently dropping user data.
      const setVal = (f: string, v: string) => { if (v) patch[f] = v; };

      // 1. AppHdr (head.001)
      const head = getT('AppHdr');
      if (head) {
        setVal('head_charSet', tval('CharSet', head));
        setVal('head_bizMsgIdr', tval('BizMsgIdr', head));
        setVal('head_msgDefIdr', tval('MsgDefIdr', head));
        setVal('head_bizSvc', tval('BizSvc', head));
        setVal('head_creDt', tval('CreDt', head).replace('+00:00', '').replace('Z', ''));
        setVal('head_cpyDplct', tval('CpyDplct', head));
        patch.head_pssblDplct = tval('PssblDplct', head) === 'true';
        setVal('head_prty', tval('Prty', head));

        const mkt = getT('MktPrctc', head);
        if (mkt) {
            setVal('head_mktPrctcRegy', tval('Regy', mkt));
            setVal('head_mktPrctcId', tval('Id', mkt));
        }

        const fr = getT('Fr', head);
        if (fr) this.mapAddrToForm(fr, 'head_from', patch);
        const to = getT('To', head);
        if (to) this.mapAddrToForm(to, 'head_to', patch);

        const rltd = getT('Rltd', head);
        if (rltd) {
            patch.head_rltd_enabled = true;
            this.mapAddrToForm(getT('Fr', rltd), 'head_rltd_from', patch);
            this.mapAddrToForm(getT('To', rltd), 'head_rltd_to', patch);
            setVal('head_rltd_bizMsgIdr', tval('BizMsgIdr', rltd));
            setVal('head_rltd_msgDefIdr', tval('MsgDefIdr', rltd));
            setVal('head_rltd_bizSvc', tval('BizSvc', rltd));
            setVal('head_rltd_creDt', tval('CreDt', rltd).replace('+00:00', '').replace('Z', ''));
            setVal('head_rltd_cpyDplct', tval('CpyDplct', rltd));
            setVal('head_rltd_prty', tval('Prty', rltd));
        }
      }

      // 2. Document (camt.055)
      const root = getT('CstmrPmtCxlReq');
      if (root) {
        const assgnmt = getT('Assgnmt', root);
        if (assgnmt) {
           setVal('assgnmt_id', tval('Id', assgnmt));
           setVal('assgnmt_creDtTm', tval('CreDtTm', assgnmt).replace('+00:00', '').replace('Z', ''));
           const assgnr = getT('Assgnr', assgnmt);
           if (assgnr) this.mapAddrToForm(assgnr, 'assgnr', patch);
           const assgne = getT('Assgne', assgnmt);
           if (assgne) this.mapAddrToForm(assgne, 'assgne', patch);
        }

        const undrlyg = getT('Undrlyg', root);
        if (undrlyg) {
          const inf = getT('OrgnlPmtInfAndCxl', undrlyg);
          if (inf) {
            setVal('orgnlPmtInfId', tval('OrgnlPmtInfId', inf));
            const grp = getT('OrgnlGrpInf', inf);
            if (grp) {
               setVal('orgnlMsgId', tval('OrgnlMsgId', grp));
               setVal('orgnlMsgNmId', tval('OrgnlMsgNmId', grp));
               setVal('orgnlCreDtTm', tval('OrgnlCreDtTm', grp).replace('+00:00', '').replace('Z', ''));
            }

            const tx = getT('TxInf', inf);
            if (tx) {
              setVal('cxlId', tval('CxlId', tx));
              const cas = getT('Case', tx);
              if (cas) {
                setVal('case_id', tval('Id', cas));
                const cretr = getT('Cretr', cas);
                if (cretr) this.mapAddrToForm(cretr, 'cretr', patch);
              }

              setVal('orgnlInstrId', tval('OrgnlInstrId', tx));
              setVal('orgnlEndToEndId', tval('OrgnlEndToEndId', tx));
              setVal('orgnlUETR', tval('OrgnlUETR', tx));

              const amt = getT('OrgnlInstdAmt', tx);
              if (amt) {
                setVal('orgnlInstdAmt_val', amt.textContent?.trim() || '');
                setVal('orgnlInstdAmt_ccy', amt.getAttribute('Ccy') || '');
              }

              const exctn = getT('OrgnlReqdExctnDt', tx);
              if (exctn) {
                setVal('orgnlReqdExctnDt', tval('Dt', exctn));
                setVal('orgnlReqdExctnDtTm', tval('DtTm', exctn).replace('+00:00', '').replace('Z', ''));
              }
              setVal('orgnlReqdColltnDt', tval('OrgnlReqdColltnDt', tx));

              const rsnInf = getT('CxlRsnInf', tx);
              if (rsnInf) {
                setVal('cxlRsnCd', tval('Cd', getT('Rsn', rsnInf) || rsnInf));
                setVal('cxlRsnAddtlInf', tval('AddtlInf', rsnInf));
                const orgtr = getT('Orgtr', rsnInf);
                if (orgtr) {
                  this.mapAddrToForm(orgtr, 'cxlRsnOrgtr', patch);
                  setVal('cxlRsnOrgtrCtryOfRes', tval('CtryOfRes', orgtr));
                }
              }
            }
          }
        }
      }

      this.form.patchValue(patch, { emitEvent: false });
    } catch (e) {
      console.error('Error parsing camt.055 XML:', e);
    } finally {
      this.isParsingXml = false;
    }
  }

  mapAddrToForm(p: Element | null, prefix: string, patch: any) {
    if (!p) return;
    const ptyNode = p.getElementsByTagName('Pty')[0] || p;
    const finNode = p.getElementsByTagName('FinInstnId')[0];

    if (ptyNode) {
      patch[prefix + 'Name'] = ptyNode.getElementsByTagName('Nm')[0]?.textContent?.trim() || '';
      const addr = ptyNode.getElementsByTagName('PstlAdr')[0];
      if (addr) {
        patch[prefix + 'Ctry'] = addr.getElementsByTagName('Ctry')[0]?.textContent?.trim() || '';
        const lines = Array.from(addr.getElementsByTagName('AdrLine'));
        if (lines.length > 0) {
          patch[prefix + 'AddrType'] = lines.length > 1 ? 'hybrid' : 'unstructured';
          for (let i = 0; i < Math.min(lines.length, 3); i++) {
            patch[prefix + 'AdrLine' + (i + 1)] = lines[i]?.textContent?.trim() || '';
          }
        } else {
          patch[prefix + 'AddrType'] = 'structured';
          patch[prefix + 'StrtNm'] = addr.getElementsByTagName('StrtNm')[0]?.textContent?.trim() || '';
          patch[prefix + 'BldgNb'] = addr.getElementsByTagName('BldgNb')[0]?.textContent?.trim() || '';
          patch[prefix + 'BldgNm'] = addr.getElementsByTagName('BldgNm')[0]?.textContent?.trim() || '';
          patch[prefix + 'PstCd'] = addr.getElementsByTagName('PstCd')[0]?.textContent?.trim() || '';
          patch[prefix + 'TwnNm'] = addr.getElementsByTagName('TwnNm')[0]?.textContent?.trim() || '';
        }
      }
      
      const idNode = ptyNode.getElementsByTagName('Id')[0];
      if (idNode) {
        const orgId = idNode.getElementsByTagName('OrgId')[0];
        if (orgId) {
          patch[prefix + 'IdType'] = 'org';
          patch[prefix + 'OrgAnyBIC'] = orgId.getElementsByTagName('AnyBIC')[0]?.textContent?.trim() || '';
          patch[prefix + 'OrgLEI'] = orgId.getElementsByTagName('LEI')[0]?.textContent?.trim() || '';
          const clr = orgId.getElementsByTagName('ClrSysMmbId')[0];
          if (clr) {
            patch[prefix + 'OrgClrSysMmbId'] = clr.getElementsByTagName('MmbId')[0]?.textContent?.trim() || '';
            const clrId = clr.getElementsByTagName('ClrSysId')[0];
            patch[prefix + 'OrgClrSysCd'] = (clrId?.getElementsByTagName('Cd')[0] || clrId)?.textContent?.trim() || '';
          }
          const othr = orgId.getElementsByTagName('Othr')[0];
          if (othr) {
            patch[prefix + 'OrgOthrId'] = othr.getElementsByTagName('Id')[0]?.textContent?.trim() || '';
            const schme = othr.getElementsByTagName('SchmeNm')[0];
            patch[prefix + 'OrgOthrCd'] = (schme?.getElementsByTagName('Cd')[0] || schme)?.textContent?.trim() || '';
            patch[prefix + 'OrgOthrIssr'] = othr.getElementsByTagName('Issr')[0]?.textContent?.trim() || '';
          }
        } else {
          const prvtId = idNode.getElementsByTagName('PrvtId')[0];
          if (prvtId) {
            patch[prefix + 'IdType'] = 'prvt';
            const birth = prvtId.getElementsByTagName('DtAndPlcOfBirth')[0];
            if (birth) {
              patch[prefix + 'PrvtBirthDt'] = birth.getElementsByTagName('BirthDt')[0]?.textContent?.trim() || '';
              patch[prefix + 'PrvtPrvcOfBirth'] = birth.getElementsByTagName('PrvcOfBirth')[0]?.textContent?.trim() || '';
              patch[prefix + 'PrvtCityOfBirth'] = birth.getElementsByTagName('CityOfBirth')[0]?.textContent?.trim() || '';
              patch[prefix + 'PrvtCtryOfBirth'] = birth.getElementsByTagName('CtryOfBirth')[0]?.textContent?.trim() || '';
            }
            const othr = prvtId.getElementsByTagName('Othr')[0];
            if (othr) {
              patch[prefix + 'PrvtOthrId'] = othr.getElementsByTagName('Id')[0]?.textContent?.trim() || '';
              const schme = othr.getElementsByTagName('SchmeNm')[0];
              patch[prefix + 'PrvtOthrCd'] = (schme?.getElementsByTagName('Cd')[0] || schme)?.textContent?.trim() || '';
              patch[prefix + 'PrvtOthrIssr'] = othr.getElementsByTagName('Issr')[0]?.textContent?.trim() || '';
            }
          }
        }
      }
    }

    if (finNode) {
      const isHead = prefix.startsWith('head_');
      patch[prefix + 'Bic'] = finNode.getElementsByTagName('BICFI')[0]?.textContent?.trim() || '';
      patch[prefix + 'Lei'] = finNode.getElementsByTagName('LEI')[0]?.textContent?.trim() || '';
      patch[prefix + 'Name'] = finNode.getElementsByTagName('Nm')[0]?.textContent?.trim() || '';
      const clr = finNode.getElementsByTagName('ClrSysMmbId')[0];
      if (clr) {
        patch[prefix + 'MmbId'] = clr.getElementsByTagName('MmbId')[0]?.textContent?.trim() || '';
        const clrId = clr.getElementsByTagName('ClrSysId')[0];
        const cd = (clrId?.getElementsByTagName('Cd')[0] || clrId)?.textContent?.trim() || '';
        if (isHead) patch[prefix + 'ClrSysId'] = cd;
        else patch[prefix + 'ClrSysCd'] = cd;
        
        // Handle assgnr/assgne special naming (they use ClrSysMmbId instead of MmbId in form)
        if (prefix === 'assgnr' || prefix === 'assgne') {
          patch[prefix + 'ClrSysMmbId'] = patch[prefix + 'MmbId'];
        }
      }
    }
  }

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
    try {
      let formatted = '';
      let indent = '';
      const tab = '    ';
      this.generatedXml.split(/>\s*</).forEach(node => {
        if (node.match(/^\/\w/)) indent = indent.substring(tab.length);
        formatted += indent + '<' + node + '>\r\n';
        if (node.match(/^<?\w[^>]*[^\/]$/) && !node.startsWith('?')) indent += tab;
      });
      this.generatedXml = formatted.trim();
      this.refreshLineCount();
      this.pushHistory();
    } catch (e) {
      this.snackBar.open('Error formatting XML', 'Close', { duration: 2000 });
    }
  }

  err(f: string, group?: any): string | null {
    // camt055-specific form-level business rules (preserved, emojis removed)
    if (f === 'orgnlReqdExctnDt' || f === 'orgnlReqdExctnDtTm') {
      if (this.form.errors?.['orgnlReqdExctnDt_duplicate']) {
        return 'Only one of Date (Dt) or DateTime (DtTm) is allowed.';
      }
    }
    if (f === 'orgnlReqdExctnDt' || f === 'orgnlReqdExctnDtTm' || f === 'orgnlReqdColltnDt') {
      if (this.form.errors?.['date_choice_conflict']) {
        return 'Only ONE of Execution Date or Collection Date is allowed (schema choice).';
      }
    }
    if (this.form.errors) {
      if (this.form.errors[f + '_required']) return 'Other ID is required when a Scheme Code is selected.';
      if (this.form.errors[f + '_lei']) return 'LEI must be exactly 20 characters.';
      if (this.form.errors[f + '_duns']) return 'DUNS must be exactly 9 digits.';
    }

    const c = group ? group.get(f) : this.form.get(f);
    if (!c) {
      if (f.startsWith('head_from') || f.startsWith('head_to') || f.startsWith('head_rltd')) {
        const prefix = f.startsWith('head_from') ? 'head_from' :
                       f.startsWith('head_to') ? 'head_to' : 'head_rltd';
        if (this.form.errors?.[prefix + '_missing_identity']) {
          return 'At least one of BIC, Clearing System, or LEI is required.';
        }
        if (this.form.errors?.[prefix + '_incomplete_clrsys']) {
          return 'Both Clearing System Code and Member ID are mandatory if either is present.';
        }
        if (prefix === 'head_rltd' && this.form.get('head_rltd_enabled')?.value) {
          const v = this.form.value;
          if (!v.head_rltd_bizMsgIdr) return 'Business Message Identifier is required when Rltd is enabled.';
          if (!v.head_rltd_msgDefIdr) return 'Message Definition Identifier is required when Rltd is enabled.';
          if (!v.head_rltd_bizSvc) return 'Business Service is required when Rltd is enabled.';
          if (!v.head_rltd_creDt) return 'Creation Date is required when Rltd is enabled.';
        }
      }
      return null;
    }
    if (!c.touched || c.valid) return null;
    if (c.errors?.['required']) return 'Required field.';
    if (c.errors?.['maxlength']) return `Max ${c.errors['maxlength'].requiredLength} chars.`;
    if (c.errors?.['future_date']) return 'Date cannot be in the future.';
    if (c.errors?.['pattern']) {
      const fl = f.toLowerCase();
      if (fl.includes('bic')) return 'Valid 8 or 11 character BIC is required.';
      if (fl.includes('iban')) return 'Valid 34-char IBAN required.';
      if (fl.includes('uetr')) return 'Invalid UETR format.';
      if (fl.includes('lei')) return 'Must be 20-char LEI.';
      if (fl.includes('ctry') || fl.includes('country')) return '2-letter ISO code required.';
      if (fl.includes('ccy')) return '3-letter ISO 4217 code required.';
      if (fl.includes('amount') || fl.includes('amt') || f === 'orgnlInstdAmt_val') return 'Max 18 digits, up to 5 decimals.';
      if (fl.includes('bldgnb') || fl.includes('pstcd') || fl.includes('pstbx')) return 'Invalid character. Only ISO 20022 MX allowed characters permitted.';
      if (fl.includes('name') || fl.includes('nm') || fl.includes('strtnm') || fl.includes('twnnm') || fl.includes('dept') || fl.includes('flr') || fl.includes('room') || fl.includes('adrline')) return 'Invalid characters. Only ISO 20022 MX allowed characters permitted.';
      if (fl.includes('dttm') || fl === 'head_credt' || fl === 'assgnmt_credttm' || fl === 'orgnlcredttm') return 'Invalid DateTime format. Use YYYY-MM-DDThh:mm:ssÂ±hh:mm.';
      if (fl.includes('dt')) return 'Invalid Date format. Use YYYY-MM-DD.';
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

  charCount(f: string, max: number): string {
    const v = this.form.get(f)?.value || '';
    return `${v.length}/${max}`;
  }

  isNearLimit(f: string, max: number): boolean {
    const v = this.form.get(f)?.value || '';
    return v.length >= max * 0.85;
  }

  isAtLimit(f: string, max: number): boolean {
    const v = this.form.get(f)?.value || '';
    return v.length >= max;
  }

  collectValidationErrors(): string[] {
    const errors: string[] = [];
    const fields: { key: string, label: string }[] = [
      { key: 'head_bizMsgIdr', label: 'Business Message ID' },
      { key: 'head_creDt', label: 'Creation DateTime' },
      { key: 'head_mktPrctcId', label: 'Market Practice ID' },
      { key: 'assgnmt_id', label: 'Assignment ID' },
      { key: 'assgnmt_creDtTm', label: 'Assignment DateTime' },
      { key: 'orgnlMsgId', label: 'Original Message ID' },
      { key: 'orgnlMsgNmId', label: 'Original Message Name' },
      { key: 'orgnlCreDtTm', label: 'Original Creation DateTime' },
      { key: 'cxlId', label: 'Cancellation ID' },
      { key: 'orgnlUETR', label: 'Original UETR' },
      { key: 'orgnlInstdAmt_ccy', label: 'Currency' },
      { key: 'orgnlInstdAmt_val', label: 'Original Amount' },
      { key: 'cxlRsnCd', label: 'Cancellation Reason Code' }
    ];

    fields.forEach(({ key, label }) => {
      const ctrl = this.form.get(key);
      if (ctrl?.invalid) {
        if (ctrl.errors?.['required']) errors.push(`${label} is required.`);
        else if (ctrl.errors?.['pattern']) errors.push(`${label} has an invalid format.`);
        else if (ctrl.errors?.['maxlength']) errors.push(`${label} exceeds maximum length.`);
      }
    });
    if (this.form.errors?.['orgnlReqdExctnDt_duplicate']) errors.push('Only one of Execution Date (Dt) or DateTime (DtTm) is allowed.');
    if (this.form.errors?.['date_choice_conflict']) errors.push('Execution Date and Collection Date are mutually exclusive.');
    return errors;
  }

  refreshUetr(): void {
    const newUetr = this.uetrService.generate();
    this.form.patchValue({ orgnlUETR: newUetr });
    this.snackBar.open('New UETR Generated', '', { duration: 1500 });
  }

  downloadXml() {
    this.generateXml();
    const blob = new Blob([this.generatedXml], { type: 'application/xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `camt055-${Date.now()}.xml`;
    a.click();
    URL.revokeObjectURL(url);
  }

  copyXml() {
    navigator.clipboard.writeText(this.generatedXml);
    this.snackBar.open('XML Copied!', 'Close', { duration: 2000 });
  }

  validateMessage() {
        if (this.bicSameWarning) return;
    this.form.markAllAsTouched();
    if (this.form.invalid) {
      this.formSubmissionErrors = this.collectValidationErrors();
      this.showSubmissionErrors = true;
      this.snackBar.open(`${this.formSubmissionErrors.length} validation error(s) found.`, 'Close', { duration: 4000 });
      return;
    }
    this.showSubmissionErrors = false;
    this.formSubmissionErrors = [];
    if (!this.generatedXml?.trim()) return;

    this.showValidationModal = true;
    this.validationStatus = 'validating';
    this.validationReport = null;

    this.http.post(this.config.getApiUrl('/validate'), {
      xml_content: this.generatedXml,
      mode: 'Full 1-3',
      message_type: 'camt.055.001.08',
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
          message: 'camt.055.001.08', total_time_ms: 0,
          layer_status: {},
          details: [{
            severity: 'ERROR', layer: 0, code: 'BACKEND_ERROR',
            path: '', message: 'Validation failed â€” ' + (err.error?.detail?.message || 'backend error.'),
            fix_suggestion: 'Verify network or service status.'
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

  closeValidationModal() { this.showValidationModal = false; }
  getValidationLayers() { return this.validationReport?.layer_status ? Object.keys(this.validationReport.layer_status) : []; }
  isLayerPass(k: string) { return this.getLayerStatus(k).includes('âœ…'); }
  isLayerFail(k: string) { return this.getLayerStatus(k).includes('âŒ'); }
  isLayerWarn(k: string) {
    const s = this.getLayerStatus(k);
    return s.includes('âš ') || s.includes('WARNING') || s.includes('WARN');
  }
  private getStatus(k: string) { return this.validationReport?.layer_status[k]?.status; }
  getLayerName(k: string) { const m: any = { '1': 'Syntax & Format', '2': 'Schema Validation', '3': 'Business Rules' }; return m[k] || `Layer ${k}`; }
  getLayerStatus(k: string) { return this.validationReport?.layer_status[k]?.status || 'IDLE'; }
  getLayerTime(k: string) { return this.validationReport?.layer_status[k]?.time || 0; }
  getValidationIssues() { return this.validationReport?.details || []; }
  toggleValidationIssue(i: any) { this.validationExpandedIssue = this.validationExpandedIssue === i ? null : i; }
  copyFix(suggestion: string, event: Event) {
    event.stopPropagation();
    navigator.clipboard.writeText(suggestion).then(() => {
      this.snackBar.open('Fix suggestion copied!', 'Close', { duration: 2000 });
    });
  }

  viewXmlModal() { this.closeValidationModal(); }
  editXmlModal() { this.closeValidationModal(); }
  runValidationModal() { this.validateMessage(); }

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
  copyToClipboard() {
    navigator.clipboard.writeText(this.generatedXml).then(() => {
      this.snackBar.open('Copied to clipboard!', 'Close', { duration: 3000 });
    });
  }
}
