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
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
import { BicSearchDialogComponent } from '../bic-search-dialog/bic-search-dialog.component';
import { debounceTime } from 'rxjs/operators';

@Component({
    selector: 'app-pacs4',
    standalone: true,
    imports: [CommonModule, ReactiveFormsModule, FormsModule, MatIconModule, MatSnackBarModule, MatTooltipModule, MatDialogModule],
    templateUrl: './pacs4.component.html',
    styleUrl: './pacs4.component.css'
})
export class Pacs4Component implements OnInit, OnDestroy {
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
    chargeBearers = ['CRED', 'SHAR', 'SLEV'];
    sttlmMethods = ['INDA', 'INGA', 'COVE', 'CLRG'];
    returnReasons = [
        'AC01', 'AC04', 'AC06', 'AG01', 'AG02', 'AM01', 'AM02', 'AM03', 'AM04', 'AM05', 
        'AM06', 'AM07', 'AM09', 'AM10', 'BE01', 'BE04', 'BE05', 'BE06', 'BE07', 'DNOR', 
        'ERIN', 'FF01', 'MD01', 'MD07', 'MS02', 'MS03', 'RC01', 'RR01', 'RR02', 'RR03', 'RR04'
    ];

    agentPrefixes = ['instgAgt', 'instdAgt', 'initgPty', 'dbtr', 'dbtrAgt', 'cdtrAgt', 'cdtr', 'ultmtDbtr', 'ultmtCdtr'];

    private readonly DRAFT_KEY = 'draft_pacs004';
    private draftSaveTimer: ReturnType<typeof setTimeout> | null = null;
    showDraftBanner = false;
    isClearingDraft = false;

    // Validation Modal State
    showValidationModal = false;
    validationStatus: 'idle' | 'validating' | 'done' = 'idle';
    validationReport: any = null;
    validationExpandedIssue: any = null;

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
        
        // Auto-sync AppHdr BICs (bidirectional)
        this.form.get('fromBic')?.valueChanges.subscribe(v => this.form.patchValue({ instgAgtBic: v }, { emitEvent: false }));
        this.form.get('toBic')?.valueChanges.subscribe(v => this.form.patchValue({ instdAgtBic: v }, { emitEvent: false }));
        this.form.get('instgAgtBic')?.valueChanges.subscribe(v => this.form.patchValue({ fromBic: v }, { emitEvent: false }));
        this.form.get('instdAgtBic')?.valueChanges.subscribe(v => this.form.patchValue({ toBic: v }, { emitEvent: false }));

        this.form.get('currency')?.valueChanges.subscribe(() => {
            this.updateAmountValidator('amount', 'currency');
        });
        this.form.get('orgnlCurrency')?.valueChanges.subscribe(() => {
            this.updateAmountValidator('orgnlAmount', 'orgnlCurrency');
        });

        const hadDraft = this.loadDraft();
        if (hadDraft) {
          this.showDraftBanner = true;
          this.generateXml();
        }

        this.form.valueChanges.pipe(debounceTime(300)).subscribe(() => {
            this.updateConditionalValidators();
            this.generateXml();
            this.scheduleDraftSave();
        });

        this.pushHistory();
        this.updateAmountValidator('amount', 'currency');
        this.updateAmountValidator('orgnlAmount', 'orgnlCurrency');
        this.updateConditionalValidators();
    }

    private updateConditionalValidators() {
        const ADDR_PAT = Validators.pattern(/^[a-zA-Z0-9\/\-\?:\(\)\.,\+' ]+$/);
        this.agentPrefixes.forEach(p => {
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

    @HostListener('keydown', ['$event'])
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
                if (start !== null && end !== null) target.setSelectionRange(start, end);
                this.form.get(name)?.patchValue(upperValue, { emitEvent: false });
            }
        }
    }

    fetchCodelists() {
        this.http.get<any>(this.config.getApiUrl('/codelists/currency')).subscribe({
            next: (res) => {
                if (res?.codes) {
                    this.currencies = res.codes;
                    this.currencyPrecision = res.currencies || {};
                    this.updateAmountValidator('amount', 'currency');
                    this.updateAmountValidator('orgnlAmount', 'orgnlCurrency');
                }
            }
        });
        this.http.get<any>(this.config.getApiUrl('/codelists/country')).subscribe({ next: (res) => { if (res?.codes) this.countries = res.codes; } });
    }

    private buildForm() {
        const BIC = [Validators.pattern(/^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$/)]; // BIC is optional for some agts
        const BIC_REQ = [Validators.required, Validators.pattern(/^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$/)];
        const SAFE_NAME = Validators.pattern(/^[a-zA-Z0-9 .,()'\-]+$/);
        const ADDR_PATTERN = Validators.pattern(/^[a-zA-Z0-9\/\-\?:\(\)\.,\+' ]+$/);

        const c: any = {
            fromBic: ['BBBBUS33XXX', BIC_REQ],
            toBic: ['CCCCGB2LXXX', BIC_REQ],
            bizMsgId: ['RTR-2026-FI-001', [Validators.required, Validators.maxLength(35)]],
            msgId: ['RTR-2026-FI-001', [Validators.required, Validators.maxLength(35)]],
            creDtTm: [this.isoNow(), Validators.required],
            nbOfTxs: ['1', [Validators.required, Validators.pattern(/^1$/)]],
            sttlmMtd: ['INDA', Validators.required],

            rtrId: ['RTR-TX-001', [Validators.required, Validators.maxLength(35)]],
            orgnlInstrId: ['INSTR-ORIG-001', [Validators.required, Validators.maxLength(35)]],
            orgnlEndToEndId: ['E2E-ORIG-001', [Validators.required, Validators.maxLength(35)]],
            orgnlTxId: ['TX-ORIG-001', [Validators.required, Validators.maxLength(35)]],
            orgnlUETR: ['550e8400-e29b-41d4-a716-446655440000', [Validators.required, Validators.pattern(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/)]],

            amount: ['50000.00', [Validators.required, Validators.pattern(/^\d{1,13}(\.\d{1,5})?$/)]],
            currency: ['USD', Validators.required],
            sttlmDt: [new Date().toISOString().split('T')[0], [Validators.required, Validators.pattern(/^\d{4}-\d{2}-\d{2}$/)]],
            chrgBr: ['SHAR', Validators.required],

            orgnlAmount: ['50000.00', [Validators.required, Validators.pattern(/^\d{1,13}(\.\d{1,5})?$/)]],
            orgnlCurrency: ['USD', Validators.required],
            orgnlSttlmDt: [new Date().toISOString().split('T')[0], [Validators.required, Validators.pattern(/^\d{4}-\d{2}-\d{2}$/)]],

            orgnlMsgId: ['ORIG-REF-001', [Validators.required, Validators.maxLength(35)]],
            orgnlMsgNmId: ['pacs.008.001.08', [Validators.required, Validators.pattern(/^pacs\.\d{3}\.\d{3}\.\d{2}$/)]],

            rtrRsnCd: ['MS03', [Validators.required, Validators.maxLength(4)]],
            rtrRsnAddtlInf: ['', [Validators.maxLength(105), ADDR_PATTERN]],
        };

        this.agentPrefixes.forEach(p => {
            const isMandatory = (p === 'dbtr' || p === 'cdtr');
            let defaultBic = (p === 'dbtr' || p === 'instgAgt' || p === 'dbtrAgt') ? 'BBBBUS33XXX' : 'CCCCGB2LXXX';
            if (p === 'initgPty' || p === 'ultmtDbtr' || p === 'ultmtCdtr') defaultBic = '';

            c[p + 'Bic'] = [isMandatory ? defaultBic : (defaultBic || ''), isMandatory ? BIC_REQ : BIC];
            // OrgAnyBIC is used by the party template (isAgent:false) for non-agent party BIC fields
            const isParty = ['dbtr', 'cdtr', 'initgPty', 'ultmtDbtr', 'ultmtCdtr'].includes(p);
            if (isParty) c[p + 'OrgAnyBIC'] = [isMandatory ? defaultBic : '', isMandatory ? BIC_REQ : BIC];
            c[p + 'Name'] = [isMandatory ? (p === 'dbtr' ? 'Original Debtor' : 'Original Creditor') : '', [Validators.maxLength(140), SAFE_NAME]];

            if (isMandatory) {
                const isDbtr = p === 'dbtr';
                c[p + 'AddrType'] = ['hybrid'];
                c[p + 'Ctry'] = [isDbtr ? 'US' : 'GB', Validators.pattern(/^[A-Z]{2,2}$/)];
                c[p + 'TwnNm'] = [isDbtr ? 'New York' : 'London', [Validators.maxLength(35), ADDR_PATTERN]];
                c[p + 'StrtNm'] = [isDbtr ? '123 Business Street' : '456 Commerce Avenue', [Validators.maxLength(70), ADDR_PATTERN]];
                c[p + 'AdrLine1'] = [isDbtr ? '123 Business Street, New York' : '456 Commerce Avenue, London', [Validators.maxLength(70), ADDR_PATTERN]];
                c[p + 'AdrLine2'] = ['', [Validators.maxLength(70), ADDR_PATTERN]];
            } else {
                c[p + 'AddrType'] = ['none'];
                c[p + 'Ctry'] = ['', Validators.pattern(/^[A-Z]{2,2}$/)];
                c[p + 'TwnNm'] = ['', [Validators.maxLength(35), ADDR_PATTERN]];
                c[p + 'StrtNm'] = ['', [Validators.maxLength(70), ADDR_PATTERN]];
                c[p + 'AdrLine1'] = ['', [Validators.maxLength(70), ADDR_PATTERN]];
                c[p + 'AdrLine2'] = ['', [Validators.maxLength(70), ADDR_PATTERN]];
            }

            c[p + 'BldgNb'] = ['', [Validators.maxLength(16), ADDR_PATTERN]];
            c[p + 'BldgNm'] = ['', [Validators.maxLength(35), ADDR_PATTERN]];
            c[p + 'PstCd'] = ['', [Validators.maxLength(16), ADDR_PATTERN]];
            c[p + 'Acct'] = ['', [Validators.pattern(/^[A-Z0-9]{5,34}$/)]];

            c[p + 'MmbId'] = ['', [Validators.maxLength(35), ADDR_PATTERN]];
            c[p + 'ClrSysCd'] = [''];
            c[p + 'Lei'] = ['', [Validators.pattern(/^[A-Z0-9]{18}[0-9]{2}$/)]];
        });

        this.form = this.fb.group(c);
    }

    private updateAmountValidator(field: string, currencyField: string) {
        const ccy = this.form.get(currencyField)?.value;
        const precision = this.currencyPrecision[ccy] ?? 2;
        const amountCtrl = this.form.get(field);
        
        const pattern = precision > 0 
            ? new RegExp(`^\\d{1,13}(\\.\\d{1,${precision}})?$`)
            : new RegExp(`^\\d{1,13}$`);
        
        amountCtrl?.setValidators([Validators.required, Validators.pattern(pattern)]);
        amountCtrl?.updateValueAndValidity({ emitEvent: false });
    }

    err(f: string): string | null {
        const c = this.form.get(f);
        if (!c || c.valid || (!c.touched && !c.dirty)) return null;
        if (c.errors?.['required']) return 'Required field.';
        if (c.errors?.['maxlength']) return `Max ${c.errors['maxlength'].requiredLength} chars.`;
        if (c.errors?.['pattern']) {
            if (f === 'amount' || f === 'orgnlAmount') {
                const ccyField = f === 'amount' ? 'currency' : 'orgnlCurrency';
                const ccy = this.form.get(ccyField)?.value;
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
            return 'Invalid format/pattern.';
        }
        return 'Invalid value.';
    }

    hint(f: string, maxLen: number): string | null {
        if (!this.showMaxLenWarning[f]) return null;
        const c = this.form.get(f);
        if (!c || !c.value) return null;
        const len = c.value.toString().length;
        return len >= maxLen ? `Maximum ${maxLen} characters reached (${len}/${maxLen})` : null;
    }

    isoNow(): string {
        const d = new Date(), p = (n: number) => n.toString().padStart(2, '0');
        const off = -d.getTimezoneOffset(), s = off >= 0 ? '+' : '-';
        return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}${s}${p(Math.floor(Math.abs(off) / 60))}:${p(Math.abs(off) % 60)}`;
    }

    fdt(dt: string): string {
        if (!dt) return dt;
        let s = dt.trim().replace(/\.\d+/, '').replace('Z', '+00:00');
        if (s && !/([+-]\d{2}:\d{2})$/.test(s)) s += '+00:00';
        return s;
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
        const creDtTm = v.creDtTm || this.isoNow();

        // Transaction Info
        let tx = '';
        
        tx += this.el('RtrId', v.rtrId, 4);

        let orgnlGrpInf = this.el('OrgnlMsgId', v.orgnlMsgId, 5) + this.el('OrgnlMsgNmId', v.orgnlMsgNmId, 5);
        if (v.orgnlCreDtTm) orgnlGrpInf += this.el('OrgnlCreDtTm', this.fdt(v.orgnlCreDtTm), 5);
        tx += this.tag('OrgnlGrpInf', orgnlGrpInf, 4);

        tx += this.el('OrgnlInstrId', v.orgnlInstrId, 4);
        tx += this.el('OrgnlEndToEndId', v.orgnlEndToEndId, 4);
        tx += this.el('OrgnlTxId', v.orgnlTxId, 4);
        tx += this.el('OrgnlUETR', v.orgnlUETR, 4); 
        
        if (v.orgnlAmount) {
            tx += `${this.tabs(4)}<OrgnlIntrBkSttlmAmt Ccy="${this.e(v.orgnlCurrency)}">${this.formatting.formatAmount(v.orgnlAmount, v.orgnlCurrency)}</OrgnlIntrBkSttlmAmt>\n`;
        }
        tx += this.el('OrgnlIntrBkSttlmDt', v.orgnlSttlmDt, 4);

        tx += `\t\t\t\t<RtrdIntrBkSttlmAmt Ccy="${this.e(v.currency)}">${this.formatting.formatAmount(v.amount, v.currency)}</RtrdIntrBkSttlmAmt>\n`;
        tx += this.el('IntrBkSttlmDt', v.sttlmDt, 4); 
        tx += this.el('ChrgBr', v.chrgBr, 4);

        tx += this.agt('InstgAgt', 'instgAgt', v, 4);
        tx += this.agt('InstdAgt', 'instdAgt', v, 4);

        let rtrChain = '';
        rtrChain += this.party('UltmtDbtr', 'ultmtDbtr', v, 5);
        rtrChain += this.party('Dbtr', 'dbtr', v, 5);
        rtrChain += this.agt('DbtrAgt', 'dbtrAgt', v, 5);
        rtrChain += this.agt('CdtrAgt', 'cdtrAgt', v, 5);
        rtrChain += this.party('Cdtr', 'cdtr', v, 5);
        rtrChain += this.party('UltmtCdtr', 'ultmtCdtr', v, 5);
        tx += this.tag('RtrChain', rtrChain, 4);

        let rtrRsnInner = this.tag('Rsn', this.el('Cd', v.rtrRsnCd, 6), 5);
        if (v.rtrRsnAddtlInf) rtrRsnInner += this.el('AddtlInf', v.rtrRsnAddtlInf, 5);
        tx += this.tag('RtrRsnInf', rtrRsnInner, 4);

        // Final Document Assembly
        this.generatedXml = `<?xml version="1.0" encoding="UTF-8"?>
<BusMsgEnvlp xmlns="urn:swift:xsd:envelope">
\t<AppHdr xmlns="urn:iso:std:iso:20022:tech:xsd:head.001.001.02">
\t\t<Fr>
\t\t\t<FIId>
\t\t\t\t<FinInstnId>
\t\t\t\t\t<BICFI>${this.e(v.fromBic)}</BICFI>
\t\t\t\t</FinInstnId>
\t\t\t</FIId>
\t\t</Fr>
\t\t<To>
\t\t\t<FIId>
\t\t\t\t<FinInstnId>
\t\t\t\t\t<BICFI>${this.e(v.toBic)}</BICFI>
\t\t\t\t</FinInstnId>
\t\t\t</FIId>
\t\t</To>
\t\t<BizMsgIdr>${this.e(v.bizMsgId)}</BizMsgIdr>
\t\t<MsgDefIdr>pacs.004.001.09</MsgDefIdr>
\t\t<BizSvc>swift.cbprplus.02</BizSvc>
\t\t<CreDt>${creDtTm}</CreDt>
\t</AppHdr>
\t<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pacs.004.001.09">
\t\t<PmtRtr>
\t\t\t<GrpHdr>
\t\t\t\t<MsgId>${this.e(v.msgId)}</MsgId>
\t\t\t\t<CreDtTm>${creDtTm}</CreDtTm>
\t\t\t\t<NbOfTxs>1</NbOfTxs>
\t\t\t\t<SttlmInf>
\t\t\t\t\t<SttlmMtd>${this.e(v.sttlmMtd)}</SttlmMtd>
\t\t\t\t</SttlmInf>
\t\t\t</GrpHdr>
\t\t\t<TxInf>
${tx}\t\t\t</TxInf>
\t\t</PmtRtr>
\t</Document>
</BusMsgEnvlp>`;

        this.formatXml(false);
        this.onEditorChange(this.generatedXml, true);
    }

    // --- XML Helpers ---
    private e(v: string) { return (v || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
    private tabs(n: number) { return '\t'.repeat(n); }
    private el(tag: string, val: string, indent = 3) { return val?.trim() ? `${this.tabs(indent)}<${tag}>${this.e(val)}</${tag}>\n` : ''; }
    private tag(tag: string, content: string, indent = 3) { return content?.trim() ? `${this.tabs(indent)}<${tag}>\n${content}${this.tabs(indent)}</${tag}>\n` : ''; }

    agt(tag: string, prefix: string, v: any, indent = 4) {
        const bic = v[prefix + 'Bic'];
        const lei = v[prefix + 'Lei'];
        const mmbId = v[prefix + 'MmbId'];
        const clrSys = v[prefix + 'ClrSysCd'];

        if (!bic && !lei && !mmbId) return '';

        let fi = '';
        if (bic) fi += this.el('BICFI', bic, indent + 2);
        if (mmbId) {
            let clr = '';
            if (clrSys) clr += this.tag('ClrSysId', this.el('Cd', clrSys, indent + 5), indent + 4);
            clr += this.el('MmbId', mmbId, indent + 4);
            fi += this.tag('ClrSysMmbId', clr, indent + 2);
        }
        if (lei) fi += this.el('LEI', lei, indent + 2);

        const finInstnId = this.tag('FinInstnId', fi, indent + 1);
        return this.tag(tag, finInstnId, indent);
    }

    party(tag: string, prefix: string, v: any, indent = 4) {
        // OrgAnyBIC is used by the party form template (isAgent:false); fall back to Bic for agents
        const bic = v[prefix + 'OrgAnyBIC'] || v[prefix + 'Bic'];
        const name = (v[prefix + 'Name'] || '').trim();
        const lei = v[prefix + 'Lei'];

        if (!bic && !name && !lei && (v[prefix + 'AddrType'] === 'none' || !v[prefix + 'AddrType'])) return '';

        let pty = '';
        if (name) pty += this.el('Nm', name, indent + 2);
        pty += this.addrXml(v, prefix, indent + 2);

        if (bic) pty += this.tag('Id', this.tag('OrgId', this.el('AnyBIC', bic, indent + 5), indent + 4), indent + 2);
        else if (lei) pty += this.tag('Id', this.tag('OrgId', this.el('LEI', lei, indent + 5), indent + 4), indent + 2);

        let res = this.tag(tag, this.tag('Pty', pty, indent + 1), indent);
        if (v[prefix + 'Acct']) {
            const acct = this.tag('Id', this.tag('Othr', this.el('Id', v[prefix + 'Acct'], indent + 3), indent + 2), indent + 1);
            res += this.tag(tag + 'Acct', acct, indent);
        }
        return res;
    }

    addrXml(v: any, p: string, indent = 4): string {
        const type = v[p + 'AddrType'];
        if (!type || type === 'none') return '';
        
        let content = '';
        if (['structured', 'hybrid'].includes(type)) {
            if (v[p + 'StrtNm']) content += this.el('StrtNm', v[p + 'StrtNm'], indent + 1);
            if (v[p + 'BldgNb']) content += this.el('BldgNb', v[p + 'BldgNb'], indent + 1);
            if (v[p + 'BldgNm']) content += this.el('BldgNm', v[p + 'BldgNm'], indent + 1);
            if (v[p + 'PstCd']) content += this.el('PstCd', v[p + 'PstCd'], indent + 1);
        }
        if (v[p + 'TwnNm']) content += this.el('TwnNm', v[p + 'TwnNm'], indent + 1);
        if (v[p + 'Ctry']) content += this.el('Ctry', v[p + 'Ctry'], indent + 1);
        if (['unstructured', 'hybrid'].includes(type)) {
            if (v[p + 'AdrLine1']) content += this.el('AdrLine', v[p + 'AdrLine1'], indent + 1);
            if (v[p + 'AdrLine2']) content += this.el('AdrLine', v[p + 'AdrLine2'], indent + 1);
        }
        return content ? this.tag('PstlAdr', content, indent) : '';
    }

    onEditorChange(content: string, fromForm = false) {
        if (!this.isInternalChange && !fromForm) this.pushHistory();
        this.generatedXml = content;
        this.refreshLineCount();
        if (fromForm || this.isParsingXml) return;
        this.parseXmlToForm(content);
    }
    
    private refreshLineCount() {
        const lines = this.generatedXml ? this.generatedXml.split('\n').length : 1;
        this.editorLineCount = Array.from({ length: lines }, (_, i) => i + 1);
    }

    syncScroll(editor: HTMLTextAreaElement, gutter: HTMLDivElement) {
        gutter.scrollTop = editor.scrollTop;
    }

    private parseXmlToForm(content: string) {
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
            // every control to '' on each XML edit, silently dropping user data for
            // any form field not covered by the parser.

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
                patch.nbOfTxs = tval('NbOfTxs', grpHdr);
                patch.sttlmMtd = tval('SttlmMtd', getT('SttlmInf', grpHdr) || grpHdr);
            }

            const tx = getT('TxInf');
            if (tx) {
                patch.rtrId = tval('RtrId', tx);
                const orgId = getT('OrgnlGrpInf', tx) || tx;
                patch.orgnlMsgId = tval('OrgnlMsgId', orgId);
                patch.orgnlMsgNmId = tval('OrgnlMsgNmId', orgId);

                const txId = getT('OrgnlTxRef', tx) || tx;
                patch.orgnlInstrId = tval('OrgnlInstrId', txId);
                patch.orgnlEndToEndId = tval('OrgnlEndToEndId', txId);
                patch.orgnlTxId = tval('OrgnlTxId', txId);
                patch.orgnlUETR = tval('OrgnlUETR', txId);

                const amtEl = getT('RtrdIntrBkSttlmAmt', tx) || getT('IntrBkSttlmAmt', tx);
                if (amtEl) {
                    patch.amount = amtEl.textContent?.trim() || '';
                    patch.currency = amtEl.getAttribute('Ccy') || '';
                }
                patch.sttlmDt = tval('IntrBkSttlmDt', tx);

                const orgAmtEl = getT('OrgnlIntrBkSttlmAmt', tx);
                if (orgAmtEl) {
                    patch.orgnlAmount = orgAmtEl.textContent?.trim() || '';
                    patch.orgnlCurrency = orgAmtEl.getAttribute('Ccy') || '';
                }
                patch.orgnlSttlmDt = tval('OrgnlIntrBkSttlmDt', tx);

                patch.chrgBr = tval('ChrgBr', tx);

                const rsnInf = getT('RtrRsnInf', tx);
                if (rsnInf) {
                    patch.rtrRsnCd = tval('Cd', getT('Rsn', rsnInf) || rsnInf);
                    patch.rtrRsnAddtlInf = tval('AddtlInf', rsnInf);
                }

                const mapAgt = (p: string, tag: string, parent: any = tx) => {
                    const el = getT(tag, parent);
                    if (!el) return;
                    const fi = getT('FinInstnId', el);
                    if (fi) {
                        patch[p + 'Bic'] = tval('BICFI', fi);
                        patch[p + 'Lei'] = tval('LEI', fi);
                        patch[p + 'Name'] = tval('Nm', fi);
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
                };

                mapAgt('instgAgt', 'InstgAgt');
                mapAgt('instdAgt', 'InstdAgt');
                mapAgt('dbtrAgt', 'DbtrAgt');
                mapAgt('cdtrAgt', 'CdtrAgt');
                mapParty('dbtr', 'Dbtr');
                mapParty('cdtr', 'Cdtr');
                mapParty('initgPty', 'InitgPty');
                mapParty('ultmtDbtr', 'UltmtDbtr');
                mapParty('ultmtCdtr', 'UltmtCdtr');
            }

            this.form.patchValue(patch, { emitEvent: false });
        } catch (e) {
            console.warn('XML Parse failed', e);
        } finally {
            this.isParsingXml = false;
        }
    }

    private pushHistory() {
        if (this.xmlHistoryIdx < this.xmlHistory.length - 1) this.xmlHistory.splice(this.xmlHistoryIdx + 1);
        this.xmlHistory.push(this.generatedXml);
        if (this.xmlHistory.length > this.maxHistory) this.xmlHistory.shift();
        else this.xmlHistoryIdx++;
    }

    undoXml() { if (this.xmlHistoryIdx > 0) { this.isInternalChange = true; this.generatedXml = this.xmlHistory[--this.xmlHistoryIdx]; setTimeout(()=>this.isInternalChange=false,10); } }
    redoXml() { if (this.xmlHistoryIdx < this.xmlHistory.length - 1) { this.isInternalChange = true; this.generatedXml = this.xmlHistory[++this.xmlHistoryIdx]; setTimeout(()=>this.isInternalChange=false,10); } }
    canUndoXml() { return this.xmlHistoryIdx > 0; }
    canRedoXml() { return this.xmlHistoryIdx < this.xmlHistory.length - 1; }

    copyToClipboard() { navigator.clipboard.writeText(this.generatedXml).then(() => this.snackBar.open('Copied!', 'Close', { duration: 2000 })); }
    downloadXml() { const b = new Blob([this.generatedXml], { type: 'application/xml' }); const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = `pacs004-${Date.now()}.xml`; a.click(); }

    validateMessage() {
                if (this.bicSameWarning) return;
                this.showValidationModal = true;
        this.validationStatus = 'validating';
        this.http.post(this.config.getApiUrl('/validate'), {
            xml_content: this.generatedXml,
            mode: 'Full 1-3',
            message_type: 'pacs.004.001.09',
            store_in_history: true
        }).subscribe({
            next: (data: any) => { this.validationReport = data; this.clearDraft(); this.validationStatus = 'done'; },
            error: (err) => { this.validationStatus = 'done'; this.snackBar.open('Backend Error', 'Close', { duration: 3000 }); }
        });
    }

    closeValidationModal() { this.showValidationModal = false; }
    getValidationLayers() { return this.validationReport?.layer_status ? Object.keys(this.validationReport.layer_status) : []; }
    isLayerPass(k: string) { return this.getLayerStatus(k).includes('✅'); }
  isLayerFail(k: string) { return this.getLayerStatus(k).includes('❌'); }
  isLayerWarn(k: string) {
    const s = this.getLayerStatus(k);
    return s.includes('⚠') || s.includes('WARNING') || s.includes('WARN');
  }
    getLayerName(k: string) { const m: any = { '1': 'Syntax & Format', '2': 'Schema Validation', '3': 'Business Rules' }; return m[k] || `Layer ${k}`; }
    getLayerTime(k: string) { return this.validationReport.layer_status[k]?.time || 0; }
    getLayerStatus(k: string) { return this.validationReport?.layer_status[k]?.status || 'IDLE'; }
    getValidationIssues() { return this.validationReport?.details || []; }
    toggleValidationIssue(i: any) { this.validationExpandedIssue = this.validationExpandedIssue === i ? null : i; }

    refreshUetr() { this.form.patchValue({ orgnlUETR: this.uetrService.generate() }); this.uetrSuccess = 'New UETR generated'; setTimeout(()=>this.uetrSuccess=null,3000); }
    validateManualUetr() { /* Optional logic if service available */ }
    onUetrPaste(e: any) { /* Optional logic */ }

    formatXml(showToast = true) {
        if (!this.generatedXml?.trim()) return;
        try {
            this.pushHistory();
            const tab = '    ';
            let formatted = '';
            let indent = '';

            // Normalize XML by removing whitespace between tags but preserving it elsewhere
            let xml = this.generatedXml.replace(/>\s+</g, '><').trim();
            
            // Regex to identify: 
            // 1. Leaf nodes like <tag>value</tag> or <tag/>
            // 2. Opening tags like <tag>
            // 3. Closing tags like </tag>
            // 4. XML declarations
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

            this.isInternalChange = true;
            this.generatedXml = formatted.trim();
            setTimeout(() => this.isInternalChange = false, 10);
            if (showToast) { this.snackBar.open('XML Formatted', 'Close', { duration: 2000 }); }
        } catch (e) {
            this.snackBar.open('Format Error', 'Close', { duration: 2000 });
        }
    }

    toggleCommentXml() {
        const textarea = document.querySelector('textarea.code-editor') as HTMLTextAreaElement;
        if (!textarea) return;
        const start = textarea.selectionStart;
        const end = textarea.selectionEnd;
        const text = this.generatedXml;
        const selection = text.substring(start, end);
        let newText = '';
        if (selection.startsWith('<!--') && selection.endsWith('-->')) {
            newText = text.substring(0, start) + selection.substring(4, selection.length - 3) + text.substring(end);
        } else {
            newText = text.substring(0, start) + '<!--' + selection + '-->' + text.substring(end);
        }
        this.isInternalChange = true;
        this.generatedXml = newText;
        setTimeout(() => this.isInternalChange = false, 10);
        this.pushHistory();
        this.snackBar.open(selection.startsWith('<!--') ? 'Comment Removed' : 'Comment Added', 'Close', { duration: 2000 });
    }

    viewXmlModal() {
        this.currentTab = 'preview';
        this.closeValidationModal();
    }

    editXmlModal() {
        this.currentTab = 'form';
        this.closeValidationModal();
    }

    runValidationModal() {
        this.validateMessage();
    }

    copyFix(suggestion: string, event: Event) {
        event.stopPropagation();
        navigator.clipboard.writeText(suggestion).then(() => {
            this.snackBar.open('Fix suggestion copied!', 'Close', { duration: 2000 });
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
