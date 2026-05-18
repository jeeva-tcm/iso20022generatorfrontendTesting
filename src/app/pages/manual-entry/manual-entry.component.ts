import { Component, OnInit } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { Router } from '@angular/router';
import { MatIconModule } from '@angular/material/icon';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
import { ConfigService } from '../../services/config.service';
import { BicSearchDialogComponent } from './bic-search-dialog/bic-search-dialog.component';

interface SchemaNode {
    name: string;
    label: string;
    type: string;
    mandatory: boolean;
    repeatable: boolean;
    children: SchemaNode[];
    options?: string[];
}

@Component({
    selector: 'app-manual-entry',
    standalone: true,
    imports: [CommonModule, FormsModule, MatIconModule, MatSnackBarModule, MatDialogModule],
    templateUrl: './manual-entry.component.html',
    styleUrl: './manual-entry.component.css'
})
export class ManualEntryComponent implements OnInit {
    viewMode: 'form' | 'xml' = 'form';
    allTypes: string[] = [];
    filteredTypes: string[] = [];
    searchQuery = '';
    showSuggestions = false;

    selectedType = '';
    schema: SchemaNode | null = null;
    loading = false;

    // Category filter for premium catalog view
    selectedCategory: 'pacs' | 'camt' | 'pain' = 'pacs';

    get filteredCategoryMessages() {
        let list = this.popularMessages.filter(m => m.type === this.selectedCategory);
        if (this.searchQuery) {
            const q = this.searchQuery.toLowerCase();
            list = list.filter(m => m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q));
        }
        return list;
    }

    // Grouped types: Family -> List of IDs
    groupedTypes: Record<string, string[]> = {};
    families: string[] = [];
    selectedFamily: string | null = null;

    // path -> value
    formData: Record<string, string> = {};

    // path -> isExpanded
    expandedPaths: Record<string, boolean> = {};

    previewXml = '';

    popularMessages = [
        // ── PACS Messages ──
        { id: 'pacs.008.001.08', name: 'Customer Credit Transfer', type: 'pacs', route: 'pacs8' },
        { id: 'pacs.003.001.08', name: 'Customer Direct Debit', type: 'pacs', route: 'pacs3' },
        { id: 'pacs.009.001.08', name: 'FI Credit Transfer', type: 'pacs', route: 'pacs9' },
        { id: 'pacs.009.001.08_ADV', name: 'FI Credit Transfer (Adv)', type: 'pacs', route: 'pacs9adv' },
        { id: 'pacs.009.001.08 COV', name: 'FI Credit Transfer (Cov)', type: 'pacs', route: 'pacs9cov' },
        { id: 'pacs.004.001.09', name: 'Payment Return', type: 'pacs', route: 'pacs4' },
        { id: 'pacs.002.001.10', name: 'Payment Status Report', type: 'pacs', route: 'pacs2' },
        { id: 'pacs.010.001.10', name: 'Interbank Direct Debit', type: 'pacs', route: 'pacs10' },
        { id: 'pacs.010.001.03', name: 'Margin Collection', type: 'pacs', route: 'pacs10v3' },
        // ── CAMT Messages ──
        { id: 'camt.057.001.08', name: 'Notification to Receive', type: 'camt', route: 'camt57' },
        { id: 'camt.052.001.08', name: 'Bank To Customer Report', type: 'camt', route: 'camt052' },
        { id: 'camt.053.001.08', name: 'Bank To Customer Statement', type: 'camt', route: 'camt053' },
        { id: 'camt.054.001.08', name: 'Debit Credit Notification', type: 'camt', route: 'camt054' },
        { id: 'camt.055.001.08', name: 'Customer Payment Cancellation', type: 'camt', route: 'camt055' },
        { id: 'camt.056.001.11', name: 'FI To FI Payment Cancellation', type: 'camt', route: 'camt056' },
        // ── PAIN Messages ──
        { id: 'pain.001.001.09', name: 'Credit Transfer Initiation', type: 'pain', route: 'pain001' },
        { id: 'pain.002.001.10', name: 'Payment Status Report', type: 'pain', route: 'pain002' },
        { id: 'pain.008.001.08', name: 'Direct Debit Initiation', type: 'pain', route: 'pain008' },
    ];

    constructor(
        private http: HttpClient,
        private config: ConfigService,
        private snackBar: MatSnackBar,
        private route: ActivatedRoute,
        private router: Router,
        private dialog: MatDialog
    ) { }

    ngOnInit() {
        this.fetchMessageTypes();
        this.route.params.subscribe(params => {
            if (params['type']) {
                this.selectType(params['type']);
            }
        });
    }

    gotoMessage(route: string) {
        this.router.navigate(['/generate', route]);
    }

    fetchMessageTypes() {
        this.http.get<string[]>(this.config.getApiUrl('/messages')).subscribe({
            next: (types) => {
                this.allTypes = types;
                this.groupTypes(types);
                this.filteredTypes = [...types].slice(0, 20);
            },
            error: (err) => console.error('Failed to fetch message types', err)
        });
    }

    groupTypes(types: string[]) {
        const groups: Record<string, string[]> = {};
        for (const type of types) {
            const family = type.split('.')[0].toUpperCase();
            if (!groups[family]) groups[family] = [];
            groups[family].push(type);
        }
        this.groupedTypes = groups;
        this.families = Object.keys(groups).sort();
    }

    onSearchInput() {
        this.selectedFamily = null;
        if (!this.searchQuery) {
            this.filteredTypes = this.allTypes.slice(0, 20);
            return;
        }
        const q = this.searchQuery.toLowerCase();
        this.filteredTypes = this.allTypes
            .filter(t => t.toLowerCase().includes(q))
            .slice(0, 100); 
        this.showSuggestions = true;
    }

    selectType(type: string) {
        this.selectedType = type;
        this.searchQuery = type;
        this.showSuggestions = false;
        this.selectedFamily = null;
        this.fetchSchema(type);
    }

    selectFamily(family: string) {
        this.selectedFamily = family;
        this.searchQuery = '';
        this.filteredTypes = this.groupedTypes[family] || [];
    }

    fetchSchema(type: string) {
        this.loading = true;
        this.schema = null;
        this.formData = {};
        this.expandedPaths = {};

        this.http.get<SchemaNode>(this.config.getApiUrl(`/messages/${type}/schema`)).subscribe({
            next: (schema) => {
                if (schema) {
                    this.applyMandatoryOverrides(schema, type);
                    this.enforceISOOrder(schema);
                }
                this.schema = schema;
                this.loading = false;
                if (schema) {
                    const autoExpandAll = (node: SchemaNode, path: string) => {
                        this.expandedPaths[path] = true;
                        if (node.children) {
                            for (const child of node.children) {
                                autoExpandAll(child, `${path}.${child.name}`);
                            }
                        }
                    };
                    autoExpandAll(schema, schema.name);
                    this.prepopulateDefaults(schema, schema.name);
                }
                this.updatePreview();
            },
            error: (err) => {
                console.error('Failed to fetch schema', err);
                this.loading = false;
                this.snackBar.open(`Error loading schema for ${type}`, 'Close', { duration: 3000, horizontalPosition: 'center', verticalPosition: 'bottom' });
            }
        });
    }

    enforceISOOrder(node: SchemaNode) {
        if (!node.children || node.children.length === 0) return;

        if (node.name === 'Sts') {
            node.children.sort((a, b) => {
                const priorityOrder = ['Conf', 'Cd'];
                const aIdx = priorityOrder.indexOf(a.name);
                const bIdx = priorityOrder.indexOf(b.name);
                if (aIdx !== -1 && bIdx !== -1) return aIdx - bIdx;
                if (aIdx !== -1) return -1;
                if (bIdx !== -1) return 1;
                return 0;
            });
        }
        
        if (node.name === 'CxlStsRsnInf' || node.name === 'CxlRsnInf') {
            const rOrder = ['Orgtr', 'Rsn', 'AddtlInf'];
            node.children.sort((a, b) => {
                const aI = rOrder.indexOf(a.name);
                const bI = rOrder.indexOf(b.name);
                if (aI !== -1 && bI !== -1) return aI - bI;
                if (aI !== -1) return -1;
                if (bI !== -1) return 1;
                return 0;
            });
        }
        
        if (node.name === 'AppHdr') {
            const hOrder = ['Fr', 'To', 'BizMsgIdr', 'MsgDefIdr', 'BizSvc', 'CreDt', 'Prty', 'Rltd'];
            node.children.sort((a, b) => {
                const aI = hOrder.indexOf(a.name);
                const bI = hOrder.indexOf(b.name);
                if (aI !== -1 && bI !== -1) return aI - bI;
                if (aI !== -1) return -1;
                if (bI !== -1) return 1;
                return 0;
            });
        }

        for (const child of node.children) {
            this.enforceISOOrder(child);
        }
    }

    applyMandatoryOverrides(node: SchemaNode, type: string) {
        const t = type.toLowerCase();
        if (t.includes('camt.056')) return;

        if (t.startsWith('pacs.') || t.startsWith('pain.')) {
            let mandatoryNames = ['Dbtr', 'Cdtr'];
            if (t.includes('pacs.008') || t.includes('pacs.003') || t.includes('pain.001') || t.includes('pain.008')) {
                mandatoryNames.push('DbtrAgt', 'CdtrAgt');
            }
            if (mandatoryNames.includes(node.name)) {
                node.mandatory = true;
            }
        }
        if (node.children) {
            for (const child of node.children) {
                this.applyMandatoryOverrides(child, type);
            }
        }
    }

    prepopulateDefaults(node: SchemaNode, path: string, depth: number = 0) {
        const n = node.name;
        const isLeaf = !node.children || node.children.length === 0;

        if (node.mandatory || depth === 0) {
            if (n === 'CreDtTm' || n === 'CreDt' || n === 'Dt' || n === 'TradDt' || n === 'SttlmDt' || n.includes('DtTm')) {
                const now = new Date();
                this.formData[path] = n.includes('Tm') ? now.toISOString().split('.')[0] + 'Z' : now.toISOString().split('T')[0];
            }
            else if (n === 'MsgId' || n === 'BizMsgIdr' || n === 'InstrId' || n === 'EndToEndId' || (n === 'Id' && (path.includes('GrpHdr') || path.includes('Assgnmt')))) {
                this.formData[path] = `${n.toUpperCase()}-${Math.random().toString(36).substring(2, 7).toUpperCase()}`;
            }
            else if (n === 'UETR' || n === 'OrgnlUETR') {
                this.formData[path] = '550e8400-e29b-41d4-a716-446655440000';
            }
            else if (n === 'NbOfTxs' || n === 'TtlNbOfTxs') {
                this.formData[path] = '1';
            }
            else if (n === 'Amt' || n === 'InstdAmt' || n === 'IntrBkSttlmAmt' || n === 'TtlIntrBkSttlmAmt') {
                this.formData[path] = '1500.00';
            }
            else if (n === 'Ccy' || n === 'InstdAmtCcy' || n === 'IntrBkSttlmAmtCcy') {
                this.formData[path] = 'USD';
            }
            else if (n === 'BIC' || n === 'BICFI' || n === 'AnyBIC' || n === 'OrgAnyBIC') {
                if (path.includes('Dbtr')) this.formData[path] = 'BBBBUS33XXX';
                else if (path.includes('Cdtr')) this.formData[path] = 'CCCCGB2LXXX';
                else this.formData[path] = 'BANKUS33XXX';
            }
            else if (n === 'IBAN') {
                this.formData[path] = 'US12345678901234567890';
            }
            else if (n === 'Ctry' || n === 'SttlmCtry' || n === 'Issr' || n === 'CtryOfBirth') {
                this.formData[path] = 'US';
            }
            else if (n === 'Nm') {
                if (path.includes('Dbtr')) this.formData[path] = 'Debtor Name';
                else if (path.includes('Cdtr')) this.formData[path] = 'Creditor Name';
                else this.formData[path] = 'Global Trading Corp';
            }
            else if (n === 'PstCd') {
                this.formData[path] = '10001';
            }
            else if (n === 'CityOfBirth' || n === 'TwnNm') {
                this.formData[path] = 'New York';
            }
            else if (n === 'BirthDt') {
                this.formData[path] = '1980-01-01';
            }
            else if (n === 'SvcLvl' || n === 'Cd' || n === 'Prtry' || n === 'Conf') {
                if (path.includes('SvcLvl')) this.formData[path] = 'URGP';
                else if (isLeaf) {
                    if (n === 'Cd') {
                        if (path.includes('.Sts.Cd') && !path.includes('RjctdMod')) return; 
                        if (path.includes('RjctdMod')) return; 
                        this.formData[path] = 'OTHR';
                    }
                    else if (n === 'Prtry') this.formData[path] = 'CUSTOM';
                    else if (n === 'Conf') {
                        this.formData[path] = 'ACCR'; 
                    }
                    else this.formData[path] = 'ADDR';
                }
            }
            else if (isLeaf && !this.formData[path]) {
                if (node.type === 'number' || node.type === 'decimal') {
                    this.formData[path] = '100.00';
                } else if (node.type === 'boolean') {
                    this.formData[path] = 'true';
                } else {
                    if (n === 'ChanlTp') this.formData[path] = 'SWIFT';
                    else if (n === 'MmbId') this.formData[path] = 'CLR00123';
                    else if (n === 'OrgnlMsgId') this.formData[path] = 'ORIG-998877';
                    else if (n === 'OrgnlMsgNmId') this.formData[path] = 'pacs.008.001.08';
                    else this.formData[path] = 'VALUE_DATA';
                }
            }
        }

        if (node.children) {
            let hasMandatoryChild = node.children.some(c => c.mandatory);
            for (let i = 0; i < node.children.length; i++) {
                const child = node.children[i];
                if (node.mandatory && !hasMandatoryChild && i === 0 && !child.children?.length) {
                    (child as any).mandatory = true;
                }
                this.prepopulateDefaults(child, `${path}.${child.name}`, depth + 1);
            }
        }
    }

    toggleNode(path: string) {
        this.expandedPaths[path] = !this.expandedPaths[path];
    }

    isExpanded(path: string): boolean {
        return !!this.expandedPaths[path];
    }

    updatePreview() {
        if (!this.schema) {
            this.previewXml = '';
            return;
        }
        const xml = this.generateXml(this.schema, this.schema.name, 0);
        this.previewXml = xml;
    }

    generateXml(node: SchemaNode, path: string, depth: number): string {
        const value = this.formData[path];
        const indent = '  '.repeat(depth);

        if (node.children && node.children.length > 0) {
            const attrs = node.children.filter(c => (c as any).isAttribute);
            const elements = node.children.filter(c => !(c as any).isAttribute);

            let attrStr = '';
            for (const attr of attrs) {
                const attrVal = this.formData[`${path}.${attr.name}`];
                if (attrVal) {
                    attrStr += ` ${attr.name}="${this.escapeXml(attrVal)}"`;
                }
            }

            let childXml = '';
            for (const child of elements) {
                childXml += this.generateXml(child, `${path}.${child.name}`, depth + 1);
            }

            if (childXml || value || attrStr) {
                let tag = node.name;
                if (depth === 0 && (this.schema as any)?.namespace) {
                    tag += ` xmlns="${(this.schema as any).namespace}"`;
                }
                tag += attrStr;

                if (childXml) {
                    return `${indent}<${tag}>\n${childXml}${indent}</${node.name}>\n`;
                } else if (value) {
                    return `${indent}<${tag}>${this.escapeXml(value)}</${node.name}>\n`;
                } else {
                    return `${indent}<${tag}/>\n`;
                }
            }
            return '';
        } else if (value) {
            return `${indent}<${node.name}>${this.escapeXml(value)}</${node.name}>\n`;
        }
        return '';
    }

    escapeXml(unsafe: string) {
        return unsafe.replace(/[<>&'"]/g, (c) => {
            switch (c) {
                case '<': return '&lt;';
                case '>': return '&gt;';
                case '&': return '&amp;';
                case '\'': return '&apos;';
                case '"': return '&quot;';
                default: return c;
            }
        });
    }

    onBlur() {
        setTimeout(() => this.showSuggestions = false, 200);
    }

    copyToClipboard() {
        const fullXml = `<?xml version="1.0" encoding="UTF-8"?>\n${this.previewXml}`;
        navigator.clipboard.writeText(fullXml).then(() => {
            this.snackBar.open('XML copied to clipboard!', 'Close', { duration: 3000, horizontalPosition: 'center', verticalPosition: 'bottom' });
        });
    }

    downloadXml() {
        const fullXml = `<?xml version="1.0" encoding="UTF-8"?>\n${this.previewXml}`;
        const blob = new Blob([fullXml], { type: 'application/xml' });
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${this.selectedType}-${Date.now()}.xml`;
        a.click();
        window.URL.revokeObjectURL(url);
    }

    openBicSearch(path: string) {
        const dialogRef = this.dialog.open(BicSearchDialogComponent, {
            width: '800px',
            disableClose: true
        });

        dialogRef.afterClosed().subscribe(result => {
            if (result && result.bic) {
                this.formData[path] = result.bic;
                this.updatePreview();
            }
        });
    }
}
