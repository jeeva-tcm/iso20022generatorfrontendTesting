import JSZip from 'jszip';
import { Component, OnInit, HostListener, ElementRef, ViewChild, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule, ReactiveFormsModule, FormControl } from '@angular/forms';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatAutocompleteModule } from '@angular/material/autocomplete';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { HttpClient } from '@angular/common/http';
import { ActivatedRoute, Router } from '@angular/router';
import { Observable } from 'rxjs';
import { map, startWith } from 'rxjs/operators';
import { ConfigService } from '../../services/config.service';

export interface FileEntry {
  id: string;
  name: string;
  size: number;
  sizeLabel: string;
  content: string;
  status: 'pending' | 'validating' | 'passed' | 'failed' | 'warnings';
  report: any;
  messageType: string;
  handle?: any;
  origin?: 'Pasted' | 'Uploaded' | 'Manual Entry' | 'MT to MX';
}

@Component({
  selector: 'app-validate',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    ReactiveFormsModule,
    MatIconModule,
    MatSnackBarModule,
    MatTooltipModule,
    MatAutocompleteModule,
    MatFormFieldModule,
    MatInputModule,
  ],
  templateUrl: './validate.component.html',
  styleUrls: ['./validate.component.css']
})
export class ValidateComponent implements OnInit {

  // ── File list ──────────────────────────────────────────────────────────────
  files: FileEntry[] = [];
  selectedFile: FileEntry | null = null;
  showReplaceModal = false;
  pendingFilesToAdd: File[] = [];

  // ── Drag state ─────────────────────────────────────────────────────────────
  isDragging = false;

  // ── Paste XML state ─────────────────────────────────────────────────────────
  showPasteModal = false;
  pastedXmlContent = '';
  pendingPastedXml = '';

  // ── UI State ─────────────────────────────────────────────────────────────
  searchQuery = '';
  filterStatus: 'All' | 'Passed' | 'Failed' = 'All';
  expandedFile: FileEntry | null = null;

  // ── Pagination State ───────────────────────────────────────────────────────
  currentPage = 1;
  pageSize = 10;
  pageSizeOptions = [10, 25, 50, 100, 250, 500, 1000];

  // ── XML Editor state ─────────────────────────────────────────────────────────────
  editingEntry: FileEntry | null = null;
  originalContent: string = '';
  selectedView = 'layer-1'; // Default active view
  editorLineCount: number[] = [];
  targetLine: number | null = null;
  private xmlHistory: string[] = [];
  private xmlHistoryIdx: number = -1;
  private maxHistory = 200;
  private isInternalChange = false;

  // ── Global options ─────────────────────────────────────────────────────────
  validationMode = 'Full 1-3';
  messageControl = new FormControl('Auto-detect');
  filteredOptions: Observable<string[]> | undefined;
  allMessageTypes: string[] = ['Auto-detect'];
  private standardMXTypes: string[] = [
    'pacs.008.001.08',
    'pacs.009.001.08',
    'pacs.002.001.10',
    'pain.001.001.09',
    'camt.053.001.08',
  ];

  // ── Selected issue (detail view) ───────────────────────────────────────────
  expandedIssue: any = null;

  // ── Summary computed from all files ────────────────────────────────────────
  get summary() {
    const done = this.files.filter(f => f.status !== 'pending' && f.status !== 'validating');
    return {
      passed: done.filter(f => f.status === 'passed' || f.status === 'warnings').length,
      failed: done.filter(f => f.status === 'failed').length,
    };
  }

  get filteredFiles() {
    return this.files.filter(f => {
      if (this.filterStatus !== 'All') {
        if (this.filterStatus === 'Passed' && (f.status !== 'passed' && f.status !== 'warnings')) return false;
        if (this.filterStatus === 'Failed' && f.status !== 'failed') return false;
      }
      if (this.searchQuery && !f.name.toLowerCase().includes(this.searchQuery.toLowerCase())) {
        return false;
      }
      return true;
    });
  }

  get paginatedFiles() {
    const startIndex = (this.currentPage - 1) * this.pageSize;
    return this.filteredFiles.slice(startIndex, startIndex + Number(this.pageSize));
  }

  get totalPages() {
    return Math.ceil(this.filteredFiles.length / this.pageSize);
  }

  changePage(newPage: number) {
    if (newPage >= 1 && newPage <= this.totalPages) {
      this.currentPage = newPage;
      this.expandedFile = null;
    }
  }

  onPageSizeChange() {
    this.currentPage = 1;
    this.expandedFile = null;
  }

  get overallPassRate() {
    if (this.files.length === 0) return 0;
    const validated = this.files.filter(f => f.status !== 'pending' && f.status !== 'validating');
    if (validated.length === 0) return 0;
    const passed = validated.filter(f => f.status === 'passed' || f.status === 'warnings').length;
    return Math.round((passed / validated.length) * 100);
  }

  getFilePassRate(f: FileEntry) {
    if (f.status === 'passed' || f.status === 'warnings') return 100;
    if (f.status === 'pending' || f.status === 'validating' || !f.report) return 0;

    let expectedLayers = this.validationMode === 'Layer 1 only' ? 1 :
      this.validationMode === 'Layer 1-2' ? 2 : 3;

    let passedLayers = 0;
    if (f.report.layer_status) {
      Object.keys(f.report.layer_status).forEach(k => {
        if (f.report.layer_status[k].status.includes('✅') || f.report.layer_status[k].status.includes('⚠') || f.report.layer_status[k].status.includes('WARN')) {
          passedLayers++;
        }
      });
    }

    // Ensure we don't divide by 0 and max is 100%
    if (expectedLayers === 0) return 0;
    return Math.min(100, Math.round((passedLayers / expectedLayers) * 100));
  }

  toggleFileRow(f: FileEntry) {
    if (this.expandedFile === f) {
      this.expandedFile = null;
      return;
    }
    this.expandedIssue = null;
    this.expandedFile = f;
    if (f.report?.details) {
      const layerSet = new Set<string>();
      f.report.details.forEach((x: any) => {
        layerSet.add(this.getLayerName(String(x.layer)));
      });
      layerSet.forEach(name => this.expandedLayers.add(f.id + '_' + name));
    }
  }

  expandedLayers: Set<string> = new Set<string>();

  toggleLayer(f: FileEntry, layerName: string, event?: Event) {
    if (event) {
      event.stopPropagation();
      event.preventDefault();
    }
    const key = f.id + '_' + layerName;
    if (this.expandedLayers.has(key)) {
      this.expandedLayers.delete(key);
    } else {
      this.expandedLayers.add(key);
    }
    this.cdr.detectChanges();
  }

  isLayerExpanded(f: FileEntry, layerName: string): boolean {
    return this.expandedLayers.has(f.id + '_' + layerName);
  }

  issueFilters: { [key: string]: 'ERROR' | 'WARNING' | 'ALL' } = {};

  setIssueFilter(f: FileEntry, layerName: string, type: 'ERROR' | 'WARNING' | 'ALL', e: Event) {
    e.stopPropagation();
    const key = f.id + '_' + layerName;
    this.expandedIssue = null; // Clear expanded issue as the displayed list is changing
    if (this.issueFilters[key] === type) {
      this.issueFilters[key] = 'ALL';
    } else {
      this.issueFilters[key] = type;
      this.expandedLayers.add(key);
    }
  }

  isIssueFilterActive(f: FileEntry, layerName: string, type: 'ERROR' | 'WARNING' | 'ALL'): boolean {
    const key = f.id + '_' + layerName;
    const current = this.issueFilters[key] || 'ALL';
    return current === type;
  }

  getLayerPillOpacity(f: FileEntry, layerName: string, pillType: 'ERROR' | 'WARNING' | 'ALL'): string {
    const key = f.id + '_' + layerName;
    const current = this.issueFilters[key] || 'ALL';
    if (current === 'ALL') return '1';
    return current === pillType ? '1' : '0.5';
  }

  getFilteredIssues(f: FileEntry, l: any) {
    const key = f.id + '_' + l.name;
    const filter = this.issueFilters[key] || 'ALL';
    if (filter === 'ALL') return l.issues;
    return l.issues.filter((issue: any) => issue.severity === filter);
  }

  setFilter(status: 'All' | 'Passed' | 'Failed') {
    this.filterStatus = status;
    this.currentPage = 1; // Reset to page 1 on filter change
  }

  downloadReport() {
    if (this.files.length === 0) return;

    let csv = "Batch ID,File ID,File Name,Status,Pass %,Total Errors,Total Warnings,Layer,Severity,Issue Path,Message\n";

    this.files.forEach(f => {
      const batchId = f.report?.batch_id || '';
      const fileId = f.report?.file_id || '';
      const name = `"${f.name.replace(/"/g, '""')}"`;
      const status = f.status.toUpperCase();
      const passRate = `${this.getFilePassRate(f)}%`;
      const errs = f.report?.errors || 0;
      const warns = f.report?.warnings || 0;

      const baseRow = `${batchId},${fileId},${name},${status},${passRate},${errs},${warns}`;

      if (f.report && f.report.details && f.report.details.length > 0) {
        f.report.details.forEach((issue: any, index: number) => {
          const layer = `"${(issue.layer || '').toString().replace(/"/g, '""')}"`;
          const severity = `"${(issue.severity || '').toString().replace(/"/g, '""')}"`;
          const issuePath = `"${(issue.path || 'Root').toString().replace(/"/g, '""')}"`;
          const msg = `"${(issue.message || '').toString().replace(/"/g, '""')}"`;
          if (index === 0) {
            csv += `${baseRow},${layer},${severity},${issuePath},${msg}\n`;
          } else {
            csv += `,,,,,,,${layer},${severity},${issuePath},${msg}\n`;
          }
        });
      } else {
        csv += `${baseRow},,,,\n`;
      }
    });

    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement("a");
    const url = URL.createObjectURL(blob);
    link.setAttribute("href", url);
    link.setAttribute("download", "iso20022_validation_report.csv");
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }

  downloadFileReport(f: FileEntry, e: MouseEvent) {
    if (e) e.stopPropagation();
    if (!f.report) {
      this.snackBar.open('Run validation to see details.', 'Dismiss', { duration: 3000 });
      return;
    }
    let csv = "File Name,Status,Pass %,Total Errors,Total Warnings,Layer,Severity,Issue Path,Message\n";
    const name = `"${f.name.replace(/"/g, '""')}"`;
    const status = f.status.toUpperCase();
    const passRate = `${this.getFilePassRate(f)}%`;
    const errs = f.report?.errors || 0;
    const warns = f.report?.warnings || 0;

    const baseRow = `${name},${status},${passRate},${errs},${warns}`;

    if (f.report && f.report.details && f.report.details.length > 0) {
      f.report.details.forEach((issue: any, index: number) => {
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
    link.setAttribute("download", `iso20022_report_${f.name}.csv`);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }

  // Cache grouped issues to prevent new object references on every change
  // detection cycle, which would cause Angular to destroy/recreate DOM nodes
  // and swallow in-flight click events (the root cause of the intermittent
  // expand/collapse bug).
  private _groupedIssuesCache: Map<string, { report: any; result: any[] }> = new Map();

  getGroupedIssues(report: any) {
    if (!report?.details) return [];
    const cacheKey = report.validation_id || report.batch_id || 'default';
    const cached = this._groupedIssuesCache.get(cacheKey);
    if (cached && cached.report === report) {
      return cached.result;
    }
    const layers = [...new Set(report.details.map((x: any) => x.layer))].sort();
    const result = layers.map(l => {
      const issues = report.details.filter((x: any) => x.layer === l);
      return {
        layer: l,
        name: this.getLayerName(String(l)),
        issues: issues,
        errors: issues.filter((x: any) => x.severity === 'ERROR').length,
        warnings: issues.filter((x: any) => x.severity === 'WARNING').length
      };
    });
    this._groupedIssuesCache.set(cacheKey, { report, result });
    return result;
  }

  get filesToDisplay(): FileEntry[] {
    return this.selectedFile ? [this.selectedFile] : this.files;
  }

  selectAllFiles() {
    this.selectedFile = null;
    this.expandedFile = null;
  }

  constructor(
    private http: HttpClient,
    private route: ActivatedRoute,
    private router: Router,
    private snackBar: MatSnackBar,
    private config: ConfigService,
    private cdr: ChangeDetectorRef
  ) { }

  async ngOnInit() {
    this.allMessageTypes = [...this.standardMXTypes];
    await this.restoreWorkspace(); // Restore previous work before handling query params

    this.http.get<string[]>(this.config.getApiUrl('/messages')).subscribe({
      next: (data) => {
        const combined = [...new Set([...this.standardMXTypes, ...data])].sort();
        this.allMessageTypes = ['Auto-detect', ...combined.filter(x => x !== 'Auto-detect')];
        this.messageControl.updateValueAndValidity();
      },
      error: () => { }
    });

    this.filteredOptions = this.messageControl.valueChanges.pipe(
      startWith(''),
      map(value => this._filter(value || '')),
    );

    // Handle History Re-run
    this.route.queryParams.subscribe(params => {
      const reportId = params['reportId'];
      const autoRun = params['autoRun'] === 'true';
      if (reportId) {
        this.loadValidationFromHistory(reportId, autoRun);

        // Clean query parameters from URL bar to prevent auto-loading the file again on page reload
        this.router.navigate([], {
          relativeTo: this.route,
          queryParams: { reportId: null, autoRun: null },
          queryParamsHandling: 'merge'
        });
      }
    });

    // Handle XML pushed via state (from Manual Entry builders)
    const state = history.state;
    if (state && state.autoValidateXml) {
      this.addXmlFromState(state.autoValidateXml, state.fileName, state.messageType);

      // Clear state so refreshing the page doesn't re-add the file
      window.history.replaceState({}, document.title);
    }
  }

  private addXmlFromState(xml: string, fileName: string, messageType: string) {
    const entry: FileEntry = {
      id: 'f' + Date.now(),
      name: fileName || `generated-${Date.now()}.xml`,
      size: new Blob([xml]).size,
      sizeLabel: this.formatSize(new Blob([xml]).size),
      content: xml,
      status: 'pending',
      report: null,
      messageType: messageType || 'Auto-detect',
      handle: null
    };

    // Check if it already exists to avoid dupes purely from reload
    const existing = this.files.find(f => f.content === xml);
    if (!existing) {
      this.files.unshift(entry);
      this.saveWorkspace();
      this.selectedFile = entry;
      this.validateFile(entry);
    } else {
      this.selectedFile = existing;
      if (existing.status === 'pending') {
        this.validateFile(existing);
      }
    }
  }

  private _filter(value: string): string[] {
    const v = value.toLowerCase();
    if (!v || v === 'auto-detect') return this.standardMXTypes.slice(0, 8);
    return this.allMessageTypes.filter(o => o.toLowerCase().includes(v));
  }

  @ViewChild('fileInput') fileInput!: ElementRef<HTMLInputElement>;

  dragCounter = 0;
  private readonly supportedFileExtensions = ['.xml', '.xsd', '.txt', '.zip'];

  // ── Drag-and-drop ──────────────────────────────────────────────────────────
  @HostListener('window:dragover', ['$event'])
  onWindowDragOver(e: DragEvent) {
    if (!this.hasDraggedFiles(e)) return;
    e.preventDefault();
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = this.editingEntry ? 'none' : 'copy';
    }
  }

  @HostListener('window:drop', ['$event'])
  onWindowDrop(e: DragEvent) {
    if (!this.hasDraggedFiles(e)) return;
    e.preventDefault();
    this.resetDragState();
  }

  onDropZoneDragEnter(e: DragEvent) {
    if (!this.hasDraggedFiles(e)) return;
    this.prepareDropEvent(e);
    if (this.editingEntry) return;
    this.dragCounter++;
    this.isDragging = true;
  }

  onDropZoneDragOver(e: DragEvent) {
    if (!this.hasDraggedFiles(e)) return;
    this.prepareDropEvent(e);
    if (this.editingEntry) return;
    this.isDragging = true;
  }

  onDropZoneDragLeave(e: DragEvent) {
    if (!this.hasDraggedFiles(e)) return;
    this.prepareDropEvent(e);
    this.dragCounter--;
    if (this.dragCounter <= 0) {
      this.resetDragState();
    }
  }

  async onDropZoneDrop(e: DragEvent) {
    if (!this.hasDraggedFiles(e)) return;
    this.prepareDropEvent(e);
    this.resetDragState();
    if (this.editingEntry) return;

    const droppedFiles = await this.getDroppedFiles(e);
    if (droppedFiles.length === 0) {
      this.snackBar.open('No supported files were dropped.', 'Dismiss', { duration: 3000 });
      return;
    }

    await this.loadFiles(droppedFiles);
  }

  private prepareDropEvent(e: DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = this.editingEntry ? 'none' : 'copy';
    }
  }

  private resetDragState() {
    this.dragCounter = 0;
    this.isDragging = false;
  }

  private hasDraggedFiles(e: DragEvent): boolean {
    return Array.from(e.dataTransfer?.types ?? []).includes('Files');
  }

  private async getDroppedFiles(e: DragEvent): Promise<File[]> {
    const dataTransfer = e.dataTransfer;
    if (!dataTransfer) return [];

    const droppedFiles = Array.from(dataTransfer.files ?? []);
    if (droppedFiles.length > 0) {
      const items = Array.from(dataTransfer.items ?? []).filter(item => item.kind === 'file');
      await Promise.all(droppedFiles.map(async (file, index) => {
        const item = items[index];
        if (!item) return;
        try {
          const handle = await (item as any).getAsFileSystemHandle?.();
          if (handle) (file as any).fileHandle = handle;
        } catch {
          // File handles are optional; the uploaded content still works without one.
        }
      }));
      return droppedFiles;
    }

    const itemFiles: File[] = [];
    if (dataTransfer.items) {
      for (let i = 0; i < dataTransfer.items.length; i++) {
        const item = dataTransfer.items[i];
        if (item.kind === 'file') {
          const file = item.getAsFile();
          if (file) {
            let handle: any = null;
            try {
              handle = await (item as any).getAsFileSystemHandle?.();
            } catch {
              handle = null;
            }
            if (handle) (file as any).fileHandle = handle;
            itemFiles.push(file);
          }
        }
      }
    }

    return itemFiles;
  }

  async triggerFilePicker() {
    if (this.editingEntry) return;
    if ('showOpenFilePicker' in window) {
      try {
        const handles = await (window as any).showOpenFilePicker({
          multiple: true,
          types: [{
            description: 'Supported Files (.xml, .zip, .xsd, .txt)',
            accept: {
              'application/xml': ['.xml'],
              'text/xml': ['.xml', '.xsd', '.txt'],
              'application/zip': ['.zip'],
              'application/x-zip-compressed': ['.zip']
            }
          }]
        });
        const validFiles: File[] = [];
        for (const h of handles) {
          const file = await h.getFile();
          (file as any).fileHandle = h;
          validFiles.push(file);
        }
        await this.loadFiles(validFiles);
      } catch (err: any) {
        if (err.name !== 'AbortError') {
          this.fileInput?.nativeElement.click(); // Fallback
        }
      }
    } else {
      this.fileInput?.nativeElement.click();
    }
  }

  async onFileSelected(event: any) {
    const files = Array.from(event.target.files ?? []) as File[];
    await this.loadFiles(files);
    event.target.value = '';
  }

  private async loadFiles(files: File[]) {
    // 1. Unzip any zip files first
    const filesToProcess: File[] = [];
    for (const file of files) {
      if (file.name.toLowerCase().endsWith('.zip')) {
        try {
          const zip = new JSZip();
          const contents = await zip.loadAsync(file);
          const zipFiles: File[] = [];
          for (const filename of Object.keys(contents.files)) {
            const zipEntry = contents.files[filename];
            if (!zipEntry.dir) {
              const ext = '.' + filename.split('.').pop()?.toLowerCase();
              if (ext === '.xml' || ext === '.xsd' || ext === '.txt') {
                const blob = await zipEntry.async('blob');
                const baseName = filename.split('/').pop() || filename;
                const extractedFile = new File([blob], baseName, { type: 'text/xml' });
                zipFiles.push(extractedFile);
              }
            }
          }
          if (zipFiles.length === 0) {
            this.snackBar.open(`${file.name}: No valid XML/XSD/TXT files found inside the zip.`, 'Dismiss', { duration: 4000 });
          } else {
            filesToProcess.push(...zipFiles);
            this.snackBar.open(`Extracted ${zipFiles.length} file(s) from ${file.name}`, 'Dismiss', { duration: 3000 });
          }
        } catch (err) {
          console.error('Error reading zip file:', err);
          this.snackBar.open(`${file.name}: Failed to unzip/read file.`, 'Dismiss', { duration: 4000 });
        }
      } else {
        filesToProcess.push(file);
      }
    }

    if (filesToProcess.length === 0) return;

    if (this.files.length + filesToProcess.length > 1000) {
      this.snackBar.open(`Maximum 1000 files allowed. You tried to add ${filesToProcess.length} to ${this.files.length} existing.`, 'Dismiss', { duration: 5000 });
      const availableCount = 1000 - this.files.length;
      if (availableCount <= 0) return;
      filesToProcess.splice(availableCount);
    }

    const validFiles = filesToProcess.filter(file => {
      const isAllowed = this.supportedFileExtensions.some(ext => file.name.toLowerCase().endsWith(ext));
      if (!isAllowed) this.snackBar.open(`${file.name}: Invalid type. XML/XSD/TXT/ZIP only.`, 'Dismiss', { duration: 3000 });

      const isSizeOk = file.size <= 1024 * 1024 * 3;
      if (!isSizeOk) this.snackBar.open(`${file.name}: File too large (max 3 MB).`, 'Dismiss', { duration: 5000 });

      return isAllowed && isSizeOk;
    });

    if (validFiles.length === 0) return;

    if (this.files.length > 0) {
      this.pendingFilesToAdd = validFiles;
      this.showReplaceModal = true;
      return;
    }

    await this.processValidFiles(validFiles, false);
  }

  async confirmReplace(replace: boolean) {
    this.showReplaceModal = false;

    // Handle pending file uploads
    const files = this.pendingFilesToAdd;
    this.pendingFilesToAdd = [];
    if (files.length > 0) {
      await this.processValidFiles(files, replace);
    }

    // Handle pending pasted XML
    const pastedXml = this.pendingPastedXml;
    this.pendingPastedXml = '';
    if (pastedXml) {
      if (replace) {
        this.clearAll();
      }
      this.addPastedEntry(pastedXml);
    }
  }

  private async processValidFiles(validFiles: File[], replace: boolean) {
    if (this.files.length > 0) {
      if (replace) {
        this.clearAll();
      } else {
        this.files.forEach(f => {
          f.status = 'pending';
          f.report = null;
        });
      }
    }

    try {
      const newEntries: FileEntry[] = await Promise.all(
        validFiles.map(async (file) => {
          const content = await file.text();
          return {
            id: crypto.randomUUID(),
            name: file.name,
            size: file.size,
            sizeLabel: this.formatSize(file.size),
            content: content,
            status: 'pending',
            report: null,
            messageType: '',
            handle: (file as any).fileHandle,
            origin: 'Uploaded'
          } as FileEntry;
        })
      );

      this.files = [...this.files, ...newEntries];
      if (this.files.length === 1) {
        this.selectedFile = this.files[0];
      } else {
        this.selectedFile = null;
      }
      this.saveWorkspace(); // PERSIST
      // Ensure UI updates immediately after all files are parsed
      this.cdr.detectChanges();

      this.snackBar.open(`${validFiles.length} file(s) uploaded successfully!`, 'Close', {
        duration: 3000,
        panelClass: ['success-snackbar']
      });
    } catch (e) {
      console.error(e);
      this.snackBar.open(`Error reading files`, 'Dismiss', { duration: 3000 });
    }
  }

  private formatSize(bytes: number): string {
    if (bytes < 1024) return bytes + ' B';
    return (bytes / 1024).toFixed(1) + ' KB';
  }

  // ── Paste XML ───────────────────────────────────────────────────────────────
  validatePastedXml() {
    const xml = this.pastedXmlContent?.trim();
    if (!xml) {
      this.snackBar.open('Please paste XML content first.', 'Dismiss', { duration: 3000 });
      return;
    }
    this.showPasteModal = false;

    // If files already exist, show the Replace/Keep Both popup
    if (this.files.length > 0) {
      this.pendingPastedXml = xml;
      this.pastedXmlContent = '';
      this.showReplaceModal = true;
      return;
    }

    // No existing files — add directly
    this.pastedXmlContent = '';
    this.addPastedEntry(xml);
  }

  closePasteModal() {
    this.showPasteModal = false;
    this.pastedXmlContent = '';
  }

  private addPastedEntry(xml: string) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const entry: FileEntry = {
      id: crypto.randomUUID(),
      name: `pasted-${ts}.xml`,
      size: new Blob([xml]).size,
      sizeLabel: this.formatSize(new Blob([xml]).size),
      content: xml,
      status: 'pending',
      report: null,
      messageType: '',
      origin: 'Pasted'
    };
    this.files = [...this.files, entry];
    this.selectedFile = entry;
    this.saveWorkspace(); // PERSIST
    this.cdr.detectChanges();
    this.validateFile(entry);
  }

  selectFile(f: FileEntry) {
    this.selectedFile = f;
    this.expandedIssue = null;
  }

  removeFile(f: FileEntry, e: MouseEvent) {
    e.stopPropagation();
    const idx = this.files.indexOf(f);
    this.files.splice(idx, 1);
    if (this.selectedFile === f) {
      this.selectedFile = this.files[idx] ?? this.files[idx - 1] ?? null;
    }
    this.saveWorkspace(); // PERSIST
  }

  clearAll() {
    this.files = [];
    this.selectedFile = null;
    this.expandedIssue = null;
    this.editingEntry = null;
    this.saveWorkspace(); // PERSIST (Clear storage)
  }

  // ── Editor ────────────────────────────────────────────────────────────────
  openEditor(f: FileEntry, e: MouseEvent) {
    e.stopPropagation();
    this.editingEntry = f;
    this.originalContent = f.content;
    this.updateEditorLines(f.content);

    // Initialize history
    this.xmlHistory = [f.content];
    this.xmlHistoryIdx = 0;
  }

  closeEditor() {
    if (this.editingEntry) {
      this.editingEntry.content = this.originalContent;
    }
    this.editingEntry = null;
  }

  copyEditorXml() {
    if (!this.editingEntry?.content) return;
    navigator.clipboard.writeText(this.editingEntry.content).then(() => {
      this.snackBar.open('Copied to clipboard!', '', { duration: 2000 });
    });
  }

  downloadEditorXml() {
    if (!this.editingEntry?.content) return;
    const blob = new Blob([this.editingEntry.content], { type: 'application/xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = this.editingEntry.name || 'message.xml';
    a.click();
    URL.revokeObjectURL(url);
  }

  onEditorChange(content: string) {
    if (!this.isInternalChange) {
      this.pushHistory();
    }
    this.updateEditorLines(content);
  }

  private pushHistory() {
    if (!this.editingEntry) return;
    const val = this.editingEntry.content;
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

  undo() {
    if (this.xmlHistoryIdx > 0 && this.editingEntry) {
      this.xmlHistoryIdx--;
      this.isInternalChange = true;
      this.editingEntry.content = this.xmlHistory[this.xmlHistoryIdx];
      this.updateEditorLines(this.editingEntry.content);
      setTimeout(() => this.isInternalChange = false, 10);
    }
  }

  redo() {
    if (this.xmlHistoryIdx < this.xmlHistory.length - 1 && this.editingEntry) {
      this.xmlHistoryIdx++;
      this.isInternalChange = true;
      this.editingEntry.content = this.xmlHistory[this.xmlHistoryIdx];
      this.updateEditorLines(this.editingEntry.content);
      setTimeout(() => this.isInternalChange = false, 10);
    }
  }

  canUndo(): boolean { return this.xmlHistoryIdx > 0; }
  canRedo(): boolean { return this.xmlHistoryIdx < this.xmlHistory.length - 1; }

  formatXml() {
    if (!this.editingEntry?.content?.trim()) return;
    this.pushHistory();

    try {
      let xml = this.editingEntry.content.trim();
      let formatted = '';
      let indent = '';
      const tab = '    ';

      xml.split(/>\s*</).forEach(node => {
        if (node.match(/^\/\w/)) indent = indent.substring(tab.length);
        formatted += indent + '<' + node + '>\r\n';
        if (node.match(/^<?\w[^>]*[^\/]$/) && !node.startsWith('?')) indent += tab;
      });

      this.editingEntry.content = formatted.substring(1, formatted.length - 3);
      this.updateEditorLines(this.editingEntry.content);
      this.snackBar.open('XML Formatted', '', { duration: 1500 });
    } catch (e) {
      this.snackBar.open('Unable to format XML', '', { duration: 3000 });
    }
  }

  toggleComment() {
    if (!this.editingEntry) return;

    const textarea = document.querySelector('.editor-textarea') as HTMLTextAreaElement;
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

    this.editingEntry.content = before + newResult + after;
    this.updateEditorLines(this.editingEntry.content);

    setTimeout(() => {
      textarea.focus();
      textarea.setSelectionRange(lineStart, lineStart + newResult.length);
      this.isInternalChange = false;
    }, 0);
  }

  updateEditorLines(content: string) {
    const lines = (content || '').split('\n').length;
    if (this.editorLineCount.length !== lines) {
      this.editorLineCount = Array.from({ length: lines }, (_, i) => i + 1);
    }
  }

  syncScroll(textarea: HTMLTextAreaElement, lineNumbers: HTMLDivElement) {
    lineNumbers.scrollTop = textarea.scrollTop;
  }

  handleKeyDown(e: KeyboardEvent) {
    if ((e.ctrlKey || e.metaKey)) {
      if (e.key === 's') {
        e.preventDefault();
        this.formatXml();
      } else if (e.key === 'z') {
        e.preventDefault();
        this.undo();
      } else if (e.key === 'y') {
        e.preventDefault();
        this.redo();
      } else if (e.key === '/') {
        e.preventDefault();
        this.toggleComment();
      }
    }
  }

  async saveEditor() {
    if (!this.editingEntry) return;
    const entry = this.editingEntry;

    // Strategy 1: Use existing FileSystemHandle (Overwrites original file)
    if (entry.handle) {
      try {
        // Request explicit read-write permission (browser will prompt the user once)
        const perm = await entry.handle.queryPermission({ mode: 'readwrite' });
        if (perm !== 'granted') {
          const newPerm = await entry.handle.requestPermission({ mode: 'readwrite' });
          if (newPerm !== 'granted') {
            throw new Error('Local write permission denied');
          }
        }

        const writable = await entry.handle.createWritable();
        await writable.write(entry.content);
        await writable.close();

        this.snackBar.open('Saved changes directly to original file!', 'Close', {
          duration: 3000,
          panelClass: ['success-snackbar']
        });
      } catch (err: any) {
        console.error('Direct save failed:', err);
        // If direct write failed (e.g. read-only file), we fall through to "Save As" fallback
        this.snackBar.open('Direct save failed. Please select where to save.', 'Dismiss', { duration: 3000 });
        await this.handleSaveAs(entry);
      }
    }
    // Strategy 2: Missing handle (File was drag-dropped or uploaded via standard input)
    else if ('showSaveFilePicker' in window) {
      await this.handleSaveAs(entry);
    }
    // Fallback: Legacy browser support
    else {
      this.snackBar.open('Changes updated in memory. Local file saving not supported in this browser.', 'Close', { duration: 4000 });
    }

    this.originalContent = entry.content;
    this.editingEntry = null;
    this.saveWorkspace(); // PERSIST
    this.validateFile(entry);
  }

  /**
   * Triggers a "Save As" dialog to let the user pick/overwrite their local file.
   * On success, we capture the new handle so future saves are direct/seamless.
   */
  private async handleSaveAs(entry: FileEntry) {
    try {
      const handle = await (window as any).showSaveFilePicker({
        suggestedName: entry.name,
        types: [{
          description: 'XML File',
          accept: { 'text/xml': ['.xml'] }
        }]
      });

      const writable = await handle.createWritable();
      await writable.write(entry.content);
      await writable.close();

      // Upgrade this entry with the new handle so next "Save" is seamless
      entry.handle = handle;

      this.snackBar.open('File linked and saved successfully!', 'Close', {
        duration: 3000,
        panelClass: ['success-snackbar']
      });
    } catch (err) {
      console.warn('Save As cancelled or failed');
      this.snackBar.open('Changes updated in memory only.', 'Close', { duration: 3000 });
    }
  }

  validateAll() {
    // Call the batch init endpoint to get one VAL ID + FILE IDs for all files
    this.http.post<any>(this.config.getApiUrl('/validate-batch'), {
      file_count: this.files.length
    }).subscribe({
      next: (data) => {
        const batchId = data.batch_id;   // e.g. VAL06032600001
        const fileIds: string[] = data.file_ids; // e.g. [FILE0001, FILE0002, ...]
        for (let i = 0; i < this.files.length; i++) {
          this.validateFile(this.files[i], batchId, fileIds[i]);
        }
      },
      error: () => {
        // Fallback: validate without batch grouping
        for (const f of this.files) {
          this.validateFile(f);
        }
      }
    });
  }

  validateFile(entry: FileEntry, batchId?: string, fileId?: string) {
    if (!entry.content?.trim()) return;

    // Client-side well-formedness pre-check
    const parser = new DOMParser();
    const doc = parser.parseFromString(entry.content, 'text/xml');
    const parseErrorEl = doc.querySelector('parsererror');
    if (parseErrorEl) {
      // Collect ALL errors from the raw content — don't stop at the first one
      const allDetails: any[] = [];
      const lines = entry.content.split('\n');
      const rawAmpRe = /&(?![a-zA-Z#][a-zA-Z0-9#]*;)/g;
      // Safe charset for name/address tags
      const nameTagRe = /<(Nm|StrtNm|TwnNm|BldgNm|AdrLine|DstrctNm|CtrySubDvsn|TwnLctnNm)>([^<]+)<\/\1>/g;
      const safeCharRe = /^[a-zA-Z0-9 .,()'"-]+$/;

      // 1. Find every line with a literal unescaped &
      lines.forEach((line, idx) => {
        let m: RegExpExecArray | null;
        rawAmpRe.lastIndex = 0;
        while ((m = rawAmpRe.exec(line)) !== null) {
          const lineNum = String(idx + 1);
          allDetails.push({
            severity: 'ERROR', layer: 1, code: 'INVALID_CHARSET', path: lineNum,
            message: `Invalid character '&' at line ${lineNum}. The ampersand is a reserved XML character and is not allowed in name or address fields.`,
            fix_suggestion: `Remove or replace the '&' at line ${lineNum}. Write 'and' instead of '&'.`
          });
          break; // one report per line is enough
        }
      });

      // 2. Find invalid charset in name/address tags (works on content even if XML is partially broken)
      let tagMatch: RegExpExecArray | null;
      nameTagRe.lastIndex = 0;
      while ((tagMatch = nameTagRe.exec(entry.content)) !== null) {
        const tagName = tagMatch[1];
        const tagValue = tagMatch[2].trim();
        if (tagValue && !safeCharRe.test(tagValue)) {
          const before = entry.content.substring(0, tagMatch.index);
          const lineNum = String((before.match(/\n/g) || []).length + 1);
          const badChars = [...new Set(tagValue.split('').filter(c => !/[a-zA-Z0-9 .,()'"-]/.test(c)))].join(' ');
          allDetails.push({
            severity: 'ERROR', layer: 1, code: 'INVALID_CHARSET', path: lineNum,
            message: `Field <${tagName}> at line ${lineNum} contains invalid character(s): ${badChars}. Only letters, digits, spaces and . , ( ) ' - are allowed.`,
            fix_suggestion: `Remove or replace the invalid character(s) ${badChars} in <${tagName}> at line ${lineNum}.`
          });
        }
      }

      // 3. If nothing specific found, fall back to a generic parse error with the browser's line number
      if (allDetails.length === 0) {
        const rawError = parseErrorEl.textContent || '';
        let lineNum = '?';
        const lineMatch = rawError.match(/[Ll]ine[:\s]+(\d+)/i) || rawError.match(/(\d+):(\d+)/);
        if (lineMatch) lineNum = lineMatch[1];
        allDetails.push({
          severity: 'ERROR', layer: 1, code: 'XML_SYNTAX', path: lineNum,
          message: `Malformed XML at line ${lineNum} — invalid structure or unclosed tags.`,
          fix_suggestion: `Check line ${lineNum}: ensure all tags are properly opened and closed and values contain no reserved XML characters.`
        });
      }

      const totalErrors = allDetails.length;
      this.snackBar.open(`${entry.name}: ${totalErrors} error(s) found`, 'Dismiss', { duration: 4000 });
      entry.status = 'failed';
      entry.report = {
        status: 'FAIL', errors: totalErrors, warnings: 0,
        message: 'Unknown', total_time_ms: 0,
        layer_status: { '1': { status: '❌', time: 0 } },
        details: allDetails
      };
      return;
    }

    entry.status = 'validating';
    entry.report = null;

    const rawType = (this.messageControl.value || 'Auto-detect').split(' ')[0];
    const cleanType = rawType === 'Auto-detect' ? 'Auto-detect' : rawType;

    // If no fileId provided (single file validation), generate one for this single file
    if (!batchId) {
      // Single file validation — still call batch init for proper ID tracking
      this.http.post<any>(this.config.getApiUrl('/validate-batch'), {
        file_count: 1
      }).subscribe({
        next: (data) => {
          this._doValidateRequest(entry, cleanType, data.batch_id, data.file_ids[0]);
        },
        error: () => {
          this._doValidateRequest(entry, cleanType);
        }
      });
    } else {
      this._doValidateRequest(entry, cleanType, batchId, fileId);
    }
  }

  private _doValidateRequest(entry: FileEntry, cleanType: string, batchId?: string, fileId?: string) {
    this.http.post(this.config.getApiUrl('/validate'), {
      xml_content: entry.content,
      mode: this.validationMode,
      message_type: cleanType,
      store_in_history: true,
      batch_id: batchId || null,
      file_id: fileId || null,
      origin: entry.origin || 'Pasted'
    }).subscribe({
      next: (data: any) => {
        if (data && data.details) {
          data.details.forEach((issue: any, index: number) => {
            issue.id = `issue_${index}`;
          });
        }
        entry.report = data;
        entry.messageType = data.message ?? '';

        // Rename pasted files to use the detected message type
        if (entry.name.startsWith('pasted-') && entry.messageType && entry.messageType !== 'Unknown') {
          entry.name = `${entry.messageType}.xml`;
        }
        if (data.status === 'PASS') {
          entry.status = data.warnings > 0 ? 'warnings' : 'passed';
        } else {
          entry.status = 'failed';
        }
        if (!this.selectedFile || this.selectedFile === entry) {
          this.selectedFile = entry;
        }
        this.saveWorkspace(); // PERSIST
        this.expandedIssue = null; // Reset stale expansion
      },
      error: () => {
        entry.status = 'failed';
        this.expandedIssue = null;
        this.snackBar.open(`${entry.name}: Validation failed (backend error)`, 'Dismiss', { duration: 3000 });
      }
    });
  }

  // ── Report helpers ─────────────────────────────────────────────────────────
  getReportLayers(report: any): string[] {
    if (!report?.layer_status) return [];
    return Object.keys(report.layer_status).sort();
  }

  // ── Persistence ────────────────────────────────────────────────────────────
  private readonly DB_NAME = 'ISO_WORKSPACE_DB';
  private readonly STORE_NAME = 'workspace_files';

  private async getDB(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.DB_NAME, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(this.STORE_NAME)) {
          db.createObjectStore(this.STORE_NAME, { keyPath: 'id' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  private async saveWorkspace() {
    try {
      const db = await this.getDB();
      const tx = db.transaction(this.STORE_NAME, 'readwrite');
      const store = tx.objectStore(this.STORE_NAME);

      // Clear existing first
      store.clear();

      // Add all current files
      for (const f of this.files) {
        // We strip large binary data if needed, but here we store content.
        // Handles CAN be stored in IDB.
        store.put({ ...f, status: f.status === 'validating' ? 'pending' : f.status });
      }
    } catch (e) {
      console.warn('Failed to persist workspace:', e);
    }
  }

  private async restoreWorkspace(): Promise<void> {
    return new Promise(async (resolve) => {
      try {
        const db = await this.getDB();
        const tx = db.transaction(this.STORE_NAME, 'readonly');
        const store = tx.objectStore(this.STORE_NAME);
        const request = store.getAll();

        request.onsuccess = () => {
          if (request.result && request.result.length > 0) {
            this.files = request.result.map((f: any) => ({
              ...f,
              status: f.status === 'validating' ? 'pending' : f.status
            }));
            this.cdr.detectChanges();
          }
          resolve();
        };
        request.onerror = () => resolve();
      } catch (e) {
        console.warn('Failed to restore workspace:', e);
        resolve();
      }
    });
  }

  private loadValidationFromHistory(reportId: string, autoRun: boolean) {
    this.http.get<any>(this.config.getApiUrl(`/history/${reportId}`)).subscribe({
      next: (data) => {
        if (data && data.original_message) {
          let msgType = data.report?.message;
          if (!msgType || msgType === 'Unknown') {
            msgType = `re_run_${reportId.substring(0, 8)}`;
          }
          const fileName = `${msgType}.xml`;

          // Check if file already exists in workspace
          const existing = this.files.find(f => f.content === data.original_message);
          if (existing) {
            this.selectedFile = existing;
            if (autoRun) {
              this.validateFile(existing);
            }
            this.cdr.detectChanges();
            return;
          }

          const entry: FileEntry = {
            id: 'f' + Date.now(),
            name: fileName,
            size: data.original_message.length,
            sizeLabel: (data.original_message.length / 1024).toFixed(1) + ' KB',
            content: data.original_message,
            status: 'pending',
            report: null,
            messageType: data.report?.message || 'Auto-detect',
            handle: null
          };

          this.files.unshift(entry); // Add to top
          this.saveWorkspace();
          this.selectedFile = entry;

          if (autoRun) {
            this.validateFile(entry);
          }
          this.cdr.detectChanges();
        }
      },
      error: (err) => {
        this.snackBar.open('Failed to load validation from history.', 'Close', { duration: 3000 });
      }
    });
  }

  getLayerName(k: string): string {
    const names: Record<string, string> = {
      '1': 'Syntax & Format',
      '2': 'Schema Validation',
      '3': 'Business Rules'
    };
    return names[k] ?? `Layer ${k}`;
  }

  trackByLayerName(_index: number, item: any): string {
    return item.name;
  }

  trackByIssueId(_index: number, item: any): string {
    return item.id;
  }

  getLayerStatus(report: any, k: string): string {
    return report?.layer_status?.[k]?.status ?? '';
  }

  getLayerTime(report: any, k: string): number {
    return report?.layer_status?.[k]?.time ?? 0;
  }

  isLayerPass(report: any, k: string) { return this.getLayerStatus(report, k).includes('✅'); }
  isLayerFail(report: any, k: string) { return this.getLayerStatus(report, k).includes('❌'); }
  isLayerWarn(report: any, k: string) {
    const s = this.getLayerStatus(report, k);
    return s.includes('⚠') || s.includes('WARNING') || s.includes('WARN');
  }

  getIssues(report: any): any[] { return report?.details ?? []; }
  getErrors(report: any): any[] { return this.getIssues(report).filter(i => i.severity === 'ERROR'); }
  getWarnings(report: any): any[] { return this.getIssues(report).filter(i => i.severity === 'WARNING'); }

  getIssueLine(issue: any): number | null {
    if (issue.line) return Number(issue.line);
    const p = String(issue.path || '').trim();
    if (/^\d+$/.test(p)) {
      return Number(p);
    }
    return null;
  }

  getIssuePath(issue: any): string | null {
    const p = String(issue.path || '').trim();
    if (!p) return null;
    if (/^\d+$/.test(p)) return null;
    if (p === '/') return 'Root';
    return p;
  }

  toggleIssue(issue: any) {
    this.expandedIssue = this.expandedIssue === issue.id ? null : issue.id;
    this.cdr.detectChanges();
  }

  copyFix(text: string, e: MouseEvent) {
    e.stopPropagation();
    navigator.clipboard.writeText(text).then(() => {
      this.snackBar.open('Copied!', '', { duration: 1500 });
    });
  }

  getStatusLabel(f: FileEntry): string {
    switch (f.status) {
      case 'passed': return 'PASSED';
      case 'failed': return 'FAILED';
      case 'warnings': return 'WARNINGS';
      case 'validating': return 'VALIDATING…';
      default: return 'PENDING';
    }
  }

  getMessageFamily(type: string): string {
    const t = (type || '').toLowerCase();
    if (t.startsWith('pacs')) return 'pacs';
    if (t.startsWith('camt')) return 'camt';
    if (t.startsWith('pain')) return 'pain';
    if (t.startsWith('sese')) return 'sese';
    if (t.startsWith('head')) return 'head';
    return 'other';
  }

  jumpToLine(f: FileEntry, lineNum: number | null, event: MouseEvent) {
    if (event) {
      event.stopPropagation();
      event.preventDefault();
    }
    if (!lineNum) return;

    try {
      this.editingEntry = f;
      this.originalContent = f.content;
      this.targetLine = Number(lineNum);
      this.updateEditorLines(f.content || '');

      // Initialize history
      this.xmlHistory = [f.content || ''];
      this.xmlHistoryIdx = 0;

      this.cdr.detectChanges();

      // Give DOM time to paint before attempting scroll
      setTimeout(() => this.scrollToLine(Number(lineNum)), 50);
    } catch (err: any) {
      this.snackBar.open('Error opening editor: ' + err.message, 'Close', { duration: 3000 });
    }
  }

  scrollToLine(lineNum: number) {
    const tryScroll = (attempts: number) => {
      try {
        const textarea = document.querySelector('.editor-textarea') as HTMLTextAreaElement;
        if (!textarea) {
          if (attempts < 30) setTimeout(() => tryScroll(attempts + 1), 50);
          return;
        }

        const content = this.editingEntry?.content || '';

        // Force populate if empty or too small
        if (!textarea.value || textarea.value.length < content.length * 0.5) {
          textarea.value = content;
        }

        const lines = textarea.value.split('\n');
        let charPos = 0;
        const targetL = lineNum - 1;
        const maxLines = Math.min(targetL, lines.length);

        for (let i = 0; i < maxLines; i++) {
          charPos += lines[i].length + 1; // +1 for the newline character
        }

        textarea.focus();
        textarea.setSelectionRange(charPos, charPos + (lines[targetL] || '').length);

        // Calculate scroll position (font-size 13px * line-height 1.5 = 19.5px)
        const lineHeight = 19.5;
        textarea.scrollTop = Math.max(0, (lineNum - 5) * lineHeight);

        const lineNumbers = document.querySelector('.editor-line-numbers') as HTMLDivElement;
        if (lineNumbers) {
          this.syncScroll(textarea, lineNumbers);
        }
      } catch (err) {
        console.error('Scroll error:', err);
        if (attempts < 30) setTimeout(() => tryScroll(attempts + 1), 50);
      }
    };

    tryScroll(0);
  }
}
