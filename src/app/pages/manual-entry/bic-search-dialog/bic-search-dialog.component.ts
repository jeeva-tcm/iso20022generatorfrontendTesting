import { Component, Inject, ViewEncapsulation } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatDialogModule, MatDialogRef, MAT_DIALOG_DATA } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { BicSearchService, BicRecord } from '../../../services/bic-search.service';

@Component({
  selector: 'app-bic-search-dialog',
  standalone: true,
  imports: [CommonModule, FormsModule, MatDialogModule, MatIconModule, MatProgressSpinnerModule],
  encapsulation: ViewEncapsulation.None,
  template: `
    <div class="bic-search-container">
        <h2 mat-dialog-title class="dialog-title">
            <mat-icon>account_balance</mat-icon>
            Global BIC Directory
            <button class="close-btn" (click)="close()"><mat-icon>close</mat-icon></button>
        </h2>

        <mat-dialog-content class="dialog-content">
            <div class="search-input-wrapper">
                <mat-icon class="search-icon">search</mat-icon>
                <input 
                    type="text" 
                    [(ngModel)]="searchQuery" 
                    (ngModelChange)="onSearch()" 
                    placeholder="Search by Bank Name or BIC..."
                    class="search-input"
                    autofocus>
                <mat-spinner *ngIf="loading" [diameter]="20" class="search-spinner"></mat-spinner>
            </div>

            <div class="results-scroller">
                <!-- Empty State -->
                <div *ngIf="!searchQuery && !loading" class="placeholder-state">
                    <mat-icon class="large-icon">search</mat-icon>
                    <p>Start typing to search thousands of Financial Institutions</p>
                    <span class="hint">Type at least 2 characters</span>
                </div>

                <!-- No Results -->
                <div *ngIf="searchQuery && results.length === 0 && !loading" class="placeholder-state">
                    <mat-icon class="large-icon">error_outline</mat-icon>
                    <p>No matches found for "{{searchQuery}}"</p>
                    <button class="clear-btn" (click)="searchQuery=''; results=[]">Clear search</button>
                </div>

                <!-- List Output -->
                <div class="bic-list" *ngIf="results.length > 0">
                    <div class="bic-item" *ngFor="let item of results" (click)="select(item)">
                        <div class="country-badge">{{item.country}}</div>
                        <div class="bic-main">
                            <div class="bank-name">{{item.name}}</div>
                            <div class="bank-addr">{{item.address}}</div>
                        </div>
                        <div class="bic-code">
                            <code>{{item.bic}}</code>
                        </div>
                    </div>
                </div>
            </div>
        </mat-dialog-content>
    </div>
  `,
  styles: [`
    .bic-search-container {
        display: flex;
        flex-direction: column;
        max-height: 90vh;
        width: 100%;
        color: var(--text-main);
    }

    .bic-search-container .dialog-title {
        display: flex;
        align-items: center;
        gap: 12px;
        margin: 0;
        padding: 20px 24px 16px;
        border-bottom: 1px solid var(--border-light);
        font-weight: 600;
        position: relative;
        color: var(--text-main) !important;
        font-size: 1.25rem;
    }

    .bic-search-container .close-btn {
        position: absolute;
        right: 20px;
        top: 20px;
        background: transparent;
        border: none;
        cursor: pointer;
        color: var(--text-muted);
        padding: 6px;
        border-radius: 50%;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: all 0.2s;
    }

    .bic-search-container .close-btn:hover {
        background: var(--bg-card-hover);
        color: #ef4444;
    }

    .bic-search-container .dialog-content {
        padding: 0 24px 24px !important;
        display: flex;
        flex-direction: column;
        overflow: hidden;
        background: transparent !important;
    }

    .bic-search-container .search-input-wrapper {
        position: sticky;
        top: 0;
        z-index: 10;
        background: var(--bg-card) !important;
        margin-bottom: 16px;
        padding: 16px 0;
        display: flex;
        align-items: center;
        border-bottom: 1px solid var(--border-light);
    }

    .bic-search-container .search-icon {
        position: absolute;
        left: 14px;
        color: var(--text-muted);
        z-index: 11;
    }

    .bic-search-container input.search-input {
        width: 100%;
        padding: 12px 16px 12px 46px !important;
        border: 1px solid var(--border-light) !important;
        border-radius: 10px !important;
        font-size: 0.95rem;
        outline: none;
        transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
        background: var(--bg-app) !important;
        color: var(--text-main) !important;
    }

    .bic-search-container input.search-input:focus {
        border-color: var(--accent-color) !important;
        box-shadow: 0 0 0 3px var(--accent-light) !important;
    }

    .bic-search-container .search-spinner {
        position: absolute;
        right: 14px;
        z-index: 11;
    }

    .bic-search-container .results-scroller {
        flex: 1;
        overflow-y: auto;
        min-height: 380px;
        max-height: 520px;
        padding-right: 4px;
    }

    .bic-search-container .results-scroller::-webkit-scrollbar {
        display: block !important;
        width: 6px !important;
    }

    .bic-search-container .results-scroller::-webkit-scrollbar-track {
        background: transparent !important;
    }

    .bic-search-container .results-scroller::-webkit-scrollbar-thumb {
        background: var(--border-light) !important;
        border-radius: 3px !important;
    }

    .bic-search-container .results-scroller::-webkit-scrollbar-thumb:hover {
        background: var(--text-muted) !important;
    }

    .bic-search-container .placeholder-state {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        height: 380px;
        text-align: center;
        color: var(--text-muted) !important;
        animation: bicFadeIn 0.3s ease-out;
    }

    .bic-search-container .large-icon {
        font-size: 48px;
        width: 48px;
        height: 48px;
        margin-bottom: 16px;
        color: var(--accent-color) !important;
        opacity: 0.8;
    }

    .bic-search-container .placeholder-state p {
        font-size: 1rem;
        font-weight: 500;
        margin: 0;
        color: var(--text-main) !important;
    }

    .bic-search-container .hint {
        font-size: 0.8rem;
        color: var(--text-muted) !important;
        margin-top: 6px;
        opacity: 0.8;
    }

    .bic-search-container .clear-btn {
        margin-top: 16px;
        background: var(--accent-light) !important;
        border: none;
        padding: 8px 16px;
        border-radius: 6px;
        color: var(--accent-text) !important;
        font-weight: 600;
        cursor: pointer;
        transition: all 0.2s;
    }

    .bic-search-container .clear-btn:hover {
        background: var(--border-light) !important;
    }

    .bic-search-container .bic-list {
        display: flex;
        flex-direction: column;
        gap: 10px;
        padding-top: 4px;
        padding-bottom: 8px;
    }

    .bic-search-container .bic-item {
        display: flex;
        align-items: center;
        padding: 14px 16px;
        background: rgba(255, 255, 255, 0.02) !important;
        border: 1px solid var(--border-light) !important;
        border-radius: 12px !important;
        cursor: pointer;
        transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1) !important;
    }

    .bic-search-container .bic-item:hover {
        border-color: var(--accent-color) !important;
        background: rgba(59, 130, 246, 0.06) !important;
        transform: translateY(-2px);
        box-shadow: 0 6px 20px rgba(0, 0, 0, 0.4) !important;
    }

    body.light-theme .bic-search-container .bic-item {
        background: rgba(0, 0, 0, 0.01) !important;
    }

    body.light-theme .bic-search-container .bic-item:hover {
        background: rgba(37, 99, 235, 0.03) !important;
        box-shadow: 0 6px 20px rgba(0, 0, 0, 0.05) !important;
    }

    .bic-search-container .country-badge {
        width: 40px;
        height: 40px;
        background: var(--accent-light) !important;
        color: var(--accent-text) !important;
        display: flex;
        align-items: center;
        justify-content: center;
        border-radius: 8px;
        font-weight: 700;
        font-size: 0.85rem;
        flex-shrink: 0;
        margin-right: 16px;
        border: 1px solid rgba(59, 130, 246, 0.2) !important;
    }

    body.light-theme .bic-search-container .country-badge {
        border-color: rgba(37, 99, 235, 0.15) !important;
    }

    .bic-search-container .bic-main {
        flex: 1;
        overflow: hidden;
    }

    .bic-search-container .bank-name {
        font-weight: 600 !important;
        font-size: 0.95rem !important;
        color: var(--text-main) !important;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        line-height: 1.4 !important;
    }

    .bic-search-container .bank-addr {
        font-size: 0.8rem !important;
        color: var(--text-muted) !important;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        margin-top: 4px;
        opacity: 0.85;
        line-height: 1.3 !important;
    }

    .bic-search-container .bic-code code {
        background: var(--bg-card) !important;
        border: 1px solid var(--border-light) !important;
        padding: 6px 14px;
        border-radius: 6px;
        font-family: 'JetBrains Mono', monospace;
        font-weight: 600;
        color: var(--accent-text) !important;
        font-size: 0.85rem;
        letter-spacing: 0.5px;
        transition: all 0.2s;
    }

    .bic-search-container .bic-item:hover .bic-code code {
        background: var(--accent-color) !important;
        color: #ffffff !important;
        border-color: var(--accent-color) !important;
    }

    @keyframes bicFadeIn {
        from { opacity: 0; transform: translateY(8px); }
        to   { opacity: 1; transform: translateY(0); }
    }
  `]
})
export class BicSearchDialogComponent {
  searchQuery = '';
  results: BicRecord[] = [];
  loading = false;
  private searchTimeout: any;

  constructor(
    private bicSearch: BicSearchService,
    private dialogRef: MatDialogRef<BicSearchDialogComponent>,
    @Inject(MAT_DIALOG_DATA) public data: any
  ) {}

  onSearch() {
    clearTimeout(this.searchTimeout);
    if (!this.searchQuery || this.searchQuery.length < 2) {
      this.results = [];
      this.loading = false;
      return;
    }

    this.loading = true;
    this.searchTimeout = setTimeout(() => {
      this.bicSearch.search(this.searchQuery).subscribe((res: BicRecord[]) => {
        this.results = res;
        this.loading = false;
      });
    }, 300);
  }

  select(record: BicRecord) {
    this.dialogRef.close(record);
  }

  close() {
    this.dialogRef.close();
  }
}
