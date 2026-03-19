export type GamePhase = 'WAITING' | 'PLAYING' | 'ENDED';

export interface PlayerData {
  uid: string;
  displayName: string;
  color: string;
  score: number;
}

export interface BallPositions {
  [uid: string]: { x: number; y: number };
  white: { x: number; y: number };
}

export interface Shot {
  shooterUid: string;
  aimX: number;
  aimY: number;
  force: number;
  ballPositions: BallPositions;
  timestamp: number;
}

export interface GameState {
  gameId: string;
  createdAt: number;
  phase: GamePhase;
  activePlayerUid: string;
  playerOrder: string[];
  players: Record<string, PlayerData>;
  lastShot?: Shot | null;
  ballPositions?: BallPositions | null;
}
