import { Component, Inject } from '@angular/core';
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
        color: #1e293b;
    }

    .dialog-title {
        display: flex;
        align-items: center;
        gap: 12px;
        margin: 0;
        padding-bottom: 16px;
        border-bottom: 1px solid #e2e8f0;
        font-weight: 600;
        position: relative;
    }

    .close-btn {
        position: absolute;
        right: 0;
        top: 0;
        background: transparent;
        border: none;
        cursor: pointer;
        color: #64748b;
        padding: 8px;
        border-radius: 50%;
        display: flex;
    }

    .close-btn:hover {
        background: #f1f5f9;
        color: #ef4444;
    }

    .dialog-content {
        padding-top: 20px !important;
        display: flex;
        flex-direction: column;
        overflow: hidden;
    }

    .search-input-wrapper {
        position: relative;
        margin-bottom: 20px;
        display: flex;
        align-items: center;
    }

    .search-icon {
        position: absolute;
        left: 12px;
        color: #94a3b8;
    }

    div.search-input-wrapper input.search-input {
        width: 100%;
        padding: 12px 12px 12px 42px !important;
        border: 2px solid #e2e8f0;
        border-radius: 8px;
        font-size: 1rem;
        outline: none;
        transition: all 0.2s;
        background: #f8fafc;
    }

    .search-input:focus {
        border-color: #3b82f6;
        background: #fff;
        box-shadow: 0 0 0 4px rgba(59, 130, 246, 0.1);
    }

    .search-spinner {
        position: absolute;
        right: 12px;
    }

    .results-scroller {
        flex: 1;
        overflow-y: auto;
        min-height: 350px;
        max-height: 500px;
        padding-right: 4px;
    }

    .placeholder-state {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        height: 350px;
        text-align: center;
        color: #94a3b8;
    }

    .large-icon {
        font-size: 64px;
        width: 64px;
        height: 64px;
        margin-bottom: 16px;
        opacity: 0.3;
    }

    .hint {
        font-size: 0.8rem;
        margin-top: 4px;
    }

    .clear-btn {
        margin-top: 16px;
        background: #f1f5f9;
        border: none;
        padding: 6px 12px;
        border-radius: 4px;
        color: #3b82f6;
        font-weight: 500;
        cursor: pointer;
    }

    .bic-list {
        display: flex;
        flex-direction: column;
        gap: 8px;
    }

    .bic-item {
        display: flex;
        align-items: center;
        padding: 12px;
        background: #fff;
        border: 1px solid #e2e8f0;
        border-radius: 8px;
        cursor: pointer;
        transition: all 0.2s;
    }

    .bic-item:hover {
        border-color: #3b82f6;
        transform: translateY(-1px);
        box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);
    }

    .country-badge {
        width: 32px;
        height: 32px;
        background: #eff6ff;
        color: #3b82f6;
        display: flex;
        align-items: center;
        justify-content: center;
        border-radius: 6px;
        font-weight: 700;
        font-size: 0.75rem;
        flex-shrink: 0;
        margin-right: 12px;
    }

    .bic-main {
        flex: 1;
        overflow: hidden;
    }

    .bank-name {
        font-weight: 600;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        font-size: 0.95rem;
    }

    .bank-addr {
        font-size: 0.8rem;
        color: #64748b;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        margin-top: 2px;
    }

    .bic-code code {
        background: #f1f5f9;
        padding: 4px 8px;
        border-radius: 4px;
        font-family: 'JetBrains Mono', monospace;
        font-weight: 700;
        color: #0f172a;
        font-size: 0.9rem;
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
