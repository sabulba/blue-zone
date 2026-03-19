import { ChangeDetectorRef, Component, inject, OnDestroy, OnInit } from '@angular/core';
import { Subscription } from 'rxjs';
import { GameState, Shot } from '../../core/models/game.model';
import { FirebaseGameService } from '../../core/services/firebase-game.service';
import { PhysicsService, ScoreResult } from '../../core/services/physics.service';
import { ArenaComponent, ShotResult } from './arena/arena.component';

@Component({
    selector: 'app-game',
    standalone: true,
    imports: [ArenaComponent],
    templateUrl: './game.component.html',
    styleUrl: './game.component.scss',
})
export class GameComponent implements OnInit, OnDestroy {
    private firebaseGame = inject(FirebaseGameService);
    private physicsSvc   = inject(PhysicsService);
    private cdr          = inject(ChangeDetectorRef);

    game: GameState | null = null;
    statusMessage = '';
    private sub!: Subscription;

    ngOnInit(): void {
        this.sub = this.firebaseGame.state$.subscribe((s) => {
            this.game = s;
            this.cdr.markForCheck();
        });
        this.firebaseGame.createGame()
            .then((id) => console.log('[Game] started, gameId:', id))
            .catch((err) => console.error('[Game] createGame failed:', err));
    }

    ngOnDestroy(): void {
        this.sub?.unsubscribe();
    }

    // ── Identity ───────────────────────────────────────────────────────────────
    // Fixed per device — comes from the service (URL ?player=2 for Phone B).

    get myUid(): string {
        return this.firebaseGame.myUid;
    }

    get isMyTurn(): boolean {
        return !!this.game
            && this.game.phase === 'PLAYING'
            && this.game.activePlayerUid === this.myUid;
    }

    // ── Delegated from ArenaComponent ─────────────────────────────────────────

    onShotFired(shot: Shot): void {
        // Write the shot to Firestore — Phone B's onSnapshot picks it up
        // and replays the same physics locally to animate the result.
        this.firebaseGame.submitShot(shot);
    }

    onSimulationDone({ simResult, shot }: ShotResult): void {
        if (!this.game) return;

        const score = this.physicsSvc.evaluateScore(simResult);
        this.showShotFeedback(score, shot.shooterUid);

        // Only the shooter's device writes results to Firestore.
        // The opponent's device just replays the animation locally.
        if (shot.shooterUid === this.myUid) {
            console.log('[onSimulationDone] shooterUid:', shot.shooterUid, 'writing to Firestore');
            this.firebaseGame.updateAfterShot(score, simResult.ballPositions, shot.shooterUid);
        }
    }

    // ── Game lifecycle ─────────────────────────────────────────────────────────

    async newGame(): Promise<void> {
        const gameId = await this.firebaseGame.createGame();
        console.log('Game created:', gameId); // share this with Phone B
    }

    joinGame(gameId: string): void {
        this.firebaseGame.joinGame(gameId);
    }

    async resetGame(): Promise<void> {
        await this.firebaseGame.reset();
    }

    // ── Helpers ────────────────────────────────────────────────────────────────

    getPlayerList(): Array<{
        uid: string;
        name: string;
        color: string;
        score: number;
        isActive: boolean;
        isMe: boolean;
    }> {
        if (!this.game) return [];
        return this.game.playerOrder.map((uid) => {
            const p = this.game!.players[uid];
            return {
                uid,
                name:     p?.displayName ?? '?',
                color:    p?.color ?? '#888',
                score:    p?.score ?? 0,
                isActive: uid === this.game!.activePlayerUid,
                isMe:     uid === this.myUid,
            };
        });
    }

    get winner(): string | null {
        if (!this.game || this.game.phase !== 'ENDED') return null;
        return this.game.players[this.game.activePlayerUid]?.displayName ?? null;
    }

    get myName(): string {
        return this.game?.players[this.myUid]?.displayName ?? '';
    }

    get activeName(): string {
        if (!this.game) return '';
        return this.game.players[this.game.activePlayerUid]?.displayName ?? '';
    }

    // ── Feedback ───────────────────────────────────────────────────────────────

    private showShotFeedback(score: ScoreResult, shooterUid: string): void {
        if (!this.game) return;

        const opponentUid  = this.game.playerOrder.find((uid) => uid !== shooterUid)!;
        const activeName   = this.game.players[shooterUid]?.displayName  ?? 'Shooter';
        const opponentName = this.game.players[opponentUid]?.displayName ?? 'Opponent';

        const parts: string[] = [];
        if (score.activePoints   > 0) parts.push(`${activeName} +${score.activePoints}`);
        if (score.opponentPoints > 0) parts.push(`${opponentName} +${score.opponentPoints}`);
        if (parts.length === 0)       parts.push('No score change');

        this.statusMessage = parts.join('  ·  ');
        setTimeout(() => (this.statusMessage = ''), 2500);
    }
}