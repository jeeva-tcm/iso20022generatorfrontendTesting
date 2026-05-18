import { CommonModule } from '@angular/common';
import { Component, OnInit, ViewChild, ElementRef, ChangeDetectorRef, HostListener } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { MatIconModule } from '@angular/material/icon';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatSelectModule } from '@angular/material/select';
import { MatFormFieldModule } from '@angular/material/form-field';
import { ConfigService } from '../../services/config.service';
import JSZip from 'jszip';

@Component({
    selector: 'app-mt-to-mx',
    standalone: true,
    imports: [CommonModule, FormsModule, MatIconModule, MatSnackBarModule, MatTooltipModule, MatSelectModule, MatFormFieldModule],
    templateUrl: './mt-to-mx.component.html',
    styleUrl: './mt-to-mx.component.css'
})
export class MtToMxComponent implements OnInit {
    mtInput = '';
    mxOutput = '';
    editorLineCount: number[] = [1];
    outputLineCount: number[] = [1];
    detectedMtType = '';
    mappedMxType = '';
    mappedMxDesc = '';
    conversionStatus: 'idle' | 'converting' | 'success' | 'error' = 'idle';
    errorMessage = '';
    showValidationSummary = false;
    missingFields: { tag: string, name: string, line?: number | string }[] = [];
    conversionLog: { severity: string; message: string }[] = [];
    conversionErrors: string[] = [];
    activeFieldGuide: any = null;
    uploadedFileName: string | null = null;
    isFileLoading = false;
    isFileWarning = false;
    
    // Bulk Conversion State
    isBulkMode = false;
    bulkMtMessages: { 
        filename: string; 
        content: string; 
        selected: boolean;
        status?: 'pending' | 'success' | 'error';
        mxOutput?: string;
        errorMsg?: string;
    }[] = [];
    bulkConversionProgress = 0;
    bulkTotalFiles = 0;
    bulkZipName: string | null = null;

    get selectedBulkCount(): number {
        return this.bulkMtMessages.filter(m => m.selected).length;
    }

    toggleAllBulkSelection(event: any) {
        const checked = event.target.checked;
        this.bulkMtMessages.forEach(m => m.selected = checked);
    }

    // Undo/Redo History
    private mtHistory: string[] = [];
    private mtHistoryIdx = -1;
    private mxHistory: string[] = [];
    private mxHistoryIdx = -1;
    private maxHistory = 50;
    private isInternalChange = false;

    // Field reference metadata for UI display
    private fieldGuides: Record<string, any[]> = {
        'MT103': [
            { tag: '20', name: 'Sender\'s Reference', mandatory: true, desc: 'Your unique identifier' },
            { tag: '23B', name: 'Bank Operation Code', mandatory: true, desc: 'Usually CRED' },
            { tag: '32A', name: 'Value Date/Currency/Amount', mandatory: true, desc: 'e.g. 250308USD10000,' },
            { tag: '50A/K', name: 'Ordering Customer', mandatory: true, desc: 'Sender details' },
            { tag: '59', name: 'Beneficiary Customer', mandatory: true, desc: 'Receiver details' },
            { tag: '71A', name: 'Details of Charges', mandatory: true, desc: 'SHA / OUR / BEN' }
        ],
        'MT103+': [
            { tag: '20', name: 'Sender\'s Reference', mandatory: true, desc: 'Unique identification' },
            { tag: '23B', name: 'Bank Operation Code', mandatory: true, desc: 'Must be CRED' },
            { tag: '32A', name: 'Value Date/Currency/Amount', mandatory: true, desc: 'Payment details' },
            { tag: '50A', name: 'Ordering Institution', mandatory: true, desc: 'Must be BIC identified' },
            { tag: '59A', name: 'Beneficiary Institution', mandatory: true, desc: 'Must be BIC identified' },
            { tag: '71A', name: 'Details of Charges', mandatory: true, desc: 'SHA / OUR / BEN' }
        ],
        'MT202': [
            { tag: '20', name: 'Transaction Reference', mandatory: true, desc: 'Sender ID' },
            { tag: '21', name: 'Related Reference', mandatory: true, desc: 'Original txn reference' },
            { tag: '32A', name: 'Value Date/Currency/Amount', mandatory: true, desc: 'Transfer details' },
            { tag: '58A', name: 'Beneficiary Institution', mandatory: true, desc: 'Final receiving bank' }
        ],
        'MT900': [
            { tag: '20', name: 'Transaction Reference', mandatory: true, desc: 'Debit reference' },
            { tag: '25', name: 'Account Identification', mandatory: true, desc: 'Account getting debited' },
            { tag: '32A', name: 'Value Date/Currency/Amount', mandatory: true, desc: 'Debit amount' }
        ],
        'MT910': [
            { tag: '20', name: 'Transaction Reference', mandatory: true, desc: 'Credit reference' },
            { tag: '25', name: 'Account Identification', mandatory: true, desc: 'Account getting credited' },
            { tag: '32A', name: 'Value Date/Currency/Amount', mandatory: true, desc: 'Credit amount' }
        ],
        'MT196': [
            { tag: '20', name: 'Transaction Reference', mandatory: true, desc: 'Your resolution ID' },
            { tag: '21', name: 'Related Reference', mandatory: true, desc: 'Original Request ID' },
            { tag: '79', name: 'Narrative (Resolution)', mandatory: true, desc: 'The actual answer' }
        ],
        'MT192': [
            { tag: '20', name: 'Transaction Reference', mandatory: true, desc: 'Cancellation ID' },
            { tag: '21', name: 'Related Reference', mandatory: true, desc: 'Message to cancel' },
            { tag: '11S', name: 'Original Message Header', mandatory: true, desc: 'Context of MT to cancel' }
        ],
        'MT940': [
            { tag: '20', name: 'Transaction Reference', mandatory: true, desc: 'Statement ID' },
            { tag: '25', name: 'Account Identification', mandatory: true, desc: 'Account for statement' },
            { tag: '28C', name: 'Statement/Sequence Number', mandatory: true, desc: 'e.g. 1/1' },
            { tag: '60F', name: 'Opening Balance', mandatory: true, desc: 'Starting funds' },
            { tag: '62F', name: 'Closing Balance', mandatory: true, desc: 'Ending funds' }
        ]
    };

    // Validation modal state
    showValidationModal = false;
    validationStatus: 'idle' | 'validating' | 'done' = 'idle';
    validationReport: any = null;
    validationExpandedIssue: any = null;

    // MT type to MX type mapping per SWIFT ISO 20022 migration
    private mtToMxMap: Record<string, { mx: string; desc: string }> = {
        'MT103': { mx: 'pacs.008.001.08', desc: 'FI to FI Customer Credit Transfer' },
        'MT103+': { mx: 'pacs.008.001.08', desc: 'FI to FI Customer Credit Transfer (STP)' },
        'MT103 REMIT': { mx: 'pacs.008.001.08', desc: 'FI to FI Customer Credit Transfer (Remit)' },
        'MT202': { mx: 'pacs.009.001.08', desc: 'FI to FI Institution Credit Transfer' },
        'MT202COV': { mx: 'pacs.009.001.08', desc: 'FI to FI Institution Credit Transfer (COV)' },
        'MT200': { mx: 'pacs.009.001.08', desc: 'Financial Institution Transfer' },
        'MT900': { mx: 'camt.054.001.08', desc: 'Debit Confirmation' },
        'MT910': { mx: 'camt.054.001.08', desc: 'Credit Confirmation' },
        'MT940': { mx: 'camt.053.001.08', desc: 'Customer Statement' },
        'MT950': { mx: 'camt.053.001.08', desc: 'Statement Message' },
        'MT942': { mx: 'camt.052.001.08', desc: 'Interim Transaction Report' },
        'MT199': { mx: 'pacs.002.001.10', desc: 'Free Format Message (FI)' },
        'MT299': { mx: 'pacs.002.001.10', desc: 'Free Format Message (FI)' },
        'MT192': { mx: 'camt.056.001.08', desc: 'Request for Cancellation' },
        'MT196': { mx: 'camt.029.001.09', desc: 'Resolution of Investigation' },
        'MT210': { mx: 'camt.057.001.06', desc: 'Notice to Receive' },
    };

    @ViewChild('mtEditor') mtEditorRef!: ElementRef<HTMLTextAreaElement>;
    @ViewChild('mtLineNumbers') mtLineNumbersRef!: ElementRef<HTMLDivElement>;
    @ViewChild('mxEditor') mxEditorRef!: ElementRef<HTMLTextAreaElement>;
    @ViewChild('mxLineNumbers') mxLineNumbersRef!: ElementRef<HTMLDivElement>;

    constructor(
        private snackBar: MatSnackBar,
        private http: HttpClient,
        private config: ConfigService,
        private cdr: ChangeDetectorRef
    ) { }

    ngOnInit() {
        // Start empty so XML is not shown by default
        this.mtInput = '';
        this.mxOutput = '';
        this.conversionStatus = 'idle';
        this.updateLineCount('mt');
        this.updateLineCount('mx');
        
        // Init history
        this.pushHistory('mt');
        this.pushHistory('mx');
    }



    onMtChange(value: string) {
        if (!this.isInternalChange) {
            this.pushHistory('mt');
        }
        
        this.mtInput = value;
        this.errorMessage = '';
        const detected = this.detectMtType(value);
        if (detected) {
            this.detectedMtType = detected;
            const cleanType = detected.replace('MT', '');
            const mapping = this.mtToMxMap[detected] || this.mtToMxMap[cleanType];
            this.mappedMxType = mapping ? mapping.mx : 'Unknown';
            this.mappedMxDesc = mapping ? mapping.desc : '';
        } else {
            this.detectedMtType = '';
            this.mappedMxType = '';
            this.mappedMxDesc = '';
        }
        this.activeFieldGuide = null; // Don't show guide proactively
        this.updateLineCount('mt');
        // Reset output when input changes - XML should only show after explicit click
        this.mxOutput = '';
        this.conversionStatus = 'idle';
        this.conversionLog = [];
        this.conversionErrors = [];
        this.missingFields = [];
        this.errorMessage = '';
    }

    onMxChange(content: string) {
        if (!this.isInternalChange) {
            this.pushHistory('mx');
        }
        this.mxOutput = content;
        this.updateLineCount('mx');
    }

    // --- History & Formatting ---
    private pushHistory(type: 'mt' | 'mx') {
        const val = type === 'mt' ? this.mtInput : this.mxOutput;
        const history = type === 'mt' ? this.mtHistory : this.mxHistory;
        let idx = type === 'mt' ? this.mtHistoryIdx : this.mxHistoryIdx;

        // Don't push if no change from last recorded state
        if (idx >= 0 && history[idx] === val) return;

        // If we are in the middle of undo/redo, clear forward states
        if (idx < history.length - 1) {
            history.splice(idx + 1);
        }

        history.push(val);
        if (history.length > this.maxHistory) {
            history.shift();
        } else {
            idx++;
        }

        if (type === 'mt') this.mtHistoryIdx = idx;
        else this.mxHistoryIdx = idx;
    }

    undo(type: 'mt' | 'mx') {
        const history = type === 'mt' ? this.mtHistory : this.mxHistory;
        let idx = type === 'mt' ? this.mtHistoryIdx : this.mxHistoryIdx;

        if (idx > 0) {
            idx--;
            this.isInternalChange = true;
            if (type === 'mt') {
                this.mtInput = history[idx];
                this.mtHistoryIdx = idx;
                this.updateLineCount('mt');
            } else {
                this.mxOutput = history[idx];
                this.mxHistoryIdx = idx;
                this.updateLineCount('mx');
            }
            setTimeout(() => this.isInternalChange = false, 10);
        }
    }

    redo(type: 'mt' | 'mx') {
        const history = type === 'mt' ? this.mtHistory : this.mxHistory;
        let idx = type === 'mt' ? this.mtHistoryIdx : this.mxHistoryIdx;

        if (idx < history.length - 1) {
            idx++;
            this.isInternalChange = true;
            if (type === 'mt') {
                this.mtInput = history[idx];
                this.mtHistoryIdx = idx;
                this.updateLineCount('mt');
            } else {
                this.mxOutput = history[idx];
                this.mxHistoryIdx = idx;
                this.updateLineCount('mx');
            }
            setTimeout(() => this.isInternalChange = false, 10);
        }
    }

    canUndo(type: 'mt' | 'mx'): boolean {
        const idx = type === 'mt' ? this.mtHistoryIdx : this.mxHistoryIdx;
        return idx > 0;
    }

    canRedo(type: 'mt' | 'mx'): boolean {
        const history = type === 'mt' ? this.mtHistory : this.mxHistory;
        const idx = type === 'mt' ? this.mtHistoryIdx : this.mxHistoryIdx;
        return idx < history.length - 1;
    }

    formatXml() {
        if (!this.mxOutput?.trim()) return;
        this.pushHistory('mx');
        
        try {
            let xml = this.mxOutput.trim();
            // Basic Prettifier
            let formatted = '';
            let indent = '';
            const tab = '    ';
            
            xml.split(/>\s*</).forEach(node => {
                if (node.match(/^\/\w/)) indent = indent.substring(tab.length);
                formatted += indent + '<' + node + '>\r\n';
                if (node.match(/^<?\w[^>]*[^\/]$/) && !node.startsWith('?')) indent += tab;
            });
            
            this.mxOutput = formatted.substring(1, formatted.length - 3);
            this.updateLineCount('mx');
            this.snackBar.open('XML Formatted', '', { duration: 1500 });
        } catch (e) {
            this.snackBar.open('Unable to format XML - Check syntax', '', { duration: 3000 });
        }
    }

    formatMt() {
        if (!this.mtInput?.trim()) return;
        this.pushHistory('mt');
        
        // Normalize line endings and trim lines
        const lines = this.mtInput.split('\n').map(l => l.trimEnd());
        this.mtInput = lines.join('\n').trim();
        this.updateLineCount('mt');
        this.snackBar.open('MT Message Cleaned', '', { duration: 1500 });
    }

    @HostListener('keydown', ['$event'])
    handleKeyboardEvents(event: KeyboardEvent) {
        if (!(event.ctrlKey || event.metaKey)) return;

        const isMtFocus = document.activeElement === this.mtEditorRef?.nativeElement;
        const isMxFocus = document.activeElement === this.mxEditorRef?.nativeElement;

        if (!isMtFocus && !isMxFocus) return;

        const type = isMtFocus ? 'mt' : 'mx';

        switch (event.key.toLowerCase()) {
            case 'z':
                event.preventDefault();
                this.undo(type);
                break;
            case 'y':
                event.preventDefault();
                this.redo(type);
                break;
            case 's':
                event.preventDefault();
                if (type === 'mx') this.formatXml();
                else this.formatMt();
                break;
        }
    }

    updateLineCount(which: 'mt' | 'mx') {
        const content = which === 'mt' ? this.mtInput : this.mxOutput;
        const lines = (content || '').split('\n').length;
        if (which === 'mt') {
            this.editorLineCount = Array.from({ length: lines }, (_, i) => i + 1);
        } else {
            this.outputLineCount = Array.from({ length: lines }, (_, i) => i + 1);
        }
    }

    syncScroll(editor: HTMLTextAreaElement, gutter: HTMLDivElement) {
        gutter.scrollTop = editor.scrollTop;
    }

    detectMtType(mt: string): string {
        if (!mt?.trim()) return '';

        // 1. Check for explicit SWIFT headers first (most reliable)
        const appMatch = mt.match(/\{2:[IO](\d{3})/);
        if (appMatch) {
            const type = 'MT' + appMatch[1];
            // Check for subtypes in Block 3 or Body
            if (type === 'MT202' && (mt.includes('{119:COV}') || mt.includes(':119:COV'))) return 'MT202COV';
            if (type === 'MT103' && (mt.includes('{119:STP}') || mt.includes(':119:STP'))) return 'MT103+';
            if (type === 'MT103' && (mt.includes('{119:REMIT}') || mt.includes(':119:REMIT') || mt.includes(':77T:'))) return 'MT103 REMIT';
            return type;
        }

        // 2. Fallback Heuristics for headerless messages (Block 4 only)
        if (mt.includes(':20:')) {
            if (mt.includes(':119:COV')) return 'MT202COV';
            if (mt.includes(':119:STP')) return 'MT103+';

            // Statement/Report types
            if (mt.includes(':25:')) {
                if (mt.includes(':13D:') || mt.includes(':34F:')) return 'MT942'; // Report
                if (mt.includes(':60F:') || mt.includes(':62F:')) {
                    if (mt.includes(':28C:')) return 'MT940';
                    return 'MT950';
                }
                if (mt.includes(':32A:')) return 'MT900'; // Debit
            }

            // Transaction types
            if (mt.includes(':23B:')) return 'MT103';
            if (mt.includes(':32B:') && mt.includes(':30:')) return 'MT210';
            if (mt.includes(':59:') || mt.includes(':50K:')) return 'MT103';
            if (mt.includes(':58A:') || mt.includes(':58D:')) return 'MT202';
            if (mt.includes(':21:') && mt.includes(':76:')) return 'MT196';
            if (mt.includes(':21:') && !mt.includes(':32A:')) return 'MT192'; // Cancel
        }
        return '';
    }

    convert() {
        this.conversionStatus = 'converting';
        this.conversionLog = [];
        this.conversionErrors = [];
        this.errorMessage = '';
        this.mxOutput = '';
        this.showValidationSummary = false;

        // Immediate UI refresh to hide old errors
        this.missingFields = [];
        this.cdr.detectChanges();

        const mtType = this.detectMtType(this.mtInput);
        this.detectedMtType = mtType;

        this.addLog('INFO', `Sending MT message to backend conversion engine...`);

        this.http.post<any>(this.config.getApiUrl('/convert-mt-to-mx'), {
            mt_message: this.mtInput,
            target_mt_type: mtType || null
        }).subscribe({
            next: (response) => {
                this.mxOutput = response.mx_message;
                this.updateLineCount('mx');

                // Set the mapped MX type based on the response if available, or fallback
                if (response.detected_type) {
                    const typeValue = String(response.detected_type);
                    this.detectedMtType = typeValue.toUpperCase().startsWith('MT') ? typeValue : ('MT' + typeValue);
                    const mapping = this.mtToMxMap[this.detectedMtType] || this.mtToMxMap[typeValue] || this.mtToMxMap['MT' + typeValue];
                    if (mapping) {
                        this.mappedMxType = mapping.mx;
                        this.mappedMxDesc = mapping.desc;
                    }
                }

                this.conversionStatus = 'success';
                this.validationReport = response.validation_report || null;

                // Only show mandatory fields that are actually MISSING after conversion
                this.activeFieldGuide = this.calculateMissingFields(this.detectedMtType);

                if (response.logs && Array.isArray(response.logs)) {
                    response.logs.forEach((log: string) => this.addLog('INFO', log));
                }
                this.addLog('INFO', `Conversion completed successfully.`);

                // Force a clean slate on success
                this.missingFields = [];
                this.conversionErrors = [];
                this.cdr.detectChanges();
            },
            error: (err) => {
                this.conversionStatus = 'error';
                this.missingFields = [];
                this.validationReport = (err.error?.detail?.validation_report) || null;

                // Show missing fields even on error so user knows what to fix
                this.activeFieldGuide = this.calculateMissingFields(this.detectedMtType);

                if (err.error && err.error.detail && err.error.detail.errors) {
                    const errors = err.error.detail.errors;
                    const logs = err.error.detail.logs;

                    if (logs && Array.isArray(logs)) {
                        logs.forEach(l => this.addLog('INFO', `Backend Log: ${l}`));
                    }

                    this.conversionErrors = errors;
                    this.errorMessage = errors[0];

                    const tagsSeen = new Set<string>();
                    errors.forEach((msg: string) => {
                        this.addLog('ERROR', msg);

                        const match = msg.match(/Missing mandatory field :([^:]+): \(([^)]+)\)/);
                        const emptyMatch = msg.match(/Mandatory field :([^:]+): \(([^)]+)\) is empty/);
                        const dataErrorMatch = msg.match(/Field :([^:]+): \(([^)]+)\) contains invalid data/);

                        if (match || emptyMatch || dataErrorMatch) {
                            const actualMatch = match || emptyMatch || dataErrorMatch;
                            if (actualMatch) {
                                const tag = actualMatch[1];
                                if (!tagsSeen.has(tag)) {
                                    const insertionInfo = this.getLineSuggestion(tag);
                                    this.missingFields.push({
                                        tag,
                                        name: actualMatch[2],
                                        line: insertionInfo.line
                                    });
                                    tagsSeen.add(tag);
                                }
                            }
                        }
                    });
                } else if (err.status === 0) {
                    this.errorMessage = 'Backend connection failed. Please ensure the local server (127.0.0.1:8001) is running.';
                    this.addLog('ERROR', 'Connection Refused: Target backend offline or CORS error.');
                } else {
                    this.errorMessage = err.error?.detail || err.message || 'Server returned an unknown error.';
                    this.addLog('ERROR', this.errorMessage);
                }
            }
        });
    }

    private parseMtFields(mt: string): Record<string, string> {
        const fields: Record<string, string> = {};

        // Parse SWIFT blocks
        const block1Match = mt.match(/\{1:([^}]+)\}/);
        const block2Match = mt.match(/\{2:([^}]+)\}/);
        if (block1Match) {
            fields['_block1'] = block1Match[1];
            const b1 = block1Match[1];
            if (b1.length >= 12) {
                fields['_senderBic'] = b1.substring(3, 11);
            }
        }
        if (block2Match) {
            fields['_block2'] = block2Match[1];
            const b2 = block2Match[1];
            if (b2.startsWith('O') && b2.length >= 18) {
                fields['_receiverBic'] = b2.substring(15, 23) || '';
            } else if (b2.startsWith('I') && b2.length >= 12) {
                fields['_receiverBic'] = b2.substring(4, 12);
            }
        }

        // Parse block 3 for UETR
        const block3Match = mt.match(/\{3:[^}]*\{121:([a-f0-9-]{36})\}/i);
        if (block3Match) fields['_uetr'] = block3Match[1];

        // Parse block 4 tags
        const block4Match = mt.match(/\{4:\s*\n?([\s\S]*?)(?:-\}|\{5:)/);
        const textBlock = block4Match ? block4Match[1] : mt;
        const tagRegex = /:(\d{2}[A-Z]?):([^:]*?)(?=\n:\d{2}[A-Z]?:|$)/gs;
        let m;
        while ((m = tagRegex.exec(textBlock)) !== null) {
            const tag = m[1].trim();
            const val = m[2].trim();
            if (fields[tag]) {
                fields[tag + '_2'] = val;
            } else {
                fields[tag] = val;
            }
        }
        return fields;
    }

    // === MT103 → pacs.008.001.08 ===
    private convertMT103ToPacs008(f: Record<string, string>): string {
        const now = this.isoNow();
        const date = now.split('T')[0];
        const senderBic = this.normalizeSwiftBic(f['_senderBic'] || 'BANKUS33XXX');
        const receiverBic = this.normalizeSwiftBic(f['_receiverBic'] || 'BANKGB2LXXX');
        const msgId = f['20'] || 'MSGID-' + Date.now();
        const instrId = f['20'] || msgId;
        const endToEndId = f['21'] || msgId;
        const uetr = f['_uetr'] || this.generateUUID();

        // Parse amount from :32A:
        const { date: valDate, ccy, amount } = this.parseField32A(f['32A'] || '');
        const sttlmDt = valDate || date;
        const chrgBr = this.mapChargeBearer(f['71A'] || 'SHA');

        // Parse parties
        const dbtr = this.parsePartyField(f['50A'] || f['50K'] || f['50F'] || '');
        const cdtr = this.parsePartyField(f['59'] || f['59A'] || f['59F'] || '');
        const dbtrAgt = this.parseBicField(f['52A'] || f['52D'] || '', senderBic);
        const cdtrAgt = this.parseBicField(f['57A'] || f['57D'] || '', receiverBic);
        const instgAgt = senderBic;
        const instdAgt = receiverBic;

        this.addLog('INFO', `Sender BIC: ${senderBic}, Receiver BIC: ${receiverBic}`);
        this.addLog('INFO', `Amount: ${amount} ${ccy}, Value Date: ${sttlmDt}`);

        return `<?xml version="1.0" encoding="UTF-8"?>
<BusMsgEnvlp xmlns="urn:swift:xsd:envelope">
\t<AppHdr xmlns="urn:iso:std:iso:20022:tech:xsd:head.001.001.02">
\t\t<Fr><FIId><FinInstnId><BICFI>${this.esc(instgAgt)}</BICFI></FinInstnId></FIId></Fr>
\t\t<To><FIId><FinInstnId><BICFI>${this.esc(instdAgt)}</BICFI></FinInstnId></FIId></To>
\t\t<BizMsgIdr>${this.esc(msgId)}</BizMsgIdr>
\t\t<MsgDefIdr>pacs.008.001.08</MsgDefIdr>
\t\t<BizSvc>swift.cbprplus.02</BizSvc>
\t\t<CreDt>${now}</CreDt>
\t</AppHdr>
\t<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pacs.008.001.08">
\t\t<FIToFICstmrCdtTrf>
\t\t\t<GrpHdr>
\t\t\t\t<MsgId>${this.esc(msgId)}</MsgId>
\t\t\t\t<CreDtTm>${now}</CreDtTm>
\t\t\t\t<NbOfTxs>1</NbOfTxs>
\t\t\t\t<SttlmInf>
\t\t\t\t\t<SttlmMtd>INDA</SttlmMtd>
\t\t\t\t</SttlmInf>
\t\t\t</GrpHdr>
\t\t\t<CdtTrfTxInf>
\t\t\t\t<PmtId>
\t\t\t\t\t<InstrId>${this.esc(instrId)}</InstrId>
\t\t\t\t\t<EndToEndId>${this.esc(endToEndId)}</EndToEndId>
\t\t\t\t\t<TxId>${this.esc(instrId)}</TxId>
\t\t\t\t\t<UETR>${uetr}</UETR>
\t\t\t\t</PmtId>
\t\t\t\t<IntrBkSttlmAmt Ccy="${this.esc(ccy)}">${amount}</IntrBkSttlmAmt>
\t\t\t\t<IntrBkSttlmDt>${sttlmDt}</IntrBkSttlmDt>
\t\t\t\t<ChrgBr>${chrgBr}</ChrgBr>
\t\t\t\t<InstgAgt>
\t\t\t\t\t<FinInstnId>
\t\t\t\t\t\t<BICFI>${this.esc(instgAgt)}</BICFI>
\t\t\t\t\t</FinInstnId>
\t\t\t\t</InstgAgt>
\t\t\t\t<InstdAgt>
\t\t\t\t\t<FinInstnId>
\t\t\t\t\t\t<BICFI>${this.esc(instdAgt)}</BICFI>
\t\t\t\t\t</FinInstnId>
\t\t\t\t</InstdAgt>
\t\t\t\t<Dbtr>
\t\t\t\t\t<Nm>${this.esc(dbtr.name)}</Nm>
\t\t\t\t</Dbtr>${dbtr.iban ? `
\t\t\t\t<DbtrAcct>
\t\t\t\t\t<Id>
\t\t\t\t\t\t<IBAN>${this.esc(dbtr.iban)}</IBAN>
\t\t\t\t\t</Id>
\t\t\t\t</DbtrAcct>` : (dbtr.acct ? `
\t\t\t\t<DbtrAcct>
\t\t\t\t\t<Id>
\t\t\t\t\t\t<Othr>
\t\t\t\t\t\t\t<Id>${this.esc(dbtr.acct)}</Id>
\t\t\t\t\t\t</Othr>
\t\t\t\t\t</Id>
\t\t\t\t</DbtrAcct>` : '')}
\t\t\t\t<DbtrAgt>
\t\t\t\t\t<FinInstnId>
\t\t\t\t\t\t<BICFI>${this.esc(dbtrAgt)}</BICFI>
\t\t\t\t\t</FinInstnId>
\t\t\t\t</DbtrAgt>
\t\t\t\t<CdtrAgt>
\t\t\t\t\t<FinInstnId>
\t\t\t\t\t\t<BICFI>${this.esc(cdtrAgt)}</BICFI>
\t\t\t\t\t</FinInstnId>
\t\t\t\t</CdtrAgt>
\t\t\t\t<Cdtr>
\t\t\t\t\t<Nm>${this.esc(cdtr.name)}</Nm>
\t\t\t\t</Cdtr>${cdtr.iban ? `
\t\t\t\t<CdtrAcct>
\t\t\t\t\t<Id>
\t\t\t\t\t\t<IBAN>${this.esc(cdtr.iban)}</IBAN>
\t\t\t\t\t</Id>
\t\t\t\t</CdtrAcct>` : (cdtr.acct ? `
\t\t\t\t<CdtrAcct>
\t\t\t\t\t<Id>
\t\t\t\t\t\t<Othr>
\t\t\t\t\t\t\t<Id>${this.esc(cdtr.acct)}</Id>
\t\t\t\t\t\t</Othr>
\t\t\t\t\t</Id>
\t\t\t\t</CdtrAcct>` : '')}${f['70'] ? `
\t\t\t\t<RmtInf>
\t\t\t\t\t<Ustrd>${this.esc(f['70'])}</Ustrd>
\t\t\t\t</RmtInf>` : ''}
\t\t\t</CdtTrfTxInf>
\t\t</FIToFICstmrCdtTrf>
\t</Document>
</BusMsgEnvlp>`;
    }

    // === MT202/MT200 → pacs.009.001.08 ===
    private convertMT202ToPacs009(f: Record<string, string>, isCov: boolean): string {
        const now = this.isoNow();
        const senderBic = this.normalizeSwiftBic(f['_senderBic'] || 'BANKUS33XXX');
        const receiverBic = this.normalizeSwiftBic(f['_receiverBic'] || 'BANKGB2LXXX');
        const msgId = f['20'] || 'MSGID-' + Date.now();
        const txRef = f['21'] || msgId;
        const uetr = f['_uetr'] || this.generateUUID();
        const { date: valDate, ccy, amount } = this.parseField32A(f['32A'] || '');
        const sttlmDt = valDate || now.split('T')[0];

        const dbtrBic = this.parseBicField(f['52A'] || f['52D'] || '', senderBic);
        const cdtrBic = this.parseBicField(f['58A'] || f['58D'] || '', receiverBic);
        const sttlmMtd = isCov ? 'COVE' : 'INDA';

        this.addLog('INFO', `Sender: ${senderBic}, Receiver: ${receiverBic}`);
        this.addLog('INFO', `Amount: ${amount} ${ccy}, COV: ${isCov}`);

        let covBlock = '';
        if (isCov) {
            // Parse underlying customer credit transfer fields from sequence B
            const covDbtrName = f['50A'] || f['50K'] || '';
            const covCdtrName = f['59'] || f['59A'] || '';
            const covDbtr = this.parsePartyField(covDbtrName);
            const covCdtr = this.parsePartyField(covCdtrName);
            const covDbtrAgt = this.parseBicField(f['52A_2'] || '', dbtrBic);
            const covCdtrAgt = this.parseBicField(f['57A_2'] || '', cdtrBic);

            covBlock = `
\t\t\t\t<UndrlygCstmrCdtTrf>
\t\t\t\t\t<Dbtr>
\t\t\t\t\t\t<Nm>${this.esc(covDbtr.name || 'Ordering Customer')}</Nm>
\t\t\t\t\t</Dbtr>${covDbtr.iban ? `
\t\t\t\t\t<DbtrAcct>
\t\t\t\t\t\t<Id>
\t\t\t\t\t\t\t<IBAN>${this.esc(covDbtr.iban)}</IBAN>
\t\t\t\t\t\t</Id>
\t\t\t\t\t</DbtrAcct>` : ''}
\t\t\t\t\t<DbtrAgt>
\t\t\t\t\t\t<FinInstnId>
\t\t\t\t\t\t\t<BICFI>${this.esc(covDbtrAgt)}</BICFI>
\t\t\t\t\t\t</FinInstnId>
\t\t\t\t\t</DbtrAgt>
\t\t\t\t\t<CdtrAgt>
\t\t\t\t\t\t<FinInstnId>
\t\t\t\t\t\t\t<BICFI>${this.esc(covCdtrAgt)}</BICFI>
\t\t\t\t\t\t</FinInstnId>
\t\t\t\t\t</CdtrAgt>
\t\t\t\t\t<Cdtr>
\t\t\t\t\t\t<Nm>${this.esc(covCdtr.name || 'Beneficiary Customer')}</Nm>
\t\t\t\t\t</Cdtr>${covCdtr.iban ? `
\t\t\t\t\t<CdtrAcct>
\t\t\t\t\t\t<Id>
\t\t\t\t\t\t\t<IBAN>${this.esc(covCdtr.iban)}</IBAN>
\t\t\t\t\t\t</Id>
\t\t\t\t\t</CdtrAcct>` : ''}
\t\t\t\t\t<InstdAmt Ccy="${this.esc(ccy)}">${amount}</InstdAmt>
\t\t\t\t</UndrlygCstmrCdtTrf>`;
        }

        return `<?xml version="1.0" encoding="UTF-8"?>
<BusMsgEnvlp xmlns="urn:swift:xsd:envelope">
\t<AppHdr xmlns="urn:iso:std:iso:20022:tech:xsd:head.001.001.02">
\t\t<Fr><FIId><FinInstnId><BICFI>${this.esc(senderBic)}</BICFI></FinInstnId></FIId></Fr>
\t\t<To><FIId><FinInstnId><BICFI>${this.esc(receiverBic)}</BICFI></FinInstnId></FIId></To>
\t\t<BizMsgIdr>${this.esc(msgId)}</BizMsgIdr>
\t\t<MsgDefIdr>pacs.009.001.08</MsgDefIdr>
\t\t<BizSvc>${isCov ? 'swift.cbprplus.cov.04' : 'swift.cbprplus.02'}</BizSvc>
\t\t<CreDt>${now}</CreDt>
\t</AppHdr>
\t<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pacs.009.001.08">
\t\t<FICdtTrf>
\t\t\t<GrpHdr>
\t\t\t\t<MsgId>${this.esc(msgId)}</MsgId>
\t\t\t\t<CreDtTm>${now}</CreDtTm>
\t\t\t\t<NbOfTxs>1</NbOfTxs>
\t\t\t\t<SttlmInf>
\t\t\t\t\t<SttlmMtd>${sttlmMtd}</SttlmMtd>
\t\t\t\t</SttlmInf>
\t\t\t</GrpHdr>
\t\t\t<CdtTrfTxInf>
\t\t\t\t<PmtId>
\t\t\t\t\t<InstrId>${this.esc(msgId)}</InstrId>
\t\t\t\t\t<EndToEndId>${this.esc(txRef)}</EndToEndId>
\t\t\t\t\t<UETR>${uetr}</UETR>
\t\t\t\t</PmtId>
\t\t\t\t<IntrBkSttlmAmt Ccy="${this.esc(ccy)}">${amount}</IntrBkSttlmAmt>
\t\t\t\t<IntrBkSttlmDt>${sttlmDt}</IntrBkSttlmDt>
\t\t\t\t<InstgAgt>
\t\t\t\t\t<FinInstnId>
\t\t\t\t\t\t<BICFI>${this.esc(senderBic)}</BICFI>
\t\t\t\t\t</FinInstnId>
\t\t\t\t</InstgAgt>
\t\t\t\t<InstdAgt>
\t\t\t\t\t<FinInstnId>
\t\t\t\t\t\t<BICFI>${this.esc(receiverBic)}</BICFI>
\t\t\t\t\t</FinInstnId>
\t\t\t\t</InstdAgt>
\t\t\t\t<Dbtr>
\t\t\t\t\t<FinInstnId>
\t\t\t\t\t\t<BICFI>${this.esc(dbtrBic)}</BICFI>
\t\t\t\t\t</FinInstnId>
\t\t\t\t</Dbtr>
\t\t\t\t<DbtrAgt>
\t\t\t\t\t<FinInstnId>
\t\t\t\t\t\t<BICFI>${this.esc(senderBic)}</BICFI>
\t\t\t\t\t</FinInstnId>
\t\t\t\t</DbtrAgt>
\t\t\t\t<CdtrAgt>
\t\t\t\t\t<FinInstnId>
\t\t\t\t\t\t<BICFI>${this.esc(receiverBic)}</BICFI>
\t\t\t\t\t</FinInstnId>
\t\t\t\t</CdtrAgt>
\t\t\t\t<Cdtr>
\t\t\t\t\t<FinInstnId>
\t\t\t\t\t\t<BICFI>${this.esc(cdtrBic)}</BICFI>
\t\t\t\t\t</FinInstnId>
\t\t\t\t</Cdtr>${covBlock}
\t\t\t</CdtTrfTxInf>
\t\t</FICdtTrf>
\t</Document>
</BusMsgEnvlp>`;
    }

    // === MT210 → camt.057.001.06 (NotificationToReceiveV06 — CBPR+ profile) ===
    private convertMT210ToCamt057(f: Record<string, string>): string {
        const now = this.isoNow();
        const senderBic = this.normalizeSwiftBic(f['_senderBic'] || 'BANKUS33XXX');
        const receiverBic = this.normalizeSwiftBic(f['_receiverBic'] || 'BANKGB2LXXX');
        const msgId = f['20'] || 'MSGID-' + Date.now();
        const { date: valDate, ccy, amount } = this.parseField32A(f['30'] ? '000000' + f['30'] : (f['32B'] || ''));

        return `<?xml version="1.0" encoding="UTF-8"?>
<BusMsgEnvlp xmlns="urn:swift:xsd:envelope">
\t<AppHdr xmlns="urn:iso:std:iso:20022:tech:xsd:head.001.001.02">
\t\t<Fr><FIId><FinInstnId><BICFI>${this.esc(senderBic)}</BICFI></FinInstnId></FIId></Fr>
\t\t<To><FIId><FinInstnId><BICFI>${this.esc(receiverBic)}</BICFI></FinInstnId></FIId></To>
\t\t<BizMsgIdr>${this.esc(msgId)}</BizMsgIdr>
\t\t<MsgDefIdr>camt.057.001.06</MsgDefIdr>
\t\t<BizSvc>swift.cbprplus.02</BizSvc>
\t\t<CreDt>${now}</CreDt>
\t</AppHdr>
\t<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.057.001.06">
\t\t<NtfctnToRcv>
\t\t\t<GrpHdr>
\t\t\t\t<MsgId>${this.esc(msgId)}</MsgId>
\t\t\t\t<CreDtTm>${now}</CreDtTm>
\t\t\t</GrpHdr>
\t\t\t<Ntfctn>
\t\t\t\t<Id>${this.esc(msgId)}</Id>
\t\t\t\t<Itm>
\t\t\t\t\t<Amt Ccy="${this.esc(ccy || 'USD')}">${amount || '0.00'}</Amt>
\t\t\t\t\t<XpctdValDt>${valDate || now.split('T')[0]}</XpctdValDt>
\t\t\t\t</Itm>
\t\t\t</Ntfctn>
\t\t</NtfctnToRcv>
\t</Document>
</BusMsgEnvlp>`;
    }

    // === Generic fallback ===
    private convertGeneric(f: Record<string, string>, mxType: string): string {
        const now = this.isoNow();
        const senderBic = this.normalizeSwiftBic(f['_senderBic'] || 'BANKUS33XXX');
        const receiverBic = this.normalizeSwiftBic(f['_receiverBic'] || 'BANKGB2LXXX');
        const msgId = f['20'] || 'MSGID-' + Date.now();

        this.addLog('WARNING', `Using generic conversion for ${mxType}. Output may need manual adjustment.`);

        return `<?xml version="1.0" encoding="UTF-8"?>
<!-- Generic conversion from ${this.detectedMtType} to ${mxType} -->
<!-- Manual review recommended for full compliance -->
<BusMsgEnvlp xmlns="urn:swift:xsd:envelope">
\t<AppHdr xmlns="urn:iso:std:iso:20022:tech:xsd:head.001.001.02">
\t\t<Fr><FIId><FinInstnId><BICFI>${this.esc(senderBic)}</BICFI></FinInstnId></FIId></Fr>
\t\t<To><FIId><FinInstnId><BICFI>${this.esc(receiverBic)}</BICFI></FinInstnId></FIId></To>
\t\t<BizMsgIdr>${this.esc(msgId)}</BizMsgIdr>
\t\t<MsgDefIdr>${mxType}</MsgDefIdr>
\t\t<BizSvc>swift.cbprplus.02</BizSvc>
\t\t<CreDt>${now}</CreDt>
\t</AppHdr>
\t<!-- Document body requires manual mapping for ${mxType} -->
</BusMsgEnvlp>`;
    }

    // ─── Helpers ───
    private esc(v: string) { return (v || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

    private isoNow(): string {
        return new Date().toISOString().split('.')[0] + '+00:00';
    }

    private generateUUID(): string {
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
            const r = Math.random() * 16 | 0;
            return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
        });
    }

    private normalizeSwiftBic(bic: string): string {
        bic = bic.trim().replace(/\s/g, '');
        if (bic.length === 8) bic += 'XXX';
        return bic.substring(0, 11).toUpperCase();
    }

    private parseField32A(val: string): { date: string; ccy: string; amount: string } {
        // Format: YYMMDDCCCAMOUNT  e.g. 260304USD1500,00
        val = val.trim().replace(/\n/g, '');
        const m = val.match(/^(\d{6})([A-Z]{3})([0-9,.]+)$/);
        if (m) {
            const yy = m[1].substring(0, 2);
            const mm = m[1].substring(2, 4);
            const dd = m[1].substring(4, 6);
            const year = parseInt(yy) > 50 ? '19' + yy : '20' + yy;
            return {
                date: `${year}-${mm}-${dd}`,
                ccy: m[2],
                amount: m[3].replace(',', '.')
            };
        }
        // Try 32B format: CCCAMOUNT
        const m2 = val.match(/^([A-Z]{3})([0-9,.]+)$/);
        if (m2) return { date: '', ccy: m2[1], amount: m2[2].replace(',', '.') };
        return { date: '', ccy: 'USD', amount: '0.00' };
    }

    private mapChargeBearer(mt: string): string {
        const map: Record<string, string> = { 'SHA': 'SHAR', 'BEN': 'CRED', 'OUR': 'DEBT', 'SLV': 'SLEV' };
        return map[mt.trim().toUpperCase()] || 'SHAR';
    }

    private parsePartyField(val: string): { name: string; iban: string; acct: string; bic: string } {
        const lines = val.split('\n').map(l => l.trim()).filter(l => l);
        let name = '', iban = '', acct = '', bic = '';

        for (const line of lines) {
            if (line.startsWith('/')) {
                const id = line.substring(1);
                if (/^[A-Z]{2}\d{2}/.test(id)) iban = id;
                else acct = id;
            } else if (/^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}/.test(line) && line.length <= 11) {
                bic = line;
            } else {
                name = name ? name + ' ' + line : line;
            }
        }
        return { name: name || 'Unknown Party', iban, acct, bic };
    }

    private parseBicField(val: string, fallback: string): string {
        const lines = val.split('\n').map(l => l.trim()).filter(l => l);
        for (const line of lines) {
            const clean = line.replace(/^\/[A-Z]+\//, '');
            if (/^[A-Z0-9]{4}[A-Z]{2}[A-Z0-9]{2,5}$/.test(clean)) {
                return this.normalizeSwiftBic(clean);
            }
        }
        return fallback;
    }

    private addLog(severity: string, message: string) {
        this.conversionLog.push({ severity, message });
    }

    // Toolbar actions
    copyMxToClipboard() {
        if (!this.mxOutput?.trim()) return;
        navigator.clipboard.writeText(this.mxOutput).then(() => {
            this.snackBar.open('MX XML copied to clipboard!', 'Close', { duration: 3000, horizontalPosition: 'center', verticalPosition: 'bottom' });
        });
    }

    downloadMx() {
        if (!this.mxOutput?.trim()) return;
        const b = new Blob([this.mxOutput], { type: 'application/xml' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(b);
        a.download = `${this.mappedMxType || 'mx'}-${Date.now()}.xml`;
        a.click();
        URL.revokeObjectURL(a.href);
    }

    validateMx() {
        if (!this.mxOutput?.trim()) return;
        this.showValidationSummary = true;

        // Client-side well-formedness pre-check
        const parser = new DOMParser();
        const doc = parser.parseFromString(this.mxOutput, 'text/xml');
        const parseErrorEl = doc.querySelector('parsererror');
        if (parseErrorEl) {
            // Collect ALL errors — don't stop at the first
            const allDetails: any[] = [];
            const lines = this.mxOutput.split('\n');
            const rawAmpRe = /&(?![a-zA-Z#][a-zA-Z0-9#]*;)/g;
            const nameTagRe = /<(Nm|StrtNm|TwnNm|BldgNm|AdrLine|DstrctNm|CtrySubDvsn|TwnLctnNm)>([^<]+)<\/\1>/g;
            const safeCharRe = /^[a-zA-Z0-9 .,()'"-]+$/;

            // 1. Find every line with a literal unescaped &
            lines.forEach((line, idx) => {
                rawAmpRe.lastIndex = 0;
                if (rawAmpRe.test(line)) {
                    const lineNum = String(idx + 1);
                    allDetails.push({
                        severity: 'ERROR', layer: 1, code: 'INVALID_CHARSET', path: lineNum,
                        message: `Invalid character '&' at line ${lineNum}. The ampersand is reserved in XML and is not allowed in name or address fields.`,
                        fix_suggestion: `Remove or replace '&' at line ${lineNum}. Write 'and' instead.`
                    });
                }
            });

            // 2. Find invalid charset in name/address tags
            let tagMatch: RegExpExecArray | null;
            nameTagRe.lastIndex = 0;
            while ((tagMatch = nameTagRe.exec(this.mxOutput)) !== null) {
                const tagName = tagMatch[1];
                const tagValue = tagMatch[2].trim();
                if (tagValue && !safeCharRe.test(tagValue)) {
                    const before = this.mxOutput.substring(0, tagMatch.index);
                    const lineNum = String((before.match(/\n/g) || []).length + 1);
                    const badChars = [...new Set(tagValue.split('').filter(c => !/[a-zA-Z0-9 .,()'"-]/.test(c)))].join(' ');
                    allDetails.push({
                        severity: 'ERROR', layer: 1, code: 'INVALID_CHARSET', path: lineNum,
                        message: `Field <${tagName}> at line ${lineNum} contains invalid character(s): ${badChars}. Only letters, digits, spaces and . , ( ) ' - are allowed.`,
                        fix_suggestion: `Remove or replace ${badChars} in <${tagName}> at line ${lineNum}.`
                    });
                }
            }

            // 3. Generic fallback if nothing specific found
            if (allDetails.length === 0) {
                const rawError = parseErrorEl.textContent || '';
                let lineNum = '?';
                const lineMatch = rawError.match(/[Ll]ine[:\s]+(\d+)/i) || rawError.match(/(\d+):(\d+)/);
                if (lineMatch) lineNum = lineMatch[1];
                allDetails.push({
                    severity: 'ERROR', layer: 1, code: 'XML_SYNTAX', path: lineNum,
                    message: `Malformed XML at line ${lineNum} — invalid structure or unclosed tags.`,
                    fix_suggestion: `Check line ${lineNum}: ensure all tags are properly opened and closed.`
                });
            }

            this.validationReport = {
                status: 'FAIL', errors: allDetails.length, warnings: 0,
                message: this.mappedMxType || 'Unknown',
                total_time_ms: 0,
                layer_status: { '1': { status: '❌', time: 0 } },
                details: allDetails
            };
            this.validationStatus = 'done';
            this.showValidationModal = true;
            return;
        }

        this.validationReport = null;
        this.validationStatus = 'validating';
        this.validationExpandedIssue = null;
        this.showValidationModal = true;

        this.http.post(this.config.getApiUrl('/validate'), {
            xml_content: this.mxOutput,
            mode: 'Full 1-3',
            message_type: this.mappedMxType || 'Auto-detect',
            store_in_history: true,
            origin: 'MT to MX'
        }).subscribe({
            next: (data: any) => {
                this.validationReport = data;
                this.validationStatus = 'done';
            },
            error: () => {
                this.validationReport = {
                    status: 'FAIL', errors: 1, warnings: 0,
                    message: 'Error', total_time_ms: 0,
                    layer_status: {},
                    details: [{
                        severity: 'ERROR', layer: 0, code: 'BACKEND_ERROR',
                        path: '', message: 'Validation failed — backend not reachable.',
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

    private calculateMissingFields(type: string): any[] {
        if (!type) return [];
        const cleanType = type.startsWith('MT') ? type : 'MT' + type;
        const fullGuide = this.fieldGuides[cleanType] || [];
        if (!fullGuide.length) return [];

        return fullGuide.filter(field => {
            // Support tags like '50A/K' or '52A/D'
            const rawParts = field.tag.split('/');
            const tagsToCheck: string[] = [];

            // Extract base tag (digits) from the first part
            const baseMatch = rawParts[0].match(/^\d+/);
            const base = baseMatch ? baseMatch[0] : '';

            rawParts.forEach((part: string, idx: number) => {
                if (idx === 0) {
                    tagsToCheck.push(part);
                } else if (part.length <= 1 && base) {
                    // Option letter like 'K' in '50A/K'
                    tagsToCheck.push(base + part);
                } else if (part.match(/^[A-Z]$/) && base) {
                    // Option letter
                    tagsToCheck.push(base + part);
                } else {
                    // Full tag
                    tagsToCheck.push(part);
                }
            });

            const found = tagsToCheck.some((t: string) => {
                const escapedTag = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const regex = new RegExp(`:${escapedTag}:`, 'i');
                return regex.test(this.mtInput);
            });
            return !found;
        });
    }

    getLayerStatus(k: string): string {
        return this.validationReport?.layer_status?.[k]?.status ?? '';
    }

    getLayerTime(k: string): number {
        return this.validationReport?.layer_status?.[k]?.time ?? 0;
    }

    isLayerPass(k: string) { return this.getLayerStatus(k).includes('✅'); }
    isLayerFail(k: string) { return this.getLayerStatus(k).includes('❌'); }
    isLayerWarn(k: string) {
        const s = this.getLayerStatus(k);
        return s.includes('⚠') || s.includes('WARNING') || s.includes('WARN');
    }

    getValidationIssues(): any[] { return this.validationReport?.details ?? []; }
    getValidationErrors(): any[] { return this.getValidationIssues().filter(i => i.severity === 'ERROR'); }
    getValidationWarnings(): any[] { return this.getValidationIssues().filter(i => i.severity === 'WARNING'); }

    toggleValidationIssue(issue: any) {
        this.validationExpandedIssue = this.validationExpandedIssue === issue ? null : issue;
    }

    copyFix(text: string, e: MouseEvent) {
        e.stopPropagation();
        navigator.clipboard.writeText(text).then(() => {
            this.snackBar.open('Copied!', '', { duration: 1500 });
        });
    }

    loadSample(eventOrType: any) {
        let type = eventOrType;
        if (eventOrType && eventOrType.target) {
            type = eventOrType.target.value;
        }

        if (type === '#' || !type) {
            this.clearAll();
            return;
        }

        switch (type) {
            case 'MT103': this.mtInput = this.getSampleMT103(); break;
            case 'MT101': this.mtInput = this.getSampleMT101(); break;
            case 'MT103+': this.mtInput = this.getSampleMT103Plus(); break;
            case 'MT103 REMIT': this.mtInput = this.getSampleMT103Remit(); break;
            case 'MT202': this.mtInput = this.getSampleMT202(); break;
            case 'MT202COV': this.mtInput = this.getSampleMT202COV(); break;
            case 'MT200': this.mtInput = this.getSampleMT200(); break;
            case 'MT210': this.mtInput = this.getSampleMT210(); break;
            case 'MT900': this.mtInput = this.getSampleMT900(); break;
            case 'MT910': this.mtInput = this.getSampleMT910(); break;
            case 'MT940': this.mtInput = this.getSampleMT940(); break;
            case 'MT950': this.mtInput = this.getSampleMT950(); break;
            case 'MT942': this.mtInput = this.getSampleMT942(); break;
            case 'MT199': this.mtInput = this.getSampleMT199(); break;
            case 'MT299': this.mtInput = this.getSampleMT299(); break;
            case 'MT192': this.mtInput = this.getSampleMT192(); break;
            case 'MT196': this.mtInput = this.getSampleMT196(); break;
            default: this.mtInput = this.getGenericSample(type);
        }
        this.onMtChange(this.mtInput);
        this.syncScroll(this.mtEditorRef.nativeElement, this.mtLineNumbersRef.nativeElement);
    }

    clearAll() {
        this.mtInput = '';
        this.mxOutput = '';
        this.detectedMtType = '';
        this.mappedMxType = '';
        this.conversionStatus = 'idle';
        this.conversionLog = [];
        this.errorMessage = '';
        this.conversionErrors = [];
        this.missingFields = [];
        this.uploadedFileName = null;
        this.isFileWarning = false;
        
        this.isBulkMode = false;
        this.bulkMtMessages = [];
        this.bulkConversionProgress = 0;
        this.bulkTotalFiles = 0;
        this.bulkZipName = null;

        this.updateLineCount('mt');
        this.updateLineCount('mx');
    }

    onFileSelected(event: any) {
        const file = event.target.files[0];
        event.target.value = ''; // reset to allow selecting same file again
        
        if (!file) return;

        // 1. File Extension Validation
        const validExtensions = ['.txt', '.fin', '.mt', '.message', '.zip'];
        const fileName = file.name.toLowerCase();
        if (!validExtensions.some(ext => fileName.endsWith(ext))) {
            this.snackBar.open('Unsupported file type. Allowed: .txt, .fin, .mt, .message, .zip', 'Dismiss', { duration: 4000 });
            return;
        }

        // 2. File Size Validation (Max 15 MB for zip)
        if (file.size > 15 * 1024 * 1024) {
            this.snackBar.open('File size exceeds maximum allowed limit (15 MB).', 'Dismiss', { duration: 4000 });
            return;
        }

        if (fileName.endsWith('.zip')) {
            this.handleZipUpload(file);
            return;
        }

        // 3. Read & Validate Content
        this.isFileLoading = true;
        
        const reader = new FileReader();
        reader.onload = (e: any) => {
            this.isFileLoading = false;
            const content = e.target.result as string;

            if (!content || !content.trim()) {
                this.snackBar.open('Please upload a non-empty MT message file.', 'Dismiss', { duration: 4000 });
                return;
            }

            // 1. Explicitly reject XML/MX content
            const cleanContent = content.trim();
            if (cleanContent.startsWith('<?xml') || cleanContent.startsWith('<') || cleanContent.includes('<Document') || cleanContent.includes('<AppHdr')) {
                this.snackBar.open('Uploaded file appears to be XML/MX, not a valid SWIFT MT message.', 'Dismiss', { duration: 4000 });
                return;
            }

            // 2. Check for SWIFT MT blocks OR common MT fields
            const hasBlocks = /\{[1-5]:/.test(content);
            const hasFields = /(?:^|[\n\r{]):([0-9]{2}[A-Z]?):/.test(content);
            
            if (!hasBlocks && !hasFields) {
                this.snackBar.open('Uploaded file does not contain valid SWIFT MT message.', 'Dismiss', { duration: 4000 });
                return;
            }

            // Success (with possible warning)
            this.clearAll(); // Ensure bulk mode is off
            this.uploadedFileName = file.name;
            this.mtInput = content;
            this.onMtChange(this.mtInput);
            
            setTimeout(() => {
                this.syncScroll(this.mtEditorRef.nativeElement, this.mtLineNumbersRef.nativeElement);
            }, 0);

            if ((hasBlocks && !hasFields && !content.includes('-}')) || (!hasBlocks && hasFields)) {
                this.isFileWarning = true;
                this.snackBar.open('MT message loaded with possible formatting issues.', 'Dismiss', { duration: 4000 });
            } else {
                this.isFileWarning = false;
                this.snackBar.open('MT file uploaded successfully.', '', { duration: 2000 });
            }
        };
        
        reader.onerror = () => {
            this.isFileLoading = false;
            this.snackBar.open('Error reading file.', 'Dismiss', { duration: 3000 });
        };
        
        reader.readAsText(file);
    }
    
    async handleZipUpload(file: File) {
        this.clearAll();
        this.isFileLoading = true;
        this.uploadedFileName = file.name;
        
        try {
            const zip = new JSZip();
            const contents = await zip.loadAsync(file);
            const mtFiles: { filename: string; content: string; selected: boolean }[] = [];
            
            for (const filename of Object.keys(contents.files)) {
                const zipEntry: any = contents.files[filename];
                if (!zipEntry.dir && filename.match(/\.(txt|fin|mt|message)$/i)) {
                    const text = await zipEntry.async('string');
                    // Basic sanity check, not strict validation per file to save time,
                    // but drop obvious XMLs
                    const cleanText = text.trim();
                    if (!cleanText.startsWith('<?xml') && !cleanText.startsWith('<') && !cleanText.includes('<AppHdr')) {
                        const baseFilename = filename.split('/').pop()?.split('\\').pop() || filename;
                        mtFiles.push({ filename: baseFilename, content: text, selected: true });
                    }
                }
            }
            
            this.isFileLoading = false;
            
            if (mtFiles.length === 0) {
                this.uploadedFileName = null;
                this.snackBar.open('ZIP file does not contain any valid MT files (.txt, .fin, .mt).', 'Dismiss', { duration: 4000 });
                return;
            }
            
            this.isBulkMode = true;
            this.bulkMtMessages = mtFiles;
            this.bulkTotalFiles = mtFiles.length;
            this.bulkZipName = file.name;
            this.isFileWarning = false;
            
            // Clear standard input since we show bulk UI instead
            this.mtInput = '';
            
            this.updateLineCount('mt');
            this.snackBar.open(`Loaded ${mtFiles.length} messages from ZIP.`, '', { duration: 3000 });
            
        } catch (error) {
            this.isFileLoading = false;
            this.uploadedFileName = null;
            this.snackBar.open('Error reading ZIP file. It may be corrupted.', 'Dismiss', { duration: 4000 });
        }
    }

    viewSingleMtMessage(file: { filename: string; content: string; selected: boolean; mxOutput?: string; status?: string }) {
        this.isBulkMode = false;
        this.uploadedFileName = file.filename;
        this.mtInput = file.content;
        this.onMtChange(this.mtInput);
        if (file.status === 'success' && file.mxOutput) {
            this.mxOutput = file.mxOutput;
            this.conversionStatus = 'success';
        }
        this.snackBar.open(`Loaded ${file.filename} into editor.`, 'Dismiss', { duration: 3000 });
        setTimeout(() => {
            this.syncScroll(this.mtEditorRef.nativeElement, this.mtLineNumbersRef.nativeElement);
        }, 0);
    }

    async convertBulk() {
        const selectedMessages = this.bulkMtMessages.filter(m => m.selected);
        if (!this.isBulkMode || selectedMessages.length === 0) return;
        
        this.conversionStatus = 'converting';
        this.bulkConversionProgress = 0;
        
        let successCount = 0;
        
        for (let i = 0; i < selectedMessages.length; i++) {
            const msg = selectedMessages[i];
            msg.status = 'pending';
            
            try {
                // Async await HTTP request using Promises
                const response: any = await new Promise((resolve, reject) => {
                    this.http.post(this.config.getApiUrl('/convert-mt-to-mx'), {
                        mt_message: msg.content,
                        target_mt_type: null
                    }).subscribe({
                        next: resolve,
                        error: reject
                    });
                });
                
                if (response.mx_message) {
                    msg.mxOutput = response.mx_message;
                    msg.status = 'success';
                    successCount++;
                } else {
                    msg.status = 'error';
                    msg.errorMsg = 'No MX output generated.';
                }
            } catch (error: any) {
                msg.status = 'error';
                const errDetail = error.error?.errors?.[0] || 'Unknown backend error';
                msg.errorMsg = errDetail;
            }
            
            this.bulkConversionProgress = Math.round(((i + 1) / selectedMessages.length) * 100);
            this.cdr.detectChanges();
        }
        
        this.conversionStatus = 'success';
        this.bulkConversionProgress = 100;
        this.snackBar.open(`Successfully converted ${successCount} files. Review results below.`, 'Dismiss', { duration: 4000 });
    }

    async downloadBulkZip() {
        const zipOutput = new JSZip();
        const successMessages = this.bulkMtMessages.filter(m => m.status === 'success' && m.mxOutput);
        const errorMessages = this.bulkMtMessages.filter(m => m.status === 'error');
        
        if (successMessages.length === 0) {
            this.snackBar.open('No successfully converted files to download.', 'Dismiss', { duration: 3000 });
            return;
        }

        successMessages.forEach(msg => {
            const baseName = msg.filename.replace(/\.[^/.]+$/, '');
            zipOutput.file(`${baseName}_MX.xml`, msg.mxOutput!);
        });
        
        if (errorMessages.length > 0) {
            const errorLog = errorMessages.map(m => `File: ${m.filename} - Failed: ${m.errorMsg}`).join('\\n');
            zipOutput.file('conversion_errors.log', errorLog);
        }
        
        try {
            const content = await zipOutput.generateAsync({ type: 'blob' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(content);
            a.download = `Bulk_MX_Conversion_${Date.now()}.zip`;
            a.click();
            URL.revokeObjectURL(a.href);
        } catch (err) {
            this.snackBar.open('Error generating ZIP file output.', 'Dismiss', { duration: 3000 });
        }
    }
    
    removeUploadedFile() {
        this.clearAll();
    }

    // Sample messages
    private getGenericSample(type: string): string {
        const cleanType = type.replace('MT', '').replace('+', '').replace(' REMIT', '').replace('COV', '');
        return `{1:F01BBBBUS33AXXX0000000000}{2:I${cleanType}CCCCGB2LXXXXN}{3:{121:${this.generateUUID()}}}{4:
:20:REF${Date.now()}
:32A:261231USD1500,00
:50K:/US33XXX12345678901234
GENERIC SENDER INC
NEW YORK US
:59:/GB29NWBK60161331926819
GENERIC RECEIVER LTD
LONDON GB
:71A:SHA
-}`;
    }

    private getSampleMT101(): string {
        return `{1:F01BBBBUS33AXXX0000000000}{2:I101CCCCGB2LXXXXN}{4:
:20:REQ-101-ABCD
:28D:1/1
:30:261231
:50C:BBBBUS33XXX
:59:/DE9988776655
BERLIN TECH GMBH
TECHNOLOGY PARK 1
BERLIN, DE
:32B:EUR4500,00
-}`;
    }

    private getSampleMT103(): string {
        return `{1:F01BBBBUS33AXXX0000000000}{2:I103CCCCGB2LXXXXN}{4:
:20:TXN-103-8899
:23B:CRED
:32A:261231USD15000,50
:50K:/US8899001122
ACME CORP
123 BUSINESS RD
NEW YORK, US
:59:/GB1122334455
GLOBAL SUPPLIES
456 INDUSTRIAL W
LONDON, GB
:71A:SHA
-}`;
    }

    private getSampleMT202(): string {
        return `{1:F01BBBBUS33AXXX0000000000}{2:I202CCCCGB2LXXXXN}{4:
:20:BANKREF-202-1
:21:RELREF-001A
:32A:261231EUR500000,00
:52A:BBBBUS33XXX
:58A:CCCCGB2LXXX
-}`;
    }

    private getSampleMT202COV(): string {
        return `{1:F01RBOSGB2LAXXX0000000000}{2:I202NDEAFIHHXXXXN}{3:{121:8a562c67-ca16-48ba-b074-65581be6f001}}{4:
:20:REF20261231003
:21:E2E-COV-001
:32A:261231EUR1500000,00
:52A:RBOSGB2LXXX
:58A:OKOYFIHH
:119:COV
:50K:/R85236974
A DEBITER
:59:/O96325478
Z KREDITER
-}`;
    }

    private getSampleMT103Plus(): string {
        return `{1:F01BBBBUS33AXXX0000000000}{2:I103CCCCGB2LXXXXN}{3:{121:550e8400-e29b-41d4-a716-446655447777}{119:STP}}{4:
:20:REF103STP001
:23B:CRED
:32A:261231USD2500,00
:50A:/US8899001122\nBBBBUS33XXX
:59A:/GB1122334455\nCCCCGB2LXXX
:71A:SHA
-}`;
    }

    private getSampleMT103Remit(): string {
        return `{1:F01BBBBUS33AXXX0000000000}{2:I103CCCCGB2LXXXXN}{3:{121:550e8400-e29b-41d4-a716-446655448888}}{4:
:20:REF103REMIT001
:32A:261231USD3500,00
:50K:/US33XXX12345678901234
REMIT SENDER CORP
NEW YORK US
:59:/GB29NWBK60161331926819
REMIT RECEIVER LTD
LONDON GB
:71A:SHA
:77T:REMITTANCE DATA
-}`;
    }

    private getSampleMT200(): string {
        return `{1:F01BBBBUS33AXXX0000000000}{2:I200CCCCGB2LXXXXN}{3:{121:200e8400-e29b-41d4-a716-446655440000}}{4:
:20:REF200001
:32A:261231USD10000,00
:53A:BBBBUS33XXX
-}`;
    }

    private getSampleMT210(): string {
        return `{1:F01BBBBUS33AXXX0000000000}{2:I210CCCCGB2LXXXXN}{3:{121:210e8400-e29b-41d4-a716-446655440000}}{4:
:20:REF210001
:25:ACCT123456
:30:261231
:32B:USD5000,00
-}`;
    }

    private getSampleMT900(): string {
        return `{1:F01BBBBUS33AXXX0000000000}{2:I900CCCCGB2LXXXXN}{3:{121:900e8400-e29b-41d4-a716-446655440000}}{4:
:20:REF900001
:25:ACCT123456
:32A:261231USD500,00
-}`;
    }

    private getSampleMT910(): string {
        return `{1:F01BBBBUS33AXXX0000000000}{2:I910CCCCGB2LXXXXN}{3:{121:910e8400-e29b-41d4-a716-446655440000}}{4:
:20:REF910001
:25:ACCT123456
:32A:261231USD750,00
-}`;
    }

    private getSampleMT940(): string {
        return `{1:F01BBBBUS33AXXX0000000000}{2:I940CCCCGB2LXXXXN}{4:
:20:STMT-2023-10
:25:ACC-9988776655
:28C:1/1
:60F:C261231USD100000,00
:61:2612311231CD1500,00NTRFTXN-103-8899
:62F:C261231USD101500,00
-}`;
    }

    private getSampleMT950(): string {
        return `{1:F01BBBBUS33AXXX0000000000}{2:I950CCCCGB2LXXXXN}{3:{121:950e8400-e29b-41d4-a716-446655440000}}{4:
:20:REF950001
:25:ACCT123456
:28C:2/1
:60F:C261231USD2000,00
:62F:C261231USD2500,00
-}`;
    }

    private getSampleMT942(): string {
        return `{1:F01BBBBUS33AXXX0000000000}{2:I942CCCCGB2LXXXXN}{3:{121:942e8400-e29b-41d4-a716-446655440000}}{4:
:20:REF942001
:25:ACCT123456
:13D:2309151200+0500
:34F:USD0,00
-}`;
    }

    private getSampleMT199(): string {
        return `{1:F01BANKUS33AXXX0000000000}{2:I199BANKDEFFXXXXN}{4:
:20:REF123456789
:21:REL987654321
:79:PLEASE CONFIRM STATUS OF PAYMENT
SENT ON 09 MARCH 2026.
-}`;
    }

    private getSampleMT299(): string {
        return `{1:F01BANKUS33AXXX0000000000}{2:I299BANKDEFFXXXXN}{4:
:20:REF987654321
:21:REL123456789
:79:PLEASE CONFIRM RECEIPT OF PAYMENT
FOR INVOICE 78945.
KINDLY UPDATE THE STATUS.
-}`;
    }

    private getSampleMT192(): string {
        return `{1:F01BANKUS33AXXX0000000000}{2:I192BANKDEFFXXXXN}{4:
:20:REF12345678
:21:RELREF987654
:11S:103240309BANKUS33XXXX1234567890
:79:REQUEST CANCELLATION OF PAYMENT
SENT IN ERROR. PLEASE CANCEL
AND CONFIRM.
-}`;
    }

    private getSampleMT196(): string {
        return `{1:F01BBBBUS33AXXX0000000000}{2:I196CCCCGB2LXXXXN}{3:{121:196e8400-e29b-41d4-a716-446655440000}}{4:
:20:REF196RES001
:21:RELREF334455
:79:CANCELLATION ACCEPTED AS REQUESTED.
-}`;
    }

    private getLineSuggestion(tag: string): { line: number | string, isExists: boolean } {
        const lines = (this.mtInput || '').split('\n');

        // 1. Check if tag exists but is empty
        for (let i = 0; i < lines.length; i++) {
            if (lines[i].trim().startsWith(`:${tag}:`)) {
                return { line: i + 1, isExists: true };
            }
        }

        // 2. Suggest insertion point based on tag order (simple numeric sort)
        const targetTagNum = parseInt(tag.substring(0, 2));
        let lastTagLine = -1;
        let foundInsertionLine = -1;

        for (let i = 0; i < lines.length; i++) {
            const lineMatch = lines[i].match(/^:([0-9]{2}[A-Z]?):/);
            if (lineMatch) {
                const currentTagNum = parseInt(lineMatch[1].substring(0, 2));
                if (currentTagNum > targetTagNum && foundInsertionLine === -1) {
                    foundInsertionLine = i + 1;
                }
                lastTagLine = i + 1;
            }
        }

        if (foundInsertionLine !== -1) return { line: `Line ${foundInsertionLine}`, isExists: false };
        if (lastTagLine !== -1) return { line: `Line ${lastTagLine + 1}`, isExists: false };

        return { line: 'New Line', isExists: false };
    }

    // Validation Layer Helpers for Auto-Summary
    getLayerIcon(layer: number): string {
        const ls = this.validationReport?.layer_status;
        if (!ls || !ls[layer]) return 'radio_button_unchecked';
        const s = ls[layer].status;
        if (s === '✅' || s === 'PASS') return 'check_circle';
        if (s === '❌' || s === 'FAIL') return 'cancel';
        if (s === '⚠️' || s === 'WARN') return 'warning';
        return 'help_outline';
    }

    getLayerClass(layer: number): string {
        const ls = this.validationReport?.layer_status;
        if (!ls || !ls[layer]) return '';
        const s = ls[layer].status;
        if (s === '✅' || s === 'PASS') return 'pass';
        if (s === '❌' || s === 'FAIL') return 'fail';
        if (s === '⚠️' || s === 'WARN') return 'warn';
        return '';
    }

    getLayerNameForSummary(layer: number): string {
        return this.getLayerName(String(layer));
    }

    viewXmlModal() {
        this.closeValidationModal();
        setTimeout(() => {
            if (this.mxEditorRef) {
                this.mxEditorRef.nativeElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
        }, 100);
    }

    editXmlModal() {
        this.closeValidationModal();
        setTimeout(() => {
            if (this.mxEditorRef) {
                this.mxEditorRef.nativeElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
                this.mxEditorRef.nativeElement.focus();
            }
        }, 100);
    }

    runValidationModal() {
        this.validateMx();
    }
}
