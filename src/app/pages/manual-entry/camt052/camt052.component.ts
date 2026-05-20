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
    selector: 'app-camt052',
    standalone: true,
    imports: [CommonModule, ReactiveFormsModule, FormsModule, MatIconModule, MatSnackBarModule, MatTooltipModule, MatDialogModule],
    templateUrl: './camt052.component.html',
    styleUrl: './camt052.component.css'
})
export class Camt052Component implements OnInit, OnDestroy {
    form!: FormGroup;
    generatedXml = '';
    currentTab: 'form' | 'preview' = 'form';
    editorLineCount: number[] = [];
    isParsingXml = false;

    // Undo/Redo History
    private xmlHistory: string[] = [];
    private xmlHistoryIdx = -1;
    private maxHistory = 50;
    private isInternalChange = false;

    currencies: string[] = [];
    currencyPrecision: { [key: string]: number } = {};
    countries: string[] = [];

    private readonly DRAFT_KEY = 'draft_camt052';
    private draftSaveTimer: ReturnType<typeof setTimeout> | null = null;
    showDraftBanner = false;
    isClearingDraft = false;

    constructor(
        private fb: FormBuilder,
        private http: HttpClient,
        private config: ConfigService,
        private snackBar: MatSnackBar,
        private router: Router,
        private formatting: FormattingService,
        private uetr: UetrService,
        private dialog: MatDialog
    ) { }


    private createPartyFields(prefix: string) {
        const BIC = [Validators.pattern(/^[A-Z0-9]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$/)];
        return {
            [prefix + 'Type']: ['FIId'],
            [prefix + 'Nm']: [prefix === 'from' ? 'SENDER BANK CORP' : 'RECEIVER BANK CORP', [Validators.maxLength(140)]],
            [prefix + 'Bic']: [prefix === 'from' ? 'SNDRBEBBXXX' : 'RCVRBEBBXXX', BIC],
            [prefix + 'Lei']: ['', [Validators.pattern(/^[A-Z0-9]{18}[0-9]{2}$/)]],
            // Postal Address - Cleared
            [prefix + 'AdrTp']: [''],
            [prefix + 'StrtNm']: ['', [Validators.maxLength(70)]],
            [prefix + 'BldgNb']: ['', [Validators.maxLength(16)]],
            [prefix + 'PstCd']: ['', [Validators.maxLength(16)]],
            [prefix + 'TwnNm']: ['', [Validators.maxLength(35)]],
            [prefix + 'CtrySubDvsn']: ['', [Validators.maxLength(35)]],
            [prefix + 'Ctry']: ['', [Validators.pattern(/^[A-Z]{2}$/)]],
            [prefix + 'AdrLine1']: ['', [Validators.maxLength(70)]],
            [prefix + 'AdrLine2']: ['', [Validators.maxLength(70)]],
            // Identification extension
            [prefix + 'OrgOthrId']: ['', [Validators.maxLength(35)]],
            [prefix + 'OrgOthrSchme']: [''],
            [prefix + 'OrgOthrIssr']: ['', [Validators.maxLength(35)]],
            // FI extension
            [prefix + 'ClrSysCd']: ['', [Validators.maxLength(5)]],
            [prefix + 'ClrSysMmbId']: ['', [Validators.maxLength(35)]],
            [prefix + 'BrnchId']: ['', [Validators.maxLength(35)]],
            // Contact Details - Cleared
            [prefix + 'CtctNm']: ['', [Validators.maxLength(140)]],
            [prefix + 'CtctPhne']: ['', [Validators.maxLength(35)]],
            [prefix + 'CtctEmail']: ['', [Validators.maxLength(256)]]
        };
    }

    private buildContactXml(prefix: string, v: any, t: (i: number) => string, indent: number) {
        if (!v[prefix + 'CtctNm']?.trim() && !v[prefix + 'CtctPhne']?.trim() && !v[prefix + 'CtctEmail']?.trim()) return '';
        let xml = t(indent) + '<CtctDtls>\n';
        if (v[prefix + 'CtctNm']?.trim()) xml += t(indent + 1) + '<Nm>' + this.e(v[prefix + 'CtctNm']) + '</Nm>\n';
        if (v[prefix + 'CtctPhne']?.trim()) xml += t(indent + 1) + '<PhneNb>' + this.e(v[prefix + 'CtctPhne']) + '</PhneNb>\n';
        if (v[prefix + 'CtctEmail']?.trim()) xml += t(indent + 1) + '<EmailAdr>' + this.e(v[prefix + 'CtctEmail']) + '</EmailAdr>\n';
        xml += t(indent) + '</CtctDtls>\n';
        return xml;
    }

    private buildPartyXml(prefix: string, v: any, t: (i: number) => string) {
        let xml = '';
        if (v[prefix + 'Type'] === 'OrgId') {
            const isHdr = (prefix === 'from' || prefix === 'to');
            const wrapTag = 'OrgId'; // Always OrgId in head.001.001.02 and camt.052
            xml += t(3) + '<' + wrapTag + '>\n';
            if (v[prefix + 'Nm']?.trim()) xml += t(4) + '<Nm>' + this.e(v[prefix + 'Nm']) + '</Nm>\n';
            xml += this.buildPostalAddr(prefix, v, t, 4);
            const hasId = v[prefix + 'Bic']?.trim() || v[prefix + 'Lei']?.trim() || v[prefix + 'OrgOthrId']?.trim();
            if (hasId) {
                xml += t(4) + '<Id>\n' + t(5) + '<OrgId>\n';
                if (v[prefix + 'Bic']?.trim()) xml += t(6) + '<AnyBIC>' + this.e(v[prefix + 'Bic']) + '</AnyBIC>\n';
                if (v[prefix + 'Lei']?.trim()) xml += t(6) + '<LEI>' + this.e(v[prefix + 'Lei']) + '</LEI>\n';
                if (v[prefix + 'OrgOthrId']?.trim()) {
                    xml += t(6) + '<Othr>\n' + t(7) + '<Id>' + this.e(v[prefix + 'OrgOthrId']) + '</Id>\n';
                    if (v[prefix + 'OrgOthrSchme']?.trim()) xml += t(8) + '<SchmeNm><Cd>' + this.e(v[prefix + 'OrgOthrSchme']) + '</Cd></SchmeNm>\n';
                    if (v[prefix + 'OrgOthrIssr']?.trim()) xml += t(8) + '<Issr>' + this.e(v[prefix + 'OrgOthrIssr']) + '</Issr>\n';
                    xml += t(7) + '</Othr>\n';
                }
                xml += t(5) + '</OrgId>\n' + t(4) + '</Id>\n';
            }

            if (v[prefix + 'Ctry']?.trim() && !isHdr) {
                xml += t(4) + '<CtryOfRes>' + this.e(v[prefix + 'Ctry']) + '</CtryOfRes>\n';
            }
            xml += this.buildContactXml(prefix, v, t, 4);
            xml += t(3) + '</' + wrapTag + '>\n';
        } else {
            // FIId
            xml += t(3) + '<FIId>\n' + t(4) + '<FinInstnId>\n';
            if (v[prefix + 'Bic']?.trim()) xml += t(5) + '<BICFI>' + this.e(v[prefix + 'Bic']) + '</BICFI>\n';
            if (v[prefix + 'ClrSysCd']?.trim() || v[prefix + 'ClrSysMmbId']?.trim()) {
                xml += t(5) + '<ClrSysMmbId>\n';
                if (v[prefix + 'ClrSysCd']?.trim()) xml += t(6) + '<ClrSysId><Cd>' + this.e(v[prefix + 'ClrSysCd']) + '</Cd></ClrSysId>\n';
                if (v[prefix + 'ClrSysMmbId']?.trim()) xml += t(6) + '<MmbId>' + this.e(v[prefix + 'ClrSysMmbId']) + '</MmbId>\n';
                xml += t(5) + '</ClrSysMmbId>\n';
            }
            if (v[prefix + 'Lei']?.trim()) xml += t(5) + '<LEI>' + this.e(v[prefix + 'Lei']) + '</LEI>\n';
            // Omit Nm and PstlAddr from Header FI identification to satisfy head.001 validation
            if (prefix !== 'from' && prefix !== 'to') {
                if (v[prefix + 'Nm']?.trim()) xml += t(5) + '<Nm>' + this.e(v[prefix + 'Nm']) + '</Nm>\n';
                xml += this.buildPostalAddr(prefix, v, t, 5);
            }
            xml += t(4) + '</FinInstnId>\n';
            if (prefix !== 'from' && prefix !== 'to') {
                if (v[prefix + 'BrnchId']?.trim()) xml += t(4) + '<BrnchId>\n' + t(5) + '<Id>' + this.e(v[prefix + 'BrnchId']) + '</Id>\n' + t(4) + '</BrnchId>\n';
            }
            xml += t(3) + '</FIId>\n';
        }
        return xml;
    }

    private buildPostalAddr(prefix: string, v: any, t: (i: number) => string, indent: number) {
        const hasAddr = v[prefix + 'StrtNm']?.trim() || v[prefix + 'BldgNb']?.trim() || v[prefix + 'PstCd']?.trim() || v[prefix + 'TwnNm']?.trim() || v[prefix + 'Ctry']?.trim() || v[prefix + 'AdrLine1']?.trim();
        if (!hasAddr) return '';
        let xml = t(indent) + '<PstlAdr>\n';
        if (v[prefix + 'AdrTp']?.trim()) xml += t(indent + 1) + '<AdrTp><Cd>' + this.e(v[prefix + 'AdrTp']) + '</Cd></AdrTp>\n';
        if (v[prefix + 'StrtNm']?.trim()) xml += t(indent + 1) + '<StrtNm>' + this.e(v[prefix + 'StrtNm']) + '</StrtNm>\n';
        if (v[prefix + 'BldgNb']?.trim()) xml += t(indent + 1) + '<BldgNb>' + this.e(v[prefix + 'BldgNb']) + '</BldgNb>\n';
        if (v[prefix + 'PstCd']?.trim()) xml += t(indent + 1) + '<PstCd>' + this.e(v[prefix + 'PstCd']) + '</PstCd>\n';
        if (v[prefix + 'TwnNm']?.trim()) xml += t(indent + 1) + '<TwnNm>' + this.e(v[prefix + 'TwnNm']) + '</TwnNm>\n';
        if (v[prefix + 'CtrySubDvsn']?.trim()) xml += t(indent + 1) + '<CtrySubDvsn>' + this.e(v[prefix + 'CtrySubDvsn']) + '</CtrySubDvsn>\n';
        if (v[prefix + 'Ctry']?.trim()) xml += t(indent + 1) + '<Ctry>' + this.e(v[prefix + 'Ctry']) + '</Ctry>\n';
        if (v[prefix + 'AdrLine1']?.trim()) xml += t(indent + 1) + '<AdrLine>' + this.e(v[prefix + 'AdrLine1']) + '</AdrLine>\n';
        if (v[prefix + 'AdrLine2']?.trim()) xml += t(indent + 1) + '<AdrLine>' + this.e(v[prefix + 'AdrLine2']) + '</AdrLine>\n';
        xml += t(indent) + '</PstlAdr>\n';
        return xml;
    }

    public syncScroll(editor: any, gutter: any) {
        gutter.scrollTop = editor.scrollTop;
    }

    ngOnInit() {
        this.fetchCodelists();
        this.buildForm();
        this.generateXml();
        this.onEditorChange(this.generatedXml, true);
        this.form.get('currency')?.valueChanges.subscribe(() => {
            this.updateAmountValidator();
        });

        const hadDraft = this.loadDraft();
        if (hadDraft) {
          this.showDraftBanner = true;
          this.generateXml();
        }

        this.form.valueChanges.pipe(debounceTime(300)).subscribe(() => {
            this.scheduleDraftSave();
            this.generateXml();
        });

        this.pushHistory();
        this.updateAmountValidator();
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
                if (res && res.codes) this.countries = res.codes;
            },
            error: (err) => console.error('Failed to load countries', err)
        });
    }

    private updateAmountValidator() {
        const ccy = this.form.get('currency')?.value;
        const precision = this.currencyPrecision[ccy] ?? 2;
        const pattern = precision > 0
            ? new RegExp(`^\\d{1,13}(\\.\\d{1,${precision}})?$`)
            : new RegExp(`^\\d{1,13}$`);

        const amtFields = ['balanceAmt', 'ntryAmt', 'txAmt', 'sumTtlNtrys', 'sumTtlCdtNtrys', 'sumTtlDbtNtrys'];
        amtFields.forEach(f => {
            const ctrl = this.form.get(f);
            if (ctrl) {
                // If required originally, keep it required. Otherwise just check pattern.
                const isReq = ['balanceAmt', 'ntryAmt'].includes(f);
                ctrl.setValidators(isReq ? [Validators.required, Validators.pattern(pattern)] : [Validators.pattern(pattern)]);
                ctrl.updateValueAndValidity({ emitEvent: false });
            }
        });
    }

    generateUetr() {
        this.form.get('txUetr')?.setValue(this.uetr.generate());
    }

    private buildForm() {
        const BIC = [Validators.pattern(/^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$/)];
        const BIC_REQ = [Validators.required, ...BIC];
        const NUM15 = [Validators.pattern(/^\d{1,15}$/)];

        this.form = this.fb.group({
            // Header Mandatory IDs
            bizMsgId: ['B2026032500001', [Validators.required, Validators.maxLength(35)]],
            bizSvc: ['swift.cbprplus.02', [Validators.required, Validators.maxLength(35)]],
            creDtTm: [new Date().toISOString(), [Validators.required]],
            msgId: ['MSG2026032500001', [Validators.required, Validators.maxLength(35)]],

            // AppHdr Expanded - Shared Party structure for From and To
            ...this.createPartyFields('from'),
            ...this.createPartyFields('to'),
            appHdrCharSet: [''],
            appHdrMktPrctcRegy: [''],
            appHdrMktPrctcId: [''],
            appHdrBizPrcgDt: [''],
            appHdrCpyDplct: [''], // CODU, COPY, DUPL
            appHdrPssblDplct: [''], // boolean
            appHdrPrty: [''],

            // GrpHdr Expanded
            grpHdrMsgRcptNm: [''],
            grpHdrMsgRcptBic: ['', BIC],
            grpHdrMsgPgntnPgNb: [''],
            grpHdrMsgPgntnLastPg: [''],
            grpHdrOrgnlBizQryMsgId: [''],
            grpHdrOrgnlBizQryMsgDef: [''],
            grpHdrAddtlInf: ['', [Validators.maxLength(500)]],

            // Account
            acctIdType: ['IBAN'],
            acctId: ['BE12345678901234', [Validators.required, Validators.maxLength(34)]],
            acctCcy: ['USD', [Validators.pattern(/^[A-Z]{3}$/)]],
            acctNm: ['', [Validators.maxLength(70)]],
            acctOwnrNm: ['', [Validators.maxLength(140)]],
            acctSvcrBic: ['', [Validators.pattern(/^[A-Z0-9]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$/)]],
            acctTp: [''], // CACC, SVGS, etc.

            // Report (Rpt)
            rptId: ['RPT2026032500001', [Validators.required, Validators.maxLength(35)]],
            elctrncSeqNb: ['', [Validators.pattern(/^\d+$/)]],
            lglSeqNb: ['', [Validators.pattern(/^\d+$/)]],
            rptgSeq: ['', [Validators.pattern(/^\d+$/)]],
            rptPgNb: ['1', [Validators.required, Validators.maxLength(5)]],
            rptPgLastPgInd: ['true', [Validators.required]],

            // New Rpt levels
            frDtTm: [new Date().toISOString()],
            toDtTm: [new Date().toISOString()],
            cpyDplctInd: [''], // CODU, COPY, DUPL
            rptgSrc: ['', [Validators.maxLength(35)]], // Prtry

            // Transactions Summary (TxsSummry)
            txsSummryEnabled: [false],
            nbOfTtlNtrys: ['', NUM15],
            sumTtlNtrys: [''],
            nbOfTtlCdtNtrys: ['', NUM15],
            sumTtlCdtNtrys: [''],
            nbOfTtlDbtNtrys: ['', NUM15],
            sumTtlDbtNtrys: [''],

            // Balance
            currency: ['USD', Validators.required],
            balType: ['OPBD', [Validators.required]],
            balInd: ['CRDT', [Validators.required]],
            balanceAmt: ['5000.00', [Validators.required]],
            balDt: [new Date().toISOString().split('T')[0], [Validators.required]],

            // Second Balance (optional)
            bal2Enabled: [false],
            bal2Type: [''],
            bal2Ind: [''],
            bal2Amt: [''],
            bal2Dt: [new Date().toISOString().split('T')[0]],

            // Entry (Ntry)
            ntryRef: ['NTRY-001', [Validators.maxLength(35)]],
            ntryAmt: ['1200.00', [Validators.required]],
            ntryInd: ['CRDT', [Validators.required]],
            ntrySts: ['BOOK', [Validators.required]],
            ntryRevsclInd: [''], // true/false
            ntryBookgDt: [new Date().toISOString().split('T')[0]],
            ntryValDt: [new Date().toISOString().split('T')[0]],
            ntryAcctSvcrRef: ['', [Validators.maxLength(35)]],

            // New Ntry Fields
            ntryAvlbtyDt: [new Date().toISOString().split('T')[0]],
            ntryAvlbtyAmt: ['', [Validators.pattern(/^[0-9]+(\.[0-9]{1,5})?$/)]],
            ntryAvlbtyCdtDbtInd: [''],
            ntryComssnWvrInd: [''],
            ntryAddtlInfIndMsgNmId: ['', [Validators.maxLength(35)]],
            ntryAmtDtlsInstdAmt: ['', [Validators.pattern(/^[0-9]+(\.[0-9]{1,5})?$/)]],
            ntryChrgsAmt: ['', [Validators.pattern(/^[0-9]+(\.[0-9]{1,5})?$/)]],
            ntryTechInptChanl: ['', [Validators.maxLength(35)]],
            ntryIntrstAmt: ['', [Validators.pattern(/^[0-9]+(\.[0-9]{1,5})?$/)]],
            ntryCardTxPan: ['', [Validators.maxLength(35)]],

            ntryPurpCd: ['', [Validators.maxLength(4)]],
            ntryAddtlInf: ['', [Validators.maxLength(500)]],

            // Bank Transaction Code (Ntry level)
            ntryBkTxCdDomn: ['PMNT', [Validators.maxLength(4)]],
            ntryBkTxCdFmly: ['IRCT', [Validators.maxLength(4)]],
            ntryBkTxCdSubFmly: ['ESCA', [Validators.maxLength(4)]],

            // Entry Details > Transaction Details
            txDtlsEnabled: [false],
            txEndToEndId: ['', [Validators.maxLength(35)]],
            txMsgId: ['', [Validators.maxLength(35)]],
            txAcctSvcrRef: ['', [Validators.maxLength(35)]],
            txPmtInfId: ['', [Validators.maxLength(35)]],
            txInstrId: ['', [Validators.maxLength(35)]],
            txUetr: ['', [Validators.pattern(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)]],

            txAmt: [''],
            txCdtDbtInd: [''],

            // Related Parties
            txInitgPtyNm: ['', [Validators.maxLength(140)]],
            txUltmtDbtrNm: ['', [Validators.maxLength(140)]],
            txDbtrNm: ['', [Validators.maxLength(140)]],
            txDbtrAcct: ['', [Validators.maxLength(34)]],
            txCdtrNm: ['', [Validators.maxLength(140)]],
            txCdtrAcct: ['', [Validators.maxLength(34)]],
            txUltmtCdtrNm: ['', [Validators.maxLength(140)]],

            // Related Agents
            txDbtrAgtBic: ['', [Validators.pattern(/^[A-Z0-9]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$/)]],
            txIntrmyAgtBic: ['', [Validators.pattern(/^[A-Z0-9]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$/)]],
            txCdtrAgtBic: ['', [Validators.pattern(/^[A-Z0-9]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$/)]],

            // Remittance
            txRmtInfStrdCdtrRefType: [''], // e.g. SCOR
            txRmtInfStrdCdtrRef: ['', [Validators.maxLength(35)]],
            txRmtInfStrdAddtlRmtInf: ['', [Validators.maxLength(140)]],
            txRmtInfUstrd: ['', [Validators.maxLength(140)]],

            // Additional Report Info
            addtlRptInf: ['', [Validators.maxLength(500)]],
        });
    }

    err(f: string): string | null {
        const c = this.form.get(f);
        if (!c || c.valid) return null;
        if (c.errors?.['required']) return 'Required field.';
        if (c.errors?.['maxlength']) return 'Max ' + c.errors['maxlength'].requiredLength + ' chars.';
        if (c.errors?.['pattern']) {
            if (f === 'txUetr') return 'Must be a valid UUID v4.';
            if (['balanceAmt', 'ntryAmt', 'txAmt', 'sumTtlNtrys', 'sumTtlCdtNtrys', 'sumTtlDbtNtrys'].includes(f)) {
                const ccy = this.form.get('currency')?.value;
                const p = this.currencyPrecision[ccy] ?? 2;
                return 'Value must be a number with max ' + p + ' decimals for ' + ccy + '.';
            }
            if (f.toLowerCase().includes('bic')) return 'Valid 8 or 11-char BIC required.';
            if (f.includes('nbOf') || f.includes('SeqNb')) return 'Must be numeric.';
            return 'Invalid value.';
        }
        return 'Invalid value.';
    }

    warningTimeouts: { [key: string]: any } = {};
    showMaxLenWarning: { [key: string]: boolean } = {};

    @HostListener('input', ['$event'])
    onInput(event: any) {
        const target = event.target as HTMLInputElement;
        if (!target) return;
        const name = target.getAttribute('formControlName');
        if (!name) return;

        const maxLen = target.maxLength;
        const val = target.value || '';
        if (maxLen > 0 && val.length >= maxLen) {
            this.showMaxLenWarning[name] = true;
            if (this.warningTimeouts[name]) clearTimeout(this.warningTimeouts[name]);
            this.warningTimeouts[name] = setTimeout(() => this.showMaxLenWarning[name] = false, 3000);
        } else {
            this.showMaxLenWarning[name] = false;
        }

        if (name.toLowerCase().includes('bic') || name.toLowerCase().includes('iban')) {
            const start = target.selectionStart;
            const end = target.selectionEnd;
            const upperValue = val.toUpperCase();
            if (val !== upperValue) {
                target.value = upperValue;
                if (start !== null && end !== null) target.setSelectionRange(start, end);
                this.form.get(name)?.patchValue(upperValue);
            }
        }
    }

    @HostListener('keydown', ['$event'])
    onKeydown(event: KeyboardEvent) {
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
        if (len >= maxLen) return 'Maximum ' + maxLen + ' characters reached (' + len + '/' + maxLen + ')';
        return null;
    }

    fdtOffset(dt: string): string {
        if (!dt) return dt;
        let d = new Date(dt);
        if (isNaN(d.getTime())) return dt;
        // Strictly YYYY-MM-DDTHH:MM:SS+00:00 for Document (CBPR_DateTime)
        return d.toISOString().split('.')[0] + '+00:00';
    }

    isoNow(): string {
        return new Date().toISOString();
    }


    private e(v: string) { return (v || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
    private tabs(n: number) { return '\t'.repeat(n); }

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
        const creDtTm = this.fdtOffset(v.creDtTm || this.isoNow());
        const t = (n: number) => this.tabs(n);

        // Account block
        let acctXml = '';
        if (v.acctIdType === 'IBAN') {
            acctXml = t(5) + '<IBAN>' + this.e(v.acctId) + '</IBAN>\n';
        } else {
            acctXml = t(5) + '<Othr>\n' + t(6) + '<Id>' + this.e(v.acctId) + '</Id>\n' + t(5) + '</Othr>\n';
        }
        let acctBlock = t(4) + '<Acct>\n' + t(5) + '<Id>\n' + acctXml + t(5) + '</Id>\n';
        if (v.acctTp?.trim()) acctBlock += t(5) + '<Tp>\n' + t(6) + '<Cd>' + this.e(v.acctTp) + '</Cd>\n' + t(5) + '</Tp>\n';
        const effectiveCcy = v.acctCcy?.trim() || v.currency || 'USD';
        acctBlock += t(5) + '<Ccy>' + this.e(effectiveCcy) + '</Ccy>\n';
        if (v.acctNm?.trim()) acctBlock += t(5) + '<Nm>' + this.e(v.acctNm) + '</Nm>\n';
        if (v.acctOwnrNm?.trim()) {
            acctBlock += t(5) + '<Ownr>\n' + t(6) + '<Nm>' + this.e(v.acctOwnrNm) + '</Nm>\n' + t(5) + '</Ownr>\n';
        }
        if (v.acctSvcrBic?.trim()) {
            acctBlock += t(5) + '<Svcr>\n' + t(6) + '<FinInstnId>\n' + t(7) + '<BICFI>' + this.e(v.acctSvcrBic) + '</BICFI>\n' + t(6) + '</FinInstnId>\n' + t(5) + '</Svcr>\n';
        }
        acctBlock += t(4) + '</Acct>\n';

        // Balance 1
        const bal1Xml = t(4) + '<Bal>\n'
            + t(5) + '<Tp>\n' + t(6) + '<CdOrPrtry>\n' + t(7) + '<Cd>' + this.e(v.balType) + '</Cd>\n' + t(6) + '</CdOrPrtry>\n' + t(5) + '</Tp>\n'
            + t(5) + '<Amt Ccy="' + this.e(v.currency) + '">' + this.formatting.formatAmount(v.balanceAmt, v.currency) + '</Amt>\n'
            + t(5) + '<CdtDbtInd>' + this.e(v.balInd) + '</CdtDbtInd>\n'
            + t(5) + '<Dt>\n' + t(6) + '<Dt>' + this.e(v.balDt) + '</Dt>\n' + t(5) + '</Dt>\n'
            + t(4) + '</Bal>\n';

        // Balance 2 (optional)
        let bal2Xml = '';
        if (v.bal2Enabled && v.bal2Amt?.trim()) {
            bal2Xml = t(4) + '<Bal>\n'
                + t(5) + '<Tp>\n' + t(6) + '<CdOrPrtry>\n' + t(7) + '<Cd>' + this.e(v.bal2Type) + '</Cd>\n' + t(6) + '</CdOrPrtry>\n' + t(5) + '</Tp>\n'
                + t(5) + '<Amt Ccy="' + this.e(v.currency) + '">' + this.formatting.formatAmount(v.bal2Amt, v.currency) + '</Amt>\n'
                + t(5) + '<CdtDbtInd>' + this.e(v.bal2Ind) + '</CdtDbtInd>\n'
                + t(5) + '<Dt>\n' + t(6) + '<Dt>' + this.e(v.bal2Dt) + '</Dt>\n' + t(5) + '</Dt>\n'
                + t(4) + '</Bal>\n';
        }

        // TxsSummry
        let txsSummryXml = '';
        if (v.txsSummryEnabled) {
            let inner = '';
            if (v.nbOfTtlNtrys?.trim() || v.sumTtlNtrys?.trim()) {
                inner += t(5) + '<TtlNtries>\n';
                if (v.nbOfTtlNtrys?.trim()) inner += t(6) + '<NbOfNtries>' + this.e(v.nbOfTtlNtrys) + '</NbOfNtries>\n';
                if (v.sumTtlNtrys?.trim()) inner += t(6) + '<Sum>' + this.formatting.formatAmount(v.sumTtlNtrys, v.currency) + '</Sum>\n';
                inner += t(5) + '</TtlNtries>\n';
            }
            if (v.nbOfTtlCdtNtrys?.trim() || v.sumTtlCdtNtrys?.trim()) {
                inner += t(5) + '<TtlCdtNtries>\n';
                if (v.nbOfTtlCdtNtrys?.trim()) inner += t(6) + '<NbOfNtries>' + this.e(v.nbOfTtlCdtNtrys) + '</NbOfNtries>\n';
                if (v.sumTtlCdtNtrys?.trim()) inner += t(6) + '<Sum>' + this.formatting.formatAmount(v.sumTtlCdtNtrys, v.currency) + '</Sum>\n';
                inner += t(5) + '</TtlCdtNtries>\n';
            }
            if (v.nbOfTtlDbtNtrys?.trim() || v.sumTtlDbtNtrys?.trim()) {
                inner += t(5) + '<TtlDbtNtries>\n';
                if (v.nbOfTtlDbtNtrys?.trim()) inner += t(6) + '<NbOfNtries>' + this.e(v.nbOfTtlDbtNtrys) + '</NbOfNtries>\n';
                if (v.sumTtlDbtNtrys?.trim()) inner += t(6) + '<Sum>' + this.formatting.formatAmount(v.sumTtlDbtNtrys, v.currency) + '</Sum>\n';
                inner += t(5) + '</TtlDbtNtries>\n';
            }
            if (inner) {
                txsSummryXml = t(4) + '<TxsSummry>\n' + inner + t(4) + '</TxsSummry>\n';
            }
        }

        // Entry
        let ntryXml = t(4) + '<Ntry>\n';
        if (v.ntryRef?.trim()) ntryXml += t(5) + '<NtryRef>' + this.e(v.ntryRef) + '</NtryRef>\n';
        ntryXml += t(5) + '<Amt Ccy="' + this.e(v.currency) + '">' + this.formatting.formatAmount(v.ntryAmt, v.currency) + '</Amt>\n';
        ntryXml += t(5) + '<CdtDbtInd>' + this.e(v.ntryInd) + '</CdtDbtInd>\n';
        if (v.ntryRevsclInd === 'true' || v.ntryRevsclInd === 'false') ntryXml += t(5) + '<RvslInd>' + v.ntryRevsclInd + '</RvslInd>\n';
        ntryXml += t(5) + '<Sts>\n' + t(6) + '<Cd>' + this.e(v.ntrySts) + '</Cd>\n' + t(5) + '</Sts>\n';
        if (v.ntryBookgDt?.trim()) ntryXml += t(5) + '<BookgDt>\n' + t(6) + '<Dt>' + this.e(v.ntryBookgDt) + '</Dt>\n' + t(5) + '</BookgDt>\n';
        if (v.ntryValDt?.trim()) ntryXml += t(5) + '<ValDt>\n' + t(6) + '<Dt>' + this.e(v.ntryValDt) + '</Dt>\n' + t(5) + '</ValDt>\n';
        if (v.ntryAcctSvcrRef?.trim()) ntryXml += t(5) + '<AcctSvcrRef>' + this.e(v.ntryAcctSvcrRef) + '</AcctSvcrRef>\n';

        // Avlbty
        if (v.ntryAvlbtyDt?.trim() || v.ntryAvlbtyAmt?.trim() || v.ntryAvlbtyCdtDbtInd?.trim()) {
            ntryXml += t(5) + '<Avlbty>\n';
            const aDt = v.ntryAvlbtyDt?.trim() || v.ntryValDt || new Date().toISOString().split('T')[0];
            ntryXml += t(6) + '<Dt>\n' + t(7) + '<ActlDt>' + this.e(aDt) + '</ActlDt>\n' + t(6) + '</Dt>\n';
            const aAmt = v.ntryAvlbtyAmt?.trim() || v.ntryAmt;
            ntryXml += t(6) + '<Amt Ccy="' + this.e(v.currency) + '">' + this.formatting.formatAmount(aAmt, v.currency) + '</Amt>\n';
            const aInd = v.ntryAvlbtyCdtDbtInd?.trim() || v.ntryInd;
            ntryXml += t(6) + '<CdtDbtInd>' + this.e(aInd) + '</CdtDbtInd>\n';
            ntryXml += t(5) + '</Avlbty>\n';
        }

        // Bank Transaction Code
        ntryXml += t(5) + '<BkTxCd>\n' + t(6) + '<Domn>\n'
            + t(7) + '<Cd>' + this.e(v.ntryBkTxCdDomn || 'PMNT') + '</Cd>\n'
            + t(7) + '<Fmly>\n'
            + t(8) + '<Cd>' + this.e(v.ntryBkTxCdFmly || 'IRCT') + '</Cd>\n'
            + t(8) + '<SubFmlyCd>' + this.e(v.ntryBkTxCdSubFmly || 'ESCA') + '</SubFmlyCd>\n'
            + t(7) + '</Fmly>\n'
            + t(6) + '</Domn>\n' + t(5) + '</BkTxCd>\n';

        // ComssnWvrInd
        if (v.ntryComssnWvrInd === 'true' || v.ntryComssnWvrInd === 'false') {
            ntryXml += t(5) + '<ComssnWvrInd>' + v.ntryComssnWvrInd + '</ComssnWvrInd>\n';
        }

        // AddtlInfInd
        if (v.ntryAddtlInfIndMsgNmId?.trim()) {
            ntryXml += t(5) + '<AddtlInfInd>\n' + t(6) + '<MsgNmId>' + this.e(v.ntryAddtlInfIndMsgNmId) + '</MsgNmId>\n' + t(5) + '</AddtlInfInd>\n';
        }

        // AmtDtls
        if (v.ntryAmtDtlsInstdAmt?.trim()) {
            ntryXml += t(5) + '<AmtDtls>\n' + t(6) + '<InstdAmt>\n' + t(7) + '<Amt Ccy="' + this.e(v.currency) + '">' + this.formatting.formatAmount(v.ntryAmtDtlsInstdAmt, v.currency) + '</Amt>\n' + t(6) + '</InstdAmt>\n' + t(5) + '</AmtDtls>\n';
        }

        // Chrgs
        if (v.ntryChrgsAmt?.trim()) {
            ntryXml += t(5) + '<Chrgs>\n' + t(6) + '<TtlChrgsAndTaxAmt Ccy="' + this.e(v.currency) + '">' + this.formatting.formatAmount(v.ntryChrgsAmt, v.currency) + '</TtlChrgsAndTaxAmt>\n' + t(5) + '</Chrgs>\n';
        }

        // TechInptChanl
        if (v.ntryTechInptChanl?.trim()) {
            ntryXml += t(5) + '<TechInptChanl>\n' + t(6) + '<Prtry>' + this.e(v.ntryTechInptChanl) + '</Prtry>\n' + t(5) + '</TechInptChanl>\n';
        }

        // Intrst
        if (v.ntryIntrstAmt?.trim()) {
            ntryXml += t(5) + '<Intrst>\n' + t(6) + '<TtlIntrstAndTaxAmt Ccy="' + this.e(v.currency) + '">' + this.formatting.formatAmount(v.ntryIntrstAmt, v.currency) + '</TtlIntrstAndTaxAmt>\n' + t(5) + '</Intrst>\n';
        }

        // CardTx â€” PlainCardData requires XpryDt per SR2025; simple YYYY-MM format
        if (v.ntryCardTxPan?.trim()) {
            ntryXml += t(5) + '<CardTx>\n' + t(6) + '<Card>\n' + t(7) + '<PlainCardData>\n'
                + t(8) + '<PAN>' + this.e(v.ntryCardTxPan) + '</PAN>\n'
                + t(8) + '<XpryDt>' + new Date().getFullYear() + '-12</XpryDt>\n'
                + t(7) + '</PlainCardData>\n' + t(6) + '</Card>\n' + t(5) + '</CardTx>\n';
        }

        // Entry Details (Transaction Details)
        if (v.txDtlsEnabled || v.ntryPurpCd?.trim()) {
            ntryXml += t(5) + '<NtryDtls>\n' + t(6) + '<TxDtls>\n';
            // Refs (Mandatory in TxDtls)
            ntryXml += t(7) + '<Refs>\n';
            if (v.txMsgId?.trim()) ntryXml += t(8) + '<MsgId>' + this.e(v.txMsgId) + '</MsgId>\n';
            if (v.txAcctSvcrRef?.trim()) ntryXml += t(8) + '<AcctSvcrRef>' + this.e(v.txAcctSvcrRef) + '</AcctSvcrRef>\n';
            if (v.txPmtInfId?.trim()) ntryXml += t(8) + '<PmtInfId>' + this.e(v.txPmtInfId) + '</PmtInfId>\n';
            if (v.txInstrId?.trim()) ntryXml += t(8) + '<InstrId>' + this.e(v.txInstrId) + '</InstrId>\n';
            if (v.txEndToEndId?.trim()) ntryXml += t(8) + '<EndToEndId>' + this.e(v.txEndToEndId) + '</EndToEndId>\n';
            if (v.txUetr?.trim()) ntryXml += t(8) + '<UETR>' + this.e(v.txUetr) + '</UETR>\n';
            // If No refs, we must still output Refs block if TxDtls is present, maybe with MsgId NOTPROVIDED or just empty Refs if schema allows
            // but CBPR+ usually wants at least EndToEndId or UETR. Fallback to entry ID if needed?
            if (!v.txMsgId?.trim() && !v.txAcctSvcrRef?.trim() && !v.txPmtInfId?.trim() && !v.txInstrId?.trim() && !v.txEndToEndId?.trim() && !v.txUetr?.trim()) {
                ntryXml += t(8) + '<EndToEndId>NOTPROVIDED</EndToEndId>\n';
            }
            ntryXml += t(7) + '</Refs>\n';

            // Amt & CdtDbtInd (Mandatory in TxDtls)
            const txAmtVal = v.txAmt?.trim() || v.ntryAmt;
            const txIndVal = v.txCdtDbtInd?.trim() || v.ntryInd;
            ntryXml += t(7) + '<Amt Ccy="' + this.e(v.currency) + '">' + this.formatting.formatAmount(txAmtVal, v.currency) + '</Amt>\n';
            ntryXml += t(7) + '<CdtDbtInd>' + this.e(txIndVal) + '</CdtDbtInd>\n';

            // Related Parties
            const hasRltdPties = v.txInitgPtyNm?.trim() || v.txUltmtDbtrNm?.trim() || v.txDbtrNm?.trim() || v.txDbtrAcct?.trim() || v.txCdtrNm?.trim() || v.txCdtrAcct?.trim() || v.txUltmtCdtrNm?.trim();
            if (hasRltdPties) {
                ntryXml += t(7) + '<RltdPties>\n';
                // InitgPty
                if (v.txInitgPtyNm?.trim()) ntryXml += t(8) + '<InitgPty>\n' + t(9) + '<Nm>' + this.e(v.txInitgPtyNm) + '</Nm>\n' + t(8) + '</InitgPty>\n';
                // Dbtr
                if (v.txDbtrNm?.trim() || v.txDbtrAcct?.trim()) {
                    if (v.txDbtrNm?.trim()) {
                        ntryXml += t(8) + '<Dbtr>\n' + t(9) + '<Nm>' + this.e(v.txDbtrNm) + '</Nm>\n' + t(8) + '</Dbtr>\n';
                    }
                    if (v.txDbtrAcct?.trim()) ntryXml += t(8) + '<DbtrAcct>\n' + t(9) + '<Id>\n' + t(10) + '<Othr>\n' + t(11) + '<Id>' + this.e(v.txDbtrAcct) + '</Id>\n' + t(10) + '</Othr>\n' + t(9) + '</Id>\n' + t(8) + '</DbtrAcct>\n';
                }
                // UltmtDbtr
                if (v.txUltmtDbtrNm?.trim()) ntryXml += t(8) + '<UltmtDbtr>\n' + t(9) + '<Nm>' + this.e(v.txUltmtDbtrNm) + '</Nm>\n' + t(8) + '</UltmtDbtr>\n';
                // Cdtr
                if (v.txCdtrNm?.trim() || v.txCdtrAcct?.trim()) {
                    if (v.txCdtrNm?.trim()) {
                        ntryXml += t(8) + '<Cdtr>\n' + t(9) + '<Nm>' + this.e(v.txCdtrNm) + '</Nm>\n' + t(8) + '</Cdtr>\n';
                    }
                    if (v.txCdtrAcct?.trim()) ntryXml += t(8) + '<CdtrAcct>\n' + t(9) + '<Id>\n' + t(10) + '<Othr>\n' + t(11) + '<Id>' + this.e(v.txCdtrAcct) + '</Id>\n' + t(10) + '</Othr>\n' + t(9) + '</Id>\n' + t(8) + '</CdtrAcct>\n';
                }
                // UltmtCdtr
                if (v.txUltmtCdtrNm?.trim()) ntryXml += t(8) + '<UltmtCdtr>\n' + t(9) + '<Nm>' + this.e(v.txUltmtCdtrNm) + '</Nm>\n' + t(8) + '</UltmtCdtr>\n';
                ntryXml += t(7) + '</RltdPties>\n';
            }
            // Related Agents
            const hasRltdAgts = v.txDbtrAgtBic?.trim() || v.txIntrmyAgtBic?.trim() || v.txCdtrAgtBic?.trim();
            if (hasRltdAgts) {
                ntryXml += t(7) + '<RltdAgts>\n';
                if (v.txDbtrAgtBic?.trim()) ntryXml += t(8) + '<DbtrAgt>\n' + t(9) + '<FinInstnId>\n' + t(10) + '<BICFI>' + this.e(v.txDbtrAgtBic) + '</BICFI>\n' + t(9) + '</FinInstnId>\n' + t(8) + '</DbtrAgt>\n';
                if (v.txCdtrAgtBic?.trim()) ntryXml += t(8) + '<CdtrAgt>\n' + t(9) + '<FinInstnId>\n' + t(10) + '<BICFI>' + this.e(v.txCdtrAgtBic) + '</BICFI>\n' + t(9) + '</FinInstnId>\n' + t(8) + '</CdtrAgt>\n';
                if (v.txIntrmyAgtBic?.trim()) ntryXml += t(8) + '<IntrmyAgt1>\n' + t(9) + '<FinInstnId>\n' + t(10) + '<BICFI>' + this.e(v.txIntrmyAgtBic) + '</BICFI>\n' + t(9) + '</FinInstnId>\n' + t(8) + '</IntrmyAgt1>\n';
                ntryXml += t(7) + '</RltdAgts>\n';
            }

            // Purpose (Must come after RelatedAgents)
            if (v.ntryPurpCd?.trim()) {
                ntryXml += t(7) + '<Purp>\n' + t(8) + '<Cd>' + this.e(v.ntryPurpCd) + '</Cd>\n' + t(7) + '</Purp>\n';
            }
            // Remittance
            const hasStrdRmt = v.txRmtInfStrdCdtrRefType?.trim() || v.txRmtInfStrdCdtrRef?.trim() || v.txRmtInfStrdAddtlRmtInf?.trim();
            if (v.txRmtInfUstrd?.trim() || hasStrdRmt) {
                ntryXml += t(7) + '<RmtInf>\n';
                if (v.txRmtInfUstrd?.trim()) ntryXml += t(8) + '<Ustrd>' + this.e(v.txRmtInfUstrd) + '</Ustrd>\n';
                if (hasStrdRmt) {
                    ntryXml += t(8) + '<Strd>\n';
                    if (v.txRmtInfStrdCdtrRefType?.trim() || v.txRmtInfStrdCdtrRef?.trim()) {
                        ntryXml += t(9) + '<CdtrRefInf>\n';
                        if (v.txRmtInfStrdCdtrRefType?.trim()) {
                            ntryXml += t(10) + '<Tp>\n' + t(11) + '<CdOrPrtry>\n' + t(12) + '<Cd>' + this.e(v.txRmtInfStrdCdtrRefType) + '</Cd>\n' + t(11) + '</CdOrPrtry>\n' + t(10) + '</Tp>\n';
                        }
                        if (v.txRmtInfStrdCdtrRef?.trim()) ntryXml += t(10) + '<Ref>' + this.e(v.txRmtInfStrdCdtrRef) + '</Ref>\n';
                        ntryXml += t(9) + '</CdtrRefInf>\n';
                    }
                    if (v.txRmtInfStrdAddtlRmtInf?.trim()) ntryXml += t(9) + '<AddtlRmtInf>' + this.e(v.txRmtInfStrdAddtlRmtInf) + '</AddtlRmtInf>\n';
                    ntryXml += t(8) + '</Strd>\n';
                }
                ntryXml += t(7) + '</RmtInf>\n';
            }
            ntryXml += t(6) + '</TxDtls>\n' + t(5) + '</NtryDtls>\n';
        }

        if (v.ntryAddtlInf?.trim()) ntryXml += t(5) + '<AddtlNtryInf>' + this.e(v.ntryAddtlInf) + '</AddtlNtryInf>\n';
        ntryXml += t(4) + '</Ntry>\n';

        // Pagination (Mandatory in CBPR+ Rpt block)
        let pgnXml = t(4) + '<RptPgntn>\n'
            + t(5) + '<PgNb>' + this.e(v.rptPgNb || '1') + '</PgNb>\n'
            + t(5) + '<LastPgInd>' + (v.rptPgLastPgInd === 'false' ? 'false' : 'true') + '</LastPgInd>\n'
            + t(4) + '</RptPgntn>\n';


        // From/To Date
        let frToDtXml = '';
        if (v.frDtTm?.trim() || v.toDtTm?.trim()) {
            frToDtXml += t(4) + '<FrToDt>\n';
            if (v.frDtTm?.trim()) frToDtXml += t(5) + '<FrDtTm>' + this.fdtOffset(v.frDtTm) + '</FrDtTm>\n';
            if (v.toDtTm?.trim()) frToDtXml += t(5) + '<ToDtTm>' + this.fdtOffset(v.toDtTm) + '</ToDtTm>\n';
            frToDtXml += t(4) + '</FrToDt>\n';
        }
        let cpyDplctXml = '';
        if (v.cpyDplctInd?.trim()) cpyDplctXml = t(4) + '<CpyDplctInd>' + this.e(v.cpyDplctInd) + '</CpyDplctInd>\n';
        let rptgSrcXml = '';
        if (v.rptgSrc?.trim()) rptgSrcXml = t(4) + '<RptgSrc>\n' + t(5) + '<Prtry>' + this.e(v.rptgSrc) + '</Prtry>\n' + t(4) + '</RptgSrc>\n';
        let addtlRptInfXml = '';
        if (v.addtlRptInf?.trim()) addtlRptInfXml = t(4) + '<AddtlRptInf>' + this.e(v.addtlRptInf) + '</AddtlRptInf>\n';

        this.generatedXml = '<?xml version="1.0" encoding="UTF-8"?>\n'
            + '<BusMsgEnvlp xmlns="urn:swift:xsd:envelope">\n'
            + t(1) + '<AppHdr xmlns="urn:iso:std:iso:20022:tech:xsd:head.001.001.02">\n';

        if (v.appHdrCharSet?.trim()) this.generatedXml += t(2) + '<CharSet>' + this.e(v.appHdrCharSet) + '</CharSet>\n';

        // From
        this.generatedXml += t(2) + '<Fr>\n';
        this.generatedXml += this.buildPartyXml('from', v, t);
        this.generatedXml += t(2) + '</Fr>\n';

        // To
        this.generatedXml += t(2) + '<To>\n';
        this.generatedXml += this.buildPartyXml('to', v, t);
        this.generatedXml += t(2) + '</To>\n';

        this.generatedXml += t(2) + '<BizMsgIdr>' + this.e(v.bizMsgId) + '</BizMsgIdr>\n'
            + t(2) + '<MsgDefIdr>camt.052.001.08</MsgDefIdr>\n'
            + t(2) + '<BizSvc>' + this.e(v.bizSvc) + '</BizSvc>\n';

        if (v.appHdrMktPrctcRegy?.trim()) {
            this.generatedXml += t(2) + '<MktPrctc>\n' + t(3) + '<Regy>' + this.e(v.appHdrMktPrctcRegy) + '</Regy>\n' + t(3) + '<Id>' + this.e(v.appHdrMktPrctcId || 'N/A') + '</Id>\n' + t(2) + '</MktPrctc>\n';
        }

        // head.001.001.02 order: CreDt (Mandatory), then optional fields. No BizPrcgDt.
        this.generatedXml += t(2) + '<CreDt>' + creDtTm + '</CreDt>\n';

        // CpyDplct, PssblDplct, Prty must come after CreDt
        if (v.appHdrCpyDplct?.trim()) this.generatedXml += t(2) + '<CpyDplct>' + this.e(v.appHdrCpyDplct) + '</CpyDplct>\n';
        if (v.appHdrPssblDplct === 'true' || v.appHdrPssblDplct === 'false') this.generatedXml += t(2) + '<PssblDplct>' + v.appHdrPssblDplct + '</PssblDplct>\n';
        if (v.appHdrPrty?.trim()) this.generatedXml += t(2) + '<Prty>' + this.e(v.appHdrPrty) + '</Prty>\n';
        // Rltd block omitted â€” empty BkToCstmrAcctRpt element is invalid per SR2025 schema

        this.generatedXml += t(1) + '</AppHdr>\n'
            + t(1) + '<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.052.001.08">\n'
            + t(2) + '<BkToCstmrAcctRpt>\n'
            + t(3) + '<GrpHdr>\n'
            + t(4) + '<MsgId>' + this.e(v.msgId) + '</MsgId>\n'
            + t(4) + '<CreDtTm>' + creDtTm + '</CreDtTm>\n';

        if (v.grpHdrMsgRcptNm?.trim() || v.grpHdrMsgRcptBic?.trim()) {
            this.generatedXml += t(4) + '<MsgRcpt>\n';
            if (v.grpHdrMsgRcptNm?.trim()) this.generatedXml += t(5) + '<Nm>' + this.e(v.grpHdrMsgRcptNm) + '</Nm>\n';
            if (v.grpHdrMsgRcptBic?.trim()) this.generatedXml += t(5) + '<Id>\n' + t(6) + '<OrgId>\n' + t(7) + '<AnyBIC>' + this.e(v.grpHdrMsgRcptBic) + '</AnyBIC>\n' + t(6) + '</OrgId>\n' + t(5) + '</Id>\n';
            this.generatedXml += t(4) + '</MsgRcpt>\n';
        }

        if (v.grpHdrMsgPgntnPgNb?.trim()) {
            this.generatedXml += t(4) + '<MsgPgntn>\n' + t(5) + '<PgNb>' + this.e(v.grpHdrMsgPgntnPgNb) + '</PgNb>\n' + t(5) + '<LastPgInd>' + (v.grpHdrMsgPgntnLastPg === 'false' ? 'false' : 'true') + '</LastPgInd>\n' + t(4) + '</MsgPgntn>\n';
        }

        if (v.grpHdrOrgnlBizQryMsgId?.trim()) {
            this.generatedXml += t(4) + '<OrgnlBizQry>\n' + t(5) + '<MsgId>' + this.e(v.grpHdrOrgnlBizQryMsgId) + '</MsgId>\n';
            if (v.grpHdrOrgnlBizQryMsgDef?.trim()) this.generatedXml += t(5) + '<MsgDefIdr>' + this.e(v.grpHdrOrgnlBizQryMsgDef) + '</MsgDefIdr>\n';
            this.generatedXml += t(4) + '</OrgnlBizQry>\n';
        }

        if (v.grpHdrAddtlInf?.trim()) this.generatedXml += t(4) + '<AddtlInf>' + this.e(v.grpHdrAddtlInf) + '</AddtlInf>\n';

        this.generatedXml += t(3) + '</GrpHdr>\n'
            + t(3) + '<Rpt>\n'
            + t(4) + '<Id>' + this.e(v.rptId) + '</Id>\n'
            + pgnXml;

        if (v.elctrncSeqNb?.trim()) this.generatedXml += t(4) + '<ElctrncSeqNb>' + this.e(v.elctrncSeqNb) + '</ElctrncSeqNb>\n';

        if (v.rptgSeq?.trim()) {
            this.generatedXml += t(4) + '<RptgSeq>\n' + t(5) + '<FrSeq>' + this.e(v.rptgSeq) + '</FrSeq>\n' + t(4) + '</RptgSeq>\n';
        }

        if (v.lglSeqNb?.trim()) this.generatedXml += t(4) + '<LglSeqNb>' + this.e(v.lglSeqNb) + '</LglSeqNb>\n';

        this.generatedXml += t(4) + '<CreDtTm>' + creDtTm + '</CreDtTm>\n'
            + frToDtXml
            + cpyDplctXml
            + rptgSrcXml
            + acctBlock
            + bal1Xml
            + bal2Xml
            + txsSummryXml
            + ntryXml
            + addtlRptInfXml
            + t(3) + '</Rpt>\n'
            + t(2) + '</BkToCstmrAcctRpt>\n'
            + t(1) + '</Document>\n'
            + '</BusMsgEnvlp>';
        this.formatXml(false);
        this.onEditorChange(this.generatedXml, true);
    }

    onEditorChange(content: string, fromForm = false) {
        if (!this.isInternalChange && !fromForm) {
            this.pushHistory();
            this.parseXmlToForm(content);
        }
        this.generatedXml = content;
        this.refreshLineCount();
    }

    private pushHistory() {
        const val = this.generatedXml;
        if (this.xmlHistoryIdx >= 0 && this.xmlHistory[this.xmlHistoryIdx] === val) return;
        if (this.xmlHistoryIdx < this.xmlHistory.length - 1) this.xmlHistory.splice(this.xmlHistoryIdx + 1);
        this.xmlHistory.push(val);
        if (this.xmlHistory.length > this.maxHistory) this.xmlHistory.shift();
        else this.xmlHistoryIdx++;
    }

    undoXml() {
        if (this.xmlHistoryIdx > 0) {
            this.xmlHistoryIdx--;
            this.isInternalChange = true;
            this.generatedXml = this.xmlHistory[this.xmlHistoryIdx];
            this.refreshLineCount();
            setTimeout(() => this.isInternalChange = false, 10);
        }
    }

    redoXml() {
        if (this.xmlHistoryIdx < this.xmlHistory.length - 1) {
            this.xmlHistoryIdx++;
            this.isInternalChange = true;
            this.generatedXml = this.xmlHistory[this.xmlHistoryIdx];
            this.refreshLineCount();
            setTimeout(() => this.isInternalChange = false, 10);
        }
    }

    canUndoXml(): boolean { return this.xmlHistoryIdx > 0; }
    canRedoXml(): boolean { return this.xmlHistoryIdx < this.xmlHistory.length - 1; }

    private refreshLineCount() {
        const lines = (this.generatedXml || '').split('\n').length;
        this.editorLineCount = Array.from({ length: lines }, (_, i) => i + 1);
    }

    openBicSearch(controlName: string) {
        const dialogRef = this.dialog.open(BicSearchDialogComponent, {
            width: '800px',
            disableClose: true
        });

        dialogRef.afterClosed().subscribe(result => {
            if (result && result.bic) {
                this.form.patchValue({ [controlName]: result.bic });
                this.form.get(controlName)?.markAsDirty();
            }
        });
    }

    openBicSearchGroup(controlName: string, group: FormGroup) {
        const dialogRef = this.dialog.open(BicSearchDialogComponent, {
            width: '800px',
            disableClose: true
        });

        dialogRef.afterClosed().subscribe(result => {
            if (result && result.bic) {
                group.patchValue({ [controlName]: result.bic });
                group.get(controlName)?.markAsDirty();
            }
        });
    }

    formatXml(showToast = true) {
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
        let lineStart = value.lastIndexOf('\n', start - 1) + 1;
        let lineEnd = value.indexOf('\n', end);
        if (lineEnd === -1) lineEnd = value.length;
        const selection = value.substring(lineStart, lineEnd);
        const before = value.substring(0, lineStart);
        const after = value.substring(lineEnd);
        let newResult = '';
        const trimmed = selection.trim();
        if (trimmed.startsWith('<!--') && trimmed.endsWith('-->')) {
            newResult = selection.replace('<!--', '').replace('-->', '');
        } else {
            newResult = '<!-- ' + selection + ' -->';
        }
        this.generatedXml = before + newResult + after;
        this.refreshLineCount();
        setTimeout(() => {
            textarea.focus();
            textarea.setSelectionRange(lineStart, lineStart + newResult.length);
            this.isInternalChange = false;
        }, 0);
    }

    showValidationModal = false;
    validationStatus: 'idle' | 'validating' | 'done' = 'idle';
    validationReport: any = null;
    validationExpandedIssue: any = null;

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
            message_type: 'camt.052.001.08',
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
                    message: 'camt.052.001.08', total_time_ms: 0,
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


  viewXmlModal() { this.showValidationModal = false; }
  editXmlModal() { this.showValidationModal = false; }
  runValidationModal() { this.validateMessage(); }
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
        return names[k] ?? ('Layer ' + k);
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
    toggleValidationIssue(issue: any) { this.validationExpandedIssue = this.validationExpandedIssue === issue ? null : issue; }

    copyFix(text: string, e: MouseEvent) {
        e.stopPropagation();
        navigator.clipboard.writeText(text).then(() => { this.snackBar.open('Copied!', '', { duration: 1500 }); });
    }

    downloadXml() {
        this.generateXml();
        const b = new Blob([this.generatedXml], { type: 'application/xml' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(b);
        a.download = 'camt052-' + Date.now() + '.xml';
        a.click();
    }

    copyToClipboard() {
        this.generateXml();
        navigator.clipboard.writeText(this.generatedXml).then(() => {
            this.snackBar.open('Copied to clipboard!', 'Close', { duration: 3000, horizontalPosition: 'center', verticalPosition: 'bottom' });
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
        if (reload) {
            setTimeout(() => window.location.reload(), 500);
        }
    }

    private scheduleDraftSave(): void {
        if (this.draftSaveTimer) clearTimeout(this.draftSaveTimer);
        this.draftSaveTimer = setTimeout(() => this.saveDraft(), 2000);
    }

    ngOnDestroy(): void {
        if (this.draftSaveTimer) clearTimeout(this.draftSaveTimer);
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
            // Reset every form control to '' so any element the user removed from the XML
            // clears its mirrored form value (prevents generateXml from re-inserting it).
            Object.keys(this.form.controls).forEach(k => patch[k] = '');
            const setVal = (f: string, v: string) => { if (v) patch[f] = v; };

            const appHdr = getT('AppHdr');
            if (appHdr) {
                setVal('bizMsgId', tval('BizMsgIdr', appHdr));
                setVal('bizSvc', tval('BizSvc', appHdr));
                setVal('creDtTm', tval('CreDt', appHdr));
                setVal('appHdrCharSet', tval('CharSet', appHdr));
                setVal('appHdrCpyDplct', tval('CpyDplct', appHdr));
                setVal('appHdrPrty', tval('Prty', appHdr));
                setVal('appHdrPssblDplct', tval('PssblDplct', appHdr));
                const mktPrctc = getT('MktPrctc', appHdr);
                if (mktPrctc) {
                    setVal('appHdrMktPrctcRegy', tval('Regy', mktPrctc));
                    setVal('appHdrMktPrctcId', tval('Id', mktPrctc));
                }

                const mapPartyHead = (p: Element | null, prefix: string) => {
                    if (!p) return;
                    const fi = getT('FinInstnId', p);
                    if (fi) {
                        patch[prefix + 'Type'] = 'FIId';
                        setVal(prefix + 'Bic', tval('BICFI', fi));
                        setVal(prefix + 'Lei', tval('LEI', fi));
                    } else {
                        patch[prefix + 'Type'] = 'OrgId';
                        setVal(prefix + 'Nm', tval('Nm', p));
                    }
                };
                mapPartyHead(getT('Fr', appHdr), 'from');
                mapPartyHead(getT('To', appHdr), 'to');
            }

            const grpHdr = getT('GrpHdr');
            if (grpHdr) {
                setVal('msgId', tval('MsgId', grpHdr));
                const rcpt = getT('MsgRcpt', grpHdr);
                if (rcpt) {
                    setVal('grpHdrMsgRcptNm', tval('Nm', rcpt));
                    setVal('grpHdrMsgRcptBic', tval('AnyBIC', rcpt));
                }
            }

            const rpt = getT('Rpt');
            if (rpt) {
                setVal('rptId', tval('Id', rpt));
                const acct = getT('Acct', rpt);
                if (acct) {
                    const id = getT('Id', acct);
                    if (id) {
                        const iban = tval('IBAN', id);
                        if (iban) {
                            setVal('acctId', iban);
                            patch.acctIdType = 'IBAN';
                        }
                    }
                    setVal('acctCcy', tval('Ccy', acct));
                    const svcr = getT('Svcr', acct);
                    if (svcr) setVal('acctSvcrBic', tval('BICFI', getT('FinInstnId', svcr) || svcr));
                }
            }

            this.form.patchValue(patch, { emitEvent: false });
        } catch (e) {
            console.error('Error parsing camt.052 XML:', e);
        } finally {
            this.isParsingXml = false;
        }
    }
}
