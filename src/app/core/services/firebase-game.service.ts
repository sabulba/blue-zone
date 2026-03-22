import { Injectable, OnDestroy, inject, Injector, NgZone, runInInjectionContext } from '@angular/core';
import {
  Firestore, doc, getDoc, setDoc, onSnapshot, updateDoc, DocumentSnapshot,
} from '@angular/fire/firestore';
import { BehaviorSubject, Observable } from 'rxjs';
import { BallPositions, GameState, PlayerData, Shot } from '../models/game.model';
import { ARENA, ScoreResult } from './physics.service';
import { AuthService } from './auth.service';

const WIN_SCORE    = 21;
const GAME_ID      = 'shared-game';
const COLORS       = ['#3498db', '#e74c3c'];
const P1_KEY       = 'player_1';
const P2_KEY       = 'player_2';

function freshPositions(): BallPositions {
  return {
    [P1_KEY]: { ...ARENA.BALL_START_P1 },
    [P2_KEY]: { ...ARENA.BALL_START_P2 },
    white:    { ...ARENA.BALL_START_WHITE },
  };
}

function freshGame(p1Name: string, p2Name: string): GameState {
  return {
    gameId:          GAME_ID,
    createdAt:       Date.now(),
    phase:           'PLAYING',
    activePlayerUid: P1_KEY,
    playerOrder:     [P1_KEY, P2_KEY],
    players: {
      [P1_KEY]: { uid: P1_KEY, displayName: p1Name, color: COLORS[0], score: 0 },
      [P2_KEY]: { uid: P2_KEY, displayName: p2Name, color: COLORS[1], score: 0 },
    },
    lastShot:      null,
    ballPositions: freshPositions(),
  };
}

@Injectable({ providedIn: 'root' })
export class FirebaseGameService implements OnDestroy {
  private firestore = inject(Firestore);
  private injector  = inject(Injector);
  private zone      = inject(NgZone);
  private authSvc   = inject(AuthService);

  private _state$ = new BehaviorSubject<GameState | null>(null);
  readonly state$: Observable<GameState | null> = this._state$.asObservable();

  private unsubSnap: (() => void) | null = null;

  get state(): GameState | null { return this._state$.value; }

  // ── myUid: this device's fixed slot ────────────────────────────────────────
  // On two devices: first to open = player_1, second = player_2.
  // On single device: returns activePlayerUid so current player can shoot.
  get myUid(): string {
    const slot = localStorage.getItem('bluezone_slot');
    if (slot) return slot;
    // Fallback: single device — active player is "me"
    return this._state$.value?.activePlayerUid ?? P1_KEY;
  }

  // ── mySlot: which fixed slot this device owns ─────────────────────────────
  // Stored in localStorage so it survives page refresh.
  // First device to open the game = player_1, second = player_2.
  get mySlot(): string {
    return localStorage.getItem('bluezone_slot') ?? '';
  }

  // ── init: called once from GameComponent.ngOnInit ─────────────────────────
  async init(): Promise<void> {
    const name = this.authSvc.displayName || 'Player';
    await runInInjectionContext(this.injector, async () => {
      const ref  = doc(this.firestore, 'games', GAME_ID);
      const snap = await getDoc(ref);

      if (!snap.exists()) {
        // First device — claim player_1, create game
        localStorage.setItem('bluezone_slot', P1_KEY);
        await setDoc(ref, freshGame(name, 'Player 2'));
      } else {
        const data = snap.data() as GameState;
        // Detect which slot this device owns
        let slot = localStorage.getItem('bluezone_slot');

        if (!slot) {
          // New device joining — take whichever slot has generic name, prefer P2
          const p2Name = data.players[P2_KEY]?.displayName ?? '';
          slot = (p2Name === 'Player 2' || p2Name === '') ? P2_KEY : P1_KEY;
          localStorage.setItem('bluezone_slot', slot);
        }

        // Write real auth name into our slot
        await updateDoc(ref, {
          [`players.${slot}.displayName`]: name,
        });
      }

      const gs = (await getDoc(ref)).data() as GameState;
      this.zone.run(() => this._state$.next(gs));
      this._watch();
    });
  }

  // ── reset ─────────────────────────────────────────────────────────────────
  async reset(): Promise<void> {
    const game = this._state$.value;
    await runInInjectionContext(this.injector, async () => {
      const ref = doc(this.firestore, 'games', GAME_ID);
      // Preserve real player names, just reset scores and positions
      const p1Name = game?.players[P1_KEY]?.displayName ?? 'Player 1';
      const p2Name = game?.players[P2_KEY]?.displayName ?? 'Player 2';
      const gs  = freshGame(p1Name, p2Name);
      await setDoc(ref, gs);
      this.zone.run(() => this._state$.next(gs));
    });
  }

  // ── submitShot ─────────────────────────────────────────────────────────────
  async submitShot(shot: Shot): Promise<void> {
    await runInInjectionContext(this.injector, async () => {
      await updateDoc(doc(this.firestore, 'games', GAME_ID), { lastShot: shot });
    });
  }

  // ── updateAfterShot ────────────────────────────────────────────────────────
  async updateAfterShot(score: ScoreResult, newPos: BallPositions, shooterUid?: string): Promise<void> {
    const game = this._state$.value;
    if (!game) return;

    const activeUid   = shooterUid ?? game.activePlayerUid;
    const opponentUid = game.playerOrder.find(u => u !== activeUid)!;

    const newActiveScore   = (game.players[activeUid]?.score   ?? 0) + score.activePoints;
    const newOpponentScore = (game.players[opponentUid]?.score ?? 0) + score.opponentPoints;
    const isGameOver = newActiveScore >= WIN_SCORE || newOpponentScore >= WIN_SCORE;
    const winnerUid  = newActiveScore >= WIN_SCORE ? activeUid : opponentUid;

    await runInInjectionContext(this.injector, async () => {
      await updateDoc(doc(this.firestore, 'games', GAME_ID), {
        ballPositions:   newPos,
        players: {
          ...game.players,
          [activeUid]:   { ...game.players[activeUid],   score: newActiveScore },
          [opponentUid]: { ...game.players[opponentUid], score: newOpponentScore },
        },
        activePlayerUid: isGameOver ? winnerUid : opponentUid,
        phase:           isGameOver ? 'ENDED' : 'PLAYING',
        lastShot:        null,
      });
    });
  }

  private _watch(): void {
    this.unsubSnap?.();
    this.unsubSnap = runInInjectionContext(this.injector, () =>
      onSnapshot(doc(this.firestore, 'games', GAME_ID), (snap: DocumentSnapshot) => {
        if (snap.exists()) {
          this.zone.run(() => this._state$.next(snap.data() as GameState));
        }
      })
    );
  }

  ngOnDestroy(): void { this.unsubSnap?.(); }
}
