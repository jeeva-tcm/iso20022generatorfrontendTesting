import { Component, OnInit, ViewChild, AfterViewInit, HostListener } from '@angular/core';
import { CommonModule } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { FormsModule } from '@angular/forms';
import { MatCardModule } from '@angular/material/card';
import { MatTableModule, MatTableDataSource } from '@angular/material/table';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatChipsModule } from '@angular/material/chips';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatPaginator, MatPaginatorModule } from '@angular/material/paginator';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { RouterModule } from '@angular/router';
import { ConfigService } from '../../services/config.service';

@Component({
    selector: 'app-history',
    standalone: true,
    imports: [
        CommonModule,
        FormsModule,
        MatCardModule,
        MatTableModule,
        MatButtonModule,
        MatIconModule,
        MatChipsModule,
        MatFormFieldModule,
        MatInputModule,
        MatTooltipModule,
        MatPaginatorModule,
        MatProgressBarModule,
        MatSnackBarModule,
        RouterModule
    ],
    templateUrl: './history.component.html',
    styleUrls: ['./history.component.css']
})
export class HistoryComponent implements OnInit {
    dataSource = new MatTableDataSource<any>([]);
    displayedColumns: string[] = ['validation_id', 'timestamp', 'origin', 'type', 'no_of_files', 'status', 'metrics', 'actions'];
    isLoading: boolean = false;
    searchTerm: string = '';
    currentFilter: 'ALL' | 'PASSED' | 'FAILED' = 'ALL';
    messageTypeFilter: string = 'ALL';
    originFilter: string = 'ALL';
    availableOrigins: string[] = ['ALL', 'Pasted', 'Uploaded', 'Manual Entry', 'MT to MX'];
    readonly ALL_MESSAGE_TYPES: string[] = [
        'camt.052.001.08',
        'camt.053.001.08',
        'camt.054.001.08',
        'camt.055.001.08',
        'camt.056.001.11',
        'camt.057.001.08',
        'pacs.002.001.10',
        'pacs.003.001.08',
        'pacs.004.001.09',
        'pacs.008.001.08',
        'pacs.009.001.08',
        'pacs.009.001.12',
        'pacs.010.001.03',
        'pacs.010.001.10',
        'pain.001.001.09',
        'pain.002.001.10',
        'pain.008.001.08',
    ];
    availableMessageTypes: string[] = ['ALL'];
    expandedElement: any | null = null;
    expandedDetail: any = null;
    selectedSubFile: any = null;
    showAllMobileIssues: boolean = false;
    isDetailLoading: boolean = false;
    detailCache: { [key: string]: any } = {};

    isEditingXml: boolean = false;
    editedXmlContent: string = '';
    editorLineCount: number[] = [1];

    @ViewChild(MatPaginator) paginator!: MatPaginator;

    constructor(
        private http: HttpClient,
        private snackBar: MatSnackBar,
        private config: ConfigService
    ) { }

    ngOnInit() {
        this.availableMessageTypes = ['ALL', ...this.ALL_MESSAGE_TYPES];
        this.loadHistory();
    }

    loadHistory() {
        this.isLoading = true;
        this.http.get<any[]>(this.config.getApiUrl('/history?limit=5000'))
            .subscribe({
                next: (data) => {
                    console.log('Fetched raw data length from backend:', data.length);
                    // Group records by batch_id (or validation_id if missing)
                    const grouped: { [key: string]: any } = {};
                    data.forEach(item => {
                        const id = item.batch_id || item.validation_id || item.id || 'unknown';

                        // Force real status based on actual numeric metrics
                        if (item.total_errors > 0) item.status = 'FAILED';
                        else if (item.total_warnings > 0) item.status = 'WARNING';
                        else item.status = 'PASSED';

                        if (!grouped[id]) {
                            // Initialize with the first item's properties
                            grouped[id] = {
                                ...item,
                                no_of_files: 0,
                                batch_records: []
                            };
                            // We will manually sum up errors and warnings so we reset the initial item's values for accumulation:
                            grouped[id].total_errors = 0;
                            grouped[id].total_warnings = 0;
                        }

                        grouped[id].no_of_files += 1;
                        grouped[id].total_errors += (item.total_errors || 0);
                        grouped[id].total_warnings += (item.total_warnings || 0);
                        grouped[id].batch_records.push(item);

                        if (grouped[id].total_errors > 0) grouped[id].status = 'FAILED';
                        else if (grouped[id].total_warnings > 0) grouped[id].status = 'WARNING';
                        else grouped[id].status = 'PASSED';
                    });

                    const aggregated = Object.values(grouped);

                    // Sort by timestamp descending
                    aggregated.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

                    // Merge hardcoded known types with any extra types found in records
                    const dynamicTypes = [...new Set(
                        aggregated.map((r: any) => r.message_type).filter(Boolean)
                    )] as string[];
                    const merged = [...new Set([...this.ALL_MESSAGE_TYPES, ...dynamicTypes])].sort();
                    this.availableMessageTypes = ['ALL', ...merged];
                    if (!this.availableMessageTypes.includes(this.messageTypeFilter)) {
                        this.messageTypeFilter = 'ALL';
                    }

                    this.dataSource.data = aggregated;
                    this.dataSource.paginator = this.paginator;

                    // Custom filter to target ID, Message Type, Status Tab, AND Origin
                    this.dataSource.filterPredicate = (record: any, filterValue: string) => {
                        const [search, statusTab, msgType, originVal] = filterValue.split('|');

                        // 1. Status Tab Filter
                        let matchStatus = false;
                        if (statusTab === 'ALL') {
                            matchStatus = true;
                        } else if (statusTab === 'PASSED') {
                            // "Passed" now includes strictly clean PASSED and those with WARNINGS
                            matchStatus = record.status === 'PASSED' || record.status === 'WARNING';
                        } else {
                            matchStatus = record.status === statusTab;
                        }
                        if (!matchStatus) return false;

                        // 2. Message Type Filter
                        if (msgType && msgType !== 'ALL') {
                            const allTypes = [
                                record.message_type || '',
                                ...((record.batch_records || []).map((r: any) => r.message_type || ''))
                            ];
                            if (!allTypes.some((t: string) => t === msgType)) return false;
                        }

                        // 3. Origin Filter
                        if (originVal && originVal !== 'ALL') {
                            const allOrigins = [
                                record.origin || 'Pasted',
                                ...((record.batch_records || []).map((r: any) => r.origin || 'Pasted'))
                            ];
                            if (!allOrigins.some((o: string) => o === originVal)) return false;
                        }

                        // 4. Text Search Filter
                        const searchStr = `${record.batch_id || record.id || record.validation_id || ''} ${record.message_type || ''} ${record.origin || 'Pasted'}`.toLowerCase();
                        return searchStr.includes(search.toLowerCase());
                    };

                    this.applyFilter(); // Initial filter apply

                    this.isLoading = false;
                },
                error: (err) => {
                    console.error(err);
                    this.isLoading = false;
                }
            });
    }

    applyFilter(status?: 'ALL' | 'PASSED' | 'FAILED') {
        if (status) {
            this.currentFilter = status;
        }
        // Use a combined string as the filter trigger
        this.dataSource.filter = `${this.searchTerm.trim().toLowerCase()}|${this.currentFilter}|${this.messageTypeFilter}|${this.originFilter}`;

        if (this.dataSource.paginator) {
            this.dataSource.paginator.firstPage();
        }
    }

    onMessageTypeChange() {
        this.applyFilter();
    }

    msgTypeDropdownOpen = false;

    toggleMsgTypeDropdown(e: Event) {
        e.stopPropagation();
        this.msgTypeDropdownOpen = !this.msgTypeDropdownOpen;
        this.originDropdownOpen = false;
    }

    selectMsgType(e: Event, t: string) {
        e.stopPropagation();
        this.messageTypeFilter = t;
        this.msgTypeDropdownOpen = false;
        this.applyFilter();
    }

    originDropdownOpen = false;

    toggleOriginDropdown(e: Event) {
        e.stopPropagation();
        this.originDropdownOpen = !this.originDropdownOpen;
        this.msgTypeDropdownOpen = false;
    }

    selectOrigin(e: Event, o: string) {
        e.stopPropagation();
        this.originFilter = o;
        this.originDropdownOpen = false;
        this.applyFilter();
    }

    @HostListener('document:click')
    closeDropdown() {
        this.msgTypeDropdownOpen = false;
        this.originDropdownOpen = false;
    }

    getAllFilesCount(): number {
        return this.dataSource.data.reduce((sum, r) => sum + (r.no_of_files || 1), 0);
    }

    getPassedCount(): number {
        // Includes both clean passes and warnings, sum up their no_of_files
        return this.dataSource.data
            .filter(r => r.status === 'PASSED' || r.status === 'WARNING')
            .reduce((sum, r) => sum + (r.no_of_files || 1), 0);
    }

    getFailedCount(): number {
        // Sum up no_of_files of FAILED rows
        return this.dataSource.data
            .filter(r => r.status === 'FAILED')
            .reduce((sum, r) => sum + (r.no_of_files || 1), 0);
    }

    getStatusClass(status: string) {
        return status ? status.toLowerCase() : 'unknown';
    }

    onViewDetails(element: any) {
        if (this.expandedElement === element) {
            this.expandedElement = null;
            this.expandedDetail = null;
            this.selectedSubFile = null;
            this.isDetailLoading = false;
            return;
        }

        this.expandedElement = element;
        this.selectedSubFile = element.batch_records && element.batch_records.length > 0
            ? element.batch_records[0]
            : element;

        // Reset expanded detail here for a fresh row open, but don't reset when switching subfiles.
        this.expandedDetail = null;

        this.loadSubFileDetail(this.selectedSubFile);
    }

    selectSubFile(subFile: any, event?: Event) {
        if (event) event.stopPropagation();
        this.selectedSubFile = subFile;
        this.loadSubFileDetail(subFile);
    }

    loadSubFileDetail(subFile: any) {
        const vid = subFile.validation_id || subFile.id;

        this.isEditingXml = false;

        // Cache Hit: immediately switch content
        if (this.detailCache[vid]) {
            this.expandedDetail = this.detailCache[vid];
            this.updateLineNumbers(this.expandedDetail.original_message);
            this.showAllMobileIssues = false;
            this.isDetailLoading = false;
            return;
        }

        this.isDetailLoading = true;
        this.showAllMobileIssues = false;

        this.http.get<any>(this.config.getApiUrl(`/history/${vid}`)).subscribe({
            next: (data) => {
                this.detailCache[vid] = data;
                // Only write to the UI if the user hasn't quickly clicked to a different file during load time
                if (this.selectedSubFile === subFile) {
                    this.expandedDetail = data;
                    this.updateLineNumbers(data.original_message || '');
                    this.isDetailLoading = false;
                }
            },
            error: (err) => {
                console.error("Failed to load historical report:", err);
                if (this.selectedSubFile === subFile) {
                    this.isDetailLoading = false;
                }
                this.snackBar.open('Error loading record details. Backend might be down.', 'Dismiss', { duration: 4000 });
            }
        });
    }

    onDelete(element: any) {
        const idToDelete = element.batch_id || element.validation_id || element.id;
        if (confirm(`Permanentely delete validation record(s) ${idToDelete}?`)) {
            this.isLoading = true;
            this.http.delete(this.config.getApiUrl(`/history/${idToDelete}`)).subscribe({
                next: () => {
                    this.loadHistory();
                    if (this.expandedElement === element) {
                        this.expandedElement = null;
                        this.expandedDetail = null;
                    }
                    this.snackBar.open('Record deleted successfully.', 'Close', { duration: 3000 });
                },
                error: (err) => {
                    console.error("Failed to delete record:", err);
                    this.isLoading = false;
                    this.snackBar.open('Failed to delete record. Please check connection.', 'Retry', { duration: 5000 });
                }
            });
        }
    }

    deleteAllHistory() {
        if (confirm('Are you sure you want to PERMANENTLY delete ALL history records? This cannot be undone.')) {
            this.isLoading = true;
            this.http.delete(this.config.getApiUrl('/history')).subscribe({
                next: (res: any) => {
                    this.loadHistory();
                    this.expandedElement = null;
                    this.expandedDetail = null;
                    this.snackBar.open(res.message || 'All records deleted successfully.', 'Close', { duration: 3000 });
                },
                error: (err) => {
                    console.error("Failed to delete all records:", err);
                    this.isLoading = false;
                    this.snackBar.open(`Failed to delete history. Status: ${err.status} ${err.statusText}`, 'Dismiss', { duration: 5000 });
                }
            });
        }
    }

    exportAudit() {
        this.isLoading = true;
        this.http.get(this.config.getApiUrl('/history/export'), { responseType: 'blob' }).subscribe({
            next: (blob) => {
                const url = window.URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `iso20022_audit_trail_${new Date().getTime()}.csv`;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                window.URL.revokeObjectURL(url);
                this.isLoading = false;
                this.snackBar.open('Audit log exported successfully', 'Close', { duration: 3000 });
            },
            error: (err) => {
                console.error("Export failed:", err);
                this.isLoading = false;
                this.snackBar.open('Export failed. Please try again later.', 'Dismiss', { duration: 5000 });
            }
        });
    }

    downloadHistoricalReport() {
        if (!this.expandedDetail || !this.expandedDetail.report) {
            this.snackBar.open('No report available for this record.', 'Dismiss', { duration: 3000 });
            return;
        }

        const report = this.expandedDetail.report;
        const msgType = this.selectedSubFile?.message_type || this.expandedElement?.message_type;
        const recordId = this.selectedSubFile?.validation_id || this.expandedElement?.validation_id;

        let csv = "Validation ID,Message Type,Status,Total Errors,Total Warnings,Layer,Severity,Issue Path,Message\n";

        const statusLabel = report.errors > 0 ? "FAILED" : (report.warnings > 0 ? "WARNINGS" : "PASSED");
        const baseRow = `"${recordId}","${msgType}","${statusLabel}",${report.errors || 0},${report.warnings || 0}`;

        if (report.details && report.details.length > 0) {
            report.details.forEach((issue: any, index: number) => {
                const layer = `"${(issue.layer || '').toString().replace(/"/g, '""')}"`;
                const severity = `"${(issue.severity || '').toString().replace(/"/g, '""')}"`;
                const issuePath = `"${(issue.path || 'Root').toString().replace(/"/g, '""')}"`;
                const msg = `"${(issue.message || '').toString().replace(/"/g, '""')}"`;
                if (index === 0) {
                    csv += `${baseRow},${layer},${severity},${issuePath},${msg}\n`;
                } else {
                    csv += `,,,,,${layer},${severity},${issuePath},${msg}\n`;
                }
            });
        } else {
            csv += `${baseRow},,,,\n`;
        }

        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
        const link = document.createElement("a");
        const url = URL.createObjectURL(blob);
        link.setAttribute("href", url);
        link.setAttribute("download", `iso20022_report_${recordId}.csv`);
        link.style.visibility = 'hidden';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    }

    startEditingXml() {
        this.isEditingXml = true;
        this.editedXmlContent = this.expandedDetail.original_message || '';
        this.updateLineNumbers(this.editedXmlContent);
    }

    cancelEditingXml() {
        this.isEditingXml = false;
        this.editedXmlContent = '';
        this.updateLineNumbers(this.expandedDetail.original_message || '');
    }

    onEditorChange(content: string) {
        this.editedXmlContent = content;
        this.updateLineNumbers(content);
    }

    updateLineNumbers(content: string) {
        const lines = content ? content.split('\n').length : 1;
        this.editorLineCount = Array(lines).fill(0);
    }

    syncScroll(textArea: any, lineNumbers: any) {
        if (textArea && lineNumbers) {
            lineNumbers.scrollTop = textArea.scrollTop;
        }
    }

    handleKeyDown(event: KeyboardEvent) {
        if (event.key === 'Tab') {
            event.preventDefault();
            const target = event.target as HTMLTextAreaElement;
            const start = target.selectionStart;
            const end = target.selectionEnd;
            this.editedXmlContent = this.editedXmlContent.substring(0, start) + '    ' + this.editedXmlContent.substring(end);
            setTimeout(() => {
                target.selectionStart = target.selectionEnd = start + 4;
            });
        }
    }

    async saveEditedXml() {
        try {
            if ('showSaveFilePicker' in window) {
                const suggestedName = (this.selectedSubFile || this.expandedElement).message_type + '_edited.xml';
                const handle = await (window as any).showSaveFilePicker({
                    suggestedName: suggestedName,
                    types: [{
                        description: 'XML File',
                        accept: { 'text/xml': ['.xml'] }
                    }]
                });
                const writable = await handle.createWritable();
                await writable.write(this.editedXmlContent);
                await writable.close();
                this.snackBar.open('Local file saved successfully.', 'Close', { duration: 3000 });
                this.isEditingXml = false;
            } else {
                // Fallback
                const blob = new Blob([this.editedXmlContent], { type: 'text/xml' });
                const url = window.URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = (this.selectedSubFile || this.expandedElement).message_type + '_edited.xml';
                a.click();
                window.URL.revokeObjectURL(url);
                this.snackBar.open('File downloaded.', 'Close', { duration: 3000 });
                this.isEditingXml = false;
            }
            this.updateLineNumbers(this.expandedDetail.original_message || '');
        } catch (err: any) {
            if (err.name !== 'AbortError') {
                console.error('Failed to save file:', err);
                this.snackBar.open('Failed to save file.', 'Dismiss', { duration: 3000 });
            }
        }
    }

    isExpansionDetailRow = (i: number, row: Object) => row.hasOwnProperty('detailRow');
}
