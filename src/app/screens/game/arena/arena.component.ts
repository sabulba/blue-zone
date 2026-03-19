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
    @Input() canShoot = false;   // set by GameComponent: isMyTurn = myUid === activePlayerUid
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

    private aimX = 0;
    private aimY = 0;
    private aimActive = false;

    ngAfterViewInit(): void {
        this.initEngine();
        this.zone.runOutsideAngular(() => this.startRenderLoop());
    }

    ngOnChanges(changes: SimpleChanges): void {
        if (!this.engine) return;

        if (changes['canShoot']) {
            console.log('[arena] canShoot:', this.canShoot, 'myUid:', this.myUid,
                'activePlayerUid:', this.game?.activePlayerUid);
            if (!this.canShoot) this.aimActive = false;
        }

        if (changes['game']) {
            const curr = changes['game'].currentValue as GameState;
            const shot = curr.lastShot;

            if (shot && shot.timestamp !== this.lastShotTimestamp && !this.simulating) {
                this.lastShotTimestamp = shot.timestamp;
                this.runShot(shot);
            }

            if (!shot && curr.ballPositions && !this.simulating) {
                this.syncBallPositions(curr.ballPositions);
            }
        }
    }

    ngOnDestroy(): void {
        cancelAnimationFrame(this.rafId);
        if (this.engine) Matter.Engine.clear(this.engine);
    }

    onMouseMove(event: MouseEvent): void {
        const { x, y } = this.canvasCoords(event.clientX, event.clientY);
        this.aimX = x;
        this.aimY = y;
        this.aimActive = true;
    }

    onMouseLeave(): void {
        this.aimActive = false;
    }

    onCanvasClick(event: MouseEvent): void {
        if (!this.canShoot || this.simulating) return;
        const { x, y } = this.canvasCoords(event.clientX, event.clientY);
        this.aimX = x;
        this.aimY = y;
        this.aimActive = true;
        this.fire();
    }

    onTouchStart(event: TouchEvent): void {
        if (!this.canShoot || this.simulating) return;
        event.preventDefault();
        const touch = event.touches[0];
        const { x, y } = this.canvasCoords(touch.clientX, touch.clientY);
        this.aimX = x;
        this.aimY = y;
        this.aimActive = true;
        this.fire();
    }

    // isMyTurn is used only for the aim-line rendering in draw().
    // All shot-firing is gated by canShoot, which is controlled by GameComponent.
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

        const wOpts: Matter.IChamferableBodyDefinition = { isStatic: true, restitution: 0.7 };
        const walls = [
            Matter.Bodies.rectangle(W / 2, -WALL / 2, W + WALL * 2, WALL, wOpts),
            Matter.Bodies.rectangle(W / 2, H + WALL / 2, W + WALL * 2, WALL, wOpts),
            Matter.Bodies.rectangle(-WALL / 2, H / 2, WALL, H, wOpts),
            Matter.Bodies.rectangle(W + WALL / 2, H / 2, WALL, H, wOpts),
        ];

        const bOpts: Matter.IBodyDefinition = { restitution: 0.75, friction: 0.005, frictionAir: 0.025, density: 0.00025 };

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
            if (this.simulating) Matter.Engine.update(this.engine, 1000 / 60);
            this.draw(ctx);
            this.rafId = requestAnimationFrame(step);
        };
        this.rafId = requestAnimationFrame(step);
    }

    private fire(): void {
        const shooterBody = this.shooterBody;
        console.log('[fire] myUid:', this.myUid, 'shooterBody label:', shooterBody.label, 'pos:', shooterBody.position);
        const shot: Shot = {
            shooterUid: this.myUid,
            aimX: this.aimX,
            aimY: this.aimY,
            force: ARENA.SHOT_FORCE,
            ballPositions: this.currentBallPositions(),
            timestamp: Date.now(),
        };
        this.aimActive = false;
        this.shotFired.emit(shot);
        this.applyForce(shooterBody, this.aimX, this.aimY, ARENA.SHOT_FORCE);
        this.waitForRest(shot);
    }

    private runShot(shot: Shot): void {
        // Guard first: if this device fired the shot, the animation is already
        // running locally. Do NOT sync positions or re-apply force — that would
        // reset balls mid-simulation when the Firestore snapshot echoes back.
        if (shot.shooterUid === this.myUid) return;

        // Opponent's shot: sync starting positions then replay the physics.
        this.syncBallPositions(shot.ballPositions);
        const shooterBody = this.bodyForUid(shot.shooterUid);
        this.applyForce(shooterBody, shot.aimX, shot.aimY, shot.force);
        this.waitForRest(shot);
    }

    private applyForce(body: Matter.Body, aimX: number, aimY: number, force: number): void {
        const dx = aimX - body.position.x;
        const dy = aimY - body.position.y;
        const len = Math.hypot(dx, dy) || 1;
        Matter.Body.applyForce(body, body.position, {
            x: (dx / len) * force,
            y: (dy / len) * force,
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

                const newPositions = self.currentBallPositions();
                const whiteBallInForbidden = self.inForbidden(self.bodies.white.position);
                const opponentBallInForbidden = self.inForbidden(
                    self.bodyForUid(self.game.playerOrder.find((u) => u !== shot.shooterUid)!).position,
                );

                const simResult: SimResult = { ballPositions: newPositions, hitWhite, whiteBallInForbidden, opponentBallInForbidden };
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

        // Thin decorative frame
        const F = 8;
        ctx.strokeStyle = 'rgba(180,120,60,0.55)';
        ctx.lineWidth = 2;
        ctx.strokeRect(F, F, W - F * 2, H - F * 2);

        ctx.fillStyle = 'rgba(220, 38, 38, 0.18)';
        ctx.fillRect(FORBIDDEN.x, FORBIDDEN.y, FORBIDDEN.w, FORBIDDEN.h);
        ctx.strokeStyle = '#dc2626';
        ctx.lineWidth = 2;
        ctx.setLineDash([6, 4]);
        ctx.strokeRect(FORBIDDEN.x, FORBIDDEN.y, FORBIDDEN.w, FORBIDDEN.h);
        ctx.setLineDash([]);

        ctx.fillStyle = 'rgba(220, 38, 38, 0.7)';
        ctx.font = 'bold 32px monospace';
        ctx.textAlign = 'center';
        ctx.fillText('FORBIDDEN', FORBIDDEN.x + FORBIDDEN.w / 2, FORBIDDEN.y + FORBIDDEN.h / 2 + 11);

        if (this.aimActive && this.canShoot && !this.simulating) {
            const sb = this.shooterBody;
            ctx.beginPath();
            ctx.moveTo(sb.position.x, sb.position.y);
            ctx.lineTo(this.aimX, this.aimY);
            ctx.strokeStyle = 'rgba(255,255,255,0.35)';
            ctx.lineWidth = 1.5;
            ctx.setLineDash([8, 5]);
            ctx.stroke();
            ctx.setLineDash([]);

            ctx.beginPath();
            ctx.arc(this.aimX, this.aimY, 6, 0, Math.PI * 2);
            ctx.strokeStyle = 'rgba(255,255,255,0.5)';
            ctx.lineWidth = 1;
            ctx.stroke();
        }

        const order = this.game.playerOrder;
        const p0 = this.game.players[order[0]];
        const p1 = this.game.players[order[1]];

        if (p0) this.drawBall(ctx, this.bodies.shooter, p0.color, BALL_R, p0.displayName);
        if (p1) this.drawBall(ctx, this.bodies.opponent, p1.color, BALL_R, p1.displayName);
        this.drawBall(ctx, this.bodies.white, '#ffffff', BALL_R, '');

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
            ctx.fillText(label.slice(0, 3), x, y);
            ctx.textBaseline = 'alphabetic';
        }
    }

    private get shooterBody(): Matter.Body { return this.bodyForUid(this.myUid); }

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

    private inForbidden(pos: { x: number; y: number }): boolean {
        const { x, y, w, h } = ARENA.FORBIDDEN;
        return pos.x >= x && pos.x <= x + w && pos.y >= y && pos.y <= y + h;
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