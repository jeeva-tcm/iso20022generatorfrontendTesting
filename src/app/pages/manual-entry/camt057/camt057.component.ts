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
import { UetrService } from '../../../services/uetr.service';
import { ISO_PURPOSE_CODES } from '../../../constants/purpose-codes';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
import { BicSearchDialogComponent } from '../bic-search-dialog/bic-search-dialog.component';
import { debounceTime } from 'rxjs/operators';

@Component({
    selector: 'app-camt057',
    standalone: true,
    imports: [CommonModule, ReactiveFormsModule, FormsModule, MatIconModule, MatSnackBarModule, MatTooltipModule, MatDialogModule],
    templateUrl: './camt057.component.html',
    styleUrl: './camt057.component.css'
})
export class Camt057Component implements OnInit, OnDestroy {
    form!: FormGroup;
    generatedXml = '';
    currentTab: 'form' | 'preview' = 'form';
    editorLineCount: number[] = [];
    isParsingXml = false;

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
    currencyPrecision: { [key: string]: number } = {};
    countries: string[] = [];
    categoryPurposes: string[] = [];
    purposes: string[] = [];

    agentPrefixes = ['dbtr', 'dbtrAgt', 'intrmyAgt', 'instgAgt', 'instdAgt'];

    private readonly DRAFT_KEY = 'draft_camt057';
    private draftSaveTimer: ReturnType<typeof setTimeout> | null = null;
    showDraftBanner = false;
    isClearingDraft = false;

    constructor(
        private fb: FormBuilder,
        private http: HttpClient,
        private config: ConfigService,
        private snackBar: MatSnackBar,
        private router: Router,
        private uetrService: UetrService,
        private formatting: FormattingService,
        private dialog: MatDialog
    ) { }

    public syncScroll(editor: any, gutter: any) {
        gutter.scrollTop = editor.scrollTop;
    }

    ngOnInit() {
        this.fetchCodelists();
        this.buildForm();
        const hadDraft = this.loadDraft();
        if (hadDraft) {
          this.showDraftBanner = true;
          this.generateXml();
        }
        this.generateXml();
        this.onEditorChange(this.generatedXml, true);
        this.form.get('currency')?.valueChanges.subscribe(() => {
            this.updateAmountValidator();
            this.updateClearingSystemValidation();
        });

        this.form.valueChanges.pipe(debounceTime(300)).subscribe(() => {
            this.updateConditionalValidators();
            this.generateXml();
            this.scheduleDraftSave();
        });

        // Init history
        this.pushHistory();
        this.updateAmountValidator();
    }

    private updateClearingSystemValidation() {
        const systems = this.agentPrefixes.map(p => this.form.get(p + 'ClrSysCd')?.value?.trim()?.toUpperCase());
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

    private updateConditionalValidators() {
        const ADDR_PATTERN = Validators.pattern(/^[a-zA-Z0-9\/\-\?:\(\)\.,\+' ]+$/);
        this.agentPrefixes.forEach(p => {
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
    }

    fetchCodelists() {
        this.http.get<any>(this.config.getApiUrl('/codelists/currency')).subscribe({
            next: (res) => {
                if (res && res.codes) {
                    this.currencies = res.codes;
                    this.currencyPrecision = res.currencies || {};
                    this.updateAmountValidator();
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
                    this.categoryPurposes = ['SALA', 'TAXS', 'SUPP', 'PENS', 'LOAN', 'DIVD', 'CASH', 'COLL', 'INTC', 'OTHR'];
                }
            },
            error: (err) => {
                console.error('Failed to load category purposes', err);
                this.categoryPurposes = ['SALA', 'TAXS', 'SUPP', 'PENS', 'LOAN', 'DIVD', 'CASH', 'COLL', 'INTC', 'OTHR'];
            }
        });
        this.http.get<any>(this.config.getApiUrl('/codelists/purp')).subscribe({
            next: (res) => {
                const apiCodes = (res && res.codes) ? res.codes : [];
                this.purposes = [...new Set([...ISO_PURPOSE_CODES, ...apiCodes])].sort();
            },
            error: (err) => {
                console.error('Failed to load purposes', err);
                this.purposes = [...ISO_PURPOSE_CODES].sort();
            }
        });

    }

    private updateAmountValidator() {
        const ccy = this.form.get('currency')?.value;
        const precision = this.currencyPrecision[ccy] ?? 2;
        const amountCtrl = this.form.get('amount');
        
        const pattern = precision > 0 
            ? new RegExp(`^\\d{1,13}(\\.\\d{1,${precision}})?$`)
            : new RegExp(`^\\d{1,13}$`);
        
        amountCtrl?.setValidators([Validators.required, Validators.pattern(pattern)]);
        amountCtrl?.updateValueAndValidity({ emitEvent: false });
    }

    private buildForm() {
        const BIC = [Validators.pattern(/^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$/)];
        const BIC_REQ = [Validators.required, ...BIC];

        this.form = this.fb.group({
            purpCd: ['', [Validators.pattern(/^[A-Z]{4,4}$/), (control: any) => {
                if (!control.value) return null;
                return this.purposes.includes(control.value.toUpperCase()) ? null : { invalidPurpose: true };
            }]],
            ctgyPurpCd: ['', [Validators.pattern(/^[A-Z]{4,4}$/)]],
            ctgyPurpPrtry: ['', [Validators.pattern(/^[A-Za-z0-9 .\-]{1,35}$/)]],
            instrPrty: ['', [Validators.pattern(/^(HIGH|NORM)$/)]],
            clrChanl: ['', [Validators.pattern(/^(BOOK|MPNS|RTGS|RTNS)$/)]],
            svcLvlCd: ['', [Validators.pattern(/^[A-Z0-9]{1,4}$/)]],
            svcLvlPrtry: ['', [Validators.pattern(/^[A-Za-z0-9 .\-]{1,35}$/)]],
            lclInstrmCd: ['', [Validators.pattern(/^[A-Z0-9]{1,4}$/)]],
            lclInstrmPrtry: ['', [Validators.pattern(/^[A-Za-z0-9 .\-]{1,35}$/)]],

            rmtInfType: ['none'],
            rmtInfUstrd: ['', [Validators.maxLength(140), Validators.pattern(/^[a-zA-Z0-9\/\-\?:\(\)\.,\+' ]+$/)]],
            rmtInfStrdCdtrRefType: [''],
            rmtInfStrdCdtrRef: ['', Validators.maxLength(35)],
            rmtInfStrdAddtlRmtInf: ['', [Validators.maxLength(140), Validators.pattern(/^[0-9a-zA-Z\/\-\?:\(\)\.,\'\+ !#$%&\*=\^_`\{\|\}~";<>@\[\\\]]+$/)]],
            rmtInfStrdRfrdDocNb: ['', Validators.maxLength(35)],
            rmtInfStrdRfrdDocCd: [''],
            rmtInfStrdRfrdDocAmt: ['', [Validators.pattern(/^\d{1,18}(\.\d{1,5})?$/)]],
            rmtInfStrdInvcrNm: ['', Validators.maxLength(140)],
            rmtInfStrdInvceeNm: ['', Validators.maxLength(140)],
            rmtInfStrdTaxRmtId: ['', Validators.maxLength(35)],
            rmtInfStrdGrnshmtId: ['', Validators.maxLength(35)],

            fromBic: ['RECVUS33XXX', BIC_REQ],
            toBic: ['SENDGB2LXXX', BIC_REQ],
            bizMsgId: ['B-2026-N-001', [Validators.required, Validators.maxLength(35)]],
            msgId: ['NTF-2026-001', [Validators.required, Validators.maxLength(35)]],
            bizSvc: ['swift.cbprplus.01', [Validators.required, Validators.maxLength(35)]],
            creDtTm: [this.isoNow(), Validators.required],

            ntfctnId: ['ID-057-001', [Validators.required, Validators.maxLength(35)]],

            itmId: ['ITEM-001', [Validators.required, Validators.maxLength(35)]],
            amount: ['5000.00', [Validators.required, Validators.pattern(/^\d{1,13}(\.\d{1,5})?$/)]],
            currency: ['USD', Validators.required],
            valDt: [new Date().toISOString().split('T')[0], [Validators.required, Validators.pattern(/^\d{4}-\d{2}-\d{2}$/)]],

            // Optional but commonly used
            endToEndId: ['E2E-057-001', Validators.maxLength(35)],
            uetr: ['550e8400-e29b-41d4-a716-446655440001', [Validators.pattern(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/)]],
            clrSysRef: ['', [Validators.pattern(/^[A-Za-z0-9]{1,35}$/)]],
        });

        // Add agents
        const BIC_OPT = [Validators.pattern(/^[A-Z0-9]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$/)];
        // Safe character set: letters, digits, space, . , ( ) ' - only. No & @ ! # $ etc.
        const SAFE_NAME = Validators.pattern(/^[a-zA-Z0-9 .,()'\-]+$/);
        const ADDR_PATTERN = Validators.pattern(/^[a-zA-Z0-9\/\-\?:\(\)\.,\+' ]+$/);
        this.agentPrefixes.forEach(p => {
            this.form.addControl(p + 'Name', this.fb.control('', [Validators.maxLength(140), SAFE_NAME]));
            this.form.addControl(p + 'Bic', this.fb.control('', BIC_OPT));
            this.form.addControl(p + 'Lei', this.fb.control('', Validators.pattern(/^[A-Z0-9]{18}[0-9]{2}$/)));
            this.form.addControl(p + 'ClrSysCd', this.fb.control('', Validators.maxLength(5)));
            this.form.addControl(p + 'ClrSysMmbId', this.fb.control('', Validators.maxLength(35)));
            this.form.addControl(p + 'Acct', this.fb.control('', Validators.maxLength(34)));

            // Address fields
            this.form.addControl(p + 'AddrType', this.fb.control('none'));
            this.form.addControl(p + 'Dept', this.fb.control('', [Validators.maxLength(70), ADDR_PATTERN]));
            this.form.addControl(p + 'SubDept', this.fb.control('', [Validators.maxLength(70), ADDR_PATTERN]));
            this.form.addControl(p + 'StrtNm', this.fb.control('', [Validators.maxLength(70), ADDR_PATTERN]));
            this.form.addControl(p + 'BldgNb', this.fb.control('', [Validators.maxLength(16), ADDR_PATTERN]));
            this.form.addControl(p + 'BldgNm', this.fb.control('', [Validators.maxLength(35), ADDR_PATTERN]));
            this.form.addControl(p + 'Flr', this.fb.control('', [Validators.maxLength(70), ADDR_PATTERN]));
            this.form.addControl(p + 'PstBx', this.fb.control('', [Validators.maxLength(16), ADDR_PATTERN]));
            this.form.addControl(p + 'Room', this.fb.control('', [Validators.maxLength(70), ADDR_PATTERN]));
            this.form.addControl(p + 'PstCd', this.fb.control('', [Validators.maxLength(16), ADDR_PATTERN]));
            this.form.addControl(p + 'TwnNm', this.fb.control('', [Validators.maxLength(35), ADDR_PATTERN]));
            this.form.addControl(p + 'CtrySubDvsn', this.fb.control('', [Validators.maxLength(35), ADDR_PATTERN]));
            this.form.addControl(p + 'Ctry', this.fb.control('', Validators.pattern(/^[A-Z]{2}$/)));
            this.form.addControl(p + 'AdrLine1', this.fb.control('', [Validators.maxLength(70), ADDR_PATTERN]));
            this.form.addControl(p + 'AdrLine2', this.fb.control('', [Validators.maxLength(70), ADDR_PATTERN]));
        });

        // Set Default Dbtr with hybrid address (Nm + PstlAdr must always be present together)
        this.form.patchValue({
            dbtrName: 'Debtor Bank FI',
            dbtrBic: 'BBBBUS33XXX',
            dbtrAddrType: 'hybrid',
            dbtrStrtNm: '123 Business Street',
            dbtrTwnNm: 'New York',
            dbtrCtry: 'US',
            dbtrAdrLine1: '123 Business Street, New York'
        });
    }

    err(f: string): string | null {
        const c = this.form.get(f);
        // Remove .touched requirement to show errors more aggressively
        if (!c || c.valid) return null;

        if (c.errors?.['required']) return 'Required field.';
        if (c.errors?.['maxlength']) return `Max ${c.errors['maxlength'].requiredLength} chars.`;
        if (c.errors?.['pattern']) {
            if (f === 'amount') {
                const ccy = this.form.get('currency')?.value;
                const p = this.currencyPrecision[ccy] ?? 2;
                return `Value must be a number with max ${p} decimals for ${ccy}.`;
            }
            // Precedence: If we're at the limit and pattern is invalid, let the limit hint take precedence
            if (this.showMaxLenWarning[f]) {
              const val = c.value?.toString() || '';
              const limitError = c.errors?.['maxlength']?.requiredLength;
              if (limitError && val.length >= limitError) return null;
              if (f.toLowerCase().includes('bic') && val.length >= 11) return null;
              if (f === 'uetr' && val.length >= 36) return null;
            }
            if (f.toLowerCase().includes('bic')) return 'Valid 8 or 11-char BIC required.';
            if (f.toLowerCase().includes('iban')) return 'Valid 34-char IBAN required.';
            if (f.toLowerCase().includes('uetr')) return 'Invalid UETR format';
            if (f.toLowerCase().includes('amount') || f.toLowerCase().includes('amt')) return 'Max 18 digits, up to 5 decimals.';
            if (f === 'bizMsgId' || f === 'msgId' || f === 'ntfctnId' || f === 'itmId' || f === 'instrId' || f === 'endToEndId') return 'Invalid Pattern.';
            if (f === 'clrSysRef') return 'Invalid Pattern (Alphanumeric only, max 35 chars).';
            if (f === 'ctgyPurpCd') return 'Invalid Category Purpose Code. Must be a valid ISO 20022 code (4 uppercase letters).';
            if (f.toLowerCase().includes('name') || f.toLowerCase().includes('nm')) return "Invalid characters. Only letters, numbers, spaces and . , ( ) ' - are allowed (no &, @, !, etc.)";
            if (f.toLowerCase().includes('ustrd') || f.toLowerCase().includes('adtlrmtinf')) return "Invalid character in remittance field. Only ISO 20022 MX allowed chars permitted.";
            if (f === 'instrPrty') return 'Invalid Priority. Must be HIGH or NORM.';
            if (f === 'clrChanl') return 'Invalid Clearing Channel. Must be BOOK, MPNS, RTGS, or RTNS.';
            if (f === 'svcLvlCd') return 'Invalid Service Level Code. Must be 1-4 alphanumeric characters.';
            if (f === 'svcLvlPrtry') return 'Invalid Proprietary Service Level. Up to 35 characters allowed.';
            if (f === 'lclInstrmCd') return 'Invalid Local Instrument Code. Must be 1-4 alphanumeric characters.';
            if (f === 'lclInstrmPrtry') return 'Invalid Proprietary Local Instrument. Up to 35 characters allowed.';
            if (f === 'ctgyPurpPrtry') return 'Invalid Proprietary Category Purpose. Up to 35 characters allowed.';
            if (f.toLowerCase().includes('bldgnb') || f.toLowerCase().includes('pstcd') || f.toLowerCase().includes('pstbx') || f.toLowerCase().includes('bldgnm') || f.toLowerCase().includes('twnnm') || f.toLowerCase().includes('twnlctn') || f.toLowerCase().includes('dstrctnm') || f.toLowerCase().includes('ctrysubdvsn') || f.toLowerCase().includes('strtnm') || f.toLowerCase().includes('dept') || f.toLowerCase().includes('subdept') || f.toLowerCase().includes('flr') || f.toLowerCase().includes('room') || f.toLowerCase().includes('adrline')) {
                return 'Invalid character. Only ISO 20022 MX allowed characters permitted.';
            }
            if (f === 'purpCd') return 'Invalid Purpose Code. Please select from the list or enter a valid ISO 20022 Purpose Code.';
        }
        if (c.errors?.['invalidPurpose']) return 'Invalid Purpose Code. Please select from the list or enter a valid ISO 20022 Purpose Code.';
        if (c.errors?.['target2']) return 'T2 allows only EUR currency.';
        if (c.errors?.['chips']) return 'CHIPS allows only USD currency.';
        if (c.errors?.['fed']) return 'FED allows only USD currency.';
        if (c.errors?.['chaps']) return 'Invalid Currency for CHAPS clearing system. When ClrSysId/Cd = CHAPS, the transaction currency must be GBP.';
        if (c.errors?.['forbidden']) return 'Clearing System Reference must NOT be sent if no active clearing system is used.';
        return 'Invalid value.';
    }

    /**
     * UETR Refresh — generates a new UUID v4, validates, updates form.
     */
    refreshUetr(): void {
        this.uetrError = null;
        this.uetrSuccess = null;
        clearTimeout(this.uetrSuccessTimer);

        const prevUetr = this.form.get('uetr')?.value || '';
        const newUetr = this.uetrService.generate();

        if (!UetrService.UUID_V4_PATTERN.test(newUetr)) {
            this.uetrError = 'Invalid UETR format';
            return;
        }
        if (newUetr === prevUetr) {
            this.uetrError = 'Duplicate UETR detected across messages';
            return;
        }

        if (prevUetr) this.uetrService.unregister(prevUetr);
        this.form.get('uetr')?.setValue(newUetr);
        this.form.get('uetr')?.markAsTouched();

        this.uetrSuccess = 'UETR refreshed successfully';
        this.uetrSuccessTimer = setTimeout(() => { this.uetrSuccess = null; }, 3000);
    }

    /**
     * Validate manually edited UETR on blur (Rule 8).
     */
    validateManualUetr(): void {
        const val = (this.form.get('uetr')?.value || '').trim();
        this.uetrError = null;
        if (!val) return;
        if (!UetrService.UUID_V4_PATTERN.test(val)) {
            this.uetrError = 'Invalid UETR format';
            return;
        }
        const result = this.uetrService.validate(val);
        if (result === 'duplicate') {
            this.uetrError = 'Duplicate UETR detected across messages';
        }
    }

    /**
     * Handle paste event on UETR field.
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
    warningTimeouts: { [key: string]: any } = {};
    showMaxLenWarning: { [key: string]: boolean } = {};

    @HostListener('input', ['$event'])
    onInput(event: any) {
        const target = event.target as HTMLInputElement;
        if (!target) return;
        const name = target.getAttribute('formControlName');
        if (!name) return;

        // Character limit warning logic (Immediate on-hit detection)
        const maxLen = target.maxLength;
        const val = target.value || '';
        if (maxLen > 0 && val.length >= maxLen) {
            this.showMaxLenWarning[name] = true;
            if (this.warningTimeouts[name]) clearTimeout(this.warningTimeouts[name]);
            this.warningTimeouts[name] = setTimeout(() => this.showMaxLenWarning[name] = false, 3000);
        } else {
            this.showMaxLenWarning[name] = false;
        }

        // BIC/IBAN Uppercasing
        if (name.toLowerCase().includes('bic') || name.toLowerCase().includes('iban')) {
            const start = target.selectionStart;
            const end = target.selectionEnd;
            const upperValue = val.toUpperCase();
            if (val !== upperValue) {
                target.value = upperValue;
                if (start !== null && end !== null) {
                    target.setSelectionRange(start, end);
                }
                this.form.get(name)?.patchValue(upperValue, { emitEvent: false });
            }
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
                    if (this.warningTimeouts[controlName]) clearTimeout(this.warningTimeouts[controlName]);
                    this.warningTimeouts[controlName] = setTimeout(() => this.showMaxLenWarning[controlName] = false, 3000);
                }
            }
        }
    }

    hint(f: string, maxLen: number): string | null {
        if (!this.showMaxLenWarning[f]) return null;
        const c = this.form.get(f);
        if (!c || !c.value) return null;
        const len = c.value.toString().length;
        if (len >= maxLen) {
            return `Maximum ${maxLen} characters reached (${len}/${maxLen})`;
        }
        return null;
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

        // Stop generation if CHIPS rule is violated
        if (this.form.get('currency')?.hasError('chips')) {
            this.generatedXml = '<!-- CHIPS VALIDATION ERROR: CHIPS allows only USD currency. -->';
            this.formatXml(false);
            this.onEditorChange(this.generatedXml, true);
            return;
        }

        // Stop generation if FED rule is violated
        if (this.form.get('currency')?.hasError('fed')) {
            this.generatedXml = '<!-- FED VALIDATION ERROR: FED allows only USD currency. -->';
            this.formatXml(false);
            this.onEditorChange(this.generatedXml, true);
            return;
        }

        // Stop generation if ClrSysRef is forbidden
        if (this.form.get('clrSysRef')?.hasError('forbidden')) {
            this.generatedXml = '<!-- CLEARING SYSTEM REFERENCE VALIDATION ERROR: Clearing System Reference must NOT be sent if no active standard clearing system is used. -->';
            this.formatXml(false);
            this.onEditorChange(this.generatedXml, true);
            return;
        }

        const v = this.form.value;
        let creDtTm = this.fdt(v.creDtTm || this.isoNow());

        // Parties & Agents correctly formatted with Pty wrapper for main notification level
        const partyXml = (tag: string, prefix: string) => {
            const inner = this.partyAgentXml(tag, prefix, v, 6);
            if (!inner.trim()) return '';
            let res = `${this.tabs(4)}<${tag}>\n${this.tabs(5)}<Pty>\n${inner}${this.tabs(5)}</Pty>\n${this.tabs(4)}</${tag}>\n`;
            if (v[prefix + 'Acct']?.trim()) {
                res += `${this.tabs(4)}<${tag}Acct>\n${this.tabs(5)}<Id>\n${this.tabs(6)}<Othr>\n${this.tabs(7)}<Id>${this.e(v[prefix + 'Acct'])}</Id>\n${this.tabs(6)}</Othr>\n${this.tabs(5)}</Id>\n${this.tabs(4)}</${tag}Acct>\n`;
            }
            return res;
        };

        const agtXmlWithAcct = (tag: string, prefix: string) => {
            let res = this.agt(tag, prefix, v, 4);
            if (v[prefix + 'Acct']?.trim()) {
                res += `${this.tabs(4)}<${tag}Acct>\n${this.tabs(5)}<Id>\n${this.tabs(6)}<Othr>\n${this.tabs(7)}<Id>${this.e(v[prefix + 'Acct'])}</Id>\n${this.tabs(6)}</Othr>\n${this.tabs(5)}</Id>\n${this.tabs(4)}</${tag}Acct>\n`;
            }
            return res;
        };

        let ntfctnPartiesXml = partyXml('Dbtr', 'dbtr');
        ntfctnPartiesXml += agtXmlWithAcct('DbtrAgt', 'dbtrAgt');
        ntfctnPartiesXml += agtXmlWithAcct('IntrmyAgt', 'intrmyAgt');
        ntfctnPartiesXml += agtXmlWithAcct('InstgAgt', 'instgAgt');
        ntfctnPartiesXml += agtXmlWithAcct('InstdAgt', 'instdAgt');

        // Optional Item components
        let itmXml = `        <Itm>\n          <Id>${this.e(v.itmId)}</Id>\n`;
        if (v.endToEndId?.trim()) itmXml += `          <EndToEndId>${this.e(v.endToEndId)}</EndToEndId>\n`;
        if (v.uetr?.trim()) itmXml += `          <UETR>${this.e(v.uetr)}</UETR>\n`;
        if (v.clrSysRef?.trim()) {
            itmXml += `          <PmtId>\n            <ClrSysRef>${this.e(v.clrSysRef)}</ClrSysRef>\n          </PmtId>\n`;
        }
        const formattedAmt = this.formatting.formatAmount(v.amount, v.currency);
        itmXml += `          <Amt Ccy="${this.e(v.currency)}">${formattedAmt}</Amt>\n`;
        itmXml += `          <XpctdValDt>${v.valDt}</XpctdValDt>\n`;

        // Payment Type Information (PmtTpInf)
        let pmtTpInfXml = '';
        if (v.instrPrty || v.clrChanl || v.svcLvlCd || v.svcLvlPrtry || v.lclInstrmCd || v.lclInstrmPrtry || v.ctgyPurpCd || v.ctgyPurpPrtry) {
            pmtTpInfXml += `          <PmtTpInf>\n`;
            if (v.instrPrty) pmtTpInfXml += `            <InstrPrty>${this.e(v.instrPrty)}</InstrPrty>\n`;
            if (v.clrChanl) pmtTpInfXml += `            <ClrChanl>${this.e(v.clrChanl)}</ClrChanl>\n`;
            
            if (v.svcLvlCd || v.svcLvlPrtry) {
                pmtTpInfXml += `            <SvcLvl>\n`;
                if (v.svcLvlCd) pmtTpInfXml += `              <Cd>${this.e(v.svcLvlCd)}</Cd>\n`;
                if (v.svcLvlPrtry) pmtTpInfXml += `              <Prtry>${this.e(v.svcLvlPrtry)}</Prtry>\n`;
                pmtTpInfXml += `            </SvcLvl>\n`;
            }
            if (v.lclInstrmCd || v.lclInstrmPrtry) {
                pmtTpInfXml += `            <LclInstrm>\n`;
                if (v.lclInstrmCd) pmtTpInfXml += `              <Cd>${this.e(v.lclInstrmCd)}</Cd>\n`;
                if (v.lclInstrmPrtry) pmtTpInfXml += `              <Prtry>${this.e(v.lclInstrmPrtry)}</Prtry>\n`;
                pmtTpInfXml += `            </LclInstrm>\n`;
            }
            if (v.ctgyPurpCd || v.ctgyPurpPrtry) {
                pmtTpInfXml += `            <CtgyPurp>\n`;
                if (v.ctgyPurpCd) pmtTpInfXml += `              <Cd>${this.e(v.ctgyPurpCd)}</Cd>\n`;
                if (v.ctgyPurpPrtry) pmtTpInfXml += `              <Prtry>${this.e(v.ctgyPurpPrtry)}</Prtry>\n`;
                pmtTpInfXml += `            </CtgyPurp>\n`;
            }
            pmtTpInfXml += `          </PmtTpInf>\n`;
        }
        itmXml += pmtTpInfXml;

        if (v.purpCd?.trim()) itmXml += `          <Purp>\n            <Cd>${this.e(v.purpCd)}</Cd>\n          </Purp>\n`;

        // Remittance
        if (v.rmtInfType && v.rmtInfType !== 'none') {
            let rmtXml = `          <RmtInf>\n`;
            if (v.rmtInfType === 'ustrd') {
                rmtXml += `            <Ustrd>${this.e(v.rmtInfUstrd)}</Ustrd>\n`;
            } else if (v.rmtInfType === 'strd') {
                rmtXml += `            <Strd>\n`;
                if (v.rmtInfStrdCdtrRef?.trim()) {
                    rmtXml += `              <CdtrRefInf>\n`;
                    if (v.rmtInfStrdCdtrRefType?.trim()) {
                        rmtXml += `                <Tp>\n                  <CdOrPrtry>\n                    <Cd>${this.e(v.rmtInfStrdCdtrRefType)}</Cd>\n                  </CdOrPrtry>\n                </Tp>\n`;
                    }
                    rmtXml += `                <Ref>${this.e(v.rmtInfStrdCdtrRef)}</Ref>\n              </CdtrRefInf>\n`;
                }
                if (v.rmtInfStrdAddtlRmtInf?.trim()) {
                    rmtXml += `              <AddtlRmtInf>${this.e(v.rmtInfStrdAddtlRmtInf)}</AddtlRmtInf>\n`;
                }
                if (v.rmtInfStrdRfrdDocNb || v.rmtInfStrdRfrdDocCd) {
                    rmtXml += `              <RfrdDocInf>\n`;
                    if (v.rmtInfStrdRfrdDocNb) rmtXml += `                <Nb>${this.e(v.rmtInfStrdRfrdDocNb)}</Nb>\n`;
                    if (v.rmtInfStrdRfrdDocCd) rmtXml += `                <Tp>\n                  <CdOrPrtry>\n                    <Cd>${this.e(v.rmtInfStrdRfrdDocCd)}</Cd>\n                  </CdOrPrtry>\n                </Tp>\n`;
                    rmtXml += `              </RfrdDocInf>\n`;
                }
                if (v.rmtInfStrdRfrdDocAmt) {
                    rmtXml += `              <RfrdDocAmt>\n                <RmtAmt>\n                  <DuePyblAmt Ccy="${this.e(v.currency)}">${this.formatting.formatAmount(v.rmtInfStrdRfrdDocAmt, v.currency)}</DuePyblAmt>\n                </RmtAmt>\n              </RfrdDocAmt>\n`;
                }
                rmtXml += `            </Strd>\n`;
            }
            rmtXml += `          </RmtInf>\n`;
            itmXml += rmtXml;
        }

        itmXml += `        </Itm>`;


        this.generatedXml = `<?xml version="1.0" encoding="UTF-8"?>
<BusMsgEnvlp xmlns="urn:swift:xsd:envelope">
  <AppHdr xmlns="urn:iso:std:iso:20022:tech:xsd:head.001.001.02">
    <Fr><FIId><FinInstnId><BICFI>${this.e(v.fromBic)}</BICFI></FinInstnId></FIId></Fr>
    <To><FIId><FinInstnId><BICFI>${this.e(v.toBic)}</BICFI></FinInstnId></FIId></To>
    <BizMsgIdr>${this.e(v.bizMsgId)}</BizMsgIdr>
    <MsgDefIdr>camt.057.001.06</MsgDefIdr>
    <BizSvc>${this.e(v.bizSvc)}</BizSvc>
    <CreDt>${creDtTm}</CreDt>
  </AppHdr>
  <Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.057.001.06">
    <NtfctnToRcv>
      <GrpHdr>
        <MsgId>${this.e(v.msgId)}</MsgId>
        <CreDtTm>${creDtTm}</CreDtTm>
      </GrpHdr>
      <Ntfctn>
        <Id>${this.e(v.ntfctnId)}</Id>
${ntfctnPartiesXml}${itmXml}
      </Ntfctn>
    </NtfctnToRcv>
  </Document>
</BusMsgEnvlp>`;
        this.formatXml(false);
            this.onEditorChange(this.generatedXml, true);
    }

    onEditorChange(content: string, fromForm = false) {
        if (!this.isInternalChange && !fromForm) {
            this.pushHistory();
        }

        this.generatedXml = content;
        this.refreshLineCount();

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
        if (!content?.trim()) {
            this.isParsingXml = true;
            const emptyPatch: any = {};
            Object.keys(this.form.controls).forEach(key => {
                emptyPatch[key] = '';
            });
            this.form.patchValue(emptyPatch, { emitEvent: false });
            this.isParsingXml = false;
            return;
        }
        try {
            const cleanXml = content.replace(/<(\/?)(?:[\w]+:)/g, '<$1');
            const doc = new DOMParser().parseFromString(cleanXml, 'text/xml');
            if (doc.querySelector('parsererror')) {
                this.snackBar.open('Invalid XML: Unable to parse content.', 'Close', { duration: 3000 });
                return;
            }

            const patch: any = {};
            // Reset every form control to '' so any element the user removed from the XML
            // clears its mirrored form value (prevents generateXml from re-inserting it).
            Object.keys(this.form.controls).forEach(k => patch[k] = '');
            const tval = (t: string) => doc.getElementsByTagName(t)[0]?.textContent || '';
            const setVal = (key: string, val: string) => { patch[key] = val; };

            setVal('bizMsgId', tval('BizMsgIdr'));
            setVal('bizSvc', tval('BizSvc'));
            setVal('msgId', tval('MsgId'));

            const tryTag = (tag: string, child: string) => {
                const p = doc.getElementsByTagName(tag)[0];
                return p?.getElementsByTagName(child)[0]?.textContent || '';
            };
            setVal('fromBic', tryTag('Fr', 'BICFI'));
            setVal('toBic', tryTag('To', 'BICFI'));

            const ntfctn = doc.getElementsByTagName('Ntfctn')[0];
            if (!ntfctn) return;

            setVal('ntfctnId', ntfctn.getElementsByTagName('Id')[0]?.textContent || '');

            setVal('creDtTm', doc.getElementsByTagName('CreDtTm')[0]?.textContent || doc.getElementsByTagName('CreDt')[0]?.textContent || '');

            const itm = doc.getElementsByTagName('Itm')[0];
            if (itm) {
                setVal('itmId', itm.getElementsByTagName('Id')[0]?.textContent || '');
                setVal('endToEndId', itm.getElementsByTagName('EndToEndId')[0]?.textContent || '');
                setVal('uetr', itm.getElementsByTagName('UETR')[0]?.textContent || '');
                const amtEl = itm.getElementsByTagName('Amt')[0];
                setVal('amount', amtEl ? (amtEl.textContent || '') : '');
                setVal('currency', amtEl ? (amtEl.getAttribute('Ccy') || '') : '');
                setVal('valDt', itm.getElementsByTagName('XpctdValDt')[0]?.textContent || '');

                const parseAgent = (tag: string, prefix: string) => {
                    const node = ntfctn.getElementsByTagName(tag)[0];
                    if (!node) return;
                    if (tag === 'Dbtr' || tag === 'Cdtr') {
                        const pty = node.getElementsByTagName('Pty')[0];
                        if (pty) {
                            setVal(prefix + 'Name', pty.getElementsByTagName('Nm')[0]?.textContent || '');
                            this.mapAddrToForm(pty, prefix, patch);
                        }
                    } else {
                        const finId = node.getElementsByTagName('FinInstnId')[0];
                        if (finId) {
                            setVal(prefix + 'Bic', finId.getElementsByTagName('BICFI')[0]?.textContent || '');
                            setVal(prefix + 'Name', finId.getElementsByTagName('Nm')[0]?.textContent || '');
                            setVal(prefix + 'Lei', finId.getElementsByTagName('LEI')[0]?.textContent || '');
                            const clr = finId.getElementsByTagName('ClrSysMmbId')[0];
                            if (clr) {
                                setVal(prefix + 'ClrSysMmbId', clr.getElementsByTagName('MmbId')[0]?.textContent || '');
                                const clrId = clr.getElementsByTagName('ClrSysId')[0];
                                if (clrId) {
                                    setVal(prefix + 'ClrSysCd', clrId.getElementsByTagName('Cd')[0]?.textContent || '');
                                }
                            }
                        }
                    }
                };
                parseAgent('Dbtr', 'dbtr');
                parseAgent('DbtrAgt', 'dbtrAgt');
                parseAgent('IntrmyAgt', 'intrmyAgt');
                parseAgent('InstgAgt', 'instgAgt');
                parseAgent('InstdAgt', 'instdAgt');

                const parseAcct = (tag: string, prefix: string) => {
                    const node = ntfctn.getElementsByTagName(tag + 'Acct')[0];
                    if (!node) return;
                    patch[prefix + 'Acct'] = node.getElementsByTagName('Id')[0]?.getElementsByTagName('Othr')[0]?.getElementsByTagName('Id')[0]?.textContent || '';
                };
                parseAcct('Dbtr', 'dbtr');
                parseAcct('DbtrAgt', 'dbtrAgt');
                parseAcct('IntrmyAgt', 'intrmyAgt');
                parseAcct('InstgAgt', 'instgAgt');
                parseAcct('InstdAgt', 'instdAgt');

                const tryTagInItm = (parentOrEl: string | Element, child: string) => {
                    const p = typeof parentOrEl === 'string' ? itm.getElementsByTagName(parentOrEl)[0] : parentOrEl;
                    return p ? (p.getElementsByTagName(child)[0]?.textContent || '') : '';
                };

                setVal('instrPrty', itm.getElementsByTagName('InstrPrty')[0]?.textContent || '');
                setVal('clrChanl', itm.getElementsByTagName('ClrChanl')[0]?.textContent || '');
                setVal('svcLvlCd', tryTagInItm('SvcLvl', 'Cd'));
                setVal('svcLvlPrtry', tryTagInItm('SvcLvl', 'Prtry'));
                setVal('lclInstrmCd', tryTagInItm('LclInstrm', 'Cd'));
                setVal('lclInstrmPrtry', tryTagInItm('LclInstrm', 'Prtry'));
                const ctgyPurp = itm.getElementsByTagName('CtgyPurp')[0];
                if (ctgyPurp) {
                    setVal('ctgyPurpCd', ctgyPurp.getElementsByTagName('Cd')[0]?.textContent || '');
                    setVal('ctgyPurpPrtry', ctgyPurp.getElementsByTagName('Prtry')[0]?.textContent || '');
                }

                const purp = itm.getElementsByTagName('Purp')[0];
                if (purp) setVal('purpCd', purp.getElementsByTagName('Cd')[0]?.textContent || '');

                const rmt = itm.getElementsByTagName('RmtInf')[0];
                if (rmt) {
                    const ustrd = rmt.getElementsByTagName('Ustrd')[0];
                    if (ustrd) {
                        setVal('rmtInfType', 'ustrd');
                        setVal('rmtInfUstrd', ustrd.textContent || '');
                    }
                    const strd = rmt.getElementsByTagName('Strd')[0];
                    if (strd) {
                        setVal('rmtInfType', 'strd');
                        const ref = strd.getElementsByTagName('CdtrRefInf')[0];
                        if (ref) {
                            setVal('rmtInfStrdCdtrRefType', ref.getElementsByTagName('Cd')[0]?.textContent || '');
                            setVal('rmtInfStrdCdtrRef', ref.getElementsByTagName('Ref')[0]?.textContent || '');
                        }
                        setVal('rmtInfStrdAddtlRmtInf', strd.getElementsByTagName('AddtlRmtInf')[0]?.textContent || '');
                        const rfrdDoc = strd.getElementsByTagName('RfrdDocInf')[0];
                        if (rfrdDoc) {
                            setVal('rmtInfStrdRfrdDocNb', rfrdDoc.getElementsByTagName('Nb')[0]?.textContent || '');
                            setVal('rmtInfStrdRfrdDocCd', rfrdDoc.getElementsByTagName('Tp')[0]?.getElementsByTagName('CdOrPrtry')[0]?.getElementsByTagName('Cd')[0]?.textContent || '');
                        }
                        const rfrdAmtNode = strd.getElementsByTagName('RfrdDocAmt')[0];
                        if (rfrdAmtNode) {
                            setVal('rmtInfStrdRfrdDocAmt', rfrdAmtNode.getElementsByTagName('RmtAmt')[0]?.getElementsByTagName('DuePyblAmt')[0]?.textContent || '');
                        }
                    }
                } else {
                    setVal('rmtInfType', 'none');
                }
            } else {
                ['itmId', 'endToEndId', 'uetr', 'amount', 'currency', 'valDt'].forEach(f => setVal(f, ''));
                this.agentPrefixes.forEach(p => {
                    setVal(p + 'Bic', ''); setVal(p + 'Name', ''); setVal(p + 'Lei', '');
                    setVal(p + 'ClrSysCd', ''); setVal(p + 'ClrSysMmbId', ''); setVal(p + 'Acct', '');
                });
            }


            this.isParsingXml = true;
            this.form.patchValue(patch, { emitEvent: false });
            this.isParsingXml = false;
        } catch (e) {
            this.isParsingXml = false;
        }
    }

    private mapAddrToForm(p: Element, prefix: string, patch: any) {
        const addr = p.getElementsByTagName('PstlAdr')[0];
        if (addr) {
            const aV = (t: string) => addr.getElementsByTagName(t)[0]?.textContent || '';
            const isStructured = ['StrtNm', 'TwnNm', 'Ctry', 'PstCd'].some(t => !!aV(t));
            if (isStructured) {
                patch[prefix + 'AddrType'] = 'structured';
                ['Dept', 'SubDept', 'StrtNm', 'BldgNb', 'BldgNm', 'Flr', 'PstBx', 'Room', 'PstCd', 'TwnNm', 'TwnLctnNm', 'DstrctNm', 'CtrySubDvsn', 'Ctry'].forEach(f => patch[prefix + f] = aV(f));
                const adrTp = addr.getElementsByTagName('AdrTp')[0];
                if (adrTp) {
                    patch[prefix + 'AdrTpCd'] = adrTp.getElementsByTagName('Cd')[0]?.textContent || '';
                    patch[prefix + 'AdrTpPrtry'] = adrTp.getElementsByTagName('Prtry')[0]?.textContent || '';
                }
            } else if (addr.getElementsByTagName('AdrLine').length > 0) {
                patch[prefix + 'AddrType'] = 'unstructured';
                const lines = addr.getElementsByTagName('AdrLine');
                patch[prefix + 'AdrLine1'] = lines[0]?.textContent || '';
                patch[prefix + 'AdrLine2'] = lines[1]?.textContent || '';
            }
        }

        const idNode = p.getElementsByTagName('Id')[0];
        if (idNode) {
            const orgId = idNode.getElementsByTagName('OrgId')[0];
            if (orgId) {
                patch[prefix + 'IdType'] = 'org';
                patch[prefix + 'OrgAnyBIC'] = orgId.getElementsByTagName('AnyBIC')[0]?.textContent || '';
                patch[prefix + 'OrgLEI'] = orgId.getElementsByTagName('LEI')[0]?.textContent || '';
                const othr = orgId.getElementsByTagName('Othr')[0];
                if (othr) {
                    patch[prefix + 'OrgOthrId'] = othr.getElementsByTagName('Id')[0]?.textContent || '';
                    patch[prefix + 'OrgOthrIssr'] = othr.getElementsByTagName('Issr')[0]?.textContent || '';
                    const schmeNm = othr.getElementsByTagName('SchmeNm')[0];
                    if (schmeNm) {
                        patch[prefix + 'OrgOthrSchmeNmCd'] = schmeNm.getElementsByTagName('Cd')[0]?.textContent || '';
                        patch[prefix + 'OrgOthrSchmeNmPrtry'] = schmeNm.getElementsByTagName('Prtry')[0]?.textContent || '';
                    }
                }
            }
            const prvtId = idNode.getElementsByTagName('PrvtId')[0];
            if (prvtId) {
                patch[prefix + 'IdType'] = 'prvt';
                const dob = prvtId.getElementsByTagName('DtAndPlcOfBirth')[0];
                if (dob) {
                    patch[prefix + 'PrvtDtAndPlcOfBirthDt'] = dob.getElementsByTagName('BirthDt')[0]?.textContent || '';
                    patch[prefix + 'PrvtDtAndPlcOfBirthCity'] = dob.getElementsByTagName('CityOfBirth')[0]?.textContent || '';
                    patch[prefix + 'PrvtDtAndPlcOfBirthCtry'] = dob.getElementsByTagName('CtryOfBirth')[0]?.textContent || '';
                }
                const othr = prvtId.getElementsByTagName('Othr')[0];
                if (othr) {
                    patch[prefix + 'PrvtOthrId'] = othr.getElementsByTagName('Id')[0]?.textContent || '';
                    patch[prefix + 'PrvtOthrIssr'] = othr.getElementsByTagName('Issr')[0]?.textContent || '';
                    const schmeNm = othr.getElementsByTagName('SchmeNm')[0];
                    if (schmeNm) {
                        patch[prefix + 'PrvtOthrSchmeNmCd'] = schmeNm.getElementsByTagName('Cd')[0]?.textContent || '';
                        patch[prefix + 'PrvtOthrSchmeNmPrtry'] = schmeNm.getElementsByTagName('Prtry')[0]?.textContent || '';
                    }
                }
            }
        }
    }


    private e(v: string) { return (v || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
    private tabs(n: number) { return '  '.repeat(n); }

    agt(tag: string, prefix: string, v: any, indent = 3) {
        const bic = v[prefix + 'Bic'];
        const name = v[prefix + 'Name'];
        const lei = v[prefix + 'Lei'];
        const clrCd = v[prefix + 'ClrSysCd'];
        const clrMmb = v[prefix + 'ClrSysMmbId'];

        if (!bic && !name && !lei && !clrMmb && !clrCd) return '';

        let content = '';
        if (bic) content += `${this.tabs(indent + 2)}<BICFI>${this.e(bic)}</BICFI>\n`;
        if (clrMmb || clrCd) {
            content += `${this.tabs(indent + 2)}<ClrSysMmbId>\n`;
            if (clrCd) content += `${this.tabs(indent + 3)}<ClrSysId>\n${this.tabs(indent + 4)}<Cd>${this.e(clrCd)}</Cd>\n${this.tabs(indent + 3)}</ClrSysId>\n`;
            if (clrMmb) content += `${this.tabs(indent + 3)}<MmbId>${this.e(clrMmb)}</MmbId>\n`;
            content += `${this.tabs(indent + 2)}</ClrSysMmbId>\n`;
        }
        if (lei) content += `${this.tabs(indent + 2)}<LEI>${this.e(lei)}</LEI>\n`;
        if (name) content += `${this.tabs(indent + 2)}<Nm>${this.e(name)}</Nm>\n`;
        content += this.addrXml(v, prefix, indent + 2);

        return `${this.tabs(indent)}<${tag}>\n${this.tabs(indent + 1)}<FinInstnId>\n${content}${this.tabs(indent + 1)}</FinInstnId>\n${this.tabs(indent)}</${tag}>\n`;
    }

    partyAgentXml(tag: string, prefix: string, v: any, indent = 4) {
        const bic = v[prefix + 'Bic'] || v[prefix + 'OrgAnyBIC'];
        const name = v[prefix + 'Name'];
        const lei = v[prefix + 'Lei'] || v[prefix + 'OrgLEI'];
        const clrCd = v[prefix + 'ClrSysCd'] || v[prefix + 'OrgClrSysCd'];
        const clrMmb = v[prefix + 'ClrSysMmbId'] || v[prefix + 'OrgClrSysMmbId'];

        if (!bic && !name && !lei && !clrMmb && !clrCd && v[prefix + 'AddrType'] === 'none') return '';

        let content = '';
        if (name) content += `${this.tabs(indent)}<Nm>${this.e(name)}</Nm>\n`;
        content += this.addrXml(v, prefix, indent);

        let org = '';
        if (bic) org += `${this.tabs(indent + 2)}<AnyBIC>${this.e(bic)}</AnyBIC>\n`;
        if (lei) org += `${this.tabs(indent + 2)}<LEI>${this.e(lei)}</LEI>\n`;
        if (clrMmb || clrCd) {
            org += `${this.tabs(indent + 2)}<Othr>\n`;
            if (clrMmb) org += `${this.tabs(indent + 3)}<Id>${this.e(clrMmb)}</Id>\n`;
            if (clrCd) {
                org += `${this.tabs(indent + 3)}<SchmeNm>\n${this.tabs(indent + 4)}<Cd>${this.e(clrCd)}</Cd>\n${this.tabs(indent + 3)}</SchmeNm>\n`;
            }
            org += `${this.tabs(indent + 2)}</Othr>\n`;
        }

        if (org) {
            content += `${this.tabs(indent)}<Id>\n${this.tabs(indent + 1)}<OrgId>\n${org}${this.tabs(indent + 1)}</OrgId>\n${this.tabs(indent)}</Id>\n`;
        }

        return content;
    }

    addrXml(v: any, p: string, indent = 4): string {
        const type = v[p + 'AddrType']; if (!type || type === 'none') return '';
        const lines: string[] = []; const t = this.tabs(indent + 1);
        if (type === 'structured' || type === 'hybrid') {
            if (v[p + 'Dept']) lines.push(`${t}<Dept>${this.e(v[p + 'Dept'])}</Dept>`);
            if (v[p + 'SubDept']) lines.push(`${t}<SubDept>${this.e(v[p + 'SubDept'])}</SubDept>`);
            if (v[p + 'StrtNm']) lines.push(`${t}<StrtNm>${this.e(v[p + 'StrtNm'])}</StrtNm>`);
            if (v[p + 'BldgNb']) lines.push(`${t}<BldgNb>${this.e(v[p + 'BldgNb'])}</BldgNb>`);
            if (v[p + 'BldgNm']) lines.push(`${t}<BldgNm>${this.e(v[p + 'BldgNm'])}</BldgNm>`);
            if (v[p + 'Flr']) lines.push(`${t}<Flr>${this.e(v[p + 'Flr'])}</Flr>`);
            if (v[p + 'PstBx']) lines.push(`${t}<PstBx>${this.e(v[p + 'PstBx'])}</PstBx>`);
            if (v[p + 'Room']) lines.push(`${t}<Room>${this.e(v[p + 'Room'])}</Room>`);
            if (v[p + 'PstCd']) lines.push(`${t}<PstCd>${this.e(v[p + 'PstCd'])}</PstCd>`);
            if (v[p + 'TwnNm']) lines.push(`${t}<TwnNm>${this.e(v[p + 'TwnNm'])}</TwnNm>`);
            if (v[p + 'CtrySubDvsn']) lines.push(`${t}<CtrySubDvsn>${this.e(v[p + 'CtrySubDvsn'])}</CtrySubDvsn>`);
        }
        if (v[p + 'Ctry']) lines.push(`${t}<Ctry>${this.e(v[p + 'Ctry'])}</Ctry>`);
        if (type === 'unstructured' || type === 'hybrid') {
            if (v[p + 'AdrLine1']) lines.push(`${t}<AdrLine>${this.e(v[p + 'AdrLine1'])}</AdrLine>`);
            if (v[p + 'AdrLine2']) lines.push(`${t}<AdrLine>${this.e(v[p + 'AdrLine2'])}</AdrLine>`);
        }
        if (!lines.length) return '';
        return `${this.tabs(indent)}<PstlAdr>\n${lines.join('\n')}\n${this.tabs(indent)}</PstlAdr>\n`;
    }

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
            message_type: 'camt.057.001.06',
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
                    message: 'camt.057.001.06', total_time_ms: 0,
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



    downloadXml() {
        this.generateXml();
        const b = new Blob([this.generatedXml], { type: 'application/xml' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(b);
        a.download = `camt057-${Date.now()}.xml`;
        a.click();
    }

    copyToClipboard() {
        this.generateXml();
        navigator.clipboard.writeText(this.generatedXml).then(() => {
            this.snackBar.open('Copied to clipboard!', 'Close', { duration: 3000, horizontalPosition: 'center', verticalPosition: 'bottom' });
        });
    }

    switchToPreview() {
        this.generateXml();
        this.currentTab = 'preview';
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
        this.currentTab = 'preview';
        this.closeValidationModal();
    }

    editXmlModal() {
        this.closeValidationModal();
        this.currentTab = 'form';
    }

    runValidationModal() {
        this.validateMessage();
    }

    openBicSearch(controlName: string, index?: number): void {
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

    openBicSearchGroup(controlName: string, group: any): void {
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
