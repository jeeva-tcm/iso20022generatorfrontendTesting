import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatCardModule } from '@angular/material/card';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { RouterModule } from '@angular/router';
import { HttpClient } from '@angular/common/http';
import { ConfigService } from '../../services/config.service';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';

@Component({
    selector: 'app-dashboard',
    standalone: true,
    imports: [CommonModule, MatCardModule, MatButtonModule, MatIconModule, RouterModule, MatSnackBarModule],
    templateUrl: './dashboard.component.html',
    styleUrls: ['./dashboard.component.css']
})
export class DashboardComponent implements OnInit {
    stats = { total: 0, passed: 0, failed: 0, efficiency: '0%' };
    recentActivity: any[] = [];

    // SVG ring: radius 33 inside 80×80 viewBox
    readonly ringCircumference = 2 * Math.PI * 33;

    constructor(
        private http: HttpClient,
        private config: ConfigService,
        private snackBar: MatSnackBar
    ) {}

    ngOnInit() {
        this.loadStats();
        this.loadRecentActivity();
    }

    get passRateNum(): number {
        if (this.stats.total === 0) return 0;
        return Math.round((this.stats.passed / this.stats.total) * 100);
    }

    get ringDashOffset(): number {
        return this.ringCircumference * (1 - this.passRateNum / 100);
    }

    getMsgClass(messageType: string): string {
        if (!messageType) return 'other';
        const t = messageType.toLowerCase();
        if (t.startsWith('pacs')) return 'pacs';
        if (t.startsWith('camt')) return 'camt';
        if (t.startsWith('pain')) return 'pain';
        if (t.startsWith('head')) return 'head';
        return 'other';
    }

    isRefreshing = false;

    loadStats() {
        this.http.get<any>(this.config.getApiUrl('/dashboard/stats')).subscribe({
            next: (data) => {
                this.stats.total = data.total_audits;
                this.stats.passed = data.passed_messages;
                this.stats.failed = data.failed_messages;
                this.stats.efficiency = data.validation_quality + '%';
            },
            error: (err) => console.error('Dashboard stats error:', err)
        });
    }

    loadRecentActivity() {
        this.http.get<any[]>(this.config.getApiUrl('/history?limit=5')).subscribe({
            next: (data) => { this.recentActivity = data; },
            error: (err) => console.error('Dashboard activity error:', err)
        });
    }

    refresh() {
        if (this.isRefreshing) return;
        this.isRefreshing = true;

        this.snackBar.open('Reloading dashboard data...', '', { duration: 1000 });

        let completed = 0;
        const checkDone = () => {
            completed++;
            if (completed === 2) {
                setTimeout(() => {
                    this.isRefreshing = false;
                    this.snackBar.open('Dashboard updated successfully.', 'Close', { duration: 2500 });
                }, 800);
            }
        };

        this.http.get<any>(this.config.getApiUrl('/dashboard/stats')).subscribe({
            next: (data) => {
                this.stats.total = data.total_audits;
                this.stats.passed = data.passed_messages;
                this.stats.failed = data.failed_messages;
                this.stats.efficiency = data.validation_quality + '%';
                checkDone();
            },
            error: (err) => {
                console.error('Dashboard stats error:', err);
                checkDone();
            }
        });

        this.http.get<any[]>(this.config.getApiUrl('/history?limit=5')).subscribe({
            next: (data) => {
                this.recentActivity = data;
                checkDone();
            },
            error: (err) => {
                console.error('Dashboard activity error:', err);
                checkDone();
            }
        });
    }
}
