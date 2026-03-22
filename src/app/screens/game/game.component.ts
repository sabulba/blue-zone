import { ChangeDetectorRef, Component, inject, OnDestroy, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import { Subscription } from 'rxjs';
import { GameState, Shot } from '../../core/models/game.model';
import { FirebaseGameService } from '../../core/services/firebase-game.service';
import { AuthService } from '../../core/services/auth.service';
import { PhysicsService, ScoreResult } from '../../core/services/physics.service';
import { ArenaComponent, ShotResult } from './arena/arena.component';

@Component({
    selector: 'app-game',
    standalone: true,
    imports: [CommonModule, ArenaComponent],
    templateUrl: './game.component.html',
    styleUrl: './game.component.scss',
})
export class GameComponent implements OnInit, OnDestroy {
    private svc        = inject(FirebaseGameService);
    private authSvc    = inject(AuthService);
    private physicsSvc = inject(PhysicsService);
    private cdr        = inject(ChangeDetectorRef);
    private router     = inject(Router);

    game: GameState | null = null;
    statusMessage = '';
    showRules     = false;
    private sub!: Subscription;

    ngOnInit(): void {
        this.sub = this.svc.state$.subscribe(s => {
            this.game = s;
            this.cdr.markForCheck();
        });
        this.svc.init().catch(console.error);
    }

    ngOnDestroy(): void { this.sub?.unsubscribe(); }

    // ── Identity ───────────────────────────────────────────────────────────────
    get myUid():    string  { return this.svc.myUid; }


    // ── Arena events ───────────────────────────────────────────────────────────
    onShotFired(shot: Shot): void {
        this.svc.submitShot(shot);
    }

    onSimulationDone({ simResult, shot }: ShotResult): void {
        if (!this.game) return;
        const score = this.physicsSvc.evaluateScore(simResult);
        this.showFeedback(score, shot.shooterUid);
        this.svc.updateAfterShot(score, simResult.ballPositions, shot.shooterUid);
    }

    // ── Actions ────────────────────────────────────────────────────────────────
    async newGame(): Promise<void>   { await this.svc.reset(); }
    async signOut(): Promise<void> {
        localStorage.removeItem('bluezone_slot');
        await this.authSvc.signOut();
        this.router.navigate(['/auth']);
    }

    // ── Helpers ────────────────────────────────────────────────────────────────
    getPlayerList() {
        if (!this.game) return [];
        return this.game.playerOrder.map(uid => {
            const p = this.game!.players[uid];
            return {
                uid,
                name:     p?.displayName ?? '?',
                color:    p?.color       ?? '#888',
                score:    p?.score       ?? 0,
                isActive: uid === this.game!.activePlayerUid,
                isMe:     uid === this.myUid,
            };
        });
    }

    get winner(): string | null {
        if (!this.game || this.game.phase !== 'ENDED') return null;
        return this.game.players[this.game.activePlayerUid]?.displayName ?? null;
    }

    get activeName(): string {
        if (!this.game) return '';
        return this.game.players[this.game.activePlayerUid]?.displayName ?? '';
    }

    private showFeedback(score: ScoreResult, shooterUid: string): void {
        if (!this.game) return;
        const oppUid   = this.game.playerOrder.find(u => u !== shooterUid)!;
        const me       = this.game.players[shooterUid]?.displayName ?? 'Shooter';
        const opp      = this.game.players[oppUid]?.displayName     ?? 'Opponent';
        const parts: string[] = [];
        if (score.activePoints   > 0) parts.push(`${me} +${score.activePoints}`);
        if (score.opponentPoints > 0) parts.push(`${opp} +${score.opponentPoints}`);
        this.statusMessage = parts.length ? parts.join('  ·  ') : 'No score change';
        setTimeout(() => (this.statusMessage = ''), 2500);
    }
}