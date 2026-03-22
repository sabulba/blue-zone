import {
    AfterViewInit,
    Component,
    ElementRef,
    EventEmitter,
    inject,
    Input,
    NgZone,
    OnChanges,
    OnDestroy,
    Output,
    SimpleChanges,
    ViewChild,
} from '@angular/core';
import Matter from 'matter-js';
import { BallPositions, GameState, Shot } from '../../../core/models/game.model';
import { ARENA, PhysicsService, SimResult } from '../../../core/services/physics.service';

export interface ShotResult {
    simResult: SimResult;
    shot: Shot;
}

@Component({
    selector: 'app-arena',
    standalone: true,
    templateUrl: './arena.component.html',
    styleUrl: './arena.component.scss',
})
export class ArenaComponent implements AfterViewInit, OnChanges, OnDestroy {
    @ViewChild('canvas', { static: true }) canvasRef!: ElementRef<HTMLCanvasElement>;

    @Input() game!: GameState;
    @Input() myUid!: string;
    @Output() shotFired = new EventEmitter<Shot>();
    @Output() simulationDone = new EventEmitter<ShotResult>();

    private physics = inject(PhysicsService);
    private zone = inject(NgZone);

    readonly arenaW = ARENA.W;
    readonly arenaH = ARENA.H;

    private engine!: Matter.Engine;
    private bodies!: { shooter: Matter.Body; opponent: Matter.Body; white: Matter.Body };
    private rafId = 0;
    private simulating = false;
    private lastShotTimestamp = 0;
    private localFiredTimestamp = 0; // timestamp of shot fired by THIS device

    // Shooting state machine: idle → target-placed → swiping → (fire) → idle
    private shootPhase: 'idle' | 'target-placed' | 'swiping' = 'idle';
    private targetX = 0;
    private targetY = 0;
    private swipeStartX = 0;
    private swipeStartY = 0;
    private swipeCurrentX = 0;
    private swipeCurrentY = 0;
    private shotVelocity = 0;
    private pendingPositions: BallPositions | null = null;

    ngAfterViewInit(): void {
        this.initEngine();
        this.zone.runOutsideAngular(() => this.startRenderLoop());
    }

    ngOnChanges(changes: SimpleChanges): void {
        if (!this.engine) return;



        if (changes['game']) {
            const curr = changes['game'].currentValue as GameState;
            // Reset aim state when it's no longer this device's turn
            if (!this.isMyTurn) { this.shootPhase = 'idle'; this.shotVelocity = 0; }
            const shot = curr.lastShot;

            if (shot && shot.timestamp !== this.lastShotTimestamp && !this.simulating) {
                this.lastShotTimestamp = shot.timestamp;
                this.runShot(shot);
            }

            if (!shot && curr.ballPositions) {
                if (!this.simulating) {
                    this.syncBallPositions(curr.ballPositions);
                } else {
                    // Authoritative positions arrived while simulating — buffer them
                    this.pendingPositions = curr.ballPositions;
                }
            }
        }
    }

    ngOnDestroy(): void {
        cancelAnimationFrame(this.rafId);
        if (this.engine) Matter.Engine.clear(this.engine);
    }

    /* ── Pointer handlers (unified mouse + touch via PointerEvent) ── */

    onPointerDown(event: PointerEvent): void {
        event.preventDefault();
        if (!this.canShoot || this.simulating) return;
        const { x, y } = this.canvasCoords(event.clientX, event.clientY);
        this.handleDown(x, y);
    }

    onPointerMove(event: PointerEvent): void {
        if (this.shootPhase !== 'swiping') return;
        event.preventDefault();
        const { x, y } = this.canvasCoords(event.clientX, event.clientY);
        this.handleMove(x, y);
    }

    onPointerUp(): void {
        if (this.shootPhase !== 'swiping') return;
        this.handleUp();
    }

    private handleDown(x: number, y: number): void {
        const ball = this.shooterBody;
        const dist = Math.hypot(x - ball.position.x, y - ball.position.y);

        if (this.shootPhase === 'target-placed' && dist <= ARENA.BALL_R * 1.8) {
            // Tap on own ball → start power swipe
            this.shootPhase = 'swiping';
            this.swipeStartX = x;
            this.swipeStartY = y;
            this.swipeCurrentX = x;
            this.swipeCurrentY = y;
            this.shotVelocity = 0;
        } else {
            // Place / move target marker
            this.targetX = x;
            this.targetY = y;
            this.shootPhase = 'target-placed';
        }
    }

    private handleMove(x: number, y: number): void {
        this.swipeCurrentX = x;
        this.swipeCurrentY = y;
        const swipeDist = Math.hypot(x - this.swipeStartX, y - this.swipeStartY);
        this.shotVelocity = Math.min(
            ARENA.MAX_VELOCITY,
            Math.max(ARENA.MIN_VELOCITY, swipeDist * ARENA.SWIPE_SCALE),
        );
    }

    private handleUp(): void {
        if (this.shotVelocity >= ARENA.MIN_VELOCITY) {
            this.fireShot();
        }
        this.shootPhase = 'idle';
        this.shotVelocity = 0;
    }

    // canShoot: computed internally — no parent input needed
    // True whenever the game is PLAYING and physics is idle.
    // On single device both players share screen so always enabled during PLAYING.
    // On two devices myUid matches activePlayerUid for the correct device.
    get canShoot(): boolean {
        return this.game?.phase === 'PLAYING' && !this.simulating;
    }

    get isMyTurn(): boolean {
        return this.game?.activePlayerUid === this.myUid && this.game?.phase === 'PLAYING';
    }

    private initEngine(): void {
        const positions = this.game.ballPositions;
        const order = this.game.playerOrder;
        const p0 = positions?.[order[0]] ?? ARENA.BALL_START_P1;
        const p1 = positions?.[order[1]] ?? ARENA.BALL_START_P2;
        const pw = positions?.['white'] ?? ARENA.BALL_START_WHITE;

        this.engine = Matter.Engine.create({ gravity: { x: 0, y: 0 } });
        const { W, H, WALL, BALL_R } = ARENA;

        const wOpts: Matter.IChamferableBodyDefinition = { isStatic: true, restitution: 1.0 };
        const fi = ARENA.WALL_INSET;
        const walls = [
            Matter.Bodies.rectangle(W / 2, fi - WALL / 2, W + WALL * 2, WALL, wOpts),
            Matter.Bodies.rectangle(W / 2, H - fi + WALL / 2, W + WALL * 2, WALL, wOpts),
            Matter.Bodies.rectangle(fi - WALL / 2, H / 2, WALL, H + WALL * 2, wOpts),
            Matter.Bodies.rectangle(W - fi + WALL / 2, H / 2, WALL, H + WALL * 2, wOpts),
        ];

        const bOpts: Matter.IBodyDefinition = { restitution: 0.8, friction: 0.005, frictionAir: 0.01, density: 0.0000625 };

        const shooter = Matter.Bodies.circle(p0.x, p0.y, BALL_R, { ...bOpts, label: order[0] });
        const opponent = Matter.Bodies.circle(p1.x, p1.y, BALL_R, { ...bOpts, label: order[1] });
        const white = Matter.Bodies.circle(pw.x, pw.y, BALL_R, { ...bOpts, label: 'white' });

        this.bodies = { shooter, opponent, white };
        Matter.Composite.add(this.engine.world, [...walls, shooter, opponent, white]);
    }

    private startRenderLoop(): void {
        const canvas = this.canvasRef.nativeElement;
        const ctx = canvas.getContext('2d')!;
        const step = () => {
            if (this.simulating) {
                Matter.Engine.update(this.engine, 1000 / 60);
                this.clampBodies();
            }
            this.draw(ctx);
            this.rafId = requestAnimationFrame(step);
        };
        this.rafId = requestAnimationFrame(step);
    }

    /**
     * Safety net: only catches balls that tunnel through walls.
     * Uses a tolerance so normal wall bounces (tiny sub-pixel penetration)
     * are handled by Matter.js, not by this clamp.
     */
    private clampBodies(): void {
        const { W, H, BALL_R, WALL_INSET } = ARENA;
        const pad = BALL_R + WALL_INSET;
        const tolerance = 8; // only intervene if ball is 8+ px past the wall
        const minX = pad - tolerance;
        const maxX = W - pad + tolerance;
        const minY = pad - tolerance;
        const maxY = H - pad + tolerance;
        for (const body of [this.bodies.shooter, this.bodies.opponent, this.bodies.white]) {
            const { x, y } = body.position;
            if (x < minX || x > maxX || y < minY || y > maxY) {
                Matter.Body.setPosition(body, {
                    x: Math.max(pad, Math.min(W - pad, x)),
                    y: Math.max(pad, Math.min(H - pad, y)),
                });
                Matter.Body.setVelocity(body, {
                    x: x < minX || x > maxX ? -body.velocity.x * 0.8 : body.velocity.x,
                    y: y < minY || y > maxY ? -body.velocity.y * 0.8 : body.velocity.y,
                });
            }
        }
    }

    private fireShot(): void {
        const shooterBody = this.shooterBody;
        const vel = this.shotVelocity;
        const activeUid = this.game.activePlayerUid;
        const shot: Shot = {
            shooterUid: activeUid,
            aimX: this.targetX,
            aimY: this.targetY,
            force: vel,           // reuse field for velocity magnitude
            ballPositions: this.currentBallPositions(),
            timestamp: Date.now(),
        };
        this.localFiredTimestamp = shot.timestamp; // mark as locally fired
        this.shotFired.emit(shot);
        this.launchBall(shooterBody, this.targetX, this.targetY, vel);
        this.waitForRest(shot);
    }

    private runShot(shot: Shot): void {
        // If this device fired this shot, animation is already running locally.
        // Guard by timestamp — NOT by myUid, which changes every turn.
        if (shot.timestamp === this.localFiredTimestamp) return;

        // Opponent's shot: sync starting positions then replay the physics.
        this.syncBallPositions(shot.ballPositions);
        const shooterBody = this.bodyForUid(shot.shooterUid);
        this.launchBall(shooterBody, shot.aimX, shot.aimY, shot.force);
        this.waitForRest(shot);
    }

    private launchBall(body: Matter.Body, aimX: number, aimY: number, velocity: number): void {
        const dx = aimX - body.position.x;
        const dy = aimY - body.position.y;
        const len = Math.hypot(dx, dy) || 1;
        Matter.Body.setVelocity(body, {
            x: (dx / len) * velocity,
            y: (dy / len) * velocity,
        });
        this.simulating = true;
    }

    private waitForRest(shot: Shot): void {
        let frames = 0;
        const MAX = 300;
        const REST = 0.05;
        let hitWhite = false;

        Matter.Events.on(this.engine, 'collisionStart', onCollide);
        const self = this;

        function onCollide(event: Matter.IEventCollision<Matter.Engine>) {
            for (const pair of event.pairs) {
                const ids = [pair.bodyA.label, pair.bodyB.label];
                if (ids.includes(shot.shooterUid) && ids.includes('white')) hitWhite = true;
            }
        }

        const check = () => {
            frames++;
            const atRest = [self.bodies.shooter, self.bodies.opponent, self.bodies.white].every(
                (b) => Math.abs(b.velocity.x) < REST && Math.abs(b.velocity.y) < REST,
            );
            if ((atRest && frames > 10) || frames >= MAX) {
                self.simulating = false;
                Matter.Events.off(self.engine, 'collisionStart', onCollide);

                // Apply authoritative positions that arrived during simulation
                if (self.pendingPositions) {
                    self.syncBallPositions(self.pendingPositions);
                    self.pendingPositions = null;
                }

                const opponentUid = self.game.playerOrder.find((u) => u !== shot.shooterUid)!;
                const shooterBody  = self.bodyForUid(shot.shooterUid);
                const opponentBody = self.bodyForUid(opponentUid);

                const shooterBallInForbidden  = self.inForbidden(shooterBody.position);
                const opponentBallInForbidden = self.inForbidden(opponentBody.position);

                // If ANY ball entered the forbidden zone — reset ALL balls to
                // their initial positions (full board reset, not just one ball).
                if (shooterBallInForbidden || opponentBallInForbidden) {
                    Matter.Body.setPosition(self.bodies.shooter, { ...ARENA.BALL_START_P1 });
                    Matter.Body.setPosition(self.bodies.opponent, { ...ARENA.BALL_START_P2 });
                    Matter.Body.setPosition(self.bodies.white,    { ...ARENA.BALL_START_WHITE });
                    Matter.Body.setVelocity(self.bodies.shooter,  { x: 0, y: 0 });
                    Matter.Body.setVelocity(self.bodies.opponent,  { x: 0, y: 0 });
                    Matter.Body.setVelocity(self.bodies.white,     { x: 0, y: 0 });
                }

                const newPositions = self.currentBallPositions();
                const simResult: SimResult = { ballPositions: newPositions, hitWhite, shooterBallInForbidden, opponentBallInForbidden };
                self.zone.run(() => self.simulationDone.emit({ simResult, shot }));
            } else {
                requestAnimationFrame(check);
            }
        };
        requestAnimationFrame(check);
    }

    private draw(ctx: CanvasRenderingContext2D): void {
        const { W, H, BALL_R, FORBIDDEN } = ARENA;
        ctx.clearRect(0, 0, W, H);

        ctx.fillStyle = '#1a3a2a';
        ctx.fillRect(0, 0, W, H);

        // Decorative frame
        const F = 8;
        ctx.setLineDash([]);
        ctx.strokeStyle = 'rgba(180,120,60,0.85)';
        ctx.lineWidth = 4;
        ctx.strokeRect(F, F, W - F * 2, H - F * 2);

        ctx.fillStyle = 'rgba(30, 80, 220, 0.22)';
        ctx.fillRect(FORBIDDEN.x, FORBIDDEN.y, FORBIDDEN.w, FORBIDDEN.h);
        ctx.strokeStyle = '#3b82f6';
        ctx.lineWidth = 2;
        ctx.setLineDash([6, 4]);
        ctx.strokeRect(FORBIDDEN.x, FORBIDDEN.y, FORBIDDEN.w, FORBIDDEN.h);
        ctx.setLineDash([]);

        ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
        ctx.font = 'bold 32px monospace';
        ctx.textAlign = 'center';
        ctx.fillText('DANGER', FORBIDDEN.x + FORBIDDEN.w / 2, FORBIDDEN.y + FORBIDDEN.h / 2 + 11);

        // Blinking highlight on the active ball — always visible on your turn.
        // Blink on the active player's ball — visible to BOTH players on any device.
        // Uses body.label === activePlayerUid so it works independently of canShoot/myUid.
        if (!this.simulating && this.game?.phase === 'PLAYING') {
            const activeUid = this.game.activePlayerUid;
            const activeBall = this.bodyForUid(activeUid);
            const t = Date.now();

            // Outer slow breathe (1.2s cycle) — always on during active turn
            const outerPulse = 0.5 + 0.5 * Math.sin(t / 600);
            ctx.setLineDash([]);
            ctx.beginPath();
            ctx.arc(activeBall.position.x, activeBall.position.y, BALL_R + 10 + outerPulse * 8, 0, Math.PI * 2);
            ctx.strokeStyle = `rgba(255, 220, 0, ${(0.2 + outerPulse * 0.5).toFixed(2)})`;
            ctx.lineWidth = 2.5;
            ctx.stroke();

            // Inner fast blink — only on this device's turn + idle phase
            if (this.isMyTurn && this.shootPhase === 'idle') {
                const innerPulse = 0.5 + 0.5 * Math.sin(t / 250);
                ctx.beginPath();
                ctx.arc(activeBall.position.x, activeBall.position.y, BALL_R + 4 + innerPulse * 3, 0, Math.PI * 2);
                ctx.strokeStyle = `rgba(255, 255, 255, ${(0.3 + innerPulse * 0.5).toFixed(2)})`;
                ctx.lineWidth = 1.5;
                ctx.stroke();
            }
        }

        // Target marker (yellow circle + red center dot)
        if (this.shootPhase !== 'idle') {
            ctx.setLineDash([]);
            ctx.beginPath();
            ctx.arc(this.targetX, this.targetY, 10, 0, Math.PI * 2);
            ctx.fillStyle = 'rgba(255, 220, 0, 0.7)';
            ctx.fill();
            ctx.strokeStyle = 'rgba(200, 170, 0, 0.9)';
            ctx.lineWidth = 2;
            ctx.stroke();

            ctx.beginPath();
            ctx.arc(this.targetX, this.targetY, 3, 0, Math.PI * 2);
            ctx.fillStyle = '#dc2626';
            ctx.fill();
        }

        const order = this.game.playerOrder;
        const p0 = this.game.players[order[0]];
        const p1 = this.game.players[order[1]];

        if (p0) this.drawBall(ctx, this.bodies.shooter, p0.color, BALL_R, '');
        if (p1) this.drawBall(ctx, this.bodies.opponent, p1.color, BALL_R, '');
        this.drawBall(ctx, this.bodies.white, '#ffffff', BALL_R, '');

        // Velocity badge above ball during swipe (drawn last = on top of everything)
        if (this.shootPhase === 'swiping' && this.shotVelocity > 0) {
            const ball = this.shooterBody;
            const bx = ball.position.x;
            const by = ball.position.y - BALL_R - 44;
            const velText = Math.round(this.shotVelocity).toString();
            const badgeR = 36;

            ctx.beginPath();
            ctx.arc(bx, by, badgeR, 0, Math.PI * 2);
            ctx.fillStyle = 'rgba(0, 0, 0, 0.75)';
            ctx.fill();
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.8)';
            ctx.lineWidth = 3;
            ctx.stroke();

            ctx.fillStyle = '#ffffff';
            ctx.font = 'bold 28px sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(velText, bx, by);
            ctx.textBaseline = 'alphabetic';
        }

    }

    private drawBall(ctx: CanvasRenderingContext2D, body: Matter.Body, color: string, r: number, label: string): void {
        const { x, y } = body.position;

        ctx.beginPath();
        ctx.arc(x + 2, y + 2, r, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(0,0,0,0.35)';
        ctx.fill();

        const grad = ctx.createRadialGradient(x - r * 0.3, y - r * 0.3, r * 0.1, x, y, r);
        grad.addColorStop(0, this.lighten(color, 0.4));
        grad.addColorStop(1, color);
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fillStyle = grad;
        ctx.fill();
        ctx.strokeStyle = 'rgba(0,0,0,0.4)';
        ctx.lineWidth = 1.5;
        ctx.stroke();

        if (label) {
            ctx.fillStyle = 'rgba(255,255,255,0.9)';
            ctx.font = `bold ${Math.max(9, r * 0.7)}px sans-serif`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            // Show "P1"/"P2" by extracting the last word/number from displayName.
            // "Player 1" → "P1", "Player 2" → "P2", any other name → first 2 chars.
            const parts = label.trim().split(/\s+/);
            const short = parts.length > 1
                ? parts[0][0] + parts[parts.length - 1]   // "P" + "1" → "P1"
                : label.slice(0, 2);                        // fallback
            ctx.fillText(short, x, y);
            ctx.textBaseline = 'alphabetic';
        }
    }

    // The active player's body — always correct regardless of myUid/slot logic
    private get shooterBody(): Matter.Body {
        return this.bodyForUid(this.game.activePlayerUid);
    }

    private bodyForUid(uid: string): Matter.Body {
        // Match by the label set on the Matter body in initEngine().
        // bodies.shooter has label = playerOrder[0], bodies.opponent = playerOrder[1].
        if (this.bodies.shooter.label === uid) return this.bodies.shooter;
        if (this.bodies.opponent.label === uid) return this.bodies.opponent;
        // fallback
        return uid === this.game.playerOrder[0] ? this.bodies.shooter : this.bodies.opponent;
    }

    private syncBallPositions(positions: BallPositions): void {
        const order = this.game.playerOrder;
        const p0 = positions[order[0]];
        const p1 = positions[order[1]];
        const pw = positions['white'];
        if (p0) Matter.Body.setPosition(this.bodies.shooter, p0);
        if (p1) Matter.Body.setPosition(this.bodies.opponent, p1);
        if (pw) Matter.Body.setPosition(this.bodies.white, pw);
        Matter.Body.setVelocity(this.bodies.shooter, { x: 0, y: 0 });
        Matter.Body.setVelocity(this.bodies.opponent, { x: 0, y: 0 });
        Matter.Body.setVelocity(this.bodies.white, { x: 0, y: 0 });
    }

    private currentBallPositions(): BallPositions {
        const order = this.game.playerOrder;
        return {
            [order[0]]: { x: this.bodies.shooter.position.x, y: this.bodies.shooter.position.y },
            [order[1]]: { x: this.bodies.opponent.position.x, y: this.bodies.opponent.position.y },
            white: { x: this.bodies.white.position.x, y: this.bodies.white.position.y },
        };
    }

    /** Ball counts as "in zone" if ≥50% overlaps (center within zone boundary). */
    private inForbidden(pos: { x: number; y: number }): boolean {
        const { x, y, w, h } = ARENA.FORBIDDEN;
        const cx = Math.max(x, Math.min(x + w, pos.x));
        const cy = Math.max(y, Math.min(y + h, pos.y));
        const dist = Math.hypot(pos.x - cx, pos.y - cy);
        return dist <= ARENA.BALL_R * 0.05;
    }

    private canvasCoords(clientX: number, clientY: number): { x: number; y: number } {
        const canvas = this.canvasRef.nativeElement;
        const rect = canvas.getBoundingClientRect();

        // With object-fit: contain the canvas content is letter-boxed.
        // Compute the rendered content area inside the CSS box.
        const canvasAspect = canvas.width / canvas.height;
        const boxAspect = rect.width / rect.height;

        let renderW: number, renderH: number, offsetX: number, offsetY: number;
        if (canvasAspect > boxAspect) {
            // pillar-boxed (bars top/bottom)
            renderW = rect.width;
            renderH = rect.width / canvasAspect;
            offsetX = 0;
            offsetY = (rect.height - renderH) / 2;
        } else {
            // letter-boxed (bars left/right)
            renderH = rect.height;
            renderW = rect.height * canvasAspect;
            offsetX = (rect.width - renderW) / 2;
            offsetY = 0;
        }

        return {
            x: ((clientX - rect.left - offsetX) / renderW) * canvas.width,
            y: ((clientY - rect.top - offsetY) / renderH) * canvas.height,
        };
    }

    private lighten(hex: string, amount: number): string {
        const num = parseInt(hex.replace('#', ''), 16);
        const r = Math.min(255, ((num >> 16) & 0xff) + Math.round(255 * amount));
        const g = Math.min(255, ((num >> 8) & 0xff) + Math.round(255 * amount));
        const b = Math.min(255, (num & 0xff) + Math.round(255 * amount));
        return `rgb(${r},${g},${b})`;
    }
}