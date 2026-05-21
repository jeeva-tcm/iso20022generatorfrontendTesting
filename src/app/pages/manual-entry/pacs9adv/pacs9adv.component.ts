import { CommonModule } from '@angular/common';
import { Component, OnInit, OnDestroy, HostListener } from '@angular/core';
import { FormBuilder, FormGroup, FormsModule, ReactiveFormsModule, Validators } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { Router } from '@angular/router';
import { ConfigService } from '../../../services/config.service';
import { UetrService } from '../../../services/uetr.service';
import { MatDialog } from '@angular/material/dialog';
import { BicSearchDialogComponent } from '../bic-search-dialog/bic-search-dialog.component';
import { debounceTime } from 'rxjs/operators';

@Component({
    selector: 'app-pacs9adv',
    standalone: true,
    imports: [CommonModule, ReactiveFormsModule, FormsModule, MatIconModule, MatSnackBarModule, MatTooltipModule],
    templateUrl: './pacs9adv.component.html',
    styleUrl: './pacs9adv.component.css'
})
export class Pacs9AdvComponent implements OnInit, OnDestroy {
    form!: FormGroup;
    generatedXml = '';
    currentTab: 'form' | 'preview' = 'form';
    editorLineCount: number[] = [];
    isParsingXml = false;

    /** UETR Refresh state */
    uetrError: string | null = null;
    uetrSuccess: string | null = null;
    private uetrSuccessTimer: any;
    warningTimeouts: { [key: string]: any } = {};
    showMaxLenWarning: { [key: string]: boolean } = {};

    // Undo/Redo History
    private xmlHistory: string[] = [];
    private xmlHistoryIdx = -1;
    private maxHistory = 50;
    private isInternalChange = false;

    currencies: string[] = [];
    countries: string[] = [];
    categoryPurposes: string[] = [];
    purposes: string[] = [];
    sttlmMethods = ['COVE'];

    agentPrefixes = ['instgAgt', 'instdAgt', 'dbtrFi', 'cdtrFi', 'dbtrAgt', 'cdtrAgt',
        'prvsInstgAgt1', 'prvsInstgAgt2', 'prvsInstgAgt3',
        'intrmyAgt1', 'intrmyAgt2', 'intrmyAgt3'];

    private readonly DRAFT_KEY = 'draft_pacs009adv';
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

        // Track form changes for live XML update
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
            const upperValue = target.value.toUpperCase();
            if (target.value !== upperValue) {
                target.value = upperValue;
                if (start !== null && end !== null) {
                    target.setSelectionRange(start, end);
                }
                this.form.get(name)?.patchValue(upperValue, { emitEvent: false });
            }
        }
    }

    private updateClearingSystemValidation() {
        const systems = this.agentPrefixes.map(p => this.form.get(p + 'ClrSysCd')?.value?.trim()?.toUpperCase());
        const anyT2 = systems.includes('T2');
        const anyCHAPS = systems.includes('CHAPS');
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

    private buildForm() {
        const BIC = [Validators.required, Validators.pattern(/^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$/)];
        const BIC_OPT = [Validators.pattern(/^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$/)];
        // Safe character set: letters, digits, space, . , ( ) ' - only. No & @ ! # $ etc.
        const SAFE_NAME = Validators.pattern(/^[a-zA-Z0-9 .,()'\-]+$/);
        const ADDR_PATTERN = Validators.pattern(/^[a-zA-Z0-9\/\-\?:\(\)\.,\+' ]+$/);
        const c: any = {
            purpCd: [''],
            ctgyPurpCd: ['', [Validators.pattern(/^[A-Z]{4,4}$/)]],
            ctgyPurpPrtry: ['', [Validators.pattern(/^[A-Za-z0-9 .\-]{1,35}$/)]],
            instrPrty: ['', [Validators.pattern(/^(HIGH|NORM)$/)]],
            clrChanl: ['', [Validators.pattern(/^(BOOK|MPNS|RTGS|RTNS)$/)]],
            svcLvlCd: ['', [Validators.pattern(/^[A-Z0-9]{1,4}$/)]],
            svcLvlPrtry: ['', [Validators.pattern(/^[A-Za-z0-9 .\-]{1,35}$/)]],
            lclInstrmCd: ['', [Validators.pattern(/^[A-Z0-9]{1,4}$/)]],
            lclInstrmPrtry: ['', [Validators.pattern(/^[A-Za-z0-9 .\-]{1,35}$/)]],
            fromBic: ['BBBBUS33XXX', BIC], toBic: ['CCCCGB2LXXX', BIC], bizMsgId: ['MSG-2026-FI-001', Validators.required],
            msgId: ['MSG-2026-FI-001', Validators.required], creDtTm: [this.isoNow(), Validators.required],
            nbOfTxs: ['1', [Validators.required, Validators.pattern(/^[1-9]\d{0,14}$/)]], sttlmMtd: ['COVE', Validators.required],
            instgAgtBic: ['BBBBUS33XXX', BIC], instdAgtBic: ['CCCCGB2LXXX', BIC],
            instrId: ['INSTR-FI-001', Validators.required], endToEndId: ['E2E-FI-001', Validators.required],
            txId: ['TX-FI-001', Validators.required],
            uetr: ['550e8400-e29b-41d4-a716-446655440000', [Validators.required, Validators.pattern(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/)]],
            appHdrPriority: [''],
            clrSysRef: ['', [Validators.pattern(/^[A-Za-z0-9]{1,35}$/)]],
            sttlmPrty: ['', [Validators.pattern(/^(HIGH|NORM)$/)]],
            amount: ['50000.00', [Validators.required, Validators.pattern(/^\d{1,13}(\.\d{1,5})?$/)]], currency: ['USD', Validators.required],
            sttlmDt: [new Date().toISOString().split('T')[0], [Validators.required, Validators.pattern(/^\d{4}-\d{2}-\d{2}$/)]],
            // Debtor FI (required)
            dbtrFiBic: ['BBBBUS33XXX', BIC],
            // Debtor Agent (mandatory)
            dbtrAgtBic: ['BBBBUS33XXX', BIC],
            // Creditor Agent (mandatory)
            cdtrAgtBic: ['CCCCGB2LXXX', BIC],
            // Creditor FI (required)
            cdtrFiBic: ['CCCCGB2LXXX', BIC],
            // Optional agents
            prvsInstgAgt1Bic: ['', BIC_OPT], prvsInstgAgt2Bic: ['', BIC_OPT], prvsInstgAgt3Bic: ['', BIC_OPT],
            intrmyAgt1Bic: ['', BIC_OPT], intrmyAgt2Bic: ['', BIC_OPT], intrmyAgt3Bic: ['', BIC_OPT],
            // Debtor/Creditor FI Accounts
            dbtrFiAcct: [''],
            cdtrFiAcct: [''],
            dbtrAgtAcct: [''],
            cdtrAgtAcct: [''],
            // Instructions for Creditor Agent (0..2)
            instrForCdtrAgt1Cd: [''], instrForCdtrAgt1InfTxt: ['', [Validators.minLength(1), Validators.maxLength(140), ADDR_PATTERN]],
            instrForCdtrAgt2Cd: [''], instrForCdtrAgt2InfTxt: ['', [Validators.minLength(1), Validators.maxLength(140), ADDR_PATTERN]],
            // Instructions for Next Agent (0..6)
            instrForNxtAgt1InfTxt: ['', [Validators.minLength(1), Validators.maxLength(35), ADDR_PATTERN]],
            instrForNxtAgt2InfTxt: ['', [Validators.minLength(1), Validators.maxLength(35), ADDR_PATTERN]],
            instrForNxtAgt3InfTxt: ['', [Validators.minLength(1), Validators.maxLength(35), ADDR_PATTERN]],
            instrForNxtAgt4InfTxt: ['', [Validators.minLength(1), Validators.maxLength(35), ADDR_PATTERN]],
            instrForNxtAgt5InfTxt: ['', [Validators.minLength(1), Validators.maxLength(35), ADDR_PATTERN]],
            instrForNxtAgt6InfTxt: ['', [Validators.minLength(1), Validators.maxLength(35), ADDR_PATTERN]],
            // Remittance (Optional)
            rmtInfType: ['none'],
            rmtInfUstrd: ['', [Validators.maxLength(140), ADDR_PATTERN]],
            rmtInfStrdCdtrRefType: [''],
            rmtInfStrdCdtrRef: ['', Validators.maxLength(35)],
            rmtInfStrdAddtlRmtInf: ['', [Validators.maxLength(140), ADDR_PATTERN]]
        };
        // Address prefixes for agents
        // Only the mandatory parties that ship with full address data default to 'hybrid'.
        // Optional agents (previous/intermediary) default to 'none' so users don't get
        // spurious "Town/Country required" errors on unused agents.
        this.agentPrefixes.forEach(p => {
            if (!c[p + 'AddrType']) {
                c[p + 'AddrType'] = ['dbtrFi', 'cdtrFi', 'dbtrAgt', 'cdtrAgt'].includes(p) ? 'hybrid' : 'none';
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
            if (!c[p + 'Bic']) c[p + 'Bic'] = ['', [Validators.pattern(/^[A-Z0-9]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$/)]];
            if (!c[p + 'Lei']) c[p + 'Lei'] = ['', [Validators.pattern(/^[A-Z0-9]{18}[0-9]{2}$/)]];
            if (!c[p + 'ClrSysCd']) c[p + 'ClrSysCd'] = ['', Validators.maxLength(5)];
            if (!c[p + 'ClrSysMmbId']) c[p + 'ClrSysMmbId'] = ['', Validators.maxLength(35)];
            if (!c[p + 'Acct']) c[p + 'Acct'] = ['', [Validators.pattern(/^[A-Z0-9]{5,34}$/)]];
        });
        // Set default names and address data for mandatory parties to comply with CBPR+ coexistence rules
        const mandatoryParties = ['dbtrFi', 'cdtrFi', 'dbtrAgt', 'cdtrAgt'];
        mandatoryParties.forEach(p => {
            const label = p.startsWith('dbtr') ? 'Debtor' : 'Creditor';
            const suffix = p.endsWith('Agt') ? ' Agent' : '';
            const isDbtr = p.startsWith('dbtr');
            c[p + 'Name'] = [label + suffix, [Validators.required, Validators.maxLength(140), SAFE_NAME]];
            c[p + 'AddrType'] = ['hybrid'];
            c[p + 'AdrLine1'] = [isDbtr ? '123 Business Street' : '456 Commerce Avenue', [Validators.maxLength(70), ADDR_PATTERN]];
            c[p + 'AdrLine2'] = [isDbtr ? 'Suite 100' : 'Floor 12', [Validators.maxLength(70), ADDR_PATTERN]];
            c[p + 'TwnNm'] = [isDbtr ? 'New York' : 'London', [Validators.maxLength(35), ADDR_PATTERN]];
            c[p + 'Ctry'] = [isDbtr ? 'US' : 'GB', Validators.pattern(/^[A-Z]{2,2}$/)];
        });

        // Reimbursement agents (required when SttlmMtd = COVE)
        if (!c['instgRmbrsmntAgtBic']) c['instgRmbrsmntAgtBic'] = ['BBBBUS33XXX', [Validators.pattern(/^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$/)]];
        if (!c['instdRmbrsmntAgtBic']) c['instdRmbrsmntAgtBic'] = ['', [Validators.pattern(/^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$/)]];

        this.form = this.fb.group(c);
    }

    err(f: string): string | null {
        const c = this.form.get(f);
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
              if (f.toLowerCase().includes('bic') && val.length >= 11) return null;
              if (f === 'uetr' && val.length >= 36) return null;
            }
            if (f.toLowerCase().includes('bic')) return 'Valid 8 or 11-char BIC required.';
            if (f.toLowerCase().includes('iban')) return 'Valid 34-char IBAN required.';
            if (f.toLowerCase().includes('uetr')) return 'Invalid UETR format';
            if (f.toLowerCase().includes('amount') || f.toLowerCase().includes('amt')) {
                const ccy = this.form.get('currency')?.value;
                if (ccy === 'USD' || ccy === 'EUR' || ccy === 'GBP') {
                    return 'Amount must be a valid number (max 2 decimals).';
                }
                return 'Amount must be > 0 (max 18 digits).';
            }
            if (f === 'nbOfTxs') return "Must be '1' for pacs.009 Advice.";
            if (f === 'bizMsgId' || f === 'msgId' || f === 'instrId' || f === 'endToEndId' || f === 'txId') return 'Invalid Pattern.';
            if (f === 'clrSysRef') return 'Alphanumeric only (1-35 characters, no special chars).';
            if (f === 'ctgyPurpCd') return 'Invalid Category Purpose Code. Must be a valid ISO 20022 code (4 uppercase letters).';
            if (f === 'instrPrty') return 'Invalid Priority. Must be HIGH or NORM.';
            if (f === 'sttlmPrty') return 'Invalid Settlement Priority. Must be HIGH or NORM.';
            if (f === 'sttlmMtd') return "Settlement Method for pacs.009 ADV must be COVE.";
            if (f === 'clrChanl') return 'Invalid Clearing Channel. Must be BOOK, MPNS, RTGS, or RTNS.';
            if (f === 'svcLvlCd') return 'Invalid Service Level Code. Must be 1-4 alphanumeric characters.';
            if (f === 'svcLvlPrtry') return 'Invalid Proprietary Service Level. Up to 35 characters allowed.';
            if (f === 'lclInstrmCd') return 'Invalid Local Instrument Code. Must be 1-4 alphanumeric characters.';
            if (f === 'lclInstrmPrtry') return 'Invalid Proprietary Local Instrument. Up to 35 characters allowed.';
            if (f === 'ctgyPurpPrtry') return 'Invalid Proprietary Category Purpose. Up to 35 characters allowed.';
            if (f.toLowerCase().includes('bldgnb') || f.toLowerCase().includes('pstcd') || f.toLowerCase().includes('pstbx') || f.toLowerCase().includes('bldgnm') || f.toLowerCase().includes('twnnm') || f.toLowerCase().includes('twnlctn') || f.toLowerCase().includes('dstrctnm') || f.toLowerCase().includes('ctrysubdvsn') || f.toLowerCase().includes('strtnm') || f.toLowerCase().includes('dept') || f.toLowerCase().includes('subdept') || f.toLowerCase().includes('flr') || f.toLowerCase().includes('room') || f.toLowerCase().includes('adrline')) {
                return 'Invalid character. Only ISO 20022 MX allowed characters permitted.';
            }
            if (f.toLowerCase().includes('name') || f.toLowerCase().includes('nm')) return "Invalid characters. Only letters, numbers, spaces and . , ( ) ' - are allowed (no &, @, !, etc.)";
        }
        if (c.errors?.['target2']) return 'TARGET2 payments must use EUR as the settlement currency.';
        if (c.errors?.['chaps']) return 'Invalid Currency for CHAPS clearing system. When ClrSysId/Cd = CHAPS, the transaction currency must be GBP.';
        return 'Invalid value.';
    }

    get coveReimburseError(): boolean {
        const isCove = this.form.get('sttlmMtd')?.value === 'COVE';
        const hasInstg = !!this.form.get('instgRmbrsmntAgtBic')?.value?.trim();
        const hasInstd = !!this.form.get('instdRmbrsmntAgtBic')?.value?.trim();
        return isCove && !hasInstg && !hasInstd;
    }

    /**
     * UETR Refresh â€” generates a new UUID v4, validates, updates form.
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


    @HostListener('keydown', ['$event'])
    onKeydown(event: KeyboardEvent) {
        // ... Shortcuts check ...
        if (event.ctrlKey || event.metaKey) {
            if (document.activeElement?.classList.contains('code-editor')) {
                switch (event.key.toLowerCase()) {
                    case 'z': event.preventDefault(); this.undoXml(); return;
                    case 'y': event.preventDefault(); this.redoXml(); return;
                    case 's': event.preventDefault(); this.formatXml(); return;
                    case '/': event.preventDefault(); this.toggleCommentXml(); return;
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

        // Stop generation if target2 rule is violated
        if (this.form.get('currency')?.hasError('target2')) {
            this.generatedXml = '<!-- TARGET2 VALIDATION ERROR: T2 allows only EUR currency. -->';
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

        // Stop generation if COVE is selected but no reimbursement agent is provided
        if (this.coveReimburseError) {
            this.generatedXml = '<!-- COVE VALIDATION ERROR: When SettlementMethod is COVE, InstructedReimbursementAgent or InstructingReimbursementAgent must be present. Please provide at least one Reimbursement Agent BIC. -->';
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

        // CdtTrfTxInf â€” pacs.009.001.08 CBPR+ element order
        let tx = '';
        let pmtIdXml = this.el('InstrId', v.instrId, 5) + this.el('EndToEndId', v.endToEndId, 5) + this.el('TxId', v.txId, 5) + this.el('UETR', v.uetr, 5);
        if (v.clrSysRef?.trim()) pmtIdXml += this.el('ClrSysRef', v.clrSysRef, 5);
        tx += this.tag('PmtId', pmtIdXml, 4);

        let pmtTpXml = '';
        if (v.instrPrty?.trim()) pmtTpXml += this.el('InstrPrty', v.instrPrty, 5);
        if (v.clrChanl?.trim()) pmtTpXml += this.el('ClrChanl', v.clrChanl, 5);
        if (v.svcLvlCd?.trim() || v.svcLvlPrtry?.trim()) {
            let content = v.svcLvlCd?.trim() ? this.el('Cd', v.svcLvlCd, 6) : this.el('Prtry', v.svcLvlPrtry, 6);
            pmtTpXml += this.tag('SvcLvl', content, 5);
        }
        if (v.lclInstrmCd?.trim() || v.lclInstrmPrtry?.trim()) {
            let content = v.lclInstrmCd?.trim() ? this.el('Cd', v.lclInstrmCd, 6) : this.el('Prtry', v.lclInstrmPrtry, 6);
            pmtTpXml += this.tag('LclInstrm', content, 5);
        }
        if (v.ctgyPurpCd?.trim() || v.ctgyPurpPrtry?.trim()) {
            let content = v.ctgyPurpCd?.trim() ? this.el('Cd', v.ctgyPurpCd, 6) : this.el('Prtry', v.ctgyPurpPrtry, 6);
            pmtTpXml += this.tag('CtgyPurp', content, 5);
        }
        if (pmtTpXml) tx += this.tag('PmtTpInf', pmtTpXml, 4);
        const getPrecision = (ccy: string) => {
            if (['JPY', 'HUF', 'KRW', 'VND'].includes(ccy)) return 0;
            if (['JOD', 'KWD', 'BHD', 'TND', 'OMR'].includes(ccy)) return 3;
            return 2;
        };
        const precision = getPrecision(v.currency);
        const formattedAmt = v.amount ? Number(v.amount).toFixed(precision) : '';
        tx += `\t\t\t\t<IntrBkSttlmAmt Ccy="${this.e(v.currency)}">${formattedAmt}</IntrBkSttlmAmt>\n`;
        tx += this.el('IntrBkSttlmDt', v.sttlmDt, 4);
        if (v.sttlmPrty?.trim()) tx += this.el('SttlmPrty', v.sttlmPrty, 4);
        // PrvsInstgAgts
        tx += this.agtWithAcct('PrvsInstgAgt1', 'prvsInstgAgt1', v, 4);
        tx += this.agtWithAcct('PrvsInstgAgt2', 'prvsInstgAgt2', v, 4);
        tx += this.agtWithAcct('PrvsInstgAgt3', 'prvsInstgAgt3', v, 4);
        // InstgAgt/InstdAgt
        tx += this.agtWithAcct('InstgAgt', 'instgAgt', v, 4);
        tx += this.agtWithAcct('InstdAgt', 'instdAgt', v, 4);
        // IntrmyAgts
        tx += this.agtWithAcct('IntrmyAgt1', 'intrmyAgt1', v, 4);
        tx += this.agtWithAcct('IntrmyAgt2', 'intrmyAgt2', v, 4);
        tx += this.agtWithAcct('IntrmyAgt3', 'intrmyAgt3', v, 4);

        // Dbtr
        tx += this.agtWithAcct('Dbtr', 'dbtrFi', v, 4);
        // DbtrAgt
        tx += this.agtWithAcct('DbtrAgt', 'dbtrAgt', v, 4);
        // CdtrAgt
        tx += this.agtWithAcct('CdtrAgt', 'cdtrAgt', v, 4);
        // Cdtr
        tx += this.agtWithAcct('Cdtr', 'cdtrFi', v, 4);

        // Instructions for Creditor Agent (0..2)
        for (let i = 1; i <= 2; i++) {
            const cd = v[`instrForCdtrAgt${i}Cd`]?.trim();
            const txt = v[`instrForCdtrAgt${i}InfTxt`]?.trim();
            if (cd || txt) {
                let inner = '';
                if (cd) inner += this.el('Cd', cd, 5);
                if (txt) inner += this.el('InstrInf', txt, 5);
                tx += this.tag('InstrForCdtrAgt', inner, 4);
            }
        }
        // Instructions for Next Agent (0..6)
        for (let i = 1; i <= 6; i++) {
            const txt = v[`instrForNxtAgt${i}InfTxt`]?.trim();
            if (txt) {
                tx += this.tag('InstrForNxtAgt', this.el('InstrInf', txt, 4), 3);
            }
        }

        if (v.purpCd?.trim()) tx += this.tag('Purp', this.el('Cd', v.purpCd, 4), 3);

        // Remittance Information
        if (v.rmtInfType === 'ustrd' && v.rmtInfUstrd?.trim()) {
            tx += this.tag('RmtInf', this.el('Ustrd', v.rmtInfUstrd, 4), 3);
        } else if (v.rmtInfType === 'strd') {
            let inner = '';
            if (v.rmtInfStrdCdtrRefType || v.rmtInfStrdCdtrRef) {
                let ref = '';
                if (v.rmtInfStrdCdtrRefType) ref += this.tag('Tp', this.tag('CdOrPrtry', this.el('Cd', v.rmtInfStrdCdtrRefType, 7), 6), 5);
                if (v.rmtInfStrdCdtrRef) ref += this.el('Ref', v.rmtInfStrdCdtrRef, 5);
                inner += this.tag('CdtrRefInf', ref, 4);
            }
            if (v.rmtInfStrdAddtlRmtInf?.trim()) {
                inner += this.el('AddtlRmtInf', v.rmtInfStrdAddtlRmtInf, 4);
            }
            if (v.rmtInfStrdRfrdDocNb || v.rmtInfStrdRfrdDocCd) {
                let rdi = '';
                if (v.rmtInfStrdRfrdDocNb) rdi += this.el('Nb', v.rmtInfStrdRfrdDocNb, 5);
                if (v.rmtInfStrdRfrdDocCd) rdi += this.tag('Tp', this.tag('CdOrPrtry', this.el('Cd', v.rmtInfStrdRfrdDocCd, 7), 6), 5);
                inner += this.tag('RfrdDocInf', rdi, 4);
            }
            if (v.rmtInfStrdRfrdDocAmt) {
                inner += this.tag('RfrdDocAmt', this.tag('RmtAmt', this.el('DuePyblAmt Ccy="' + this.e(v.currency) + '"', v.rmtInfStrdRfrdDocAmt, 6), 5), 4);
            }
            if (inner) tx += this.tag('RmtInf', this.tag('Strd', inner, 4), 3);
        }


        const frBic = v.fromBic;
        const toBic = v.toBic;

        this.generatedXml =
            `<?xml version="1.0" encoding="UTF-8"?>
<BusMsgEnvlp xmlns="urn:swift:xsd:envelope">
\t<AppHdr xmlns="urn:iso:std:iso:20022:tech:xsd:head.001.001.02">
\t\t<Fr>
\t\t\t<FIId>
\t\t\t\t<FinInstnId>
\t\t\t\t\t<BICFI>${this.e(frBic)}</BICFI>
\t\t\t\t</FinInstnId>
\t\t\t</FIId>
\t\t</Fr>
\t\t<To>
\t\t\t<FIId>
\t\t\t\t<FinInstnId>
\t\t\t\t\t<BICFI>${this.e(toBic)}</BICFI>
\t\t\t\t</FinInstnId>
\t\t\t</FIId>
\t\t</To>
\t\t<BizMsgIdr>${this.e(v.bizMsgId)}</BizMsgIdr>
\t\t<MsgDefIdr>pacs.009.001.08</MsgDefIdr>
\t\t<BizSvc>swift.cbprplus.02</BizSvc>
\t\t<CreDt>${creDtTm}</CreDt>${v.appHdrPriority?.trim() ? `\n\t\t<Prty>${v.appHdrPriority}</Prty>` : ''}
\t</AppHdr>
\t<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pacs.009.001.08">
\t\t<FICdtTrf>
\t\t\t<GrpHdr>
\t\t\t\t<MsgId>${this.e(v.msgId)}</MsgId>
\t\t\t\t<CreDtTm>${creDtTm}</CreDtTm>
\t\t\t\t<NbOfTxs>${v.nbOfTxs}</NbOfTxs>
\t\t\t\t<SttlmInf>
\t\t\t\t\t<SttlmMtd>${this.e(v.sttlmMtd)}</SttlmMtd>${v.sttlmMtd === 'COVE' && v.instgRmbrsmntAgtBic?.trim() ? `
\t\t\t\t\t<InstgRmbrsmntAgt>
\t\t\t\t\t\t<FinInstnId>
\t\t\t\t\t\t\t<BICFI>${this.e(v.instgRmbrsmntAgtBic)}</BICFI>
\t\t\t\t\t\t</FinInstnId>
\t\t\t\t\t</InstgRmbrsmntAgt>` : ''}${v.sttlmMtd === 'COVE' && v.instdRmbrsmntAgtBic?.trim() ? `
\t\t\t\t\t<InstdRmbrsmntAgt>
\t\t\t\t\t\t<FinInstnId>
\t\t\t\t\t\t\t<BICFI>${this.e(v.instdRmbrsmntAgtBic)}</BICFI>
\t\t\t\t\t\t</FinInstnId>
\t\t\t\t\t</InstdRmbrsmntAgt>` : ''}
\t\t\t\t</SttlmInf>
\t\t\t</GrpHdr>
\t\t\t<CdtTrfTxInf>
${tx}\t\t\t</CdtTrfTxInf>
\t\t</FICdtTrf>
\t</Document>
</BusMsgEnvlp>`;
        this.formatXml(false);
            this.onEditorChange(this.generatedXml, true);
    }

    openBicSearch(controlName: string): void {
        const dialogRef = this.dialog.open(BicSearchDialogComponent, {
            width: '800px',
            disableClose: true
        });
        dialogRef.afterClosed().subscribe(result => {
            if (result && result.bic) {
                const ctrl = this.form.get(controlName);
                if (ctrl) {
                    ctrl.setValue(result.bic, { emitEvent: false });
                    ctrl.markAsTouched();
                    ctrl.markAsDirty();
                    ctrl.updateValueAndValidity({ emitEvent: false });
                    this.generateXml();
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
                const control = targetGroup.get(controlName);
                if (control) {
                    control.setValue(result.bic, { emitEvent: false });
                    control.markAsTouched();
                    control.markAsDirty();
                    control.updateValueAndValidity({ emitEvent: false });
                    this.generateXml();
                }
            }
        });
    }

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

    grpAgt(tag: string, prefix: string, v: any) {
        const bic = v[prefix + 'Bic']; if (!bic) return '';
        return `\t\t\t\t<${tag}>\n\t\t\t\t\t<FinInstnId>\n\t\t\t\t\t\t<BICFI>${this.e(bic)}</BICFI>\n${this.addrXml(v, prefix, 6)}\t\t\t\t\t</FinInstnId>\n\t\t\t\t</${tag}>\n`;
    }
    agtWithAcct(tag: string, prefix: string, v: any, indent = 4) {
        let res = this.agt(tag, prefix, v, indent);
        if (v[prefix + 'Acct']?.trim()) {
            const val = v[prefix + 'Acct'];
            const ibanCountries = ['AD', 'AE', 'AL', 'AT', 'AZ', 'BA', 'BE', 'BG', 'BH', 'BR', 'BY', 'CH', 'CR', 'CY', 'CZ', 'DE', 'DK', 'DO', 'EE', 'EG', 'ES', 'FI', 'FO', 'FR', 'GB', 'GE', 'GI', 'GL', 'GR', 'GT', 'HR', 'HU', 'IE', 'IL', 'IQ', 'IS', 'IT', 'JO', 'KW', 'KZ', 'LB', 'LI', 'LT', 'LU', 'LV', 'MC', 'MD', 'ME', 'MK', 'MR', 'MT', 'MU', 'NL', 'NO', 'PK', 'PL', 'PS', 'PT', 'QA', 'RO', 'RS', 'RU', 'SA', 'SC', 'SE', 'SI', 'SK', 'SM', 'ST', 'SV', 'TL', 'TN', 'TR', 'UA', 'VA', 'VG', 'XK'];
            let idContent = '';
            if (val.length >= 14 && ibanCountries.includes(val.substring(0, 2).toUpperCase()) && /^[A-Z]{2}[0-9]{2}[A-Z0-9]+$/i.test(val)) {
                idContent = this.el('IBAN', val, indent + 2);
            } else {
                idContent = `\n${this.tabs(indent + 2)}<Othr>\n${this.tabs(indent + 3)}<Id>${this.e(val)}</Id>\n${this.tabs(indent + 2)}</Othr>\n${this.tabs(indent + 1)}`;
            }
            res += this.tag(tag + 'Acct', this.tag('Id', idContent, indent + 1), indent);
        }
        return res;
    }

    agt(tag: string, prefix: string, v: any, indent = 4) {
        const bic = v[prefix + 'Bic'];
        const name = v[prefix + 'Name'];
        const lei = v[prefix + 'Lei'];
        const clrCd = v[prefix + 'ClrSysCd'];
        const clrMmb = v[prefix + 'ClrSysMmbId'];

        if (!bic && !name && !lei && !clrMmb) return '';

        let content = '';
        const t = this.tabs(indent + 2);
        if (bic) content += `${t}<BICFI>${this.e(bic)}</BICFI>\n`;
        if (clrMmb) {
            content += `${t}<ClrSysMmbId>\n`;
            if (clrCd) content += `${t}\t<ClrSysId>\n${t}\t\t<Cd>${this.e(clrCd)}</Cd>\n${t}\t</ClrSysId>\n`;
            content += `${t}\t<MmbId>${this.e(clrMmb)}</MmbId>\n`;
            content += `${t}</ClrSysMmbId>\n`;
        }
        if (lei) content += `${t}<LEI>${this.e(lei)}</LEI>\n`;

        // Filter: Nm and PstlAdr are NOT allowed for InstgAgt and InstdAgt as per MyStandards requirements
        if (tag !== 'InstgAgt' && tag !== 'InstdAgt') {
            if (name) content += `${t}<Nm>${this.e(name)}</Nm>\n`;
            content += this.addrXml(v, prefix, indent + 2, tag.startsWith('PrvsInstgAgt'));
        }

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

        // Geographic elements (Allowed in ALL modes; must precede Ctry/AdrLine)
        if (v[p + 'TwnNm']) lines.push(`${t}<TwnNm>${this.e(v[p + 'TwnNm'])}</TwnNm>`);
        if (v[p + 'TwnLctnNm']) lines.push(`${t}<TwnLctnNm>${this.e(v[p + 'TwnLctnNm'])}</TwnLctnNm>`);
        if (v[p + 'DstrctNm']) lines.push(`${t}<DstrctNm>${this.e(v[p + 'DstrctNm'])}</DstrctNm>`);
        if (v[p + 'CtrySubDvsn']) lines.push(`${t}<CtrySubDvsn>${this.e(v[p + 'CtrySubDvsn'])}</CtrySubDvsn>`);
        if (v[p + 'Ctry']) lines.push(`${t}<Ctry>${this.e(v[p + 'Ctry'])}</Ctry>`);

        // AdrLine (unstructured or hybrid)
        if (['unstructured', 'hybrid'].includes(type)) {
            if (v[p + 'AdrLine1']) lines.push(`${t}<AdrLine>${this.e(v[p + 'AdrLine1'])}</AdrLine>`);
            if (v[p + 'AdrLine2']) lines.push(`${t}<AdrLine>${this.e(v[p + 'AdrLine2'])}</AdrLine>`);
        }
        if (!lines.length) return '';
        return `${this.tabs(indent)}<PstlAdr>\n${lines.join('\n')}\n${this.tabs(indent)}</PstlAdr>\n`;
    }



    // Validation
    validateMessage() {
                if (this.bicSameWarning) return;
        if (this.form.invalid) {
            this.form.markAllAsTouched();
            this.snackBar.open('Please fix the errors in the form before validating.', 'Close', { duration: 3000 });
            return;
        }
        if (this.coveReimburseError) {
            this.snackBar.open('Settlement Method is COVE: at least one Reimbursement Agent (Instructed or Instructing) must be provided.', 'Close', { duration: 5000 });
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
            message_type: 'pacs.009.001.08_ADV',
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
                    message: 'pacs.009.001.08', total_time_ms: 0,
                    layer_status: {},
                    details: [{
                        severity: 'ERROR', layer: 0, code: 'BACKEND_ERROR',
                        path: '', message: 'Validation failed â€” ' + (err.error?.detail?.message || 'backend not reachable.'),
                        fix_suggestion: 'Ensure the validation server is running.'
                    }]
                };
                this.validationStatus = 'done';
            }
        });
    }



    downloadXml() { this.generateXml(); const b = new Blob([this.generatedXml], { type: 'application/xml' }); const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = `pacs009-${Date.now()}.xml`; a.click(); URL.revokeObjectURL(a.href); }
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
                patch.appHdrPriority = tval('Prty', appHdr);
            }

            // Document
            const grpHdr = getT('GrpHdr');
            if (grpHdr) {
                patch.msgId = tval('MsgId', grpHdr);
                patch.creDtTm = tval('CreDtTm', grpHdr);
                patch.nbOfTxs = tval('NbOfTxs', grpHdr);
                const sttlmInf = getT('SttlmInf', grpHdr) || grpHdr;
                patch.sttlmMtd = tval('SttlmMtd', sttlmInf);
                const instgRmbrs = getT('InstgRmbrsmntAgt', sttlmInf);
                if (instgRmbrs) patch.instgRmbrsmntAgtBic = tval('BICFI', getT('FinInstnId', instgRmbrs) || instgRmbrs);
                const instdRmbrs = getT('InstdRmbrsmntAgt', sttlmInf);
                if (instdRmbrs) patch.instdRmbrsmntAgtBic = tval('BICFI', getT('FinInstnId', instdRmbrs) || instdRmbrs);
            }

            const tx = getT('CdtTrfTxInf');
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
                patch.sttlmPrty = tval('SttlmPrty', tx);

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
                            patch[p + 'ClrSysId'] = tval('Cd', getT('ClrSysId', mmb) || mmb);
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
                mapAgt('dbtrFi', 'Dbtr');
                mapAgt('dbtrAgt', 'DbtrAgt');
                mapAgt('cdtrAgt', 'CdtrAgt');
                mapAgt('cdtrFi', 'Cdtr');

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
    isLayerPass(k: string) { return this.getLayerStatus(k).includes('âœ…'); }
  isLayerFail(k: string) { return this.getLayerStatus(k).includes('âŒ'); }
  isLayerWarn(k: string) {
    const s = this.getLayerStatus(k);
    return s.includes('âš ') || s.includes('WARNING') || s.includes('WARN');
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
