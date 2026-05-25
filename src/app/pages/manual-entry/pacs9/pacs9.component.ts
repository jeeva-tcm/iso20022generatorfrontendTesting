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
    selector: 'app-pacs9',
    standalone: true,
    imports: [CommonModule, ReactiveFormsModule, FormsModule, MatIconModule, MatSnackBarModule, MatTooltipModule, MatDialogModule],
    templateUrl: './pacs9.component.html',
    styleUrl: './pacs9.component.css'
})
export class Pacs9Component implements OnInit, OnDestroy {
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
    currencyPrecision: { [key: string]: number } = {};
    countries: string[] = [];
    categoryPurposes: string[] = [];
    purposes: string[] = [];
    sttlmMethods = ['INDA', 'INGA'];

    agentPrefixes = ['instgAgt', 'instdAgt', 'dbtrFi', 'cdtrFi', 'dbtrAgt', 'cdtrAgt',
        'prvsInstgAgt1', 'prvsInstgAgt2', 'prvsInstgAgt3',
        'intrmyAgt1', 'intrmyAgt2', 'intrmyAgt3'];

    private readonly DRAFT_KEY = 'draft_pacs009';
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
        this.form.get('currency')?.valueChanges.subscribe(() => {
            this.updateAmountValidator();
            this.updateClearingSystemValidation();
        });

        const hadDraft = this.loadDraft();
        if (hadDraft) {
          this.showDraftBanner = true;
          this.generateXml();
        }

        // Track form changes for live XML update
        this.form.valueChanges.pipe(debounceTime(300)).subscribe(() => {
            this.updateConditionalValidators();
            this.generateXml();
            this.scheduleDraftSave();
        });

        // Init history
        this.pushHistory();
        this.updateAmountValidator();

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
                const existingCodes = res && res.codes ? res.codes : [];
                this.purposes = [...new Set([...existingCodes, ...ISO_PURPOSE_CODES])].sort();
            },
            error: (err) => {
                console.error('Failed to load purposes', err);
                this.purposes = [...ISO_PURPOSE_CODES].sort();
            }
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
        // BICFIDec2014Identifier — first 4 chars are alphanumeric per ISO 9362 / CBPR+
        const BIC = [Validators.required, Validators.pattern(/^[A-Z0-9]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$/)];
        const BIC_OPT = [Validators.pattern(/^[A-Z0-9]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$/)];
        // Safe character set: letters, digits, space, . , ( ) ' - only. No & @ ! # $ etc.
        const SAFE_NAME = Validators.pattern(/^[a-zA-Z0-9 .,()'\-]+$/);
        const ADDR_PATTERN = Validators.pattern(/^[a-zA-Z0-9\/\-\?:\(\)\.,\+' ]+$/);
        const c: any = {
            purpCd: [''],
            ctgyPurpCd: ['', [Validators.pattern(/^[A-Z]{4,4}$/), (control: any) => {
                if (!control.value) return null;
                return (this.purposes || []).includes(control.value.toUpperCase()) ? null : { invalidPurpose: true };
            }]],
            ctgyPurpPrtry: ['', [Validators.pattern(/^[A-Za-z0-9 .\-]{1,35}$/)]],
            instrPrty: ['', [Validators.pattern(/^(HIGH|NORM)$/)]],
            clrChanl: ['', [Validators.pattern(/^(BOOK|MPNS|RTGS|RTNS)$/)]],
            svcLvlCd: ['', [Validators.pattern(/^[A-Z0-9]{1,4}$/)]],
            svcLvlPrtry: ['', [Validators.pattern(/^[A-Za-z0-9 .\-]{1,35}$/)]],
            lclInstrmCd: ['', [Validators.pattern(/^[A-Z0-9]{1,4}$/)]],
            lclInstrmPrtry: ['', [Validators.pattern(/^[A-Za-z0-9 .\-]{1,35}$/)]],
            fromBic: ['BBBBUS33XXX', BIC], toBic: ['CCCCGB2LXXX', BIC], bizMsgId: ['MSG-2026-FI-001', [Validators.required, Validators.maxLength(35)]],
            msgId: ['MSG-2026-FI-001', [Validators.required, Validators.maxLength(35)]], creDtTm: [this.isoNow(), Validators.required],
            nbOfTxs: ['1', [Validators.required, Validators.pattern(/^[1-9]\d{0,14}$/)]], sttlmMtd: ['INDA', Validators.required],
            instgAgtBic: ['BBBBUS33XXX', BIC], instdAgtBic: ['CCCCGB2LXXX', BIC],
            instrId: ['INSTR-FI-001', [Validators.required, Validators.maxLength(35)]], endToEndId: ['E2E-FI-001', [Validators.required, Validators.maxLength(35)]],
            txId: ['TX-FI-001', [Validators.required, Validators.maxLength(35)]],
            uetr: ['550e8400-e29b-41d4-a716-446655440000', [Validators.required, Validators.pattern(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/)]],
            appHdrPriority: [''],
            fromMmbId: ['', [Validators.maxLength(35)]], fromClrSysId: ['', [Validators.maxLength(5)]], fromLei: ['', [Validators.pattern(/^[A-Z0-9]{18}[0-9]{2}$/)]],
            toMmbId: ['', [Validators.maxLength(35)]], toClrSysId: ['', [Validators.maxLength(5)]], toLei: ['', [Validators.pattern(/^[A-Z0-9]{18}[0-9]{2}$/)]],
            rltd: [''], rltdCharSet: [''],
            clrSysRef: ['', [Validators.pattern(/^[A-Za-z0-9]{1,35}$/)]],
            sttlmPrty: ['', [Validators.pattern(/^(HIGH|NORM)$/)]],
            instdAmt: [''], instdAmtCcy: [''],
            xchgRate: [''],
            rgltryRptg1Code: [''], rgltryRptg1Inf: [''],
            rgltryRptg2Code: [''], rgltryRptg2Inf: [''],
            rgltryRptg3Code: [''], rgltryRptg3Inf: [''],
            rltdRmtInf1Ref: [''], rltdRmtInf2Ref: [''], rltdRmtInf3Ref: [''],
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
            dbtrFiAcct: ['471932901234'],
            dbtrFiAcctType: ['other'],
            cdtrFiAcct: ['471932905678'],
            cdtrFiAcctType: ['other'],
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
            instrForNxtAgt5Cd: [''],
            instrForNxtAgt5InfTxt: ['', [Validators.minLength(1), Validators.maxLength(35), ADDR_PATTERN]],
            instrForNxtAgt6Cd: [''],
            instrForNxtAgt6InfTxt: ['', [Validators.minLength(1), Validators.maxLength(35), ADDR_PATTERN]],
            // Remittance (Optional)
            rmtInfType: ['none'],
            rmtInfUstrd: ['', [Validators.maxLength(140), ADDR_PATTERN]],
            rmtInfStrdCdtrRefType: [''],
            rmtInfStrdCdtrRef: ['', Validators.maxLength(35)],
            rmtInfStrdAddtlRmtInf: ['', [Validators.maxLength(140), ADDR_PATTERN]],
            rmtInfStrdRfrdDocNb: ['', Validators.maxLength(35)],
            rmtInfStrdRfrdDocCd: [''],
            rmtInfStrdRfrdDocAmt: ['', [Validators.pattern(/^\d{1,18}(\.\d{1,5})?$/)]]
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
            // CBPR_RestrictedFINXMax28Text — schema caps MmbId at 28 and constrains the FIN-X character set
            if (!c[p + 'ClrSysMmbId']) c[p + 'ClrSysMmbId'] = ['', [Validators.maxLength(28), ADDR_PATTERN]];
            // CBPR_RestrictedFINXMax34Text — Acct must be ≤ 34
            if (!c[p + 'Acct']) c[p + 'Acct'] = ['', [Validators.maxLength(34), Validators.pattern(/^[A-Z0-9]{5,34}$/)]];
        });

        // Add static address data to resolve "Name and Address must always be present together"
        // AND the rule: "If Address Line is present and any other element is present, then Town Name and Country are mandatory"
        c['dbtrFiAddrType'] = ['hybrid'];
        c['dbtrFiCtry'] = ['US', Validators.pattern(/^[A-Z]{2,2}$/)];
        c['dbtrFiTwnNm'] = ['New York', [Validators.maxLength(35), ADDR_PATTERN]];
        c['dbtrFiAdrLine1'] = ['123 Wall Street', [Validators.maxLength(70), ADDR_PATTERN]];

        c['cdtrFiAddrType'] = ['hybrid'];
        c['cdtrFiCtry'] = ['GB', Validators.pattern(/^[A-Z]{2,2}$/)];
        c['cdtrFiTwnNm'] = ['London', [Validators.maxLength(35), ADDR_PATTERN]];
        c['cdtrFiAdrLine1'] = ['456 Canary Wharf', [Validators.maxLength(70), ADDR_PATTERN]];

        // Also for Agents
        c['dbtrAgtAddrType'] = ['hybrid'];
        c['dbtrAgtCtry'] = ['US', Validators.pattern(/^[A-Z]{2,2}$/)];
        c['dbtrAgtTwnNm'] = ['New York', [Validators.maxLength(35), ADDR_PATTERN]];
        c['dbtrAgtAdrLine1'] = ['789 Banker Lane', [Validators.maxLength(70), ADDR_PATTERN]];

        c['cdtrAgtAddrType'] = ['hybrid'];
        c['cdtrAgtCtry'] = ['GB', Validators.pattern(/^[A-Z]{2,2}$/)];
        c['cdtrAgtTwnNm'] = ['London', [Validators.maxLength(35), ADDR_PATTERN]];
        c['cdtrAgtAdrLine1'] = ['321 Finance Square', [Validators.maxLength(70), ADDR_PATTERN]];

        // Set default names for mandatory parties
        c['dbtrFiName'] = ['Debtor FI', [Validators.required, Validators.maxLength(140), SAFE_NAME]];
        c['cdtrFiName'] = ['Creditor FI', [Validators.required, Validators.maxLength(140), SAFE_NAME]];
        c['dbtrAgtName'] = ['Debtor Agent', [Validators.required, Validators.maxLength(140), SAFE_NAME]];
        c['cdtrAgtName'] = ['Creditor Agent', [Validators.required, Validators.maxLength(140), SAFE_NAME]];

        this.form = this.fb.group(c);
    }

    err(f: string): string | null {
        const c = this.form.get(f);
        // Remove touched/dirty requirement to show errors immediately
        if (!c || c.valid || (!c.touched && !c.dirty)) return null;

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
            if (f.toLowerCase().includes('bic')) return 'Valid 8 or 11 character BIC is required.';
            if (f.toLowerCase().includes('iban')) return 'Valid 34-char IBAN required.';
            if (f.toLowerCase().includes('uetr')) return 'Invalid UETR format';
            if (f.toLowerCase().includes('amount') || f.toLowerCase().includes('amt')) return 'Amount must be > 0 (max 18 digits).';
            if (f === 'nbOfTxs') return 'Must be 1-15 digits.';
            if (f === 'bizMsgId' || f === 'msgId' || f === 'instrId' || f === 'endToEndId' || f === 'txId') return 'Invalid Pattern.';
            if (f === 'clrSysRef') return 'Alphanumeric only (1-35 characters, no special chars).';
            if (f === 'ctgyPurpCd') return 'Invalid Category Purpose Code. Must be a valid ISO 20022 code (4 uppercase letters).';
            if (f === 'instrPrty') return 'Invalid Priority. Must be HIGH or NORM.';
            if (f === 'sttlmPrty') return 'Invalid Settlement Priority. Must be HIGH or NORM.';
            if (f === 'clrChanl') return 'Invalid Clearing Channel. Must be BOOK, MPNS, RTGS, or RTNS.';
            if (f === 'svcLvlCd') return 'Invalid Service Level Code. Must be 1-4 alphanumeric characters.';
            if (f === 'svcLvlPrtry') return 'Invalid Proprietary Service Level. Up to 35 characters allowed.';
            if (f === 'lclInstrmCd') return 'Invalid Local Instrument Code. Must be 1-4 alphanumeric characters.';
            if (f === 'lclInstrmPrtry') return 'Invalid Proprietary Local Instrument. Up to 35 characters allowed.';
            if (f === 'ctgyPurpPrtry') return 'Invalid Proprietary Category Purpose. Up to 35 characters allowed.';
            if (f === 'ctgyPurpCd') return 'Invalid Category Purpose Code. Please select from the list or enter a valid ISO 20022 Purpose Code.';
        }

        if (f.toLowerCase().includes('bldgnb') || f.toLowerCase().includes('pstcd') || f.toLowerCase().includes('pstbx') || f.toLowerCase().includes('bldgnm') || f.toLowerCase().includes('twnnm') || f.toLowerCase().includes('twnlctn') || f.toLowerCase().includes('dstrctnm') || f.toLowerCase().includes('ctrysubdvsn') || f.toLowerCase().includes('strtnm') || f.toLowerCase().includes('dept') || f.toLowerCase().includes('subdept') || f.toLowerCase().includes('flr') || f.toLowerCase().includes('room') || f.toLowerCase().includes('adrline')) {
            if (c.errors?.['pattern']) return 'Invalid character. Only ISO 20022 MX allowed characters permitted.';
        }
        if (f.toLowerCase().includes('name') || f.toLowerCase().includes('nm')) {
            if (c.errors?.['pattern']) return "Invalid characters. Only letters, numbers, spaces and . , ( ) ' - are allowed (no &, @, !, etc.)";
        }
        if (c.errors?.['invalidPurpose']) return 'Invalid Purpose Code. Please select from the list or enter a valid ISO 20022 Purpose Code.';
        if (c.errors?.['target2']) return 'TARGET2 payments must use EUR as the settlement currency.';
        if (c.errors?.['chaps']) return 'Invalid Currency for CHAPS clearing system. When ClrSysId/Cd = CHAPS, the transaction currency must be GBP.';
        return 'Invalid value.';
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

    formatCbprDateTime(dt: string): string {
        if (!dt) return this.isoNow();
        let res = dt.trim();
        // 1. Replace Z with +00:00
        if (res.endsWith('Z')) res = res.replace('Z', '+00:00');
        // 2. Remove milliseconds if present (e.g. .415)
        res = res.replace(/\.\d{1,}/, '');
        // 3. Ensure mandatory timezone offset. If missing, assume +00:00
        if (!/[+-]\d{2}:\d{2}$/.test(res)) {
            res += '+00:00';
        }
        return res;
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

        // Stop generation if ClrSysRef is forbidden
        if (this.form.get('clrSysRef')?.hasError('forbidden')) {
            this.generatedXml = '<!-- CLEARING SYSTEM REFERENCE VALIDATION ERROR: Clearing System Reference must NOT be sent if no active standard clearing system is used. -->';
            this.formatXml(false);
            this.onEditorChange(this.generatedXml, true);
            return;
        }

        const v = this.form.value;
        let creDtTm = this.fdt(v.creDtTm || this.isoNow());

        let tx = '';
        let pmtIdXml = this.el('InstrId', v.instrId, 5) + this.el('EndToEndId', v.endToEndId, 5) + this.el('TxId', v.txId, 5) + this.el('UETR', v.uetr, 5);
        if (v.clrSysRef?.trim()) pmtIdXml += this.el('ClrSysRef', v.clrSysRef, 5);
        tx += this.tag('PmtId', pmtIdXml, 4);

        let pmtTpXml = '';
        if (v.instrPrty?.trim()) pmtTpXml += this.el('InstrPrty', v.instrPrty, 4);
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
        const formattedAmt = this.formatting.formatAmount(v.amount, v.currency);
        tx += `\t\t\t\t<IntrBkSttlmAmt Ccy="${this.e(v.currency)}">${formattedAmt}</IntrBkSttlmAmt>\n`;
        tx += this.el('IntrBkSttlmDt', v.sttlmDt, 4);
        if (v.sttlmPrty?.trim()) tx += this.el('SttlmPrty', v.sttlmPrty, 4);

        const formatAcct = (val: string, tabs: number) => {
            if (!val) return '';
            const ibanCountries = ['AD', 'AE', 'AL', 'AT', 'AZ', 'BA', 'BE', 'BG', 'BH', 'BR', 'BY', 'CH', 'CR', 'CY', 'CZ', 'DE', 'DK', 'DO', 'EE', 'EG', 'ES', 'FI', 'FO', 'FR', 'GB', 'GE', 'GI', 'GL', 'GR', 'GT', 'HR', 'HU', 'IE', 'IL', 'IQ', 'IS', 'IT', 'JO', 'KW', 'KZ', 'LB', 'LI', 'LT', 'LU', 'LV', 'MC', 'MD', 'ME', 'MK', 'MR', 'MT', 'MU', 'NL', 'NO', 'PK', 'PL', 'PS', 'PT', 'QA', 'RO', 'RS', 'RU', 'SA', 'SC', 'SE', 'SI', 'SK', 'SM', 'ST', 'SV', 'TL', 'TN', 'TR', 'UA', 'VA', 'VG', 'XK'];
            if (val.length >= 14 && ibanCountries.includes(val.substring(0, 2).toUpperCase()) && /^[A-Z]{2}[0-9]{2}[A-Z0-9]+$/i.test(val)) {
                return this.el('IBAN', val, tabs + 1);
            } else {
                return `\n${'\t'.repeat(tabs + 1)}<Othr>\n${'\t'.repeat(tabs + 2)}<Id>${this.e(val)}</Id>\n${'\t'.repeat(tabs + 1)}</Othr>\n${'\t'.repeat(tabs)}`;
            }
        };

        if (v.instdAmt && v.instdAmtCcy) {
            const formattedInstdAmt = this.formatting.formatAmount(v.instdAmt, v.instdAmtCcy);
            tx += `\t\t\t\t<InstdAmt Ccy="${this.e(v.instdAmtCcy)}">${formattedInstdAmt}</InstdAmt>\n`;
        }
        if (v.xchgRate) tx += this.el('XchgRate', v.xchgRate, 4);
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
                if (cd) inner += this.el('Cd', cd, 4);
                if (txt) inner += this.el('InstrInf', txt, 4);
                tx += this.tag('InstrForCdtrAgt', inner, 4);
            }
        }
        // Instructions for Next Agent (0..6)
        for (let i = 1; i <= 6; i++) {
            const cd = v[`instrForNxtAgt${i}Cd`]?.trim();
            const txt = v[`instrForNxtAgt${i}InfTxt`]?.trim();
            if (cd || txt) {
                let inner = '';
                if (cd) inner += this.el('Cd', cd, 6);
                if (txt) inner += this.el('InstrInf', txt, 6);
                tx += this.tag('InstrForNxtAgt', inner, 5);
            }
        }

        if (v.purpCd?.trim()) tx += this.tag('Purp', this.el('Cd', v.purpCd, 5), 4);

        // Regulatory Reporting (0..3)
        for (let i = 1; i <= 3; i++) {
            const cd = v[`rgltryRptg${i}Code`]?.trim();
            const inf = v[`rgltryRptg${i}Inf`]?.trim();
            if (cd || inf) {
                let dtls = '';
                if (cd) dtls += this.el('Cd', cd, 6);
                if (inf) dtls += this.el('Inf', inf, 6);
                tx += this.tag('RgltryRptg', this.tag('Dtls', dtls, 5), 4);
            }
        }

        // Related Remittance Information (0..10)
        for (let i = 1; i <= 3; i++) {
            const ref = v[`rltdRmtInf${i}Ref`]?.trim();
            if (ref) {
                tx += this.tag('RltdRmtInf', this.el('Ref', ref, 5), 4);
            }
        }

        // Remittance Information
        if (v.rmtInfType === 'ustrd' && v.rmtInfUstrd?.trim()) {
            tx += this.tag('RmtInf', this.el('Ustrd', v.rmtInfUstrd, 5), 4);
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
            if (inner) tx += this.tag('RmtInf', this.tag('Strd', inner, 5), 4);
        }


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
\t\t<MsgDefIdr>pacs.009.001.08</MsgDefIdr>
\t\t<BizSvc>swift.cbprplus.02</BizSvc>
\t\t<CreDt>${creDtTm}</CreDt>${v.appHdrPriority?.trim() ? `\n\t\t<Prty>${v.appHdrPriority}</Prty>` : ''}${v.rltd ? `\n\t\t<Rltd>\n\t\t\t<BizMsgIdr>${this.e(v.rltd)}</BizMsgIdr>\n\t\t</Rltd>` : ''}
\t</AppHdr>
\t<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pacs.009.001.08">
\t\t<FICdtTrf>
\t\t\t<GrpHdr>
\t\t\t\t<MsgId>${this.e(v.msgId)}</MsgId>
\t\t\t\t<CreDtTm>${creDtTm}</CreDtTm>
\t\t\t\t<NbOfTxs>${v.nbOfTxs}</NbOfTxs>
\t\t\t\t<SttlmInf>
\t\t\t\t\t<SttlmMtd>${this.e(v.sttlmMtd)}</SttlmMtd>
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

    // XML helpers
    private e(v: string) { return (v || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
    private tabs(n: number) { return '\t'.repeat(n); }
    private el(tag: string, val: string, indent = 3) { return val?.trim() ? `${this.tabs(indent)}<${tag}>${this.e(val)}</${tag}>\n` : ''; }
    private tag(tag: string, content: string, indent = 3) { return content?.trim() ? `${this.tabs(indent)}<${tag}>\n${content}${this.tabs(indent)}</${tag}>\n` : ''; }

    grpAgt(tag: string, prefix: string, v: any) {
        const bic = v[prefix + 'Bic']; if (!bic) return '';
        return `\t\t\t\t<${tag}>\n\t\t\t\t\t<FinInstnId>\n\t\t\t\t\t\t<BICFI>${this.e(bic)}</BICFI>\n${this.addrXml(v, prefix, 6)}\t\t\t\t\t</FinInstnId>\n\t\t\t\t</${tag}>\n`;
    }
    agtWithAcct(tag: string, prefix: string, v: any, indent = 4) {
        let res = this.agt(tag, prefix, v, indent);
        if (v[prefix + 'Acct']?.trim()) {
            const val = v[prefix + 'Acct'];
            const explicitType = v[prefix + 'AcctType'];
            const ibanCountries = ['AD', 'AE', 'AL', 'AT', 'AZ', 'BA', 'BE', 'BG', 'BH', 'BR', 'BY', 'CH', 'CR', 'CY', 'CZ', 'DE', 'DK', 'DO', 'EE', 'EG', 'ES', 'FI', 'FO', 'FR', 'GB', 'GE', 'GI', 'GL', 'GR', 'GT', 'HR', 'HU', 'IE', 'IL', 'IQ', 'IS', 'IT', 'JO', 'KW', 'KZ', 'LB', 'LI', 'LT', 'LU', 'LV', 'MC', 'MD', 'ME', 'MK', 'MR', 'MT', 'MU', 'NL', 'NO', 'PK', 'PL', 'PS', 'PT', 'QA', 'RO', 'RS', 'RU', 'SA', 'SC', 'SE', 'SI', 'SK', 'SM', 'ST', 'SV', 'TL', 'TN', 'TR', 'UA', 'VA', 'VG', 'XK'];
            let idContent = '';
            const useIban = explicitType === 'iban' ||
                (!explicitType && val.length >= 14 && ibanCountries.includes(val.substring(0, 2).toUpperCase()) && /^[A-Z]{2}[0-9]{2}[A-Z0-9]+$/i.test(val));
            if (useIban) {
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
        content += this.addrXml(v, prefix, indent + 2, tag.startsWith('PrvsInstgAgt'));

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

        // Geographic elements (Allowed in ALL modes; must precede Ctry/AdrLine)
        if (v[p + 'TwnNm']) lines.push(`${t}<TwnNm>${this.e(v[p + 'TwnNm'])}</TwnNm>`);
        if (v[p + 'TwnLctnNm']) lines.push(`${t}<TwnLctnNm>${this.e(v[p + 'TwnLctnNm'])}</TwnLctnNm>`);
        if (v[p + 'DstrctNm']) lines.push(`${t}<DstrctNm>${this.e(v[p + 'DstrctNm'])}</DstrctNm>`);
        if (v[p + 'CtrySubDvsn']) lines.push(`${t}<CtrySubDvsn>${this.e(v[p + 'CtrySubDvsn'])}</CtrySubDvsn>`);
        if (v[p + 'Ctry']) lines.push(`${t}<Ctry>${this.e(v[p + 'Ctry'])}</Ctry>`);

        // AdrLine (unstructured or hybrid). Previous code was ['hybrid','hybrid']
        // — a typo that silently dropped both AdrLines for unstructured addresses.
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
        if (!this.generatedXml?.trim()) return;

        this.showValidationModal = true;
        this.validationStatus = 'validating';
        this.validationReport = null;
        this.validationExpandedIssue = null;

        this.http.post(this.config.getApiUrl('/validate'), {
            xml_content: this.generatedXml,
            mode: 'Full 1-3',
            message_type: 'pacs.009.001.08',
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
        if (content.length < 50) return;
        if (this.isParsingXml) return;
        try {
            this.isParsingXml = true;
            // Strip namespaces for easier selector matching
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

            // 1. AppHdr (BAH)
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
                const rltd = getT('Rltd', appHdr);
                if (rltd) patch.rltd = tval('BizMsgIdr', rltd);
            }

            // 2. Document
            const grpHdr = getT('GrpHdr');
            if (grpHdr) {
                patch.msgId = tval('MsgId', grpHdr);
                patch.creDtTm = tval('CreDtTm', grpHdr);
                patch.nbOfTxs = tval('NbOfTxs', grpHdr);
                patch.sttlmMtd = tval('SttlmMtd', getT('SttlmInf', grpHdr) || grpHdr);
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

                const instdAmt = getT('InstdAmt', tx);
                if (instdAmt) {
                    patch.instdAmt = instdAmt.textContent?.trim() || '';
                    patch.instdAmtCcy = instdAmt.getAttribute('Ccy') || '';
                }
                patch.xchgRate = tval('XchgRate', tx);

                const mapAgt = (p: string, tag: string) => {
                    const el = getT(tag, tx);
                    if (!el) return;
                    const fi = getT('FinInstnId', el);
                    if (fi) {
                        patch[p + 'Bic'] = tval('BICFI', fi);
                        patch[p + 'Lei'] = tval('LEI', fi);
                        patch[p + 'Name'] = tval('Nm', fi);
                        const mmb = getT('ClrSysMmbId', fi);
                        if (mmb) {
                            patch[p + 'ClrSysMmbId'] = tval('MmbId', mmb);
                            patch[p + 'ClrSysCd'] = tval('Cd', getT('ClrSysId', mmb) || mmb);
                        }
                        const pstl = getT('PstlAdr', fi);
                        if (pstl) {
                            patch[p + 'Ctry'] = tval('Ctry', pstl);
                            patch[p + 'TwnNm'] = tval('TwnNm', pstl);
                            patch[p + 'StrtNm'] = tval('StrtNm', pstl);
                            patch[p + 'BldgNb'] = tval('BldgNb', pstl);
                            patch[p + 'BldgNm'] = tval('BldgNm', pstl);
                            patch[p + 'PstCd'] = tval('PstCd', pstl);
                            const lines = pstl.querySelectorAll(':scope > AdrLine');
                            if (lines.length > 0) patch[p + 'AdrLine1'] = lines[0].textContent || '';
                            if (lines.length > 1) patch[p + 'AdrLine2'] = lines[1].textContent || '';
                            patch[p + 'AddrType'] = lines.length > 0 ? 'hybrid' : 'structured';
                        }
                    }
                    const acct = getT(tag + 'Acct', tx);
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

                const instrC = tx.querySelectorAll(':scope > InstrForCdtrAgt');
                instrC.forEach((el, i) => {
                    if (i < 2) {
                        patch[`instrForCdtrAgt${i+1}Cd`] = tval('Cd', el);
                        patch[`instrForCdtrAgt${i+1}InfTxt`] = tval('InstrInf', el);
                    }
                });

                const instrN = tx.querySelectorAll(':scope > InstrForNxtAgt');
                instrN.forEach((el, i) => {
                    if (i < 6) {
                        patch[`instrForNxtAgt${i+1}Cd`] = tval('Cd', el);
                        patch[`instrForNxtAgt${i+1}InfTxt`] = tval('InstrInf', el);
                    }
                });

                patch.purpCd = tval('Cd', getT('Purp', tx) || tx);

                const rgltry = tx.querySelectorAll(':scope > RgltryRptg');
                rgltry.forEach((el, i) => {
                    if (i < 3) {
                        const dtls = getT('Dtls', el);
                        if (dtls) {
                            patch[`rgltryRptg${i+1}Code`] = tval('Cd', dtls);
                            patch[`rgltryRptg${i+1}Inf`] = tval('Inf', dtls);
                        }
                    }
                });

                const rltdRmt = tx.querySelectorAll(':scope > RltdRmtInf');
                rltdRmt.forEach((el, i) => {
                    if (i < 3) patch[`rltdRmtInf${i+1}Ref`] = tval('Ref', el);
                });

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
                            const cRef = getT('CdtrRefInf', strd);
                            if (cRef) {
                                patch.rmtInfStrdCdtrRefType = tval('Cd', getT('CdOrPrtry', getT('Tp', cRef) || cRef) || cRef);
                                patch.rmtInfStrdCdtrRef = tval('Ref', cRef);
                            }
                            patch.rmtInfStrdAddtlRmtInf = tval('AddtlRmtInf', strd);
                            const rfrd = getT('RfrdDocInf', strd);
                            if (rfrd) {
                                patch.rmtInfStrdRfrdDocNb = tval('Nb', rfrd);
                                patch.rmtInfStrdRfrdDocCd = tval('Cd', getT('CdOrPrtry', getT('Tp', rfrd) || rfrd) || rfrd);
                            }
                        }
                    }
                } else {
                    patch.rmtInfType = 'none';
                }
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

    openBicSearchGroup(controlName: string, group: FormGroup) {
        const dialogRef = this.dialog.open(BicSearchDialogComponent, {
            width: '800px',
            disableClose: true
        });

        dialogRef.afterClosed().subscribe(result => {
             if (result && result.bic) {
                const targetGroup = group || this.form;

                const ctrl = targetGroup.get(controlName);
                                if (ctrl) {
                                  ctrl.setValue(result.bic, { emitEvent: true });
                                  ctrl.markAsTouched();
                                  ctrl.markAsDirty();
                                  ctrl.updateValueAndValidity();
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
