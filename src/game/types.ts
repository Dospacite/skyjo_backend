export type CardValue = -2 | -1 | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12;

export interface Card {
  id: string;
  value: CardValue;
}

export interface LayoutSlot {
  card: Card | null;
  revealed: boolean;
  removed: boolean;
}

export interface RoundPlayerState {
  layout: LayoutSlot[];
  pendingDrawnCard: Card | null;
  initialRevealDone: boolean;
}

export interface MatchPlayerState {
  seatIndex: number;
  playerId: string;
  displayName: string;
  totalScore: number;
  connected: boolean;
  round: RoundPlayerState;
}

export type RoundPhase =
  | 'WAITING_INITIAL_REVEALS'
  | 'PLAYING'
  | 'FINAL_TURNS'
  | 'ROUND_REVEAL_PENDING_SUMMARY'
  | 'ROUND_ENDED'
  | 'GAME_ENDED';

export type TurnStage = 'NONE' | 'AWAITING_ACTION' | 'DRAWN_PENDING' | 'AWAITING_COLUMN_DECISION';

export interface ColumnDecisionState {
  seatIndex: number;
  columnIndex: number;
}

export interface RoundScoreResult {
  seatIndex: number;
  score: number;
  doubled: boolean;
  totalScoreAfter: number;
}

export interface CompletedRoundSummary {
  roundId: string;
  roundNumber: number;
  triggerSeatIndex: number;
  scores: RoundScoreResult[];
  endedAt: number;
}

export interface SkyjoGameState {
  gameId: string;
  rulesVariant: 'canonical';
  targetScore: number;
  initialRevealCount: number;
  roundId: string;
  roundNumber: number;
  roundStartedAt: number;
  phase: RoundPhase;
  turnStage: TurnStage;
  currentTurnSeat: number | null;
  roundEndTriggerSeat: number | null;
  finalTurnsRemaining: number[];
  pendingColumnDecision: ColumnDecisionState | null;
  initialRevealOrder: number[];
  initialRevealSums: Record<number, number>;
  players: MatchPlayerState[];
  deck: Card[];
  discardPile: Card[];
  winnerSeatIndex: number | null;
  completedRound: CompletedRoundSummary | null;
}

export type EngineEvent = {
  event: string;
  payload: Record<string, unknown>;
};

export interface TransitionResult {
  state: SkyjoGameState;
  events: EngineEvent[];
  privateEventsBySeat: Record<number, EngineEvent[]>;
}

export type GameAction =
  | { type: 'game.revealInitial'; seatIndex: number; positions: number[] }
  | { type: 'game.drawDeck'; seatIndex: number }
  | { type: 'game.swapDrawn'; seatIndex: number; targetPosition: number }
  | { type: 'game.discardDrawnAndReveal'; seatIndex: number; revealPosition: number }
  | { type: 'game.takeDiscard'; seatIndex: number }
  | { type: 'game.confirmEndRound'; seatIndex: number }
  | { type: 'game.discardColumn'; seatIndex: number; columnIndex: number }
  | { type: 'game.passColumnDiscard'; seatIndex: number };

export interface PublicCardSlotView {
  position: number;
  removed: boolean;
  revealed: boolean;
  value: number | null;
}

export interface PublicPlayerView {
  seatIndex: number;
  displayName: string;
  totalScore: number;
  connected: boolean;
  layout: PublicCardSlotView[];
}

export interface PrivatePlayerAddon {
  seatIndex: number;
  hiddenValues: Array<{ position: number; value: number }>;
  pendingDrawnCard: number | null;
}

export interface PublicGameSnapshot {
  gameId: string;
  roundId: string;
  rulesVariant: 'canonical';
  initialRevealCount: number;
  roundNumber: number;
  phase: RoundPhase;
  turnStage: TurnStage;
  currentTurnSeat: number | null;
  roundEndTriggerSeat: number | null;
  finalTurnsRemaining: number[];
  deckCount: number;
  discardTop: number | null;
  discardCount: number;
  pendingColumnDecision: ColumnDecisionState | null;
  winnerSeatIndex: number | null;
  completedRound: CompletedRoundSummary | null;
  players: PublicPlayerView[];
}
