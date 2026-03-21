import { Injectable } from '@angular/core';
import Matter from 'matter-js';
import { BallPositions, Shot } from '../models/game.model';

const _W = 800;
const _H = 1000;
const _WALL_INSET = 8;
const _BALL_R = 72;
const _FW = Math.round(_W * 0.625);          // danger zone width  (responsive)
const _FH = Math.round(_H * 0.2);            // danger zone height (responsive)

export const ARENA = {
    W: _W,
    H: _H,
    WALL: 50,
    WALL_INSET: _WALL_INSET,
    BALL_R: _BALL_R,
    MAX_VELOCITY: 40,
    MIN_VELOCITY: 4,
    SWIPE_SCALE: 0.12,
    BALL_START_P1:    { x: _WALL_INSET + _BALL_R,       y: _H - _WALL_INSET - _BALL_R },
    BALL_START_P2:    { x: _W - _WALL_INSET - _BALL_R,  y: _H - _WALL_INSET - _BALL_R },
    BALL_START_WHITE: { x: _W / 2,                       y: Math.round(_H * 0.62) },
    FORBIDDEN:        { x: Math.round((_W - _FW) / 2),  y: _WALL_INSET + 18, w: _FW, h: _FH },
} as const;

export interface SimResult {
    ballPositions: BallPositions;
    hitWhite: boolean;
    shooterBallInForbidden: boolean;
    opponentBallInForbidden: boolean;
}

interface ArenaBodies {
    shooter: Matter.Body;
    opponent: Matter.Body;
    white: Matter.Body;
}

// Scoring result — always non-negative.
// activePoints  → added to the active player's score.
// opponentPoints → added to the opponent's score (penalty converted to opponent reward).
export interface ScoreResult {
    activePoints: number;
    opponentPoints: number;
}

@Injectable({ providedIn: 'root' })
export class PhysicsService {
    simulate(shot: Shot, shooterUid: string, opponentUid: string): SimResult {
        const { engine, bodies } = this.buildWorld(shot.ballPositions, shooterUid, opponentUid);
        let hitWhite = false;

        Matter.Events.on(engine, 'collisionStart', (event) => {
            for (const pair of event.pairs) {
                const ids = [pair.bodyA.label, pair.bodyB.label];
                if (ids.includes('shooter') && ids.includes('white')) hitWhite = true;
            }
        });

        const { shooter } = bodies;
        const dx = shot.aimX - shooter.position.x;
        const dy = shot.aimY - shooter.position.y;
        const len = Math.hypot(dx, dy) || 1;
        Matter.Body.setVelocity(shooter, {
            x: (dx / len) * shot.force,
            y: (dy / len) * shot.force,
        });

        const MAX_FRAMES = 300;
        const STEP_MS = 1000 / 60;
        const REST_THRESHOLD = 0.05;

        for (let i = 0; i < MAX_FRAMES; i++) {
            Matter.Engine.update(engine, STEP_MS);
            const allRest = [bodies.shooter, bodies.opponent, bodies.white].every(
                (b) => Math.abs(b.velocity.x) < REST_THRESHOLD && Math.abs(b.velocity.y) < REST_THRESHOLD,
            );
            if (allRest && i > 10) break;
        }

        const ballPositions = this.extractPositions(bodies, shooterUid, opponentUid);
        const shooterBallInForbidden = this.inForbidden(bodies.shooter.position);
        const opponentBallInForbidden = this.inForbidden(bodies.opponent.position);
        Matter.Engine.clear(engine);

        return { ballPositions, hitWhite, shooterBallInForbidden, opponentBallInForbidden };
    }

    // Returns ScoreResult — no negative values, penalties go to opponent as points.
    //
    // Rules:
    //   Miss white ball                 → opponent +3
    //   Opponent ball in danger zone     → active player +5
    //   Shooter’s own ball in danger zone → opponent +5 (penalty)
    evaluateScore(
        result: Pick<SimResult, 'hitWhite' | 'shooterBallInForbidden' | 'opponentBallInForbidden'>,
    ): ScoreResult {
        let activePoints = 0;
        let opponentPoints = 0;

        if (!result.hitWhite) {
            opponentPoints += 3;            // penalty → opponent reward
        }

        if (result.opponentBallInForbidden) {
            activePoints += 5;              // reward stays with active player
        }

        if (result.shooterBallInForbidden) {
            opponentPoints += 5;            // penalty → opponent reward
        }

        return { activePoints, opponentPoints };
    }

    private buildWorld(
        positions: BallPositions,
        shooterUid: string,
        opponentUid: string,
    ): { engine: Matter.Engine; bodies: ArenaBodies } {
        const engine = Matter.Engine.create({ gravity: { x: 0, y: 0 } });
        const { W, H, WALL, BALL_R } = ARENA;

        const wallOpts: Matter.IChamferableBodyDefinition = { isStatic: true, label: 'wall', restitution: 1.0 };
        const fi = ARENA.WALL_INSET;
        const walls = [
            Matter.Bodies.rectangle(W / 2, fi - WALL / 2, W + WALL * 2, WALL, wallOpts),
            Matter.Bodies.rectangle(W / 2, H - fi + WALL / 2, W + WALL * 2, WALL, wallOpts),
            Matter.Bodies.rectangle(fi - WALL / 2, H / 2, WALL, H + WALL * 2, wallOpts),
            Matter.Bodies.rectangle(W - fi + WALL / 2, H / 2, WALL, H + WALL * 2, wallOpts),
        ];

        const ballOpts: Matter.IBodyDefinition = { restitution: 0.8, friction: 0.005, frictionAir: 0.01, density: 0.0000625 };

        const pShooter = positions[shooterUid] ?? ARENA.BALL_START_P1;
        const pOpponent = positions[opponentUid] ?? ARENA.BALL_START_P2;
        const pWhite = positions['white'] ?? ARENA.BALL_START_WHITE;

        const shooter = Matter.Bodies.circle(pShooter.x, pShooter.y, BALL_R, { ...ballOpts, label: 'shooter' });
        const opponent = Matter.Bodies.circle(pOpponent.x, pOpponent.y, BALL_R, { ...ballOpts, label: 'opponent' });
        const white = Matter.Bodies.circle(pWhite.x, pWhite.y, BALL_R, { ...ballOpts, label: 'white' });

        Matter.Composite.add(engine.world, [...walls, shooter, opponent, white]);
        return { engine, bodies: { shooter, opponent, white } };
    }

    /** Ball counts as "in zone" if ≥50% overlaps (center within zone boundary). */
    private inForbidden(pos: { x: number; y: number }): boolean {
        const { x, y, w, h } = ARENA.FORBIDDEN;
        // Clamp center to nearest point on the zone rectangle
        const cx = Math.max(x, Math.min(x + w, pos.x));
        const cy = Math.max(y, Math.min(y + h, pos.y));
        const dist = Math.hypot(pos.x - cx, pos.y - cy);
        // dist === 0 means center is inside the zone (≥ 50% overlap).
        // Allow a small tolerance so balls resting right at the edge count.
        return dist <= ARENA.BALL_R * 0.05;
    }

    private extractPositions(bodies: ArenaBodies, shooterUid: string, opponentUid: string): BallPositions {
        return {
            [shooterUid]: { x: bodies.shooter.position.x, y: bodies.shooter.position.y },
            [opponentUid]: { x: bodies.opponent.position.x, y: bodies.opponent.position.y },
            white: { x: bodies.white.position.x, y: bodies.white.position.y },
        };
    }
}