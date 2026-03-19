import { Injectable } from '@angular/core';
import Matter from 'matter-js';
import { BallPositions, Shot } from '../models/game.model';

export const ARENA = {
    W: 800,
    H: 500,
    WALL: 50,
    BALL_R: 18,
    SHOT_FORCE: 0.18,
    BALL_START_P1: { x: 150, y: 250 },
    BALL_START_P2: { x: 650, y: 250 },
    BALL_START_WHITE: { x: 400, y: 250 },
    FORBIDDEN: { x: 300, y: 390, w: 200, h: 80 },
} as const;

export interface SimResult {
    ballPositions: BallPositions;
    hitWhite: boolean;
    whiteBallInForbidden: boolean;
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
        Matter.Body.applyForce(shooter, shooter.position, {
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
        const whiteBallInForbidden = this.inForbidden(bodies.white.position);
        const opponentBallInForbidden = this.inForbidden(bodies.opponent.position);
        Matter.Engine.clear(engine);

        return { ballPositions, hitWhite, whiteBallInForbidden, opponentBallInForbidden };
    }

    // Returns ScoreResult — no negative values, penalties go to opponent as points.
    //
    // Rules:
    //   Miss white ball        → opponent +3
    //   White ball in forbidden → opponent +5
    //   Opponent ball in forbidden → active player +5
    evaluateScore(
        result: Pick<SimResult, 'hitWhite' | 'whiteBallInForbidden' | 'opponentBallInForbidden'>,
    ): ScoreResult {
        let activePoints = 0;
        let opponentPoints = 0;

        if (!result.hitWhite) {
            opponentPoints += 3;            // penalty → opponent reward
        } else if (result.whiteBallInForbidden) {
            opponentPoints += 5;            // penalty → opponent reward
        }

        if (result.opponentBallInForbidden) {
            activePoints += 5;              // reward stays with active player
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

        const wallOpts: Matter.IChamferableBodyDefinition = { isStatic: true, label: 'wall', restitution: 0.7 };
        const walls = [
            Matter.Bodies.rectangle(W / 2, -WALL / 2, W + WALL * 2, WALL, wallOpts),
            Matter.Bodies.rectangle(W / 2, H + WALL / 2, W + WALL * 2, WALL, wallOpts),
            Matter.Bodies.rectangle(-WALL / 2, H / 2, WALL, H, wallOpts),
            Matter.Bodies.rectangle(W + WALL / 2, H / 2, WALL, H, wallOpts),
        ];

        const ballOpts: Matter.IBodyDefinition = { restitution: 0.75, friction: 0.005, frictionAir: 0.025 };

        const pShooter = positions[shooterUid] ?? ARENA.BALL_START_P1;
        const pOpponent = positions[opponentUid] ?? ARENA.BALL_START_P2;
        const pWhite = positions['white'] ?? ARENA.BALL_START_WHITE;

        const shooter = Matter.Bodies.circle(pShooter.x, pShooter.y, BALL_R, { ...ballOpts, label: 'shooter' });
        const opponent = Matter.Bodies.circle(pOpponent.x, pOpponent.y, BALL_R, { ...ballOpts, label: 'opponent' });
        const white = Matter.Bodies.circle(pWhite.x, pWhite.y, BALL_R, { ...ballOpts, label: 'white' });

        Matter.Composite.add(engine.world, [...walls, shooter, opponent, white]);
        return { engine, bodies: { shooter, opponent, white } };
    }

    private inForbidden(pos: { x: number; y: number }): boolean {
        const { x, y, w, h } = ARENA.FORBIDDEN;
        return pos.x >= x && pos.x <= x + w && pos.y >= y && pos.y <= y + h;
    }

    private extractPositions(bodies: ArenaBodies, shooterUid: string, opponentUid: string): BallPositions {
        return {
            [shooterUid]: { x: bodies.shooter.position.x, y: bodies.shooter.position.y },
            [opponentUid]: { x: bodies.opponent.position.x, y: bodies.opponent.position.y },
            white: { x: bodies.white.position.x, y: bodies.white.position.y },
        };
    }
}