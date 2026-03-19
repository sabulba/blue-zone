import { Injectable, OnDestroy, inject, Injector, NgZone, runInInjectionContext } from '@angular/core';
import {
    Firestore,
    doc,
    getDoc,
    setDoc,
    onSnapshot,
    updateDoc,
    DocumentSnapshot,
} from '@angular/fire/firestore';
import { BehaviorSubject, Observable } from 'rxjs';
import { BallPositions, GameState, PlayerData, Shot } from '../models/game.model';
import { ARENA, ScoreResult } from './physics.service';

// ── Constants ─────────────────────────────────────────────────────────────────

const WIN_SCORE = 21;

// Hardcoded players — no auth/lobby needed for now.
// Phone A always plays as player_1, Phone B as player_2.
const PLAYER_1: PlayerData = { uid: 'player_1', displayName: 'Player 1', color: '#3498db', score: 0 };
const PLAYER_2: PlayerData = { uid: 'player_2', displayName: 'Player 2', color: '#e74c3c', score: 0 };

function defaultBallPositions(): BallPositions {
    return {
        [PLAYER_1.uid]: { ...ARENA.BALL_START_P1 },
        [PLAYER_2.uid]: { ...ARENA.BALL_START_P2 },
        white: { ...ARENA.BALL_START_WHITE },
    };
}

// ── Service ───────────────────────────────────────────────────────────────────

@Injectable({ providedIn: 'root' })
export class FirebaseGameService implements OnDestroy {
    private firestore = inject(Firestore);
    private injector  = inject(Injector);
    private zone      = inject(NgZone);

    private _state$ = new BehaviorSubject<GameState | null>(null);
    readonly state$: Observable<GameState | null> = this._state$.asObservable();

    // Fixed per-device identity.
    // Phone A (default):  open normally           → player_1
    // Phone B:            open with ?player=2     → player_2
    readonly myUid: string = new URLSearchParams(window.location.search).get('player') === '2'
        ? PLAYER_2.uid
        : PLAYER_1.uid;

    private gameId: string | null = null;
    private unsubscribeSnapshot: (() => void) | null = null;

    get state(): GameState | null { return this._state$.value; }

    // ── Create or join the shared game ───────────────────────────────────────
    // Uses a fixed well-known gameId so both phones always share the same doc
    // without any invite/lobby flow. If the doc doesn't exist yet, creates it.
    // If it already exists (other phone already started it), just subscribes.
    async createGame(): Promise<string> {
        const SHARED_GAME_ID = 'shared-game';
        this.gameId = SHARED_GAME_ID;

        return runInInjectionContext(this.injector, async () => {
            const gameRef = doc(this.firestore, 'games', SHARED_GAME_ID);
            const snap = await getDoc(gameRef);

            // Emit immediately from getDoc so the loading screen
            // disappears without waiting for the first onSnapshot round-trip.
            if (snap.exists()) {
                this.zone.run(() => this._state$.next(snap.data() as GameState));
            }

            if (!snap.exists()) {
                const initialState: GameState = {
                    gameId: SHARED_GAME_ID,
                    createdAt: Date.now(),
                    phase: 'PLAYING',
                    activePlayerUid: PLAYER_1.uid,
                    playerOrder: [PLAYER_1.uid, PLAYER_2.uid],
                    players: {
                        [PLAYER_1.uid]: { ...PLAYER_1 },
                        [PLAYER_2.uid]: { ...PLAYER_2 },
                    },
                    lastShot: null,
                    ballPositions: defaultBallPositions(),
                };
                await setDoc(gameRef, initialState);
                this.zone.run(() => this._state$.next(initialState));
            }

            this._watchGame(SHARED_GAME_ID);
            return SHARED_GAME_ID;
        });
    }

    // ── Join existing game ─────────────────────────────────────────────────────
    // Called when Phone B opens the app with a known gameId.
    // No write needed — players are already in the doc from createGame().
    joinGame(gameId: string): void {
        this.gameId = gameId;
        this._watchGame(gameId);
    }

    // ── Reset ──────────────────────────────────────────────────────────────────
    // Overwrites the shared doc with a fresh initial state.
    async reset(): Promise<string> {
        this._stopWatching();
        const SHARED_GAME_ID = 'shared-game';
        this.gameId = SHARED_GAME_ID;
        return runInInjectionContext(this.injector, async () => {
            const gameRef = doc(this.firestore, 'games', SHARED_GAME_ID);
            const freshState: GameState = {
                gameId: SHARED_GAME_ID,
                createdAt: Date.now(),
                phase: 'PLAYING',
                activePlayerUid: PLAYER_1.uid,
                playerOrder: [PLAYER_1.uid, PLAYER_2.uid],
                players: {
                    [PLAYER_1.uid]: { ...PLAYER_1 },
                    [PLAYER_2.uid]: { ...PLAYER_2 },
                },
                lastShot: null,
                ballPositions: defaultBallPositions(),
            };
            await setDoc(gameRef, freshState);
            // Emit immediately — don't wait for onSnapshot round-trip
            this.zone.run(() => this._state$.next(freshState));
            this._watchGame(SHARED_GAME_ID);
            return SHARED_GAME_ID;
        });
    }

    // ── submitShot ─────────────────────────────────────────────────────────────
    // Active player writes their shot to Firestore.
    // Phone B's onSnapshot fires and it replays the same shot locally.
    async submitShot(shot: Shot): Promise<void> {
        if (!this.gameId) return;
        await runInInjectionContext(this.injector, async () => {
            await updateDoc(doc(this.firestore, 'games', this.gameId!), { lastShot: shot });
        });
    }

    // ── updateAfterShot ────────────────────────────────────────────────────────
    // Called ONLY by the active player after their local physics simulation ends.
    // Writes the final ball positions, updated scores, and next active player.
    // Phone B reads this via onSnapshot and updates its own state — it never
    // calls this method itself.
    async updateAfterShot(score: ScoreResult, newBallPositions: BallPositions, shooterUid?: string): Promise<void> {
        if (!this.gameId || !this._state$.value) return;

        const game = this._state$.value;
        // Use shooterUid when provided — activePlayerUid in state may have already
        // been updated by a snapshot that arrived during the physics simulation.
        const activeUid = shooterUid ?? game.activePlayerUid;
        const opponentUid = game.playerOrder.find((uid) => uid !== activeUid)!;
        console.log('[updateAfterShot] activeUid:', activeUid, '→ next:', opponentUid);

        const newActiveScore   = (game.players[activeUid]?.score   ?? 0) + score.activePoints;
        const newOpponentScore = (game.players[opponentUid]?.score ?? 0) + score.opponentPoints;

        const isGameOver = newActiveScore >= WIN_SCORE || newOpponentScore >= WIN_SCORE;
        const winnerUid  = newActiveScore >= WIN_SCORE ? activeUid : opponentUid;

        await runInInjectionContext(this.injector, async () => {
            await updateDoc(doc(this.firestore, 'games', this.gameId!), {
                ballPositions: newBallPositions,
                players: {
                    ...game.players,
                    [activeUid]:   { ...game.players[activeUid],   score: newActiveScore },
                    [opponentUid]: { ...game.players[opponentUid], score: newOpponentScore },
                },
                activePlayerUid: isGameOver ? winnerUid : opponentUid,
                phase: isGameOver ? 'ENDED' : 'PLAYING',
                lastShot: null,
            });
            console.log('[updateAfterShot] Firestore write complete, next active:', isGameOver ? winnerUid : opponentUid);
        });
    }

    // ── Internal: Firestore snapshot listener ──────────────────────────────────

    private _watchGame(gameId: string): void {
        this._stopWatching();
        this.unsubscribeSnapshot = runInInjectionContext(this.injector, () =>
            onSnapshot(
                doc(this.firestore, 'games', gameId),
                (snap: DocumentSnapshot) => {
                    if (snap.exists()) {
                        this.zone.run(() => this._state$.next(snap.data() as GameState));
                    }
                },
            )
        );
    }

    private _stopWatching(): void {
        this.unsubscribeSnapshot?.();
        this.unsubscribeSnapshot = null;
    }

    ngOnDestroy(): void {
        this._stopWatching();
    }
}