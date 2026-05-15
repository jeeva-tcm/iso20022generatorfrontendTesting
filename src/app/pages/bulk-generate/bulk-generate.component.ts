import JSZip from 'jszip';
import { Component, OnInit, ElementRef, HostListener, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { ConfigService } from '../../services/config.service';

interface MessageBlock {
  id: string;
  label: string;
  mandatory: boolean;
  requires?: string[];
}

interface MessageTypeConfig {
  id: string;
  bulkId: string;
  label: string;
  description: string;
  family: string;
  badge: string;
  blocks: MessageBlock[];
}

interface MessageFamily {
  name: string;
  label: string;
  messages: MessageTypeConfig[];
}

interface GeneratedMessage {
  index: number;
  xml: string;
  message_type: string;
  status: string;
  error?: string;
  validation_report?: any;
}

interface GroupedMessage {
  message_type: string;
  messages: GeneratedMessage[];
  status: string;
  expanded: boolean;
  activeMessageIndex: number;
}

interface DependencyWarning {
  blockId: string;
  blockLabel: string;
  requiredId: string;
  requiredLabel: string;
}

/**
 * Single source of truth: Manual Entry popularMessages.
 * Bulk Generation dynamically derives its config from this list.
 * When a new message is added in Manual Entry, add it here
 * and it automatically appears in both Manual Entry AND Bulk Generation.
 */
const MANUAL_ENTRY_MESSAGES: {
  id: string;
  name: string;
  type: string;
  bulkId: string;          // key used by the backend bulk generator
}[] = [
  // ── PACS Messages ──
  { id: 'pacs.008.001.13', name: 'Customer Credit Transfer',     type: 'pacs', bulkId: 'pacs.008' },
  { id: 'pacs.003.001.11', name: 'Customer Direct Debit',        type: 'pacs', bulkId: 'pacs.003' },
  { id: 'pacs.009.001.12', name: 'FI Credit Transfer',           type: 'pacs', bulkId: 'pacs.009' },
  { id: 'pacs.009.001.12_ADV', name: 'FI Credit Transfer (Adv)', type: 'pacs', bulkId: 'pacs.009.adv' },
  { id: 'pacs.009.001.12 COV', name: 'FI Credit Transfer (Cov)', type: 'pacs', bulkId: 'pacs.009.cov' },
  { id: 'pacs.004.001.14', name: 'Payment Return',               type: 'pacs', bulkId: 'pacs.004' },
  { id: 'pacs.002.001.15', name: 'Payment Status Report',        type: 'pacs', bulkId: 'pacs.002' },
  { id: 'pacs.010.001.06', name: 'Interbank Direct Debit',       type: 'pacs', bulkId: 'pacs.010' },
  { id: 'pacs.010.001.03', name: 'Margin Collection',            type: 'pacs', bulkId: 'pacs.010.v3' },

  // ── CAMT Messages ──
  { id: 'camt.057.001.08', name: 'Notification to Receive',              type: 'camt', bulkId: 'camt.057' },
  { id: 'camt.052.001.13', name: 'Account Report',                       type: 'camt', bulkId: 'camt.052' },
  { id: 'camt.053.001.13', name: 'Bank To Customer Statement',           type: 'camt', bulkId: 'camt.053' },
  { id: 'camt.054.001.13', name: 'Debit Credit Notification',            type: 'camt', bulkId: 'camt.054' },
  { id: 'camt.055.001.12', name: 'Customer Payment Cancellation Request',type: 'camt', bulkId: 'camt.055' },
  { id: 'camt.056.001.11', name: 'FI To FI Payment Cancellation',        type: 'camt', bulkId: 'camt.056' },

  // ── PAIN Messages ──
  { id: 'pain.001.001.12', name: 'Credit Transfer Initiation',   type: 'pain', bulkId: 'pain.001' },
  { id: 'pain.002.001.14', name: 'Payment Status Report',        type: 'pain', bulkId: 'pain.002' },
  { id: 'pain.008.001.11', name: 'Direct Debit Initiation',      type: 'pain', bulkId: 'pain.008' },
];

@Component({
  selector: 'app-bulk-generate',
  standalone: true,
  imports: [CommonModule, FormsModule, MatIconModule, MatSnackBarModule, MatTooltipModule],
  templateUrl: './bulk-generate.component.html',
  styleUrl: './bulk-generate.component.css'
})
export class BulkGenerateComponent implements OnInit {

  /** All message configs dynamically built from Manual Entry source */
  messageConfigs: MessageTypeConfig[] = [];

  /** Grouped by family for category display */
  messageFamilies: MessageFamily[] = [];

  selectedConfigs: MessageTypeConfig[] = [];
  activeConfig: MessageTypeConfig | null = null;

  messageCount: number = 1;
  messageCountError: string = '';

  // block selection: configId -> blockId -> boolean
  blockChecked: Record<string, Record<string, boolean>> = {};

  // dependency warnings list by configId
  dependencyWarnings: Record<string, DependencyWarning[]> = {};

  // generation state
  isGenerating = false;
  generatedMessages: GeneratedMessage[] = [];
  groupedMessages: GroupedMessage[] = [];
  expandedIndex: number | null = null;

  // generation stats from backend response
  generationStats: {
    requested: number;
    produced: number;
    totalAttempts: number;
  } | null = null;

  // preview / results view
  view: 'select' | 'config' | 'results' = 'select';

  @ViewChild('loadingSection') loadingSection?: ElementRef;
  @ViewChild('resultsSection') resultsSection?: ElementRef;

  // loading state for blocks
  loadingBlocks = false;

  // ── Search State ──
  searchQuery = '';
  showDropdown = false;
  highlightedSuggestionIndex = -1;
  searchSuggestions: MessageTypeConfig[] = [];

  constructor(
    private http: HttpClient,
    private config: ConfigService,
    private snackBar: MatSnackBar,
    private elRef: ElementRef
  ) {}

  /** Close dropdown when clicking outside the search container */
  @HostListener('document:click', ['$event'])
  onDocumentClick(event: MouseEvent) {
    const searchContainer = this.elRef.nativeElement.querySelector('.search-container');
    if (searchContainer && !searchContainer.contains(event.target as Node)) {
      this.showDropdown = false;
      this.highlightedSuggestionIndex = -1;
    }
  }

  ngOnInit() {
    this.buildConfigsFromManualEntry();
  }

  // ── Dynamic Config Builder ────────────────────────────────────────────────

  /**
   * Build message configs from the single source of truth (MANUAL_ENTRY_MESSAGES).
   * Groups them by family (PACS, CAMT, PAIN) for the UI.
   * Blocks are loaded on-demand from the backend when a message is selected.
   */
  private buildConfigsFromManualEntry() {
    const familyMap: Record<string, { label: string; configs: MessageTypeConfig[] }> = {};

    const familyLabels: Record<string, string> = {
      pacs: 'PACS Messages',
      camt: 'Cash Management (CAMT)',
      pain: 'Payment Initiation (PAIN)',
    };

    for (const msg of MANUAL_ENTRY_MESSAGES) {
      const cfg: MessageTypeConfig = {
        id: msg.id,
        bulkId: msg.bulkId,
        label: msg.id,
        description: msg.name,
        family: msg.type.toUpperCase(),
        badge: msg.type,
        blocks: [],  // loaded on-demand from backend
      };

      if (!familyMap[msg.type]) {
        familyMap[msg.type] = {
          label: familyLabels[msg.type] || msg.type.toUpperCase(),
          configs: [],
        };
      }
      familyMap[msg.type].configs.push(cfg);
      this.messageConfigs.push(cfg);
    }

    // Build ordered family groups
    const familyOrder = ['pacs', 'camt', 'pain'];
    for (const key of familyOrder) {
      if (familyMap[key]) {
        this.messageFamilies.push({
          name: key,
          label: familyMap[key].label,
          messages: familyMap[key].configs,
        });
      }
    }

    // Any remaining families not in the order
    for (const key of Object.keys(familyMap)) {
      if (!familyOrder.includes(key)) {
        this.messageFamilies.push({
          name: key,
          label: familyMap[key].label,
          messages: familyMap[key].configs,
        });
      }
    }
  }

  // ── Search / Filter Logic ──────────────────────────────────────────────────

  /** Filtered families based on searchQuery — filters cards across code, description, and family */
  get filteredFamilies(): MessageFamily[] {
    const q = this.searchQuery.trim().toLowerCase();
    if (!q) return this.messageFamilies;

    return this.messageFamilies
      .map(family => {
        const filtered = family.messages.filter(cfg =>
          cfg.label.toLowerCase().includes(q) ||
          cfg.description.toLowerCase().includes(q) ||
          cfg.family.toLowerCase().includes(q) ||
          cfg.id.toLowerCase().includes(q) ||
          family.label.toLowerCase().includes(q)
        );
        return { ...family, messages: filtered };
      })
      .filter(family => family.messages.length > 0);
  }

  /** Total count of visible messages after filtering */
  get filteredMessageCount(): number {
    return this.filteredFamilies.reduce((sum, f) => sum + f.messages.length, 0);
  }

  /** Whether the search has no results */
  get hasNoResults(): boolean {
    return this.searchQuery.trim().length > 0 && this.filteredMessageCount === 0;
  }

  onSearchInput() {
    const q = this.searchQuery.trim().toLowerCase();
    this.highlightedSuggestionIndex = -1;

    if (q.length === 0) {
      this.searchSuggestions = [];
      this.showDropdown = false;
      return;
    }

    // Build flat suggestion list (max 8)
    this.searchSuggestions = this.messageConfigs.filter(cfg =>
      cfg.label.toLowerCase().includes(q) ||
      cfg.description.toLowerCase().includes(q) ||
      cfg.family.toLowerCase().includes(q) ||
      cfg.id.toLowerCase().includes(q)
    ).slice(0, 8);

    this.showDropdown = this.searchSuggestions.length > 0;
  }

  onSearchKeydown(event: KeyboardEvent) {
    if (!this.showDropdown || this.searchSuggestions.length === 0) {
      // If Enter is pressed with an exact-ish match
      if (event.key === 'Enter') {
        const q = this.searchQuery.trim().toLowerCase();
        const exact = this.messageConfigs.find(cfg =>
          cfg.label.toLowerCase() === q ||
          cfg.description.toLowerCase() === q
        );
        if (exact) {
          this.selectSuggestion(exact);
        }
      }
      return;
    }

    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        this.highlightedSuggestionIndex = Math.min(
          this.highlightedSuggestionIndex + 1,
          this.searchSuggestions.length - 1
        );
        break;

      case 'ArrowUp':
        event.preventDefault();
        this.highlightedSuggestionIndex = Math.max(
          this.highlightedSuggestionIndex - 1,
          0
        );
        break;

      case 'Enter':
        event.preventDefault();
        if (this.highlightedSuggestionIndex >= 0 && this.highlightedSuggestionIndex < this.searchSuggestions.length) {
          this.selectSuggestion(this.searchSuggestions[this.highlightedSuggestionIndex]);
        } else if (this.searchSuggestions.length === 1) {
          this.selectSuggestion(this.searchSuggestions[0]);
        }
        break;

      case 'Escape':
        this.showDropdown = false;
        this.highlightedSuggestionIndex = -1;
        break;
    }
  }

  selectSuggestion(cfg: MessageTypeConfig) {
    this.showDropdown = false;
    this.highlightedSuggestionIndex = -1;
    this.searchQuery = cfg.label;
    if (!this.isSelected(cfg)) {
      this.toggleMessageType(cfg);
    }
  }

  clearSearch() {
    this.searchQuery = '';
    this.searchSuggestions = [];
    this.showDropdown = false;
    this.highlightedSuggestionIndex = -1;
  }

  onSearchFocus() {
    if (this.searchQuery.trim().length > 0 && this.searchSuggestions.length > 0) {
      this.showDropdown = true;
    }
  }

  // ── Message Type Selection ──────────────────────────────────────────────────

  isSelected(cfg: MessageTypeConfig): boolean {
    return this.selectedConfigs.some(c => c.id === cfg.id);
  }

  toggleMessageType(cfg: MessageTypeConfig) {
    const idx = this.selectedConfigs.findIndex(c => c.id === cfg.id);
    if (idx >= 0) {
      this.selectedConfigs.splice(idx, 1);
    } else {
      this.selectedConfigs.push(cfg);
    }
  }

  get allMessageTypesSelected(): boolean {
    return this.messageConfigs.length > 0 && this.selectedConfigs.length === this.messageConfigs.length;
  }

  selectAllMessageTypes(): void {
    if (this.allMessageTypesSelected) {
      this.selectedConfigs = [];
    } else {
      this.selectedConfigs = [...this.messageConfigs];
    }
  }

  isFamilyAllSelected(family: MessageFamily): boolean {
    return family.messages.length > 0 && family.messages.every(m => this.isSelected(m));
  }

  toggleFamilySelectAll(family: MessageFamily): void {
    if (this.isFamilyAllSelected(family)) {
      // Deselect all in this family
      const familyIds = new Set(family.messages.map(m => m.id));
      this.selectedConfigs = this.selectedConfigs.filter(c => !familyIds.has(c.id));
    } else {
      // Select all in this family (add missing ones)
      for (const msg of family.messages) {
        if (!this.isSelected(msg)) {
          this.selectedConfigs.push(msg);
        }
      }
    }
  }

  goToConfig() {
    if (this.selectedConfigs.length === 0) return;
    this.view = 'config';
    this.activeConfig = this.selectedConfigs[0];
    this.generatedMessages = [];
    this.expandedIndex = null;

    // Load blocks for each selected config
    this.selectedConfigs.forEach(cfg => {
      if (!this.blockChecked[cfg.id]) {
        this.blockChecked[cfg.id] = {};
        this.dependencyWarnings[cfg.id] = [];
      }
      if (cfg.blocks.length === 0) {
        this.loadBlocksFromBackend(cfg);
      } else {
        this.initBlockChecked(cfg);
      }
    });
  }

  setActiveConfig(cfg: MessageTypeConfig) {
    this.activeConfig = cfg;
  }

  private initBlockChecked(cfg: MessageTypeConfig) {
    if (!this.blockChecked[cfg.id]) {
      this.blockChecked[cfg.id] = {};
    }
    cfg.blocks.forEach(b => {
      if (this.blockChecked[cfg.id][b.id] === undefined) {
        this.blockChecked[cfg.id][b.id] = b.mandatory;
      }
    });
    this.updateDependencyWarnings(cfg);
  }

  private loadBlocksFromBackend(cfg: MessageTypeConfig) {
    this.loadingBlocks = true;
    this.http.get<any>(this.config.getApiUrl(`/bulk-generate/blocks/${cfg.bulkId}`)).subscribe({
      next: (res) => {
        const blocks: MessageBlock[] = (res.blocks || []).map((b: any) => ({
          id: b.id,
          label: b.label,
          mandatory: b.mandatory,
          requires: b.requires || undefined
        }));
        cfg.blocks = blocks;
        this.loadingBlocks = false;

        // Pre-check mandatory blocks
        this.initBlockChecked(cfg);
      },
      error: () => {
        this.loadingBlocks = false;
        this.snackBar.open('Failed to load block configuration.', 'Close', {
          duration: 4000, horizontalPosition: 'center', verticalPosition: 'bottom'
        });
      }
    });
  }

  // ── Block Checkbox Logic ───────────────────────────────────────────────────

  onBlockChange(cfgId: string, blockId: string, checked: boolean) {
    const cfg = this.selectedConfigs.find(c => c.id === cfgId);
    if (!cfg) return;

    const block = cfg.blocks.find(b => b.id === blockId);
    if (!block || block.mandatory) return;  // mandatory blocks can't be toggled

    this.blockChecked[cfgId][blockId] = checked;

    if (checked) {
      // Auto-check required dependencies
      this.autoCheckDependencies(cfg, blockId);
    } else {
      // Uncheck blocks that depend on this one
      this.autoClearDependents(cfg, blockId);
    }

    this.updateDependencyWarnings(cfg);
  }

  private autoCheckDependencies(cfg: MessageTypeConfig, blockId: string) {
    const block = cfg.blocks.find(b => b.id === blockId);
    if (!block?.requires) return;
    block.requires.forEach(reqId => {
      if (!this.blockChecked[cfg.id][reqId]) {
        this.blockChecked[cfg.id][reqId] = true;
        this.autoCheckDependencies(cfg, reqId);
      }
    });
  }

  private autoClearDependents(cfg: MessageTypeConfig, blockId: string) {
    cfg.blocks
      .filter(b => b.requires?.includes(blockId) && !b.mandatory)
      .forEach(dependent => {
        this.blockChecked[cfg.id][dependent.id] = false;
        this.autoClearDependents(cfg, dependent.id);
      });
  }

  private updateDependencyWarnings(cfg: MessageTypeConfig) {
    const warnings: DependencyWarning[] = [];

    cfg.blocks.forEach(block => {
      if (this.blockChecked[cfg.id][block.id] && block.requires) {
        block.requires.forEach(reqId => {
          if (!this.blockChecked[cfg.id][reqId]) {
            const reqBlock = cfg.blocks.find(b => b.id === reqId);
            if (reqBlock) {
              warnings.push({
                blockId: block.id,
                blockLabel: block.label,
                requiredId: reqId,
                requiredLabel: reqBlock.label
              });
            }
          }
        });
      }
    });

    this.dependencyWarnings[cfg.id] = warnings;
  }

  // ── Count Validation ───────────────────────────────────────────────────────

  onCountChange() {
    const v = this.messageCount;
    if (!v || v < 1) {
      this.messageCountError = 'Minimum value is 1.';
    } else if (v > 500) {
      this.messageCountError = 'Maximum value is 500.';
    } else if (!Number.isInteger(v)) {
      this.messageCountError = 'Must be a whole number.';
    } else {
      this.messageCountError = '';
    }
  }

  // ── Selected Blocks List ───────────────────────────────────────────────────

  getSelectedBlocks(cfgId: string): string[] {
    if (!this.blockChecked[cfgId]) return [];
    return Object.entries(this.blockChecked[cfgId])
      .filter(([, v]) => v)
      .map(([k]) => k);
  }

  get mandatoryBlocks(): MessageBlock[] {
    return this.activeConfig?.blocks.filter(b => b.mandatory) ?? [];
  }

  get optionalBlocks(): MessageBlock[] {
    const mandatoryIds = new Set(this.mandatoryBlocks.map(b => b.id));
    return this.activeConfig?.blocks.filter(b => !b.mandatory && !mandatoryIds.has(b.id)) ?? [];
  }

  get allOptionalSelected(): boolean {
    if (!this.activeConfig || this.optionalBlocks.length === 0) return false;
    return this.optionalBlocks.every(b => this.blockChecked[this.activeConfig!.id]?.[b.id]);
  }

  toggleSelectAllOptional(): void {
    if (!this.activeConfig) return;
    const cfgId = this.activeConfig.id;
    const newState = !this.allOptionalSelected;

    for (const block of this.optionalBlocks) {
      this.blockChecked[cfgId][block.id] = newState;
      if (newState) {
        this.autoCheckDependencies(this.activeConfig, block.id);
      }
    }

    // If deselecting all, clear dependents too
    if (!newState) {
      for (const block of this.optionalBlocks) {
        this.autoClearDependents(this.activeConfig, block.id);
      }
    }

    this.updateDependencyWarnings(this.activeConfig);
  }

  get allOptionalSelectedGlobally(): boolean {
    if (this.selectedConfigs.length === 0) return false;
    for (const cfg of this.selectedConfigs) {
      const mandatoryIds = new Set(cfg.blocks.filter(b => b.mandatory).map(b => b.id));
      const optBlocks = cfg.blocks.filter(b => !b.mandatory && !mandatoryIds.has(b.id));
      if (optBlocks.length === 0) continue;
      const allCheckedForCfg = optBlocks.every(b => this.blockChecked[cfg.id]?.[b.id]);
      if (!allCheckedForCfg) return false;
    }
    return true;
  }

  toggleSelectAllGlobally(): void {
    if (this.selectedConfigs.length === 0) return;
    const newState = !this.allOptionalSelectedGlobally;

    for (const cfg of this.selectedConfigs) {
      const cfgId = cfg.id;
      const mandatoryIds = new Set(cfg.blocks.filter(b => b.mandatory).map(b => b.id));
      const optBlocks = cfg.blocks.filter(b => !b.mandatory && !mandatoryIds.has(b.id));

      for (const block of optBlocks) {
        this.blockChecked[cfgId][block.id] = newState;
        if (newState) {
          this.autoCheckDependencies(cfg, block.id);
        } else {
          this.autoClearDependents(cfg, block.id);
        }
      }
      this.updateDependencyWarnings(cfg);
    }
  }

  get canGenerate(): boolean {
    if (this.selectedConfigs.length === 0) return false;
    if (this.messageCountError || this.messageCount < 1) return false;

    for (const cfg of this.selectedConfigs) {
      if ((this.dependencyWarnings[cfg.id]?.length || 0) > 0) return false;
      if (this.getSelectedBlocks(cfg.id).length === 0) return false;
    }

    return true;
  }

  // ── Generation ─────────────────────────────────────────────────────────────

  scrollToLoading() {
    this.loadingSection?.nativeElement?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  scrollToResults() {
    this.resultsSection?.nativeElement?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  async generate() {
    if (!this.canGenerate) return;

    this.isGenerating = true;
    this.generatedMessages = [];
    this.generationStats = { requested: 0, produced: 0, totalAttempts: 0 };

    const totalRequested = this.messageCount * this.selectedConfigs.length;
    this.generationStats.requested = totalRequested;

    // Scroll to loading section
    setTimeout(() => this.scrollToLoading(), 50);

    let globalIndex = 1;
    let hasError = false;

    for (const cfg of this.selectedConfigs) {
      const payload = {
        message_type: cfg.bulkId,
        count: this.messageCount,
        selected_blocks: this.getSelectedBlocks(cfg.id)
      };

      try {
        const res = await this.http.post<any>(this.config.getApiUrl('/bulk-generate'), payload).toPromise();
        
        const msgs = res.messages || [];
        msgs.forEach((m: any) => {
          m.index = globalIndex++;
          this.generatedMessages.push(m);
        });

        this.generationStats.produced += (res.count || 0);
        this.generationStats.totalAttempts += (res.total_attempts || 0);

      } catch (err: any) {
        hasError = true;
        const detail = typeof err?.error?.detail === 'string'
          ? err.error.detail
          : err?.error?.detail?.message || err?.message || `Generation failed for ${cfg.label}.`;
        
        // Add a visible error entry so the user can see which type failed
        this.generatedMessages.push({
          index: globalIndex++,
          xml: `<!-- Generation failed: ${detail} -->`,
          message_type: cfg.bulkId,
          status: 'error',
          error: detail
        });

        this.snackBar.open(`⚠️ ${cfg.label}: ${detail}`, 'Close', {
          duration: 6000,
          horizontalPosition: 'center',
          verticalPosition: 'bottom'
        });
        continue; // Continue with next message type instead of stopping
      }
    }

    // Group the messages by message type
    const groupMap = new Map<string, GroupedMessage>();
    for (const msg of this.generatedMessages) {
      if (!groupMap.has(msg.message_type)) {
        groupMap.set(msg.message_type, {
          message_type: msg.message_type,
          messages: [],
          status: 'VALIDATED',
          expanded: false,
          activeMessageIndex: 0
        });
      }
      const group = groupMap.get(msg.message_type)!;
      group.messages.push(msg);
      if (msg.status === 'error') {
        group.status = 'ERROR';
      }
    }
    this.groupedMessages = Array.from(groupMap.values());

    this.isGenerating = false;
    this.expandedIndex = null;

    if (!hasError || this.generatedMessages.length > 0) {
      this.view = 'results';
      // Scroll to results
      setTimeout(() => this.scrollToResults(), 100);
      this.snackBar.open(
        `✅ Generated ${this.generatedMessages.length} valid messages successfully.`,
        'Close',
        { duration: 4000, horizontalPosition: 'center', verticalPosition: 'bottom' }
      );
    }
  }

  // ── Results Actions ────────────────────────────────────────────────────────

  toggleExpand(idx: number) {
    this.expandedIndex = this.expandedIndex === idx ? null : idx;
  }

  copyXml(msg: GeneratedMessage) {
    navigator.clipboard.writeText(msg.xml).then(() => {
      this.snackBar.open(`Message #${msg.index} copied to clipboard.`, 'Close', { duration: 2500 });
    });
  }

  downloadXml(msg: GeneratedMessage) {
    const blob = new Blob([msg.xml], { type: 'application/xml' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    const cfg = this.getConfigForMessage(msg.message_type);
    a.download = `${cfg?.id || 'message'}-${String(msg.index).padStart(4, '0')}.xml`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  async downloadAll() {
    const combined = this.generatedMessages
      .map(m => {
        // Remove XML declaration and trim
        let xml = m.xml.replace(/<\?xml.*\?>/g, '').trim();
        // Indent each line for better readability in the bulk file
        return xml.split('\n').map(line => '  ' + line).join('\n');
      })
      .join('\n\n');
    
    const finalXml = `<?xml version="1.0" encoding="UTF-8"?>\n<BulkMessages>\n${combined}\n</BulkMessages>`;
    
    const blob = new Blob([finalXml], { type: 'application/xml' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    const msgId = this.selectedConfigs.length === 1 ? this.selectedConfigs[0].id : 'bulk';
    a.download = `${msgId}-${this.generatedMessages.length}-combined.xml`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  async downloadZip() {
    const zip = new JSZip();
    const msgId = this.selectedConfigs.length === 1 ? this.selectedConfigs[0].id : 'bulk';
    this.generatedMessages.forEach(m => {
      const cfg = this.selectedConfigs.find(c => c.bulkId === m.message_type) || this.selectedConfigs[0];
      const filename = `${cfg.id}-${String(m.index).padStart(4, '0')}.xml`;
      zip.file(filename, m.xml);
    });
    const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${msgId}-${this.generatedMessages.length}-messages.zip`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  async downloadGroupZip(group: GroupedMessage) {
    const zip = new JSZip();
    const cfg = this.selectedConfigs.find(c => c.bulkId === group.message_type) || { id: group.message_type };
    
    group.messages.forEach((m, idx) => {
      const filename = `${cfg.id}-${String(idx + 1).padStart(4, '0')}.xml`;
      zip.file(filename, m.xml);
    });

    const blob = await zip.generateAsync({ type: 'blob' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${cfg.id}-${group.messages.length}-messages.zip`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  downloadGroupCombined(group: GroupedMessage) {
    const combined = group.messages
      .map(m => m.xml.replace(/<\?xml[^>]*\?>/gi, '').trim())
      .join('\n\n');
    
    const finalXml = `<?xml version="1.0" encoding="UTF-8"?>\n<BulkMessages>\n${combined}\n</BulkMessages>`;
    
    const cfg = this.selectedConfigs.find(c => c.bulkId === group.message_type) || { id: group.message_type };
    const blob = new Blob([finalXml], { type: 'application/xml' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${cfg.id}-${group.messages.length}-combined.xml`;
    a.click();
    URL.revokeObjectURL(a.href);
  }


  backToConfig() {
    this.view = 'config';
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  isMsgValid(m: any): boolean {
    return m.status === 'VALID' || m.status === 'success';
  }

  regenerate() {
    this.generate();
  }

  // ── Helpers ────────────────────────────────────────────────────────────────
  
  getConfigForMessage(msgType: string): MessageTypeConfig | undefined {
    let match = this.selectedConfigs.find(c => c.bulkId === msgType || c.id === msgType);
    if (match) return match;

    // Handle case where backend returns e.g., 'pacs.008.001.08' but config has bulkId 'pacs.008'
    // Sort to ensure more specific bulkIds (like pacs.009.adv) are checked before pacs.009
    const sortedConfigs = [...this.selectedConfigs].sort((a, b) => b.bulkId.length - a.bulkId.length);
    return sortedConfigs.find(c => msgType.startsWith(c.bulkId));
  }

  getFamilyClass(family: string): string {
    return family.toLowerCase();
  }

  getLineCount(xml: string): number {
    return xml.split('\n').length;
  }

  trackByIndex(_i: number, msg: GeneratedMessage) {
    return msg.index;
  }
}
