import { CommonModule } from '@angular/common';
import { Component, OnInit, OnDestroy, HostListener } from '@angular/core';
import { FormBuilder, FormGroup, FormsModule, ReactiveFormsModule, Validators } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { Router, RouterModule } from '@angular/router';
import { ConfigService } from '../../../services/config.service';
import { UetrService } from '../../../services/uetr.service';
import { ISO_PURPOSE_CODES } from '../../../constants/purpose-codes';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
import { BicSearchDialogComponent } from '../bic-search-dialog/bic-search-dialog.component';
import { debounceTime } from 'rxjs/operators';

@Component({
    selector: 'app-pacs10',
    standalone: true,
    imports: [CommonModule, ReactiveFormsModule, FormsModule, MatIconModule, MatSnackBarModule, MatTooltipModule, RouterModule, MatDialogModule],
    templateUrl: './pacs10.component.html',
    styleUrl: './pacs10.component.css'
})
export class Pacs10Component implements OnInit, OnDestroy {
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
    public xmlHistory: string[] = [];
    public xmlHistoryIdx = -1;
    public maxHistory = 50;
    private isInternalChange = false;
    
    // Validation Modal State
    showValidationModal = false;
    validationStatus: 'idle' | 'validating' | 'done' = 'idle';
    validationReport: any = null;
    validationExpandedIssue: any = null;

    canUndoXml() { return this.xmlHistoryIdx > 0; }
    canRedoXml() { return this.xmlHistoryIdx < this.xmlHistory.length - 1; }

    warningTimeouts: { [key: string]: any } = {};
    showMaxLenWarning: { [key: string]: boolean } = {};

    currencies: string[] = [];
    currencyPrecision: { [key: string]: number } = {};
    countries: string[] = [];
    categoryPurposes: string[] = [];
    purposes: string[] = [];
    chargeBearers = ['SHAR', 'DEBT', 'CRED', 'SLEV'];
    copyDuplicateEnums = ['COPY', 'CODU', 'DUPL'];
    priorityEnums = ['HIGH', 'NORM', 'LOW'];

    agentPrefixes = ['instgAgt', 'instdAgt', 'dbtrAgt', 'cdtrAgt'];
    partyPrefixes = ['dbtr', 'cdtr'];

    private readonly DRAFT_KEY = 'draft_pacs010';
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
        
        // Auto-sync AppHdr Fr/To BICs with GrpHdr InstgAgt/InstdAgt
        // Auto-sync AppHdr Fr/To BICs with GrpHdr InstgAgt/InstdAgt
        this.form.get('fromBic')?.valueChanges.subscribe(v => this.form.patchValue({ instgAgtBic: v }, { emitEvent: false }));
        this.form.get('toBic')?.valueChanges.subscribe(v => this.form.patchValue({ instdAgtBic: v }, { emitEvent: false }));
        this.form.get('instgAgtBic')?.valueChanges.subscribe(v => this.form.patchValue({ fromBic: v }, { emitEvent: false }));
        this.form.get('instdAgtBic')?.valueChanges.subscribe(v => this.form.patchValue({ toBic: v }, { emitEvent: false }));

        const hadDraft = this.loadDraft();
        if (hadDraft) {
          this.showDraftBanner = true;
          this.generateXml();
        }

        this.form.valueChanges.pipe(debounceTime(300)).subscribe(() => {
            if (!this.isParsingXml && !this.isInternalChange) {
                this.generateXml();
                this.pushHistory();
            }
            this.scheduleDraftSave();
            this.updateConditionalValidators();
            this.updateClearingSystemValidation();
        });

        this.form.get('currency')?.valueChanges.subscribe(() => {
            this.updateAmountValidator();
            this.updateClearingSystemValidation(); 
        });
        
        // Init history
        this.pushHistory();
        this.setupAddressTypeFiller();
    }

    private setupAddressTypeFiller() {
        [...this.agentPrefixes, ...this.partyPrefixes].forEach(p => {
            this.form.get(p + 'AddrType')?.valueChanges.subscribe(type => {
                if (type === 'structured') {
                    this.form.patchValue({
                        [p + 'Dept']: 'Treasury Operations',
                        [p + 'SubDept']: 'Corporate Payments',
                        [p + 'StrtNm']: '10 Bishopsgate',
                        [p + 'BldgNb']: '10',
                        [p + 'BldgNm']: 'City Tower',
                        [p + 'Flr']: '12th Floor',
                        [p + 'PstBx']: 'PO Box 100',
                        [p + 'Room']: 'Room 1201',
                        [p + 'PstCd']: 'EC2N 4BQ',
                        [p + 'TwnNm']: 'London',
                        [p + 'TwnLctnNm']: 'Central London',
                        [p + 'Ctry']: 'GB'
                    }, { emitEvent: false });
                } else if (type === 'unstructured') {
                    this.form.patchValue({
                        [p + 'AdrLine1']: '10 Bishopsgate',
                        [p + 'AdrLine2']: 'Central Business District',
                        [p + 'AdrLine3']: 'London GB'
                    }, { emitEvent: false });
                    // Clear structured fields
                    const structured = ['Dept', 'SubDept', 'StrtNm', 'BldgNb', 'BldgNm', 'Flr', 'PstBx', 'Room', 'PstCd', 'TwnNm', 'TwnLctnNm', 'Ctry'];
                    structured.forEach(f => this.form.get(p + f)?.patchValue('', { emitEvent: false }));
                } else if (type === 'hybrid') {
                    this.form.patchValue({
                        [p + 'Dept']: 'Treasury Operations',
                        [p + 'SubDept']: 'Corporate Payments',
                        [p + 'StrtNm']: '10 Bishopsgate',
                        [p + 'BldgNb']: '10',
                        [p + 'BldgNm']: 'City Tower',
                        [p + 'Flr']: '12th Floor',
                        [p + 'PstBx']: 'PO Box 100',
                        [p + 'Room']: 'Room 1201',
                        [p + 'PstCd']: 'EC2N 4BQ',
                        [p + 'TwnNm']: 'London',
                        [p + 'TwnLctnNm']: 'Central London',
                        [p + 'Ctry']: 'GB',
                        [p + 'AdrLine1']: 'Central Business District',
                        [p + 'AdrLine2']: 'Near Liverpool Street',
                        [p + 'AdrLine3']: ''
                    }, { emitEvent: false });
                }
            });
        });
    }

    private updateClearingSystemValidation() {
        [...this.agentPrefixes, ...this.partyPrefixes].forEach(p => {
            const cd = this.form.get(p + 'ClrSysCd');
            const mmb = this.form.get(p + 'ClrSysMmbId');
            
            if (cd?.value?.trim() && !mmb?.value?.trim()) {
                mmb?.setErrors({ ...mmb.errors, required: true });
            } else if (mmb?.value?.trim() && !cd?.value?.trim()) {
                cd?.setErrors({ ...cd.errors, required: true });
            } else {
                [cd, mmb].forEach(ctrl => {
                    if (ctrl?.hasError('required')) {
                        const errors = { ...ctrl.errors };
                        delete errors['required'];
                        ctrl.setErrors(Object.keys(errors).length ? errors : null);
                    }
                });
            }
        });

        // Also for Org party parts 
        this.partyPrefixes.forEach(p => {
            const cd = this.form.get(p + 'OrgClrSysCd');
            const mmb = this.form.get(p + 'OrgClrSysMmbId');
            if (cd && mmb) {
                if (cd.value?.trim() && !mmb.value?.trim()) {
                    mmb.setErrors({ ...mmb.errors, required: true });
                } else if (mmb.value?.trim() && !cd.value?.trim()) {
                    cd.setErrors({ ...cd.errors, required: true });
                } else {
                    [cd, mmb].forEach(ctrl => {
                        if (ctrl?.hasError('required')) {
                            const errors = { ...ctrl.errors };
                            delete errors['required'];
                            ctrl.setErrors(Object.keys(errors).length ? errors : null);
                        }
                    });
                }
            }
        });

        const systems = [...this.agentPrefixes, ...this.partyPrefixes].map(p => {
            return this.form.get(p + 'ClrSysCd')?.value?.trim()?.toUpperCase();
        });

        const anyT2 = systems.includes('T2');
        const anyCHAPS = systems.includes('CHAPS');
        const anyCHIPS = systems.includes('CHIPS');
        const anyFED = systems.includes('FED');

        const currencyCtrl = this.form.get('currency');
        // Target2/CHAPS/CHIPS/FED Validation (Moving to on-demand to prevent flow interruption)
        if (currencyCtrl?.hasError('target2') || currencyCtrl?.hasError('chaps') || 
            currencyCtrl?.hasError('chips') || currencyCtrl?.hasError('fed')) {
            const errors = { ...currencyCtrl.errors };
            delete errors['target2'];
            delete errors['chaps'];
            delete errors['chips'];
            delete errors['fed'];
            currencyCtrl.setErrors(Object.keys(errors).length ? errors : null);
        }

        // ClrSysRef Validation (Moving to on-demand to prevent flow interruption)
        const clrRefCtrl = this.form.get('clrSysRef');
        if (clrRefCtrl?.hasError('forbidden')) {
            const errors = { ...clrRefCtrl.errors };
            delete errors['forbidden'];
            clrRefCtrl.setErrors(Object.keys(errors).length ? errors : null);
        }
    }

    private validateFullMessageErrors() {
        const systems = [...this.agentPrefixes, ...this.partyPrefixes].map(p => {
            return this.form.get(p + 'ClrSysCd')?.value?.trim()?.toUpperCase();
        });
        const standardSystems = ['T2', 'CHAPS', 'CHIPS', 'FED', 'RTGS'];
        const hasStandardClearing = systems.some(s => standardSystems.includes(s));
        
        const anyT2 = systems.includes('T2');
        const anyCHAPS = systems.includes('CHAPS');
        const anyCHIPS = systems.includes('CHIPS');
        const anyFED = systems.includes('FED');

        const currencyCtrl = this.form.get('currency');
        const ccy = currencyCtrl?.value;

        // T2 Validation
        if (anyT2 && ccy !== 'EUR' && ccy !== '') {
            currencyCtrl?.setErrors({ ...currencyCtrl.errors, target2: true });
        }
        // CHAPS Validation
        if (anyCHAPS && ccy !== 'GBP' && ccy !== '') {
            currencyCtrl?.setErrors({ ...currencyCtrl.errors, chaps: true });
        }
        // CHIPS Validation
        if (anyCHIPS && ccy !== 'USD' && ccy !== '') {
            currencyCtrl?.setErrors({ ...currencyCtrl.errors, chips: true });
        }
        // FED Validation
        if (anyFED && ccy !== 'USD' && ccy !== '') {
            currencyCtrl?.setErrors({ ...currencyCtrl.errors, fed: true });
        }

        const clrRefCtrl = this.form.get('clrSysRef');
        if (clrRefCtrl?.value?.trim() && !hasStandardClearing) {
            clrRefCtrl.setErrors({ ...clrRefCtrl.errors, forbidden: true });
        }

        // Co-presence rule for FIs: Name and Address must always be together or both absent.
        // Applies to Cdtr, Dbtr, CdtrAgt, DbtrAgt as per ISO 20022/CBPR+ standards.
        ['cdtr', 'dbtr', 'cdtrAgt', 'dbtrAgt'].forEach(p => {
            const name = this.form.get(p + 'Name')?.value?.trim();
            const addrType = this.form.get(p + 'AddrType')?.value;
            const addrTypeCtrl = this.form.get(p + 'AddrType');
            const nameCtrl = this.form.get(p + 'Name');

            if (name && addrType === 'none') {
                addrTypeCtrl?.setErrors({ ...addrTypeCtrl?.errors, linked: true });
            } else if (!name && addrType && addrType !== 'none') {
                nameCtrl?.setErrors({ ...nameCtrl?.errors, linked: true });
            }
        });

        // Cdtr-specific rule: Nm must NEVER be generated without PstlAdr.
        // If cdtrName is filled but addrType is 'none', block with a dedicated error.
        const cdtrName = this.form.get('cdtrName')?.value?.trim();
        const cdtrAddrType = this.form.get('cdtrAddrType')?.value;
        const cdtrAddrCtrl = this.form.get('cdtrAddrType');
        if (cdtrName && cdtrAddrType === 'none') {
            cdtrAddrCtrl?.setErrors({ ...cdtrAddrCtrl?.errors, nmWithoutAddr: true });
        }
    }

    private updateConditionalValidators() {
        const ADDR_PATTERN = Validators.pattern(/^[a-zA-Z0-9\/\-\?:\(\)\.,\+' ]+$/);
        [...this.agentPrefixes, ...this.partyPrefixes].forEach(p => {
            const addrType = this.form.get(p + 'AddrType')?.value;
            const ctryCtrl = this.form.get(p + 'Ctry');
            const twnNmCtrl = this.form.get(p + 'TwnNm');

            const nameCtrl = this.form.get(p + 'Name');
            const addrTypeCtrl = this.form.get(p + 'AddrType');
            const name = nameCtrl?.value?.trim();

            // Real-time: Only clear cross-field errors to allow "accept any data" until validation
            [nameCtrl, addrTypeCtrl].forEach(ctrl => {
                const errors = { ...ctrl?.errors };
                delete errors['linked'];
                ctrl?.setErrors(Object.keys(errors).length ? errors : null);
            });

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
                    twnNmCtrl?.setValidators([Validators.required, Validators.maxLength(35), Validators.pattern(/^[a-zA-Z0-9\/\-\?:\(\)\.,\+' ]*$/)]);
                    twnNmCtrl?.updateValueAndValidity({ emitEvent: false });
                }
            } else {
                if (twnNmCtrl?.hasValidator(Validators.required)) {
                    twnNmCtrl?.clearValidators();
                    twnNmCtrl?.setValidators([Validators.maxLength(35), Validators.pattern(/^[a-zA-Z0-9\/\-\?:\(\)\.,\+' ]*$/)]);
                    twnNmCtrl?.updateValueAndValidity({ emitEvent: false });
                }
            }

            // Hybrid/Mixed Address Logic
            const addrLinesModel = [1, 2, 3, 4, 5, 6, 7].map(i => this.form.get(p + 'AdrLine' + i)?.value);
            const hasAnyAdrLine = addrLinesModel.some(v => !!v);

            if (addrType === 'hybrid') {
                // RULE: In Hybrid/Mixed mode, Town and Country are mandatory
                if (!ctryCtrl?.hasValidator(Validators.required)) {
                    ctryCtrl?.addValidators(Validators.required);
                    ctryCtrl?.updateValueAndValidity({ emitEvent: false });
                }
                if (!twnNmCtrl?.hasValidator(Validators.required)) {
                    twnNmCtrl?.addValidators(Validators.required);
                    twnNmCtrl?.updateValueAndValidity({ emitEvent: false });
                }
                
                // RULE: In Hybrid/Mixed mode, only max 2 AdrLines allowed (3rd line cleared)
                [3].forEach(i => {
                    const ctrl = this.form.get(p + 'AdrLine' + i);
                    if (ctrl?.value) ctrl.setValue('', { emitEvent: false });
                });
            }
            
            // Re-eval mandated fields based on any manual data entry patterns (detecting mixed records)
            const hasStructuredFields = ['Dept', 'SubDept', 'StrtNm', 'BldgNb', 'BldgNm', 'Flr', 'PstBx', 'Room', 'PstCd', 'TwnLctnNm'].some(f => !!this.form.get(p + f)?.value);
            if (hasStructuredFields && hasAnyAdrLine) {
                if (!ctryCtrl?.hasValidator(Validators.required)) {
                    ctryCtrl?.addValidators(Validators.required);
                    ctryCtrl?.updateValueAndValidity({ emitEvent: false });
                }
                if (!twnNmCtrl?.hasValidator(Validators.required)) {
                    twnNmCtrl?.addValidators(Validators.required);
                    twnNmCtrl?.updateValueAndValidity({ emitEvent: false });
                }
            }
        });

        // Party Identification Validators
        this.partyPrefixes.forEach(p => {
            const idType = this.form.get(p + 'IdType')?.value;

            // Org Id Validators
            const orgOthrIdCtrl = this.form.get(p + 'OrgOthrId');
            const orgOthrSchme = this.form.get(p + 'OrgOthrSchmeNmCd');
            if (idType === 'org' && orgOthrIdCtrl?.value?.trim()) {
                orgOthrSchme?.setValidators([Validators.required, Validators.maxLength(4)]);
            } else {
                orgOthrSchme?.clearValidators();
                orgOthrSchme?.setValidators([Validators.maxLength(4)]);
            }
            orgOthrSchme?.updateValueAndValidity({ emitEvent: false });

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
        });

    }





    private fetchCodelists() {
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
            next: (res) => { if (res && res.codes) this.countries = res.codes; },
            error: (err) => console.error('Failed to load countries', err)
        });
        this.http.get<any>(this.config.getApiUrl('/codelists/ctgyPurp')).subscribe({
            next: (res) => {
                const existing = res && res.codes ? res.codes : [];
                this.categoryPurposes = [...new Set([...existing, 'ADVA', 'AGRT', 'CASH', 'COLL', 'DIVD', 'GOVT', 'HEDG', 'INTC', 'LOAN', 'OTHR', 'PENS', 'SALA', 'SUPP', 'TAXS', 'TREA', 'VATX'])].sort();
            },
            error: () => {
                this.categoryPurposes = ['ADVA', 'AGRT', 'CASH', 'COLL', 'DIVD', 'GOVT', 'HEDG', 'INTC', 'LOAN', 'OTHR', 'PENS', 'SALA', 'SUPP', 'TAXS', 'TREA', 'VATX'].sort();
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

    isoNow(): string {
        const d = new Date(), p = (n: number) => n.toString().padStart(2, '0');
        const off = -d.getTimezoneOffset(), s = off >= 0 ? '+' : '-';
        return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}${s}${p(Math.floor(Math.abs(off) / 60))}:${p(Math.abs(off) % 60)}`;
    }

    formatCbprDateTime(dt: string): string {
        if (!dt) return this.isoNow();
        let res = dt.trim();
        if (res.endsWith('Z')) res = res.replace('Z', '+00:00');
        res = res.replace(/\.\d{1,}/, '');
        if (!/[+-]\d{2}:\d{2}$/.test(res)) res += '+00:00';
        return res;
    }

    private updateAmountValidator() {
        const ccy = this.form.get('currency')?.value;
        const precision = this.currencyPrecision[ccy] ?? 2;
        const amountCtrl = this.form.get('amount');
        
        // Dynamic regex matching pacs.008 logic: 1-18 digits total, optional decimal based on precision
        const pattern = precision > 0 
          ? new RegExp(`^\\d{1,18}(\\.\\d{1,${precision}})?$`)
          : new RegExp(`^\\d{1,18}$`);
        
        amountCtrl?.setValidators([Validators.required, Validators.pattern(pattern)]);
        amountCtrl?.updateValueAndValidity({ emitEvent: false });
    }

    private buildForm() {
        const BIC = [Validators.required, Validators.pattern(/^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$/)];
        const BIC_OPT = [Validators.pattern(/^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$/)];
        const SAFE_NAME = Validators.pattern(/^[a-zA-Z0-9 .,()'\-]+$/);
        const ADDR_PATTERN = Validators.pattern(/^[a-zA-Z0-9\/\-\?:\(\)\.,\+' ]+$/);

        const c: any = {
            fromBic: ['BOFAUS3NXXX', BIC], 
            toBic: ['CITIUS33XXX', BIC], 
            bizMsgId: ['BMD-2026-PAC010-001', [Validators.required, Validators.maxLength(35), Validators.pattern(/^[a-zA-Z0-9\/\-\?:\(\)\.,\+' ]*$/)]],
            msgId: ['MSGID-2026-PAC010-001', [Validators.required, Validators.maxLength(35), Validators.pattern(/^[a-zA-Z0-9\/\-\?:\(\)\.,\+' ]*$/)]], 
            creDtTm: [this.isoNow(), Validators.required],
            nbOfTxs: ['1', [Validators.required, Validators.pattern(/^[1-9]\d{0,14}$/)]],
            cdtId: ['CDT-FI-2026-001', [Validators.required, Validators.maxLength(35), Validators.pattern(/^[a-zA-Z0-9\/\-\?:\(\)\.,\+' ]*$/)]],
            
            // Creditor Agent
            cdtrAgtBic: ['CHASUS33XXX', BIC_OPT],
            cdtrAgtName: ['JPMORGAN CHASE BANK', [Validators.maxLength(140), SAFE_NAME]],
            cdtrAgtLei: ['7H6LDXLRUQGFU57RNE97', [Validators.pattern(/^[A-Z0-9]{18}[0-9]{2}$/)]],
            cdtrAgtClrSysCd: ['USFW', Validators.maxLength(5)],
            cdtrAgtClrSysMmbId: ['MEM-CAGT-01', Validators.maxLength(35)],
            cdtrAgtAddrType: ['structured'],
            
            // Creditor
            cdtrBic: ['CITIUS33XXX', BIC],
            cdtrName: ['CITIBANK NA', [Validators.maxLength(140), SAFE_NAME]],
            cdtrLei: ['E57ODZWZ7FF32TWEFS77', [Validators.pattern(/^[A-Z0-9]{18}[0-9]{2}$/)]],
            cdtrClrSysCd: ['USFW', Validators.maxLength(5)],
            cdtrClrSysMmbId: ['MEM-CDTR-01', Validators.maxLength(35)],
            cdtrAddrType: ['structured'],
            
            // Payment IDs
            instrId: ['INSTR-2026-PAC010-001', [Validators.required, Validators.maxLength(35), Validators.pattern(/^[a-zA-Z0-9\/\-\?:\(\)\.,\+' ]*$/)]],
            endToEndId: ['E2E-2026-PAC010-001', [Validators.required, Validators.maxLength(35), Validators.pattern(/^[a-zA-Z0-9\/\-\?:\(\)\.,\+' ]*$/)]],
            txId: ['TXID-2026-PAC010-001', [Validators.maxLength(35), Validators.pattern(/^[a-zA-Z0-9\/\-\?:\(\)\.,\+' ]*$/)]],
            uetr: ['6bbef0a5-218b-42dc-8bce-9684f59847cd', [Validators.required, Validators.pattern(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/)]],
            clrSysRef: ['', [Validators.pattern(/^[a-zA-Z0-9\/\-\?:\(\)\.,\+' ]+$/), Validators.maxLength(35)]],
            
            // AppHdr extensions
            copyDplct: ['COPY'], pssblDplct: ['true'], prty: ['HIGH'],
            
            // Payment Type Info
            instrPrty: ['HIGH'],
            svcLvlCd: ['G001', [Validators.maxLength(4), Validators.pattern(/^[A-Z0-9]{1,4}$/)]], 
            svcLvlPrtry: ['PRIORITY-SVC', [Validators.maxLength(35), Validators.pattern(/^[a-zA-Z0-9\/\-\?:\(\)\.,\+' ]*$/)]],
            lclInstrmCd: ['ONCL', [Validators.maxLength(4), Validators.pattern(/^[A-Z0-9]{1,4}$/)]], 
            lclInstrmPrtry: ['INSTANT-SETTLM', [Validators.maxLength(35), Validators.pattern(/^[a-zA-Z0-9\/\-\?:\(\)\.,\+' ]*$/)]],
            ctgyPurpCd: ['INTC', [Validators.pattern(/^[A-Z]{4}$/)]], 
            ctgyPurpPrtry: ['CORP-CASH-POOL', [Validators.maxLength(35), Validators.pattern(/^[a-zA-Z0-9\/\-\?:\(\)\.,\+' ]*$/)]],
            
            amount: ['50000', [Validators.required, Validators.pattern(/^\d{1,18}(\.\d{1,5})?$/)]],
            currency: ['GBP', [Validators.required, Validators.pattern(/^[A-Z]{3}$/)]],
            intrBkSttlmDt: [new Date().toISOString().split('T')[0], Validators.required],
            clstTm: ['09:00:00+00:00', [Validators.pattern(/^([01]\d|2[0-3]):[0-5]\d:[0-5]\d([+-][01]\d:[0-5]\d|Z)$/)]],
            tillTm: ['17:00:00+00:00', [Validators.pattern(/^([01]\d|2[0-3]):[0-5]\d:[0-5]\d([+-][01]\d:[0-5]\d|Z)$/)]],
            frTm: ['08:00:00+00:00', [Validators.pattern(/^([01]\d|2[0-3]):[0-5]\d:[0-5]\d([+-][01]\d:[0-5]\d|Z)$/)]],
            rjctTm: ['16:00:00+00:00', [Validators.pattern(/^([01]\d|2[0-3]):[0-5]\d:[0-5]\d([+-][01]\d:[0-5]\d|Z)$/)]],
            purposeCd: ['INTC', [Validators.pattern(/^[A-Z]{4}$/)]], 
            purposePrtry: ['INTERBANK-XFER', [Validators.maxLength(35), Validators.pattern(/^[a-zA-Z0-9\/\-\?:\(\)\.,\+' ]*$/)]],
            remittanceInfo: ['Interbank Direct Debit Settlement March 2026', [Validators.maxLength(140), Validators.pattern(/^[a-zA-Z0-9\/\-\?:\(\)\.,\+' ]*$/)]],
            instrForDbtrAgt: ['Settle via RTGS system immediately', [Validators.maxLength(140), Validators.pattern(/^[a-zA-Z0-9\/\-\?:\(\)\.,\+' ]*$/)]],
            
            // Debtor
            dbtrBic: ['BOFAUS3NXXX', BIC],
            dbtrName: ['BANK OF AMERICA NA', [Validators.maxLength(140), SAFE_NAME]],
            dbtrLei: ['5493001KJTIIGC8Y1R12', [Validators.pattern(/^[A-Z0-9]{18}[0-9]{2}$/)]],
            dbtrClrSysCd: ['USFW', Validators.maxLength(5)],
            dbtrClrSysMmbId: ['MEM-DBTR-01', Validators.maxLength(35)],
            dbtrAddrType: ['hybrid'],
            
            // Debtor Agent
            dbtrAgtBic: ['WFBIUS6SXXX', BIC_OPT],
            dbtrAgtName: ['WELLS FARGO BANK NA', [Validators.maxLength(140), SAFE_NAME]],
            dbtrAgtLei: ['724500PMK2A2M1SQQ228', [Validators.pattern(/^[A-Z0-9]{18}[0-9]{2}$/)]],
            dbtrAgtClrSysCd: ['USFW', Validators.maxLength(5)],
            dbtrAgtClrSysMmbId: ['MEM-DAGT-01', Validators.maxLength(35)],
            dbtrAgtAddrType: ['hybrid'],
            
            // Instructing / Instructed Agents
            instgAgtBic: ['BOFAUS3NXXX', BIC],
            instdAgtBic: ['CITIUS33XXX', BIC]
        };

        const prefixes = [...this.agentPrefixes, ...this.partyPrefixes];

        prefixes.forEach(p => {
            const isAgent = this.agentPrefixes.includes(p);
            
            if (!c[p + 'AddrType']) c[p + 'AddrType'] = [(p === 'instgAgt' || p === 'instdAgt') ? 'none' : 'hybrid'];
            
            // Address field mapping per party
            const addrMap: any = {
                dbtr:    { Dept: 'Treasury Operations', SubDept: 'Corporate Payments', StrtNm: '10 Bishopsgate', BldgNb: '10', BldgNm: 'City Tower', Flr: '12th Floor', PstBx: 'PO Box 100', Room: 'Room 1201', PstCd: 'EC2N 4BQ', TwnNm: 'London', TwnLctnNm: 'Central London', Ctry: 'GB', AdrLine1: 'Central Business District', AdrLine2: 'Near Liverpool Street' },
                cdtr:    { Dept: 'Treasury Operations', SubDept: 'Corporate Payments', StrtNm: '10 Bishopsgate', BldgNb: '10', BldgNm: 'City Tower', Flr: '12th Floor', PstBx: 'PO Box 100', Room: 'Room 1201', PstCd: 'EC2N 4BQ', TwnNm: 'London', TwnLctnNm: 'Central London', Ctry: 'GB', AdrLine1: 'Central Business District', AdrLine2: 'Near Liverpool Street' },
                dbtrAgt: { Dept: 'Treasury Operations', SubDept: 'Corporate Payments', StrtNm: '10 Bishopsgate', BldgNb: '10', BldgNm: 'City Tower', Flr: '12th Floor', PstBx: 'PO Box 100', Room: 'Room 1201', PstCd: 'EC2N 4BQ', TwnNm: 'London', TwnLctnNm: 'Central London', Ctry: 'GB', AdrLine1: 'Central Business District', AdrLine2: 'Near Liverpool Street' },
                cdtrAgt: { Dept: 'Treasury Operations', SubDept: 'Corporate Payments', StrtNm: '10 Bishopsgate', BldgNb: '10', BldgNm: 'City Tower', Flr: '12th Floor', PstBx: 'PO Box 100', Room: 'Room 1201', PstCd: 'EC2N 4BQ', TwnNm: 'London', TwnLctnNm: 'Central London', Ctry: 'GB', AdrLine1: 'Central Business District', AdrLine2: 'Near Liverpool Street' }
            };
            const defaults = addrMap[p] || {};

            ['Dept', 'SubDept', 'StrtNm', 'BldgNb', 'BldgNm', 'Flr', 'PstBx', 'Room', 'PstCd', 'TwnNm', 'TwnLctnNm', 'Ctry', 'AdrLine1', 'AdrLine2', 'AdrLine3'].forEach(f => {
                let val = defaults[f] || '';
                
                // Per-field ISO 20022 validators
                let validators: any[];
                if (f === 'Ctry') {
                    validators = [Validators.pattern(/^[A-Z]{2,2}$/)];
                } else if (f.startsWith('AdrLine')) {
                    validators = [Validators.maxLength(70), Validators.pattern(/^[a-zA-Z0-9\/\-\?:\(\)\.,\+' ]*$/)];
                } else {
                    validators = [Validators.maxLength(70), Validators.pattern(/^[a-zA-Z0-9\/\-\?:\(\)\.,\+' ]*$/)];
                }
                if (!c[p + f]) c[p + f] = [val, validators];
            });
            
            const pName = p.replace(/([A-Z])/g, ' $1').toUpperCase();
            if (!c[p + 'Name']) c[p + 'Name'] = [pName + ' INSTITUTION', [Validators.maxLength(140), SAFE_NAME]];
            if (!c[p + 'Lei']) c[p + 'Lei'] = ['54930084UKLVMY22DS16', [Validators.pattern(/^[A-Z0-9]{18}[0-9]{2}$/)]];
            if (!c[p + 'ClrSysCd']) c[p + 'ClrSysCd'] = ['USAB', Validators.maxLength(5)];
            if (!c[p + 'ClrSysMmbId']) c[p + 'ClrSysMmbId'] = ['MEM-' + p.toUpperCase().substring(0, 5) + '-01', Validators.maxLength(35)];
            
            if (!c[p + 'AcctIBAN']) {
                c[p + 'AcctIBAN'] = ['', [Validators.pattern(/^[A-Z]{2}[0-9]{2}[A-Z0-9]+$/), Validators.minLength(10), Validators.maxLength(34)]];
            }

            // Account defaults per party
            const acctMap: any = {
                dbtr:    { AcctIBAN: 'GB82WEST12345698765432', AcctCcy: 'GBP', AcctNm: 'GBP DEBTOR SETTLEMENT ACCOUNT' },
                cdtr:    { AcctIBAN: 'GB29NWBK60161331926819', AcctCcy: 'USD', AcctNm: 'CITI CREDITOR SETTLEMENT' },
                dbtrAgt: { AcctIBAN: 'GB33BUKB20201555555555', AcctCcy: 'GBP', AcctNm: 'GBP DEBTOR AGENT SETTLEMENT ACCOUNT' },
                cdtrAgt: { AcctIBAN: 'GB82WEST12345698765432', AcctCcy: 'USD', AcctNm: 'JPM AGENT SETTLEMENT ACCOUNT' }
            };
            const acctDefaults = acctMap[p] || {};

            // Set IBAN per party
            if (acctDefaults.AcctIBAN) {
                c[p + 'AcctIBAN'] = [acctDefaults.AcctIBAN, [Validators.pattern(/^[A-Z]{2}[0-9]{2}[A-Z0-9]+$/), Validators.minLength(10), Validators.maxLength(34)]];
            }

            // Currency, Account Name
            if (!c[p + 'AcctCcy']) {
                c[p + 'AcctCcy'] = [acctDefaults.AcctCcy || '', [Validators.pattern(/^[A-Z]{3}$/)]];
            }
            if (!c[p + 'AcctNm']) {
                c[p + 'AcctNm'] = [acctDefaults.AcctNm || ''];
            }

            if (!isAgent) {
                if (!c[p + 'IdType']) c[p + 'IdType'] = ['org'];
                if (!c[p + 'OrgAnyBIC']) c[p + 'OrgAnyBIC'] = [c[p + 'Bic'] ? c[p + 'Bic'][0] : 'BOFAUS3NXXX', BIC_OPT];
                if (!c[p + 'OrgLEI']) c[p + 'OrgLEI'] = [c[p + 'Lei'] ? c[p + 'Lei'][0] : '54930084UKLVMY22DS16', [Validators.pattern(/^[A-Z0-9]{18}[0-9]{2}$/)]];
                if (!c[p + 'OrgClrSysCd']) c[p + 'OrgClrSysCd'] = ['USFW', Validators.maxLength(5)];
                if (!c[p + 'OrgClrSysMmbId']) c[p + 'OrgClrSysMmbId'] = ['ORG-' + p.toUpperCase().substring(0, 5), Validators.maxLength(35)];
                if (!c[p + 'OrgOthrId']) c[p + 'OrgOthrId'] = ['OTH-' + p.toUpperCase().substring(0, 5), [Validators.maxLength(35), Validators.pattern(/^[a-zA-Z0-9\/\-\?:\(\)\.,\+' ]*$/)]];
                if (!c[p + 'OrgOthrSchmeNmCd']) c[p + 'OrgOthrSchmeNmCd'] = ['BANK', [Validators.maxLength(4), Validators.pattern(/^[A-Z0-9]{1,4}$/)]];
            }
        });

        this.form = this.fb.group(c);
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

        const v = this.form.value;
        const creDtTm = this.formatCbprDateTime(v.creDtTm);

        let appHdr = `\t\t<Fr><FIId><FinInstnId><BICFI>${this.e(v.fromBic)}</BICFI></FinInstnId></FIId></Fr>\n`;
        appHdr += `\t\t<To><FIId><FinInstnId><BICFI>${this.e(v.toBic)}</BICFI></FinInstnId></FIId></To>\n`;
        appHdr += `\t\t<BizMsgIdr>${this.e(v.bizMsgId)}</BizMsgIdr>\n\t\t<MsgDefIdr>pacs.010.001.10</MsgDefIdr>\n\t\t<BizSvc>swift.cbprplus.02</BizSvc>\n`;
        
        appHdr += `\t\t<CreDt>${creDtTm}</CreDt>\n`;
        if (v.copyDplct) appHdr += this.el('CpyDplct', v.copyDplct, 2);
        if (v.pssblDplct === 'true' || v.pssblDplct === 'false') {
            appHdr += this.el('PssblDplct', v.pssblDplct, 2);
        }
        if (v.prty) appHdr += this.el('Prty', v.prty, 2);

        let xml = `<?xml version="1.0" encoding="UTF-8"?>
<BusMsgEnvlp xmlns="urn:swift:xsd:envelope">
\t<AppHdr xmlns="urn:iso:std:iso:20022:tech:xsd:head.001.001.02">
${appHdr}\t</AppHdr>
\t<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pacs.010.001.10">
\t\t<FIDrctDbt>
\t\t\t<GrpHdr>
\t\t\t\t<MsgId>${this.e(v.msgId)}</MsgId>
\t\t\t\t<CreDtTm>${creDtTm}</CreDtTm>
\t\t\t\t<NbOfTxs>1</NbOfTxs>
\t\t\t</GrpHdr>
\t\t\t<CdtInstr>
\t\t\t\t<CdtId>${this.e(v.cdtId)}</CdtId>
${this.agt('InstgAgt', 'instgAgt', v, 4, true)}
${this.agt('InstdAgt', 'instdAgt', v, 4, true)}
${this.agt('CdtrAgt', 'cdtrAgt', v, 4)}
${this.fullAcct('CdtrAgtAcct', 'cdtrAgt', v, 4)}
${this.agt('Cdtr', 'cdtr', v, 4)}
${this.fullAcct('CdtrAcct', 'cdtr', v, 4)}
\t\t\t\t<DrctDbtTxInf>
\t\t\t\t\t<PmtId>
${this.el('InstrId', v.instrId, 6)}${this.el('EndToEndId', v.endToEndId, 6)}${this.el('TxId', v.txId, 6)}${this.el('UETR', v.uetr, 6)}${this.el('ClrSysRef', v.clrSysRef, 6)}
\t\t\t\t\t</PmtId>
${this.pmtTpInf(v)}
\t\t\t\t\t<IntrBkSttlmAmt Ccy="${this.e(v.currency)}">${this.formatAmount(v.amount)}</IntrBkSttlmAmt>
${v.intrBkSttlmDt ? `\t\t\t\t\t<IntrBkSttlmDt>${this.e(v.intrBkSttlmDt)}</IntrBkSttlmDt>\n` : ""}${this.sttlmTmReq(v)}${this.agt('Dbtr', 'dbtr', v, 5)}
${this.fullAcct('DbtrAcct', 'dbtr', v, 5)}
${this.agt('DbtrAgt', 'dbtrAgt', v, 5)}
${this.fullAcct('DbtrAgtAcct', 'dbtrAgt', v, 5)}
${this.el('InstrForDbtrAgt', v.instrForDbtrAgt, 5)}
${this.purp(v)}
${this.rmtInf(v)}
\t\t\t\t</DrctDbtTxInf>
\t\t\t</CdtInstr>
\t\t</FIDrctDbt>
\t</Document>
</BusMsgEnvlp>`;
        this.generatedXml = xml;
        this.formatXml(false);
    }

    private sttlmTmReq(v: any) {
        let res = '';
        if (v.clstTm) res += this.el('CLSTm', v.clstTm, 6);
        if (v.tillTm) res += this.el('TillTm', v.tillTm, 6);
        if (v.frTm) res += this.el('FrTm', v.frTm, 6);
        if (v.rjctTm) res += this.el('RjctTm', v.rjctTm, 6);
        return res ? this.tag('SttlmTmReq', res, 5) : '';
    }

    private pmtTpInf(v: any) {
        let res = '';
        if (v.instrPrty) res += this.el('InstrPrty', v.instrPrty, 6);
        if (v.svcLvlCd || v.svcLvlPrtry) {
            // Prioritize Cd; only fall back to Prtry if Cd is absent
            let sv = v.svcLvlCd ? this.el('Cd', v.svcLvlCd, 7) : this.el('Prtry', v.svcLvlPrtry, 7);
            res += this.tag('SvcLvl', sv, 6);
        }
        if (v.lclInstrmCd || v.lclInstrmPrtry) {
            let lc = v.lclInstrmCd ? this.el('Cd', v.lclInstrmCd, 7) : this.el('Prtry', v.lclInstrmPrtry, 7);
            res += this.tag('LclInstrm', lc, 6);
        }
        if (v.ctgyPurpCd || v.ctgyPurpPrtry) {
            let cp = v.ctgyPurpCd ? this.el('Cd', v.ctgyPurpCd, 7) : this.el('Prtry', v.ctgyPurpPrtry, 7);
            res += this.tag('CtgyPurp', cp, 6);
        }

        return res ? this.tag('PmtTpInf', res, 5) : '';
    }


    private purp(v: any) {
        if (!v.purposeCd && !v.purposePrtry) return '';
        // Prioritize Cd; only fall back to Prtry if Cd is absent
        const p = v.purposeCd ? this.el('Cd', v.purposeCd, 6) : this.el('Prtry', v.purposePrtry, 6);
        return this.tag('Purp', p, 5);
    }

    private rmtInf(v: any) {
        if (!v.remittanceInfo) return '';
        return this.tag('RmtInf', this.el('Ustrd', v.remittanceInfo, 6), 5);
    }

    private fullAcct(tag: string, p: string, v: any, indent = 4) {
        let id = this.formatAcctDetails(v, p, indent + 2);
        if (!id) return '';
        let res = this.tag('Id', id, indent + 1);
        if (v[p + 'AcctCcy'] && /^[A-Z]{3}$/.test(v[p + 'AcctCcy'])) {
            res += this.el('Ccy', v[p + 'AcctCcy'], indent + 1);
        }
        if (v[p + 'AcctNm']) res += this.el('Nm', v[p + 'AcctNm'], indent + 1);
        return this.tag(tag, res, indent);
    }

    private formatAcctDetails(v: any, p: string, tabs: number) {
        // IBAN is the only identification allowed in this standardized suite
        if (v[p + 'AcctIBAN']) {
            return this.el('IBAN', v[p + 'AcctIBAN'], tabs);
        }
        return '';
    }

    private e(v: string) { return (v || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
    private tabs(n: number) { return '\t'.repeat(n); }
    private el(tag: string, val: string, indent = 3) { return val?.trim() ? `${this.tabs(indent)}<${tag}>${this.e(val)}</${tag}>\n` : ''; }
    private tag(tag: string, content: string, indent = 3) { return content?.trim() ? `${this.tabs(indent)}<${tag}>\n${content}${this.tabs(indent)}</${tag}>\n` : ''; }

    agt(tag: string, prefix: string, v: any, indent = 3, onlyBic = false) {
        const bic = v[prefix + 'Bic'];
        const name = (v[prefix + 'Name'] || '').trim();
        const lei = v[prefix + 'Lei'];
        const clrCd = v[prefix + 'ClrSysCd'];
        const clrMmb = v[prefix + 'ClrSysMmbId'];
        
        if (!bic && !name && !lei && !clrMmb && v[prefix + 'AddrType'] === 'none') return '';

        let finInstnId = '';
        if (bic) finInstnId += this.el('BICFI', bic, indent + 2);
        
        if (clrMmb) {
            let clr = '';
            // Sequence: ClrSysId -> MmbId
            const sysId = clrCd ? this.el('Cd', clrCd, indent + 4) : `${this.tabs(indent + 4)}<Cd></Cd>\n`;
            clr += `${this.tabs(indent + 3)}<ClrSysId>\n${sysId}${this.tabs(indent + 3)}</ClrSysId>\n`;
            clr += this.el('MmbId', clrMmb, indent + 3);
            finInstnId += this.tag('ClrSysMmbId', clr, indent + 2);
        }

        if (lei) finInstnId += this.el('LEI', lei, indent + 2);
        
        if (!onlyBic) {
            const addr = this.addrXml(v, prefix, indent + 2);
            // ISO 20022 rule: Name and Address must always be together or both absent for Financial Institutions
            if (name && addr) {
                finInstnId += this.el('Nm', name, indent + 2);
                finInstnId += addr;
            }
        }

        return this.tag(tag, this.tag('FinInstnId', finInstnId, indent + 1), indent);
    }

    party(tag: string, prefix: string, v: any, indent = 4) {
        const bic = v[prefix + 'OrgAnyBIC'] || v[prefix + 'Bic'];
        const name = (v[prefix + 'Name'] || '').trim();
        const lei = v[prefix + 'OrgLEI'] || v[prefix + 'Lei'];
        const clrMmb = v[prefix + 'OrgClrSysMmbId'] || v[prefix + 'ClrSysMmbId'];
        if (!bic && !name && !lei && !clrMmb && v[prefix + 'AddrType'] === 'none') return '';

        let partyContent = '';
        const addr = this.addrXml(v, prefix, indent + 1);
        // Rule: Nm and PstlAdr together or none
        if (name && addr) {
            partyContent += this.el('Nm', name, indent + 1);
            partyContent += addr;
        }

        let id = '';
        if (bic || lei || clrMmb) {
            let org = '';
            if (bic) org += this.el('AnyBIC', bic, indent + 3);
            if (lei) org += this.el('LEI', lei, indent + 3);
            if (clrMmb) {
                let othr = this.el('Id', clrMmb, indent + 5) + this.tag('SchmeNm', this.el('Prtry', 'ClrSysMmbId', indent + 6), indent + 5);
                org += this.tag('Othr', othr, indent + 4);
            }
            id = this.tag('OrgId', org, indent + 2);
        }
        if (id) partyContent += this.el('Id', id, indent + 1);

        return this.tag(tag, partyContent, indent);
    }

    addrXml(v: any, p: string, indent = 4): string {
        const type = v[p + 'AddrType']; 
        if (!type || type === 'none') return '';
        
        let lines: string[] = []; 
        const t = this.tabs(indent + 1);
        
        if (type === 'structured' || type === 'hybrid') {
            const structuredFields = ['Dept', 'SubDept', 'StrtNm', 'BldgNb', 'BldgNm', 'Flr', 'PstBx', 'Room', 'PstCd', 'TwnNm', 'TwnLctnNm'];
            structuredFields.forEach(f => {
                if (v[p + f]) lines.push(`${t}<${f}>${this.e(v[p + f])}</${f}>`);
            });
            // Ctry is only emitted for structured/hybrid, not for unstructured
            if (v[p + 'Ctry']) {
                lines.push(`${t}<Ctry>${this.e(v[p + 'Ctry'])}</Ctry>`);
            }
        }

        if (type === 'unstructured' || type === 'hybrid') {
            // Hybrid allows only 2 lines, Unstructured allows max 3 (restricted per user request)
            const limit = type === 'hybrid' ? 2 : 3;
            [1, 2, 3].slice(0, limit).forEach(i => {
                const val = v[p + 'AdrLine' + i];
                if (val) lines.push(`${t}<AdrLine>${this.e(val)}</AdrLine>`);
            });
        }
        
        if (!lines.length) return '';
        return `${this.tabs(indent)}<PstlAdr>\n${lines.join('\n')}\n${this.tabs(indent)}</PstlAdr>\n`;
    }

    partyIdXml(v: any, p: string, indent = 4): string {
        const type = v[p + 'IdType']; if (!type || type === 'none') return '';
        let res = '';
        if (type === 'org') {
            let org = '';
            if (v[p + 'OrgAnyBIC']) org += this.el('AnyBIC', v[p + 'OrgAnyBIC'], indent + 2);
            if (v[p + 'OrgLEI']) org += this.el('LEI', v[p + 'OrgLEI'], indent + 2);
            if (v[p + 'OrgOthrId']) {
                let othr = this.el('Id', v[p + 'OrgOthrId'], indent + 3);
                if (v[p + 'OrgOthrSchmeNmCd']) othr += this.tag('SchmeNm', this.el('Cd', v[p + 'OrgOthrSchmeNmCd'], indent + 5), indent + 4);
                org += this.tag('Othr', othr, indent + 2);
            }
            res = this.tag('OrgId', org, indent + 1);
        }
        return res ? this.tag('Id', res, indent) : '';
    }

    refreshUetr(): void {
        this.uetrError = null;
        this.uetrSuccess = null;
        if (this.uetrSuccessTimer) clearTimeout(this.uetrSuccessTimer);
        const prevUetr = this.form.get('uetr')?.value || '';
        const newUetr = this.uetrService.generate();
        if (newUetr === prevUetr) return;
        this.form.get('uetr')?.setValue(newUetr);
        this.uetrSuccess = 'UETR refreshed successfully';
        this.uetrSuccessTimer = setTimeout(() => { this.uetrSuccess = null; }, 3000);
    }

    validateManualUetr(): void {
        const val = this.form.get('uetr')?.value;
        this.uetrError = UetrService.UUID_V4_PATTERN.test(val) ? null : 'Invalid UETR format';
    }

    onUetrPaste(_event: ClipboardEvent) {
        setTimeout(() => {
            const ctrl = this.form.get('uetr');
            if (ctrl) {
                ctrl.setValue((ctrl.value || '').toLowerCase());
                this.validateManualUetr();
            }
        }, 0);
    }

    openBicSearch(f: string): void {
        const dialogRef = this.dialog.open(BicSearchDialogComponent, {
            width: '800px',
            disableClose: true
        });
        dialogRef.afterClosed().subscribe(result => {
            if (result && result.bic) {
                const ctrl = this.form.get(f);
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

    syncScroll(editor: HTMLTextAreaElement, gutter: HTMLDivElement) {
        if (gutter) gutter.scrollTop = editor.scrollTop;
    }

    onEditorChange(content: string, fromForm = false) {
        if (!this.isInternalChange && !fromForm) this.pushHistory();
        this.generatedXml = content;
        const lines = content.split('\n').length;
        this.editorLineCount = Array.from({ length: lines }, (_, i) => i + 1);
        if (!fromForm) this.parseXmlToForm(content);
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

    private pushHistory() {
        if (this.xmlHistoryIdx >= 0 && this.xmlHistory[this.xmlHistoryIdx] === this.generatedXml) return;
        if (this.xmlHistoryIdx < this.xmlHistory.length - 1) this.xmlHistory.splice(this.xmlHistoryIdx + 1);
        this.xmlHistory.push(this.generatedXml);
        if (this.xmlHistory.length > this.maxHistory) this.xmlHistory.shift();
        else this.xmlHistoryIdx++;
    }

    private refreshLineCount() {
        const lines = (this.generatedXml || '').split('\n').length;
        this.editorLineCount = Array.from({ length: lines }, (_, i) => i + 1);
    }

    formatXml(showToast = true) {
        if (!this.generatedXml?.trim()) return;
        this.pushHistory();

        try {
            const tab = '  ';
            let formatted = '';
            let indent = '';

            // Normalize XML
            let xml = this.generatedXml.replace(/>\s+</g, '><').trim();

            // Improved regex from pacs8 - ensures proper splitting of nested tags
            const reg = /(<[^/!?][^>]*>[^<]*<\/([^>]+)>)|(<[^>]+\/>)|(<[^>]+>)|(<!--[\s\S]*?-->)|([^<]+)/g;
            const nodes = xml.match(reg) || [];

            nodes.forEach(node => {
                const trimmed = node.trim();
                if (!trimmed) return;

                if (trimmed.startsWith('</')) {
                    // Closing tag - decrease indent before adding
                    if (indent.length >= tab.length) indent = indent.substring(tab.length);
                    formatted += indent + trimmed + '\r\n';
                } else if ((trimmed.startsWith('<') && trimmed.includes('</')) || trimmed.endsWith('/>')) {
                    // One-liner element <tag>val</tag> or self-closing <tag/>
                    formatted += indent + trimmed + '\r\n';
                } else if (trimmed.startsWith('<') && !trimmed.startsWith('<?') && !trimmed.startsWith('<!')) {
                    // Opening tag - add then increase indent
                    formatted += indent + trimmed + '\r\n';
                    indent += tab;
                } else {
                    // Plain text content or XML declaration
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

    parseXmlToForm(xml: string) {
        if (!xml?.trim()) return;
        try {
            const cleanXml = xml.replace(/<(\/?)(?:[\w]+:)/g, '<$1');
            const doc = new DOMParser().parseFromString(cleanXml, 'text/xml');
            if (doc.querySelector('parsererror')) return;

            const patch: any = {};
            Object.keys(this.form.controls).forEach(k => patch[k] = '');

            const tval = (el: Element | Document, tag: string) =>
                el.getElementsByTagName(tag)[0]?.textContent?.trim() || '';

            patch['fromBic'] = doc.getElementsByTagName('Fr')[0]
                ?.getElementsByTagName('BICFI')[0]?.textContent?.trim() || '';
            patch['toBic'] = doc.getElementsByTagName('To')[0]
                ?.getElementsByTagName('BICFI')[0]?.textContent?.trim() || '';
            patch['bizMsgId'] = tval(doc, 'BizMsgIdr');
            patch['msgId'] = tval(doc, 'MsgId');
            patch['creDtTm'] = tval(doc, 'CreDtTm') || tval(doc, 'CreDt');

            const cdtInstr = doc.getElementsByTagName('CdtInstr')[0];
            if (cdtInstr) {
                patch['cdtId'] = tval(cdtInstr, 'CdtId');

                const parseAgt = (tag: string, pfx: string) => {
                    const node = cdtInstr.getElementsByTagName(tag)[0];
                    if (!node) return;
                    const fi = node.getElementsByTagName('FinInstnId')[0];
                    if (fi) {
                        patch[pfx + 'Bic'] = tval(fi, 'BICFI');
                        patch[pfx + 'Name'] = tval(fi, 'Nm');
                        patch[pfx + 'Lei'] = tval(fi, 'LEI');
                        const clr = fi.getElementsByTagName('ClrSysMmbId')[0];
                        if (clr) {
                            patch[pfx + 'ClrSysMmbId'] = tval(clr, 'MmbId');
                            patch[pfx + 'ClrSysCd'] = clr.getElementsByTagName('ClrSysId')[0]
                                ?.getElementsByTagName('Cd')[0]?.textContent?.trim() || '';
                        }
                    }
                };
                parseAgt('InstgAgt', 'instgAgt');
                parseAgt('InstdAgt', 'instdAgt');
                parseAgt('CdtrAgt', 'cdtrAgt');
                parseAgt('Cdtr', 'cdtr');
                parseAgt('Dbtr', 'dbtr');
                parseAgt('DbtrAgt', 'dbtrAgt');

                const drctDbt = cdtInstr.getElementsByTagName('DrctDbtTxInf')[0];
                if (drctDbt) {
                    const pmtId = drctDbt.getElementsByTagName('PmtId')[0];
                    if (pmtId) {
                        patch['instrId'] = tval(pmtId, 'InstrId');
                        patch['endToEndId'] = tval(pmtId, 'EndToEndId');
                        patch['txId'] = tval(pmtId, 'TxId');
                        patch['uetr'] = tval(pmtId, 'UETR');
                        patch['clrSysRef'] = tval(pmtId, 'ClrSysRef');
                    }
                    const amtEl = drctDbt.getElementsByTagName('IntrBkSttlmAmt')[0];
                    if (amtEl) {
                        patch['amount'] = amtEl.textContent?.trim() || '';
                        patch['currency'] = amtEl.getAttribute('Ccy') || '';
                    }
                    patch['intrBkSttlmDt'] = tval(drctDbt, 'IntrBkSttlmDt');
                    const sttlmTmReqEl = drctDbt.getElementsByTagName('SttlmTmReq')[0];
                    if (sttlmTmReqEl) {
                        patch['clstTm'] = tval(sttlmTmReqEl, 'CLSTm');
                        patch['tillTm'] = tval(sttlmTmReqEl, 'TillTm');
                        patch['frTm'] = tval(sttlmTmReqEl, 'FrTm');
                        patch['rjctTm'] = tval(sttlmTmReqEl, 'RjctTm');
                    }
                    const pmtTp = drctDbt.getElementsByTagName('PmtTpInf')[0];
                    if (pmtTp) {
                        patch['instrPrty'] = tval(pmtTp, 'InstrPrty');
                        patch['svcLvlCd'] = pmtTp.getElementsByTagName('SvcLvl')[0]
                            ?.getElementsByTagName('Cd')[0]?.textContent?.trim() || '';
                        patch['svcLvlPrtry'] = pmtTp.getElementsByTagName('SvcLvl')[0]
                            ?.getElementsByTagName('Prtry')[0]?.textContent?.trim() || '';
                        patch['lclInstrmCd'] = pmtTp.getElementsByTagName('LclInstrm')[0]
                            ?.getElementsByTagName('Cd')[0]?.textContent?.trim() || '';
                        patch['lclInstrmPrtry'] = pmtTp.getElementsByTagName('LclInstrm')[0]
                            ?.getElementsByTagName('Prtry')[0]?.textContent?.trim() || '';
                        patch['ctgyPurpCd'] = pmtTp.getElementsByTagName('CtgyPurp')[0]
                            ?.getElementsByTagName('Cd')[0]?.textContent?.trim() || '';
                        patch['ctgyPurpPrtry'] = pmtTp.getElementsByTagName('CtgyPurp')[0]
                            ?.getElementsByTagName('Prtry')[0]?.textContent?.trim() || '';
                    }
                    const purp = drctDbt.getElementsByTagName('Purp')[0];
                    if (purp) {
                        patch['purposeCd'] = tval(purp, 'Cd');
                        patch['purposePrtry'] = tval(purp, 'Prtry');
                    }
                    patch['instrForDbtrAgt'] = tval(drctDbt, 'InstrForDbtrAgt');
                    patch['remittanceInfo'] = drctDbt.getElementsByTagName('RmtInf')[0]
                        ?.getElementsByTagName('Ustrd')[0]?.textContent?.trim() || '';
                }
            }

            this.isParsingXml = true;
            this.form.patchValue(patch, { emitEvent: false });
            this.isParsingXml = false;
        } catch (e) {
            this.isParsingXml = false;
        }
    }

    switchToPreview() {
        this.generateXml();
        this.currentTab = 'preview';
    }

    validateMessage() {
                if (this.bicSameWarning) return;
                // Do NOT regenerate XML here: generatedXml is already kept in sync with the
                // editor via ngModel, and parseXmlToForm is not wired up for this message,
                // so calling generateXml() would silently restore any tag the user just deleted
                // (causing validation to falsely pass).
        this.validateFullMessageErrors();
        if (this.form.invalid) {
            this.form.markAllAsTouched();
        }
        if (!this.generatedXml?.trim()) return;

        this.showValidationModal = true;
        this.validationStatus = 'validating';
        this.validationReport = null;
        this.validationExpandedIssue = null;

        this.http.post(this.config.getApiUrl('/validate'), {
            xml_content: this.generatedXml,
            mode: 'Full 1-3',
            message_type: 'pacs.010.001.10',
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
                    message: 'pacs.010.001.10', total_time_ms: 0,
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

    viewXmlModal() {
        this.closeValidationModal();
        this.switchToPreview();
    }

    editXmlModal() {
        this.closeValidationModal();
        this.currentTab = 'form';
    }

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

    downloadXml() {
        this.generateXml(); // Re-ensure XML is fresh
        const b = new Blob([this.generatedXml], { type: 'application/xml' });
        const a = document.createElement('a'); a.href = URL.createObjectURL(b);
        a.download = `pacs010-${Date.now()}.xml`; a.click();
    }

    copyToClipboard() {
        this.generateXml(); // Re-ensure XML is fresh
        navigator.clipboard.writeText(this.generatedXml).then(() => {
            this.snackBar.open('Copied to clipboard!', 'Close', { duration: 2000 });
        });
    }

    err(c: string): string | null {
        const ctrl = this.form.get(c);
        if (!ctrl || ctrl.valid || (!ctrl.touched && !ctrl.dirty)) return null;
        
        // Hide pattern/format errors if we are showing a maxlen "at limit" hint
        if (this.showMaxLenWarning[c]) {
            const val = ctrl.value?.toString() || '';
            const limit = ctrl.errors?.['maxlength']?.requiredLength;
            if (limit && val.length >= limit) return null;
            if (c.toLowerCase().includes('bic') && val.length >= 11) return null;
        }

        const tFields = ['clstTm', 'tillTm', 'frTm', 'rjctTm'];
        if (tFields.includes(c) && ctrl!.errors?.['pattern'])
            return 'Invalid time format. Must include timezone offset (e.g., 09:00:00+05:30).';

        // ISO 20022 MX address field validation
        const cl = c.toLowerCase();
        if (cl.includes('bldgnb') || cl.includes('pstcd') || cl.includes('pstbx') || cl.includes('bldgnm') || cl.includes('twnnm') || cl.includes('twnlctn') || cl.includes('dstrctnm') || cl.includes('ctrysubdvsn') || cl.includes('strtnm') || cl.includes('dept') || cl.includes('subdept') || cl.includes('flr') || cl.includes('room') || cl.includes('adrline')) {
            if (ctrl!.errors?.['pattern']) return 'Invalid character. Only ISO 20022 MX allowed characters permitted.';
        }

        if (ctrl!.errors?.['required']) return 'Required field.';

        if (c === 'svcLvlCd') return 'Invalid Service Level Code. Must be 1-4 alphanumeric characters.';
        if (c === 'svcLvlPrtry') return 'Invalid Proprietary Service Level. Up to 35 characters allowed.';
        if (c === 'lclInstrmCd') return 'Invalid Local Instrument Code. Must be 1-4 alphanumeric characters.';
        if (c === 'lclInstrmPrtry') return 'Invalid Proprietary Local Instrument. Up to 35 characters allowed.';
        if (c === 'ctgyPurpPrtry') return 'Invalid Proprietary Category Purpose. Up to 35 characters allowed.';
        if (c === 'purposePrtry') return 'Invalid Proprietary Purpose. Up to 35 characters allowed.';
        if (c === 'purposeCd') return 'Invalid Purpose Code. Please select from the list or enter a valid ISO 20022 Purpose Code.';
        if (c === 'ctgyPurpCd') return 'Invalid Category Purpose Code. Please select from the list or enter a valid ISO 20022 Purpose Code.';
        if (c === 'clrSysRef') return 'Invalid Pattern (Alphanumeric and standard special characters only, max 35 chars).';

        if (ctrl!.errors?.['maxlength']) return `Max ${ctrl!.errors!['maxlength'].requiredLength} chars.`;

        if (ctrl!.errors?.['pattern']) {
            if (cl.includes('bic')) return 'Valid 8 or 11-char BIC required.';
            if (cl.includes('iban')) return 'Valid 34-char IBAN required.';
            if (cl.includes('lei')) return 'Must be 20-char LEI.';
            if (cl.includes('ctry') || cl.includes('country')) return '2-letter ISO code required.';
            
            return 'Invalid format.';
        }

        if (ctrl!.errors?.['target2']) return 'T2 requires EUR.';
        if (ctrl!.errors?.['chaps']) return 'CHAPS requires GBP.';
        if (ctrl!.errors?.['chips']) return 'CHIPS requires USD.';
        if (ctrl!.errors?.['fed']) return 'FED requires USD.';
        if (ctrl!.errors?.['forbidden']) return 'Clearing System Reference must NOT be sent if no active clearing system is used.';
        if (ctrl!.errors?.['linked']) return 'Name and Address must always be present together.';
        return 'Invalid value.';
    }

    hint(f: string, maxLen: number): string | null {
        if (!this.showMaxLenWarning[f]) return null;
        const c = this.form.get(f);
        if (!c || !c.value) return null;
        const len = c.value.toString().length;
        if (len >= maxLen) return `Maximum ${maxLen} characters reached (${len}/${maxLen})`;
        return null;
    }

    @HostListener('keydown', ['$event'])
    onKeyDown(event: KeyboardEvent) {
        // 1. History & Formatting Shortcuts
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
        
        const name = target.getAttribute('formControlName') || target.getAttribute('name');
        if (!name) return;

        // Allow system/control keys (Backspace, Delete, Arrow keys, Tab, etc.)
        const controlKeys = ['Backspace', 'Delete', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Tab', 'Enter', 'Home', 'End', 'Escape'];
        if (controlKeys.includes(event.key) || event.ctrlKey || event.metaKey || event.altKey) return;

        const val = target.value || '';
        const key = event.key;

        // 1. Max length restriction (Warning & Block)
        const maxLen = target.maxLength;
        if (maxLen > 0 && val.length >= maxLen && target.selectionStart === target.selectionEnd) {
            if (event.key.length === 1 && !event.ctrlKey && !event.altKey && !event.metaKey) {
                this.showMaxLenWarning[name] = true;
                if (this.warningTimeouts[name]) clearTimeout(this.warningTimeouts[name]);
                this.warningTimeouts[name] = setTimeout(() => this.showMaxLenWarning[name] = false, 3000);
            }
        }

        const n = name.toLowerCase();

        // 2. Character-level restrictions
        // Numeric only (Amount, nbOfTxs)
        if (n.includes('amount') || n === 'nboftxs') {
            if (!/^[0-9.]$/.test(key)) {
                // restriction removed;
            }
            if (key === '.' && val.includes('.')) {
                // restriction removed;
            }
        }
        
        // BIC/IBAN (Alphanumeric only)
        if (n.includes('bic') || n.includes('iban')) {
            if (!/^[A-Za-z0-9]$/.test(key)) {
                // restriction removed;
            }
        }

        // LEI (Alphanumeric only)
        if (n.includes('lei')) {
            if (!/^[A-Za-z0-9]$/.test(key)) {
                // restriction removed;
            }
        }

        // UETR (Hex + dashes)
        if (n === 'uetr') {
            if (!/^[a-fA-F0-9\-]$/.test(key)) {
                // restriction removed;
            }
        }

        // ISO 20022 MX character set restriction for all other text fields
        const mxSetRegex = /^[a-zA-Z0-9\/\-\?:\(\)\.,\+' ]*$/;
        if (target.type === 'text' || target.type === 'textarea') {
            if (!mxSetRegex.test(key)) {
                // restriction removed;
            }
        }
    }

    @HostListener('input', ['$event'])
    onInput(event: any) {
        const target = event.target as HTMLInputElement;
        if (!target) return;
        const name = target.getAttribute('formControlName') || target.getAttribute('name');
        if (!name) return;

        const maxLen = target.maxLength;
        let val = target.value || '';

        // Sanitize input (especially after paste) - Strip literal escape characters
        val = val.replace(/\\n/g, '').replace(/\\t/g, '');
        
        const n = name.toLowerCase();
        if (n.includes('amount') || n === 'nboftxs') {
            // sanitization removed
            const parts = val.split('.');
            if (parts.length > 2) val = parts[0] + '.' + parts.slice(1).join('');
        }
        if (n.includes('bic') || n.includes('iban') || n.includes('lei')) {
            // sanitization removed
        }

        // Enforce casing
        if (n.includes('bic') || n.includes('iban') || n.includes('ctry') || n === 'purposecd' || n === 'ctgypurpcd' || n === 'svclvlcd' || n === 'lclinstrmcd') {
            val = val.toUpperCase();
        }

        // Hard trim for maxlength (Paste protection)
        if (maxLen > 0 && val.length > maxLen) {
            val = val.substring(0, maxLen);
        }

        if (target.value !== val) {
            const start = target.selectionStart;
            const end = target.selectionEnd;
            target.value = val;
            if (start !== null && end !== null) target.setSelectionRange(start, end);
            this.form.get(name)?.setValue(val, { emitEvent: false });
        }

        // Max length warning hints
        if (maxLen > 0 && val.length >= maxLen) {
            this.showMaxLenWarning[name] = true;
            if (this.warningTimeouts[name]) clearTimeout(this.warningTimeouts[name]);
            this.warningTimeouts[name] = setTimeout(() => this.showMaxLenWarning[name] = false, 3000);
        } else {
            this.showMaxLenWarning[name] = false;
        }
    }

    private scrollToFirstError() {
        setTimeout(() => {
            const firstInvalid = document.querySelector('.ng-invalid.ng-touched, .ng-invalid.ng-dirty');
            if (firstInvalid) {
                firstInvalid.scrollIntoView({ behavior: 'smooth', block: 'center' });
                (firstInvalid as HTMLElement).focus();
            }
        }, 100);
    }

    hasSectionError(prefixes: string[]): boolean {
        return prefixes.some(p => {
            return Object.keys(this.form.controls).some(key => 
                key.startsWith(p) && 
                this.form.get(key)?.invalid && 
                (this.form.get(key)?.touched || this.form.get(key)?.dirty)
            );
        });
    }

    private formatAmount(val: any): string {
        if (!val) return '0.00';
        let numStr = val.toString().trim().replace(/,/g, '');
        const num = parseFloat(numStr);
        return isNaN(num) ? '0.00' : num.toFixed(2);
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

    openBicSearchGroup(controlName: string, group: FormGroup | any): void {
        const dialogRef = this.dialog.open(BicSearchDialogComponent, { width: '800px', disableClose: true });
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
}
