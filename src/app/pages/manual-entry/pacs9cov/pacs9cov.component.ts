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
import { MatDialog } from '@angular/material/dialog';
import { BicSearchDialogComponent } from '../bic-search-dialog/bic-search-dialog.component';
import { debounceTime } from 'rxjs/operators';

@Component({
    selector: 'app-pacs9cov',
    standalone: true,
    imports: [CommonModule, ReactiveFormsModule, FormsModule, MatIconModule, MatSnackBarModule, MatTooltipModule],
    templateUrl: './pacs9cov.component.html',
    styleUrl: './pacs9cov.component.css'
})
export class Pacs9CovComponent implements OnInit, OnDestroy {
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
    sttlmMethods = ['INGA', 'INDA'];

    agentPrefixes = ['instgAgt', 'instdAgt', 'dbtrFi', 'cdtrFi', 'dbtrAgt', 'cdtrAgt',
        'prvsInstgAgt1', 'prvsInstgAgt2', 'prvsInstgAgt3',
        'intrmyAgt1', 'intrmyAgt2', 'intrmyAgt3', 'covDbtrAgt', 'covCdtrAgt'];

    // COV address prefixes for UndrlygCstmrCdtTrf parties
    covPartyPrefixes = ['covDbtr', 'covCdtr', 'covUltmtCdtr'];

    instrForCdtrAgtCodes = ['', 'CHQB', 'HOLD', 'PHOB', 'TELB'];

    private readonly DRAFT_KEY = 'draft_pacs009cov';
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
        // Auto-sync AppHdr Fr/To BICs with InstgAgt/InstdAgt
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
        const name = target.getAttribute('formControlName') || target.getAttribute('formcontrolname') || target.getAttribute('name');
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

    private updateClearingSystemValidation() {
        const allPrefixes = [...this.agentPrefixes, ...this.covPartyPrefixes];
        const systems = allPrefixes.map(p => {
            const val = this.form.get(p + 'ClrSysCd')?.value || this.form.get(p + 'OrgClrSysCd')?.value;
            return val?.trim()?.toUpperCase();
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

    updateConditionalValidators() {
        const ADDR_PATTERN = Validators.pattern(/^[a-zA-Z0-9\/\-\?:\(\)\.,\+' ]+$/);
        const allPrefixes = [...this.agentPrefixes, ...this.covPartyPrefixes];
        allPrefixes.forEach(p => {
            const addrType = this.form.get(p + 'AddrType')?.value;
            const ctryCtrl = this.form.get(p + 'Ctry');
            const twnNmCtrl = this.form.get(p + 'TwnNm');
            const adrLine1 = this.form.get(p + 'AdrLine1')?.value || '';
            const adrLine2 = this.form.get(p + 'AdrLine2')?.value || '';
            const hasAdrLine = !!(adrLine1.trim() || adrLine2.trim());

            if (addrType && addrType !== 'none' && !hasAdrLine) {
                if (!ctryCtrl?.hasValidator(Validators.required)) {
                    ctryCtrl?.setValidators([Validators.required, Validators.pattern(/^[A-Z]{2,2}$/)]);
                    ctryCtrl?.updateValueAndValidity({ emitEvent: false });
                }
                if (!twnNmCtrl?.hasValidator(Validators.required)) {
                    twnNmCtrl?.setValidators([Validators.required, Validators.maxLength(35), ADDR_PATTERN]);
                    twnNmCtrl?.updateValueAndValidity({ emitEvent: false });
                }
            } else {
                ctryCtrl?.clearValidators();
                ctryCtrl?.setValidators([Validators.pattern(/^[A-Z]{2,2}$/)]);
                ctryCtrl?.updateValueAndValidity({ emitEvent: false });

                twnNmCtrl?.clearValidators();
                twnNmCtrl?.setValidators([Validators.maxLength(35), ADDR_PATTERN]);
                twnNmCtrl?.updateValueAndValidity({ emitEvent: false });
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
            svcLvlCd: ['', [Validators.maxLength(4), Validators.pattern(/^[A-Z0-9]{1,4}$/)]],
            svcLvlPrtry: ['', [Validators.maxLength(35), Validators.pattern(/^[A-Za-z0-9 .\-]{1,35}$/)]],
            lclInstrmCd: ['', [Validators.maxLength(35), Validators.pattern(/^[A-Z0-9]{1,4}$/)]],
            lclInstrmPrtry: ['', [Validators.maxLength(35), Validators.pattern(/^[A-Za-z0-9 .\-]{1,35}$/)]],

            rmtInfType: ['none'],
            rmtInfUstrd: ['', [Validators.maxLength(140), Validators.pattern(/^[a-zA-Z0-9\/\-\?:\(\)\.,\+' ]+$/)]],
            rmtInfUstrd2: ['', [Validators.maxLength(140), Validators.pattern(/^[a-zA-Z0-9\/\-\?:\(\)\.,\+' ]+$/)]],
            rmtInfStrdCdtrRefType: [''],
            rmtInfStrdCdtrRef: ['', Validators.maxLength(35)],
            rmtInfStrdAddtlRmtInf: ['', [Validators.maxLength(140), Validators.pattern(/^[0-9a-zA-Z\/\-\?:\(\)\.,\'\+ !#$%&\*=\^_`\{\|\}~";<>@\[\\\]]+$/)]],
            rmtInfStrdRfrdDocNb: ['', Validators.maxLength(35)],
            rmtInfStrdRfrdDocCd: [''],
            rmtInfStrdRfrdDocAmt: ['', [Validators.maxLength(18), Validators.pattern(/^\d{1,18}(\.\d{1,5})?$/)]],
            rmtInfStrdInvcrNm: ['', Validators.maxLength(140)],
            rmtInfStrdInvceeNm: ['', Validators.maxLength(140)],
            rmtInfStrdTaxRmtId: ['', Validators.maxLength(35)],
            rmtInfStrdGrnshmtId: ['', Validators.maxLength(35)],

            fromBic: ['RBOSGB2L', BIC], toBic: ['NDEAFIHH', BIC], bizMsgId: ['pacs9bizmsgidr01', Validators.required],
            msgId: ['pacs9bizmsgidr01', Validators.required], creDtTm: [this.isoNow(), Validators.required],
            sttlmPrty: ['', [Validators.pattern(/^(HIGH|NORM)$/)]],
            nbOfTxs: ['1', [Validators.required, Validators.maxLength(15), Validators.pattern(/^[1-9]\d{0,14}$/)]], sttlmMtd: ['INDA', Validators.required],
            sttlmAcct: ['', [Validators.maxLength(34), Validators.pattern(/^[A-Z0-9]{5,34}$/)]],
            instgAgtBic: ['RBOSGB2L', BIC], instdAgtBic: ['NDEAFIHH', BIC],
            instrId: ['pacs9bizmsgidr01', Validators.required], endToEndId: ['pacs8bizmsgidr01', Validators.required],
            uetr: ['8a562c67-ca16-48ba-b074-65581be6f001', [Validators.required, Validators.pattern(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/)]],
            clrSysRef: ['', [Validators.pattern(/^[A-Za-z0-9]{1,35}$/)]],
            appHdrPriority: [''],
            amount: ['1500000', [Validators.required, Validators.maxLength(18), Validators.pattern(/^\d{1,13}(\.\d{1,5})?$/)]], currency: ['EUR', Validators.required],
            sttlmDt: [new Date().toISOString().split('T')[0], [Validators.required, Validators.pattern(/^\d{4}-\d{2}-\d{2}$/)]],
            // Debtor FI (required)
            dbtrFiBic: ['BBBBUS33XXX', BIC],
            dbtrFiAcct: ['471932901234'],
            // Debtor Agent (mandatory)
            dbtrAgtBic: ['BBBBUS33XXX', BIC],
            dbtrAgtAcct: [''],
            // Creditor Agent (mandatory)
            cdtrAgtBic: ['CCCCGB2LXXX', BIC],
            cdtrAgtAcct: [''],
            // Creditor FI (required)
            cdtrFiBic: ['CCCCGB2LXXX', BIC],
            cdtrFiAcct: ['471932905678'],
            // Optional agents
            prvsInstgAgt1Bic: ['', BIC_OPT], prvsInstgAgt2Bic: ['', BIC_OPT], prvsInstgAgt3Bic: ['', BIC_OPT],
            intrmyAgt1Bic: ['', BIC_OPT], intrmyAgt2Bic: ['', BIC_OPT], intrmyAgt3Bic: ['', BIC_OPT],
            prvsInstgAgt1Acct: [''], prvsInstgAgt2Acct: [''], prvsInstgAgt3Acct: [''],
            intrmyAgt1Acct: [''], intrmyAgt2Acct: [''], intrmyAgt3Acct: [''],

            // COV â€” UndrlygCstmrCdtTrf fields
            covDbtrName: ['Debtor Name', [Validators.required, Validators.maxLength(140), SAFE_NAME]],
            covDbtrAcct: ['471932901234'],
            covDbtrOrgAnyBIC: ['BBBBUS33XXX', BIC],
            covDbtrAgtBic: ['BBBBUS33XXX', BIC],
            covDbtrAgtAcct: [''],
            covCdtrAgtBic: ['CCCCGB2LXXX', BIC],
            covCdtrAgtAcct: [''],
            covCdtrName: ['Creditor Name', [Validators.required, Validators.maxLength(140), SAFE_NAME]],
            covCdtrOrgAnyBIC: ['CCCCGB2LXXX', BIC],
            covCdtrAcct: ['471932905678'],
            covPurpCd: ['', [Validators.pattern(/^[A-Z]{4,4}$/), (control: any) => {
                if (!control.value) return null;
                return this.purposes.includes(control.value.toUpperCase()) ? null : { invalidPurpose: true };
            }]],

            // InstrForCdtrAgt (COV) (0..2)
            covInstrForCdtrAgt1Cd: [''], covInstrForCdtrAgt1InfTxt: ['', [Validators.minLength(1), Validators.maxLength(140), ADDR_PATTERN]],
            covInstrForCdtrAgt2Cd: [''], covInstrForCdtrAgt2InfTxt: ['', [Validators.minLength(1), Validators.maxLength(140), ADDR_PATTERN]],
            // InstrForNxtAgt (COV) (0..6)
            covInstrForNxtAgt1Cd: [''], covInstrForNxtAgt1InfTxt: ['', [Validators.minLength(1), Validators.maxLength(35), ADDR_PATTERN]],
            covInstrForNxtAgt2Cd: [''], covInstrForNxtAgt2InfTxt: ['', [Validators.minLength(1), Validators.maxLength(35), ADDR_PATTERN]],
            covInstrForNxtAgt3Cd: [''], covInstrForNxtAgt3InfTxt: ['', [Validators.minLength(1), Validators.maxLength(35), ADDR_PATTERN]],
            covInstrForNxtAgt4Cd: [''], covInstrForNxtAgt4InfTxt: ['', [Validators.minLength(1), Validators.maxLength(35), ADDR_PATTERN]],
            covInstrForNxtAgt5Cd: [''], covInstrForNxtAgt5InfTxt: ['', [Validators.minLength(1), Validators.maxLength(35), ADDR_PATTERN]],
            covInstrForNxtAgt6Cd: [''], covInstrForNxtAgt6InfTxt: ['', [Validators.minLength(1), Validators.maxLength(35), ADDR_PATTERN]],

            // RmtInf (Ustrd)
            covRmtInfUstrd: [''],
            covRmtInfUstrd2: [''],
            // Tax
            covTaxRef: [''],
            covTaxAmt: [''],
            covTaxCcy: ['EUR'],
            // InstdAmt
            covInstdAmtCcy: ['EUR'],
            covInstdAmt: [''],
        };
        // Address prefixes for main agents
        // Only the mandatory parties that ship with full address data default to 'hybrid'.
        // Optional agents (previous/intermediary) default to 'none' so users don't get
        // spurious "Town/Country required" errors on unused agents.
        this.agentPrefixes.forEach(p => {
            if (!c[p + 'AddrType']) {
                c[p + 'AddrType'] = ['dbtrFi', 'cdtrFi', 'dbtrAgt', 'cdtrAgt', 'covDbtrAgt', 'covCdtrAgt'].includes(p) ? 'hybrid' : 'none';
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
            // BICFIDec2014Identifier — schema allows alphanumeric in the 4-char institution code
            if (!c[p + 'Bic']) c[p + 'Bic'] = ['', [Validators.maxLength(11), Validators.pattern(/^[A-Z0-9]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$/)]];
            if (!c[p + 'Lei']) c[p + 'Lei'] = ['', [Validators.maxLength(20), Validators.pattern(/^[A-Z0-9]{18}[0-9]{2}$/)]];
            if (!c[p + 'ClrSysCd']) c[p + 'ClrSysCd'] = ['', Validators.maxLength(5)];
            // CBPR_RestrictedFINXMax28Text — MmbId capped at 28 + FIN-X charset
            if (!c[p + 'ClrSysMmbId']) c[p + 'ClrSysMmbId'] = ['', [Validators.maxLength(28), ADDR_PATTERN]];
            if (!c[p + 'Acct']) c[p + 'Acct'] = ['', [Validators.maxLength(34), Validators.pattern(/^[A-Z0-9]{5,34}$/)]];
            if (['intrmyAgt1', 'intrmyAgt2', 'intrmyAgt3'].includes(p)) {
                if (!c[p + 'AcctType']) c[p + 'AcctType'] = ['iban'];
            }
        });
        // Address prefixes for COV parties (Debtor / Creditor in UndrlygCstmrCdtTrf)
        // covDbtr and covCdtr are mandatory and ship with full address data â€” they default to 'hybrid'.
        this.covPartyPrefixes.forEach(p => {
            if (!c[p + 'AddrType']) {
                c[p + 'AddrType'] = ['covDbtr', 'covCdtr'].includes(p) ? 'hybrid' : 'none';
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

            if (p === 'covUltmtDbtr' || p === 'covUltmtCdtr') {
                if (!c[p + 'IdType']) c[p + 'IdType'] = 'none';
                if (!c[p + 'OrgAnyBIC']) c[p + 'OrgAnyBIC'] = ['', [Validators.pattern(/^[A-Z0-9]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$/)]];
                if (!c[p + 'OrgLEI']) c[p + 'OrgLEI'] = ['', [Validators.pattern(/^[A-Z0-9]{18}[0-9]{2}$/)]];
                // CBPR_RestrictedFINXMax35Text — FIN-X character set
                if (!c[p + 'OrgOthrId']) c[p + 'OrgOthrId'] = ['', [Validators.maxLength(35), ADDR_PATTERN]];
                if (!c[p + 'OrgOthrSchmeNmCd']) c[p + 'OrgOthrSchmeNmCd'] = ['', Validators.maxLength(4)];
                if (!c[p + 'OrgOthrSchmeNmPrtry']) c[p + 'OrgOthrSchmeNmPrtry'] = ['', Validators.maxLength(35)];
                if (!c[p + 'OrgOthrIssr']) c[p + 'OrgOthrIssr'] = ['', Validators.maxLength(35)];
                // ISODate — schema requires a valid YYYY-MM-DD calendar date
                if (!c[p + 'PrvtDtAndPlcOfBirthDt']) c[p + 'PrvtDtAndPlcOfBirthDt'] = ['', [Validators.pattern(/^\d{4}-\d{2}-\d{2}$/)]];
                if (!c[p + 'PrvtDtAndPlcOfBirthPrvc']) c[p + 'PrvtDtAndPlcOfBirthPrvc'] = ['', Validators.maxLength(35)];
                if (!c[p + 'PrvtDtAndPlcOfBirthCity']) c[p + 'PrvtDtAndPlcOfBirthCity'] = ['', Validators.maxLength(35)];
                if (!c[p + 'PrvtDtAndPlcOfBirthCtry']) c[p + 'PrvtDtAndPlcOfBirthCtry'] = ['', Validators.pattern(/^[A-Z]{2,2}$/)];
                if (!c[p + 'PrvtOthrId']) c[p + 'PrvtOthrId'] = ['', [Validators.maxLength(35), ADDR_PATTERN]];
                if (!c[p + 'PrvtOthrSchmeNmCd']) c[p + 'PrvtOthrSchmeNmCd'] = ['', Validators.maxLength(4)];
                if (!c[p + 'PrvtOthrSchmeNmPrtry']) c[p + 'PrvtOthrSchmeNmPrtry'] = ['', Validators.maxLength(35)];
                if (!c[p + 'PrvtOthrIssr']) c[p + 'PrvtOthrIssr'] = ['', Validators.maxLength(35)];
            } else {
                if (!c[p + 'Bic']) c[p + 'Bic'] = ['', [Validators.maxLength(11), Validators.pattern(/^[A-Z0-9]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$/)]];
                if (!c[p + 'Lei']) c[p + 'Lei'] = ['', [Validators.maxLength(20), Validators.pattern(/^[A-Z0-9]{18}[0-9]{2}$/)]];
                if (!c[p + 'ClrSysCd']) c[p + 'ClrSysCd'] = ['', Validators.maxLength(5)];
                if (!c[p + 'ClrSysMmbId']) c[p + 'ClrSysMmbId'] = ['', [Validators.maxLength(28), ADDR_PATTERN]];
                if (!c[p + 'Acct']) c[p + 'Acct'] = ['', [Validators.maxLength(34), Validators.pattern(/^[A-Z0-9]{5,34}$/)]];
            }
        });
        // Set default names and address data for mandatory parties to comply with CBPR+ coexistence rules
        const mandatoryParties = ['dbtrFi', 'cdtrFi', 'dbtrAgt', 'cdtrAgt', 'covDbtrAgt', 'covCdtrAgt', 'covDbtr', 'covCdtr'];
        mandatoryParties.forEach(p => {
            let label = '';
            if (p === 'dbtrFi') label = 'Debtor';
            else if (p === 'cdtrFi') label = 'Creditor';
            else if (p === 'dbtrAgt') label = 'Debtor Agent';
            else if (p === 'cdtrAgt') label = 'Creditor Agent';
            else if (p === 'covDbtrAgt') label = 'COV Debtor Agent';
            else if (p === 'covCdtrAgt') label = 'COV Creditor Agent';
            else if (p === 'covDbtr') label = 'Debtor Name';
            else if (p === 'covCdtr') label = 'Creditor Name';

            const isDbtr = p.toLowerCase().includes('dbtr');
            c[p + 'Name'] = [label, [Validators.required, Validators.maxLength(140), SAFE_NAME]];
            c[p + 'AddrType'] = ['hybrid'];
            c[p + 'AdrLine1'] = [isDbtr ? '123 Business Street' : '456 Commerce Avenue', [Validators.maxLength(70), ADDR_PATTERN]];
            c[p + 'AdrLine2'] = [isDbtr ? 'Suite 100' : 'Floor 12', [Validators.maxLength(70), ADDR_PATTERN]];
            c[p + 'TwnNm'] = [isDbtr ? 'New York' : 'London', [Validators.maxLength(35), ADDR_PATTERN]];
            c[p + 'Ctry'] = [isDbtr ? 'US' : 'GB', Validators.pattern(/^[A-Z]{2,2}$/)];
        });

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
            if (f === 'ctgyPurpCd') return 'Invalid Category Purpose Code. Please select from the list or enter a valid ISO 20022 Purpose Code.';
            if (f === 'nbOfTxs') return 'Must be 1-15 digits.';
            if (f === 'bizMsgId' || f === 'msgId' || f === 'instrId' || f === 'endToEndId' || f === 'txId' || f === 'clrSysRef') return 'Invalid Pattern (Alphanumeric only, max 35 chars).';
            if (f.toLowerCase().includes('name') || f.toLowerCase().includes('nm')) return "Invalid characters. Only letters, numbers, spaces and . , ( ) ' - are allowed (no &, @, !, etc.)";
            if (f.toLowerCase().includes('ustrd') || f.toLowerCase().includes('adtlrmtinf')) return "Invalid character in remittance field. Only ISO 20022 MX allowed chars permitted.";
            if (f === 'instrPrty') return 'Invalid Priority. Must be HIGH or NORM.';
            if (f === 'sttlmPrty') return 'Invalid Settlement Priority. Must be HIGH or NORM.';
            if (f === 'clrChanl') return 'Invalid Clearing Channel. Must be BOOK, MPNS, RTGS, or RTNS.';
            if (f === 'svcLvlCd') return 'Invalid Service Level Code. Must be 1-4 alphanumeric characters.';
            if (f === 'svcLvlPrtry') return 'Invalid Proprietary Service Level. Up to 35 characters allowed.';
            if (f === 'lclInstrmCd') return 'Invalid Local Instrument Code. Must be 1-4 alphanumeric characters.';
            if (f === 'lclInstrmPrtry') return 'Invalid Proprietary Local Instrument. Up to 35 characters allowed.';
            if (f === 'ctgyPurpPrtry') return 'Invalid Proprietary Category Purpose. Up to 35 characters allowed.';
            if (f.toLowerCase().includes('bldgnb') || f.toLowerCase().includes('pstcd') || f.toLowerCase().includes('pstbx') || f.toLowerCase().includes('bldgnm') || f.toLowerCase().includes('twnnm') || f.toLowerCase().includes('twnlctn') || f.toLowerCase().includes('dstrctnm') || f.toLowerCase().includes('ctrysubdvsn') || f.toLowerCase().includes('strtnm') || f.toLowerCase().includes('dept') || f.toLowerCase().includes('subdept') || f.toLowerCase().includes('flr') || f.toLowerCase().includes('room') || f.toLowerCase().includes('adrline')) {
                return 'Invalid character. Only ISO 20022 MX allowed characters permitted.';
            }
            if (f === 'covPurpCd') return 'Invalid Purpose Code. Please select from the list or enter a valid ISO 20022 Purpose Code.';
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
    warningTimeouts: { [key: string]: any } = {};
    showMaxLenWarning: { [key: string]: boolean } = {};

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
                const controlName = target.getAttribute('formControlName') || target.getAttribute('formcontrolname') || target.getAttribute('name');
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

        // Stop generation if TARGET2 rule is violated
        if (this.form.get('currency')?.hasError('target2')) {
            this.generatedXml = '<!-- TARGET2 VALIDATION ERROR: TARGET2 payments must use EUR as the settlement currency. -->';
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
        if (this.form.get('fed')?.hasError('fed') || this.form.get('currency')?.hasError('fed')) {
            this.generatedXml = '<!-- FED VALIDATION ERROR: FED allows only USD currency. -->';
            this.formatXml(false);
            this.onEditorChange(this.generatedXml, true);
            return;
        }

        // Pre-generation check: If Postal Address is present but Address Line is absent, Town Name and Country are required
        const allPrefixes = [...this.agentPrefixes, ...this.covPartyPrefixes];
        for (const p of allPrefixes) {
            const addrType = this.form.get(p + 'AddrType')?.value;
            if (addrType && addrType !== 'none') {
                const adrLine1 = this.form.get(p + 'AdrLine1')?.value || '';
                const adrLine2 = this.form.get(p + 'AdrLine2')?.value || '';
                const hasAdrLine = !!(adrLine1.trim() || adrLine2.trim());

                const twnNm = this.form.get(p + 'TwnNm')?.value || '';
                const ctry = this.form.get(p + 'Ctry')?.value || '';
                const hasTwnNmAndCtry = !!(twnNm.trim() && ctry.trim());

                if (!hasAdrLine && !hasTwnNmAndCtry) {
                    this.generatedXml = `<!-- VALIDATION ERROR: Party/Agent '${p}' has an invalid Postal Address. If Address Line is absent, then Town Name and Country must be present. -->`;
                    this.onEditorChange(this.generatedXml, true);
                    return;
                }
            }
        }

        const v = this.form.value;
        let creDtTm = this.fdt(v.creDtTm || this.isoNow());

        // CdtTrfTxInf â€” pacs.009.001.08 COV element order
        let tx = '';
        let pmtIdXml = this.el('InstrId', v.instrId) + this.el('EndToEndId', v.endToEndId) + this.el('UETR', v.uetr);
        if (v.clrSysRef?.trim()) pmtIdXml += this.el('ClrSysRef', v.clrSysRef);
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
        const formattedAmt = this.formatting.formatAmount(v.amount, v.currency);
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
        // Cdtr (FI)
        tx += this.agtWithAcct('Cdtr', 'cdtrFi', v, 4);


        // UndrlygCstmrCdtTrf (COV)
        tx += this.buildCov(v);



        const frBic = v.fromBic;
        const toBic = v.toBic;

        this.generatedXml = `<?xml version="1.0" encoding="UTF-8"?>
<BusMsgEnvlp xmlns="urn:swift:xsd:envelope">
	<AppHdr xmlns="urn:iso:std:iso:20022:tech:xsd:head.001.001.02">
		<Fr>
			<FIId>
				<FinInstnId>
					<BICFI>${this.e(frBic)}</BICFI>
				</FinInstnId>
			</FIId>
		</Fr>
		<To>
			<FIId>
				<FinInstnId>
					<BICFI>${this.e(toBic)}</BICFI>
				</FinInstnId>
			</FIId>
		</To>
		<BizMsgIdr>${this.e(v.bizMsgId)}</BizMsgIdr>
		<MsgDefIdr>pacs.009.001.08</MsgDefIdr>
		<BizSvc>swift.cbprplus.cov.04</BizSvc>
		<CreDt>${creDtTm}</CreDt>${v.appHdrPriority?.trim() ? `\n\t\t<Prty>${v.appHdrPriority}</Prty>` : ''}
	</AppHdr>
	<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pacs.009.001.08">
		<FICdtTrf>
			<GrpHdr>
				<MsgId>${this.e(v.msgId)}</MsgId>
				<CreDtTm>${creDtTm}</CreDtTm>
				<NbOfTxs>${v.nbOfTxs}</NbOfTxs>
				<SttlmInf>
					<SttlmMtd>${this.e(v.sttlmMtd)}</SttlmMtd>${v.sttlmAcct?.trim() ? `\n\t\t\t\t\t<SttlmAcct>\n\t\t\t\t\t\t<Id>\n\t\t\t\t\t\t\t<IBAN>${this.e(v.sttlmAcct)}</IBAN>\n\t\t\t\t\t\t</Id>\n\t\t\t\t\t</SttlmAcct>` : ''}
				</SttlmInf>
			</GrpHdr>
			<CdtTrfTxInf>
${tx}\t\t\t</CdtTrfTxInf>
		</FICdtTrf>
	</Document>
</BusMsgEnvlp>`;
        this.formatXml(false);
            this.onEditorChange(this.generatedXml, true);
    }

    // Prefix all XML element tags with pacs: namespace (Deprecated - using default namespaces now)
    private prefixLines(xml: string, ns: string): string {
        return xml.replace(/<(\/?)([\w]+)([ >])/g, `<$1${ns}$2$3`);
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
    private el(tag: string, val: any, indent: number = 4): string {
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

        // Filter: Nm and PstlAdr are NOT allowed for InstgAgt and InstdAgt as per MyStandards requirements
        if (tag !== 'InstgAgt' && tag !== 'InstdAgt') {
            if (name) content += `${t}<Nm>${this.e(name)}</Nm>\n`;
            content += this.addrXml(v, prefix, indent + 2, tag.startsWith('PrvsInstgAgt'));
        }

        if (!content.trim()) return '';
        return `${this.tabs(indent)}<${tag}>\n${this.tabs(indent + 1)}<FinInstnId>\n${content}${this.tabs(indent + 1)}</FinInstnId>\n${this.tabs(indent)}</${tag}>\n`;
    }

    partyAgentXml(tag: string, prefix: string, v: any, indent = 4) {
        const bic = v[prefix + 'Bic'] || v[prefix + 'OrgAnyBIC'];
        const name = v[prefix + 'Name'];
        const lei = v[prefix + 'Lei'] || v[prefix + 'OrgLEI'];
        const clrCd = v[prefix + 'ClrSysCd'] || v[prefix + 'OrgClrSysCd'];
        const clrMmb = v[prefix + 'ClrSysMmbId'] || v[prefix + 'OrgClrSysMmbId'];

        let content = '';
        if (name) content += `${this.tabs(indent + 1)}<Nm>${this.e(name)}</Nm>\n`;
        content += this.addrXml(v, prefix, indent + 1);

        content += this.partyIdXml(v, prefix, indent + 1);

        if (!content.trim()) return '';
        return `${this.tabs(indent)}<${tag}>\n${content}${this.tabs(indent)}</${tag}>\n`;
    }
    addrXml(v: any, p: string, indent = 4, isPrvs = false): string {
        const type = v[p + 'AddrType']; if (!type || type === 'none') return '';
        const lines: string[] = []; const t = this.tabs(indent + 1);
        
        if (!isPrvs) {
            if (v[p + 'AdrTpCd']) lines.push(`${t}<AdrTp>\n${t}\t<Cd>${this.e(v[p + 'AdrTpCd'])}</Cd>\n${t}</AdrTp>`);
            else if (v[p + 'AdrTpPrtry']) lines.push(`${t}<AdrTp>\n${t}\t<Prtry>${this.e(v[p + 'AdrTpPrtry'])}</Prtry>\n${t}</AdrTp>`);
        }

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

        if (v[p + 'TwnNm']) lines.push(`${t}<TwnNm>${this.e(v[p + 'TwnNm'])}</TwnNm>`);
        if (v[p + 'TwnLctnNm']) lines.push(`${t}<TwnLctnNm>${this.e(v[p + 'TwnLctnNm'])}</TwnLctnNm>`);
        if (v[p + 'DstrctNm']) lines.push(`${t}<DstrctNm>${this.e(v[p + 'DstrctNm'])}</DstrctNm>`);
        if (v[p + 'CtrySubDvsn']) lines.push(`${t}<CtrySubDvsn>${this.e(v[p + 'CtrySubDvsn'])}</CtrySubDvsn>`);
        if (v[p + 'Ctry']) lines.push(`${t}<Ctry>${this.e(v[p + 'Ctry'])}</Ctry>`);

        if (['unstructured', 'hybrid'].includes(type)) {
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
            if (v[p + 'OrgAnyBIC']) org += `${t}\t<AnyBIC>${this.e(v[p + 'OrgAnyBIC'])}</AnyBIC>\n`;
            if (v[p + 'OrgLEI']) org += `${t}\t<LEI>${this.e(v[p + 'OrgLEI'])}</LEI>\n`;
            if (v[p + 'OrgOthrId']) {
                org += `${t}\t<Othr>\n${t}\t\t<Id>${this.e(v[p + 'OrgOthrId'])}</Id>\n`;
                if (v[p + 'OrgOthrSchmeNmCd'] || v[p + 'OrgOthrSchmeNmPrtry']) {
                    org += `${t}\t\t<SchmeNm>\n`;
                    if (v[p + 'OrgOthrSchmeNmCd']) org += `${t}\t\t\t<Cd>${this.e(v[p + 'OrgOthrSchmeNmCd'])}</Cd>\n`;
                    else org += `${t}\t\t\t<Prtry>${this.e(v[p + 'OrgOthrSchmeNmPrtry'])}</Prtry>\n`;
                    org += `${t}\t\t</SchmeNm>\n`;
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
                if (v[p + 'PrvtDtAndPlcOfBirthPrvc']) prvt += `${t}\t\t<PrvcOfBirth>${this.e(v[p + 'PrvtDtAndPlcOfBirthPrvc'])}</PrvcOfBirth>\n`;
                if (v[p + 'PrvtDtAndPlcOfBirthCity']) prvt += `${t}\t\t<CityOfBirth>${this.e(v[p + 'PrvtDtAndPlcOfBirthCity'])}</CityOfBirth>\n`;
                if (v[p + 'PrvtDtAndPlcOfBirthCtry']) prvt += `${t}\t\t<CtryOfBirth>${this.e(v[p + 'PrvtDtAndPlcOfBirthCtry'])}</CtryOfBirth>\n`;
                prvt += `${t}\t</DtAndPlcOfBirth>\n`;
            }
            if (v[p + 'PrvtOthrId']) {
                prvt += `${t}\t<Othr>\n${t}\t\t<Id>${this.e(v[p + 'PrvtOthrId'])}</Id>\n`;
                if (v[p + 'PrvtOthrSchmeNmCd'] || v[p + 'PrvtOthrSchmeNmPrtry']) {
                    prvt += `${t}\t\t<SchmeNm>\n`;
                    if (v[p + 'PrvtOthrSchmeNmCd']) prvt += `${t}\t\t\t<Cd>${this.e(v[p + 'PrvtOthrSchmeNmCd'])}</Cd>\n`;
                    else prvt += `${t}\t\t\t<Prtry>${this.e(v[p + 'PrvtOthrSchmeNmPrtry'])}</Prtry>\n`;
                    prvt += `${t}\t\t</SchmeNm>\n`;
                }
                if (v[p + 'PrvtOthrIssr']) prvt += `${t}\t\t<Issr>${this.e(v[p + 'PrvtOthrIssr'])}</Issr>\n`;
                prvt += `${t}\t</Othr>\n`;
            }
            return `${this.tabs(indent)}<Id>\n${t}<PrvtId>\n${prvt}${t}</PrvtId>\n${this.tabs(indent)}</Id>\n`;
        }
        return '';
    }

    // COV: UndrlygCstmrCdtTrf (CreditTransferTransaction62)
    // XSD element order: InitgPty?, Dbtr, DbtrAcct?, DbtrAgt, DbtrAgtAcct?,
    //   PrvsInstgAgt1..3?, IntrmyAgt1..3?, CdtrAgt, CdtrAgtAcct?, Cdtr, CdtrAcct?,
    //   UltmtCdtr?, InstrForCdtrAgt*, InstrForNxtAgt*, Purp?, RmtInf?, InstdAmt?
    private buildCov(v: any): string {
        let b = `\t\t\t<UndrlygCstmrCdtTrf>\n`;

        const formatAcct = (val: string, tabs: number) => {
            if (!val) return '';
            const ibanCountries = ['AD', 'AE', 'AL', 'AT', 'AZ', 'BA', 'BE', 'BG', 'BH', 'BR', 'BY', 'CH', 'CR', 'CY', 'CZ', 'DE', 'DK', 'DO', 'EE', 'EG', 'ES', 'FI', 'FO', 'FR', 'GB', 'GE', 'GI', 'GL', 'GR', 'GT', 'HR', 'HU', 'IE', 'IL', 'IQ', 'IS', 'IT', 'JO', 'KW', 'KZ', 'LB', 'LI', 'LT', 'LU', 'LV', 'MC', 'MD', 'ME', 'MK', 'MR', 'MT', 'MU', 'NL', 'NO', 'PK', 'PL', 'PS', 'PT', 'QA', 'RO', 'RS', 'RU', 'SA', 'SC', 'SE', 'SI', 'SK', 'SM', 'ST', 'SV', 'TL', 'TN', 'TR', 'UA', 'VA', 'VG', 'XK'];
            if (val.length >= 14 && ibanCountries.includes(val.substring(0, 2).toUpperCase()) && /^[A-Z]{2}[0-9]{2}[A-Z0-9]+$/i.test(val)) {
                return this.el('IBAN', val, tabs + 1);
            } else {
                return `\n${'\t'.repeat(tabs + 1)}<Othr>\n${'\t'.repeat(tabs + 2)}<Id>${this.e(val)}</Id>\n${'\t'.repeat(tabs + 1)}</Othr>\n${'\t'.repeat(tabs)}`;
            }
        };

        // Dbtr (PartyIdentification272)
        if (v.covDbtrName?.trim() || v.covDbtrBic?.trim() || v.covDbtrLei?.trim() || v.covDbtrClrSysMmbId?.trim() || (v.covDbtrAddrType && v.covDbtrAddrType !== 'none')) {
            b += this.partyAgentXml('Dbtr', 'covDbtr', v, 4);
        }
        // DbtrAcct
        if (v.covDbtrAcct?.trim()) {
            b += `\t\t\t\t<DbtrAcct>\n\t\t\t\t\t<Id>${formatAcct(v.covDbtrAcct, 5)}\t\t\t\t\t</Id>\n\t\t\t\t</DbtrAcct>\n`;
        }
        // DbtrAgt (uses agt() so address fields like covDbtrAgtAddrType are included)
        b += this.agt('DbtrAgt', 'covDbtrAgt', v, 4);
        // DbtrAgtAcct
        if (v.covDbtrAgtAcct?.trim()) {
            b += `\t\t\t\t<DbtrAgtAcct>\n\t\t\t\t\t<Id>${formatAcct(v.covDbtrAgtAcct, 5)}\t\t\t\t\t</Id>\n\t\t\t\t</DbtrAgtAcct>\n`;
        }
        // CdtrAgt (uses agt() so address fields like covCdtrAgtAddrType are included)
        b += this.agt('CdtrAgt', 'covCdtrAgt', v, 4);
        // CdtrAgtAcct
        if (v.covCdtrAgtAcct?.trim()) {
            b += `\t\t\t\t<CdtrAgtAcct>\n\t\t\t\t\t<Id>${formatAcct(v.covCdtrAgtAcct, 5)}\t\t\t\t\t</Id>\n\t\t\t\t</CdtrAgtAcct>\n`;
        }
        // Cdtr (PartyIdentification272)
        if (v.covCdtrName?.trim() || v.covCdtrBic?.trim() || v.covCdtrLei?.trim() || v.covCdtrClrSysMmbId?.trim() || (v.covCdtrAddrType && v.covCdtrAddrType !== 'none')) {
            b += this.partyAgentXml('Cdtr', 'covCdtr', v, 4);
        }
        // CdtrAcct
        if (v.covCdtrAcct?.trim()) {
            b += `\t\t\t\t<CdtrAcct>\n\t\t\t\t\t<Id>${formatAcct(v.covCdtrAcct, 5)}\t\t\t\t\t</Id>\n\t\t\t\t</CdtrAcct>\n`;
        }
        // UltmtCdtr (COV Ultimate Creditor - optional party)
        if (v.covUltmtCdtrName?.trim() || v.covUltmtCdtrOrgAnyBIC?.trim() || v.covUltmtCdtrOrgLEI?.trim() || (v.covUltmtCdtrAddrType && v.covUltmtCdtrAddrType !== 'none')) {
            b += this.partyAgentXml('UltmtCdtr', 'covUltmtCdtr', v, 4);
        }
        // InstrForCdtrAgt (optional, max 2)
        for (let i = 1; i <= 2; i++) {
            const cd = v[`covInstrForCdtrAgt${i}Cd`]?.trim();
            const txt = v[`covInstrForCdtrAgt${i}InfTxt`]?.trim();
            if (cd || txt) {
                let inner = '';
                if (cd) inner += this.el('Cd', cd, 5);
                if (txt) inner += this.el('InstrInf', txt, 5);
                b += `\t\t\t\t<InstrForCdtrAgt>\n${inner}\t\t\t\t</InstrForCdtrAgt>\n`;
            }
        }

        // InstrForNxtAgt (optional, max 6)
        for (let i = 1; i <= 6; i++) {
            const cd = v[`covInstrForNxtAgt${i}Cd`]?.trim();
            const txt = v[`covInstrForNxtAgt${i}InfTxt`]?.trim();
            if (cd || txt) {
                let inner = '';
                if (cd) inner += this.el('Cd', cd, 6);
                if (txt) inner += this.el('InstrInf', txt, 6);
                b += `\t\t\t\t<InstrForNxtAgt>\n${inner}\t\t\t\t</InstrForNxtAgt>\n`;
            }
        }
        // RmtInf (optional â€” inside UndrlygCstmrCdtTrf)
        if (v.rmtInfType === 'ustrd') {
            let ustrdContent = '';
            if (v.rmtInfUstrd?.trim()) {
                ustrdContent += `\t\t\t\t\t<Ustrd>${this.e(v.rmtInfUstrd)}</Ustrd>\n`;
            }
            if (ustrdContent) {
                b += `\t\t\t\t<RmtInf>\n${ustrdContent}\t\t\t\t</RmtInf>\n`;
            }
        } else if (v.rmtInfType === 'strd') {
            let cdtrRef = '';
            if (v.rmtInfStrdCdtrRefType && v.rmtInfStrdCdtrRef) {
                cdtrRef = `\n\t\t\t\t\t\t<CdtrRefInf>\n\t\t\t\t\t\t\t<Tp>\n\t\t\t\t\t\t\t\t<CdOrPrtry>\n\t\t\t\t\t\t\t\t\t<Cd>${this.e(v.rmtInfStrdCdtrRefType)}</Cd>\n\t\t\t\t\t\t\t\t</CdOrPrtry>\n\t\t\t\t\t\t\t</Tp>\n\t\t\t\t\t\t\t<Ref>${this.e(v.rmtInfStrdCdtrRef)}</Ref>\n\t\t\t\t\t\t</CdtrRefInf>`;
            }
            let addtl = v.rmtInfStrdAddtlRmtInf ? `\n\t\t\t\t\t\t<AddtlRmtInf>${this.e(v.rmtInfStrdAddtlRmtInf)}</AddtlRmtInf>` : '';
            let rfrdDoc = '';
            if (v.rmtInfStrdRfrdDocNb?.trim() || v.rmtInfStrdRfrdDocCd?.trim()) {
                rfrdDoc = `\n\t\t\t\t\t\t<RfrdDocInf>\n`;
                if (v.rmtInfStrdRfrdDocNb?.trim()) rfrdDoc += `\t\t\t\t\t\t\t<Nb>${this.e(v.rmtInfStrdRfrdDocNb)}</Nb>\n`;
                if (v.rmtInfStrdRfrdDocCd?.trim()) {
                    rfrdDoc += `\t\t\t\t\t\t\t<Tp>\n\t\t\t\t\t\t\t\t<CdOrPrtry>\n\t\t\t\t\t\t\t\t\t<Cd>${this.e(v.rmtInfStrdRfrdDocCd)}</Cd>\n\t\t\t\t\t\t\t\t</CdOrPrtry>\n\t\t\t\t\t\t\t</Tp>\n`;
                }
                rfrdDoc += `\t\t\t\t\t\t</RfrdDocInf>`;
            }
            let rfrdAmt = '';
            if (v.rmtInfStrdRfrdDocAmt) {
                rfrdAmt = `\n\t\t\t\t\t\t<RfrdDocAmt>\n\t\t\t\t\t\t\t<RmtAmt>\n\t\t\t\t\t\t\t\t<DuePyblAmt Ccy="${this.e(v.currency)}">${this.formatting.formatAmount(v.rmtInfStrdRfrdDocAmt, v.currency)}</DuePyblAmt>\n\t\t\t\t\t\t\t</RmtAmt>\n\t\t\t\t\t\t</RfrdDocAmt>`;
            }
            if (cdtrRef || addtl || rfrdDoc || rfrdAmt) {
                b += `\t\t\t\t<RmtInf>\n\t\t\t\t\t<Strd>${cdtrRef}${addtl}${rfrdDoc}${rfrdAmt}\n\t\t\t\t\t</Strd>\n\t\t\t\t</RmtInf>\n`;
            }
        }

        // InstdAmt (optional)
        if (v.covInstdAmt?.trim() && v.covInstdAmtCcy?.trim()) {
            b += `\t\t\t\t<InstdAmt Ccy="${this.e(v.covInstdAmtCcy)}">${this.formatting.formatAmount(v.covInstdAmt, v.covInstdAmtCcy)}</InstdAmt>\n`;
        }
        b += `\t\t\t</UndrlygCstmrCdtTrf>\n`;
        return b;
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
            message_type: 'Auto-detect',
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



    downloadXml() { this.generateXml(); const b = new Blob([this.generatedXml], { type: 'application/xml' }); const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = `pacs009cov-${Date.now()}.xml`; a.click(); URL.revokeObjectURL(a.href); }
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
            // Only patch fields the parser explicitly reads — previously this wiped
            // every control to '' on each XML edit, silently dropping user data.

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
                const sttlmInf = getT('SttlmInf', grpHdr);
                if (sttlmInf) {
                    patch.sttlmMtd = tval('SttlmMtd', sttlmInf);
                    const sttlmAcct = getT('SttlmAcct', sttlmInf);
                    if (sttlmAcct) {
                        patch.sttlmAcct = tval('IBAN', getT('Id', sttlmAcct) || sttlmAcct);
                    }
                }
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
                        if (['intrmyAgt1', 'intrmyAgt2', 'intrmyAgt3'].includes(p)) {
                            const isIban = acct.querySelector('IBAN') || getT('IBAN', acct);
                            patch[p + 'AcctType'] = isIban ? 'iban' : 'other';
                        }
                    }
                };

                const mapParty = (p: string, tag: string, parent: any = tx) => {
                    const el = getT(tag, parent);
                    if (!el) return;
                    patch[p + 'Name'] = tval('Nm', el);
                    const pstl = getT('PstlAdr', el);
                    if (pstl) {
                        patch[p + 'AddrType'] = 'unstructured'; // Default
                        const lines = pstl.querySelectorAll(':scope > AdrLine');
                        if (lines.length > 0) {
                            patch[p + 'AdrLine1'] = lines[0].textContent || '';
                            if (lines.length > 1) patch[p + 'AdrLine2'] = lines[1].textContent || '';
                            patch[p + 'AddrType'] = 'unstructured';
                        } else {
                            patch[p + 'Ctry'] = tval('Ctry', pstl);
                            patch[p + 'TwnNm'] = tval('TwnNm', pstl);
                            patch[p + 'StrtNm'] = tval('StrtNm', pstl);
                            patch[p + 'BldgNb'] = tval('BldgNb', pstl);
                            patch[p + 'PstCd'] = tval('PstCd', pstl);
                            patch[p + 'AddrType'] = 'structured';
                        }
                    }
                    const acct = getT(tag + 'Acct', parent);
                    if (acct) {
                        patch[p + 'Acct'] = tval('IBAN', getT('Id', acct) || acct) || tval('Id', getT('Othr', getT('Id', acct) || acct) || acct);
                    }
                    const id = getT('Id', el);
                    if (id) {
                        const org = getT('OrgId', id);
                        if (org) patch[p + 'OrgAnyBIC'] = tval('AnyBIC', org);
                    }
                };

                mapAgt('instgAgt', 'InstgAgt');
                mapAgt('instdAgt', 'InstdAgt');
                mapAgt('dbtrFi', 'Dbtr');
                mapAgt('dbtrAgt', 'DbtrAgt');
                mapAgt('cdtrAgt', 'CdtrAgt');
                mapAgt('cdtrFi', 'Cdtr');

                // Optional agents
                mapAgt('prvsInstgAgt1', 'PrvsInstgAgt1');
                mapAgt('prvsInstgAgt2', 'PrvsInstgAgt2');
                mapAgt('prvsInstgAgt3', 'PrvsInstgAgt3');
                mapAgt('intrmyAgt1', 'IntrmyAgt1');
                mapAgt('intrmyAgt2', 'IntrmyAgt2');
                mapAgt('intrmyAgt3', 'IntrmyAgt3');

                const coreRmts = tx.querySelectorAll(':scope > RmtInf');
                if (coreRmts.length > 0) {
                    const ustrd = getT('Ustrd', coreRmts[0]);
                    if (ustrd) {
                        patch.rmtInfType = 'ustrd';
                        patch.rmtInfUstrd = ustrd.textContent || '';
                        if (coreRmts.length > 1) patch.rmtInfUstrd2 = tval('Ustrd', coreRmts[1]);
                    } else {
                        const strd = getT('Strd', coreRmts[0]);
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
                }

                const undrl = getT('UndrlygCstmrCdtTrf', tx);
                if (undrl) {
                    mapParty('covDbtr', 'Dbtr', undrl);
                    mapAgt('covDbtrAgt', 'DbtrAgt', undrl);
                    mapAgt('covCdtrAgt', 'CdtrAgt', undrl);
                    mapParty('covCdtr', 'Cdtr', undrl);

                    const uInstrC = undrl.querySelectorAll(':scope > InstrForCdtrAgt');
                    uInstrC.forEach((el, i) => {
                        if (i < 2) {
                            patch[`covInstrForCdtrAgt${i+1}Cd`] = tval('Cd', el);
                            patch[`covInstrForCdtrAgt${i+1}InfTxt`] = tval('InstrInf', el);
                        }
                    });
                    const uInstrN = undrl.querySelectorAll(':scope > InstrForNxtAgt');
                    uInstrN.forEach((el, i) => {
                        if (i < 6) {
                            patch[`covInstrForNxtAgt${i+1}InfTxt`] = tval('InstrInf', el);
                        }
                    });

                    patch.covPurpCd = tval('Cd', getT('Purp', undrl) || undrl);

                    const uRmt = undrl.querySelectorAll(':scope > RmtInf');
                    if (uRmt.length > 0) patch.covRmtInfUstrd = tval('Ustrd', uRmt[0]);
                    if (uRmt.length > 1) patch.covRmtInfUstrd2 = tval('Ustrd', uRmt[1]);

                    const cAmt = getT('InstdAmt', undrl);
                    if (cAmt) {
                        patch.covInstdAmt = cAmt.textContent?.trim() || '';
                        patch.covInstdAmtCcy = cAmt.getAttribute('Ccy') || '';
                    }
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

