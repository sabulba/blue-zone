import { Injectable } from '@angular/core';
import { BehaviorSubject, Observable } from 'rxjs';
import { BallPositions, GameState, PlayerData, Shot } from '../models/game.model';
import { ARENA, ScoreResult } from './physics.service';

const WIN_SCORE = 21;

function defaultBallPositions(p1Uid: string, p2Uid: string): BallPositions {
    return {
        [p1Uid]: { ...ARENA.BALL_START_P1 },
        [p2Uid]: { ...ARENA.BALL_START_P2 },
        white: { ...ARENA.BALL_START_WHITE },
    };
}

@Injectable({ providedIn: 'root' })
export class LocalGameService {
    private _state$ = new BehaviorSubject<GameState>(this.createInitialState());
    readonly state$: Observable<GameState> = this._state$.asObservable();

    get state(): GameState { return this._state$.value; }

    private createInitialState(): GameState {
        const p1: PlayerData = { uid: 'player_1', displayName: 'Player 1', color: '#3498db', score: 0 };
        const p2: PlayerData = { uid: 'player_2', displayName: 'Player 2', color: '#e74c3c', score: 0 };
        return {
            gameId: 'LOCAL',
            createdAt: Date.now(),
            phase: 'PLAYING',
            activePlayerUid: p1.uid,
            playerOrder: [p1.uid, p2.uid],
            players: { [p1.uid]: p1, [p2.uid]: p2 },
            lastShot: null,
            ballPositions: defaultBallPositions(p1.uid, p2.uid),
        };
    }

    reset(): void {
        this._state$.next(this.createInitialState());
    }

    submitShot(shot: Shot): void {
        this._state$.next({ ...this._state$.value, lastShot: shot });
    }

    // Accepts ScoreResult — both values are always >= 0.
    // activePoints  → added to the shooter's score.
    // opponentPoints → added to the opponent's score (penalty converted to reward).
    // Game ends when either player reaches WIN_SCORE.
    updateAfterShot(score: ScoreResult, newBallPositions: BallPositions): void {
        const game = this._state$.value;
        const activeUid = game.activePlayerUid;
        const opponentUid = game.playerOrder.find((uid) => uid !== activeUid)!;

        const newActiveScore = (game.players[activeUid]?.score ?? 0) + score.activePoints;
        const newOpponentScore = (game.players[opponentUid]?.score ?? 0) + score.opponentPoints;

        const isGameOver = newActiveScore >= WIN_SCORE || newOpponentScore >= WIN_SCORE;
        // If game over due to opponent's penalty points, winner is opponent
        const winnerUid = newActiveScore >= WIN_SCORE ? activeUid : opponentUid;

        this._state$.next({
            ...game,
            players: {
                ...game.players,
                [activeUid]: { ...game.players[activeUid], score: newActiveScore },
                [opponentUid]: { ...game.players[opponentUid], score: newOpponentScore },
            },
            activePlayerUid: isGameOver ? winnerUid : opponentUid,
            phase: isGameOver ? 'ENDED' : 'PLAYING',
            lastShot: null,
            ballPositions: newBallPositions,
        });
    }
}