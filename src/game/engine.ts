import { randomUUID } from 'node:crypto';
import { createCanonicalDeck, shuffleCards, type RngFn } from './deck';
import type {
  Card,
  CompletedRoundSummary,
  EngineEvent,
  GameAction,
  MatchPlayerState,
  SkyjoGameState,
  TransitionResult,
} from './types';

export interface PlayerSpec {
  playerId: string;
  displayName: string;
  seatIndex: number;
  connected?: boolean;
}

export interface EngineOptions {
  rng?: RngFn;
  targetScore?: number;
  maxRounds?: number;
  initialRevealCount?: number;
  idFactory?: () => string;
  now?: () => number;
}

export class GameRuleError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'GameRuleError';
  }
}

function assert(condition: unknown, code: string, message: string, details?: unknown): asserts condition {
  if (!condition) {
    throw new GameRuleError(code, message, details);
  }
}

function cloneState(state: SkyjoGameState): SkyjoGameState {
  return structuredClone(state);
}

function createTransition(state: SkyjoGameState): TransitionResult {
  return { state, events: [], privateEventsBySeat: {} };
}

function emit(result: TransitionResult, event: string, payload: Record<string, unknown>) {
  result.events.push({ event, payload });
}

function emitPrivate(
  result: TransitionResult,
  seatIndex: number,
  event: string,
  payload: Record<string, unknown>,
): void {
  if (!result.privateEventsBySeat[seatIndex]) {
    result.privateEventsBySeat[seatIndex] = [];
  }
  result.privateEventsBySeat[seatIndex].push({ event, payload });
}

function activeSeats(state: SkyjoGameState): number[] {
  return state.players.map((p) => p.seatIndex);
}

function nextSeatClockwise(state: SkyjoGameState, fromSeat: number): number {
  const seats = activeSeats(state);
  const idx = seats.indexOf(fromSeat);
  if (idx === -1) {
    throw new GameRuleError('INVALID_SEAT', 'Unknown seat', { fromSeat });
  }
  return seats[(idx + 1) % seats.length];
}

function seatsAfter(state: SkyjoGameState, fromSeat: number): number[] {
  const seats = activeSeats(state);
  const idx = seats.indexOf(fromSeat);
  if (idx === -1) {
    throw new GameRuleError('INVALID_SEAT', 'Unknown seat', { fromSeat });
  }
  return [...seats.slice(idx + 1), ...seats.slice(0, idx)];
}

function columnPositions(columnIndex: number): [number, number, number] {
  assert(Number.isInteger(columnIndex) && columnIndex >= 0 && columnIndex < 4, 'INVALID_COLUMN', 'Column index must be 0..3');
  const base = columnIndex * 3;
  return [base, base + 1, base + 2];
}

function validatePosition(position: number): void {
  assert(Number.isInteger(position) && position >= 0 && position < 12, 'INVALID_POSITION', 'Position must be 0..11');
}

function getPlayer(state: SkyjoGameState, seatIndex: number): MatchPlayerState {
  const player = state.players.find((p) => p.seatIndex === seatIndex);
  assert(player, 'INVALID_SEAT', 'Unknown seat', { seatIndex });
  return player;
}

function ensureTurn(state: SkyjoGameState, seatIndex: number): void {
  assert(state.currentTurnSeat === seatIndex, 'NOT_YOUR_TURN', 'It is not your turn', {
    seatIndex,
    currentTurnSeat: state.currentTurnSeat,
  });
}

function ensureStage(state: SkyjoGameState, expected: SkyjoGameState['turnStage']): void {
  assert(state.turnStage === expected, 'INVALID_TURN_STAGE', 'Action not allowed in current turn stage', {
    expected,
    actual: state.turnStage,
  });
}

function isAllRevealed(player: MatchPlayerState): boolean {
  return player.round.layout.every((slot) => slot.removed || slot.revealed);
}

function columnIsEligible(player: MatchPlayerState, columnIndex: number): boolean {
  const [a, b, c] = columnPositions(columnIndex);
  const slots = [player.round.layout[a], player.round.layout[b], player.round.layout[c]];
  if (slots.some((slot) => slot.removed)) {
    return false;
  }
  if (slots.some((slot) => !slot.revealed || !slot.card)) {
    return false;
  }
  const values = slots.map((slot) => slot.card!.value);
  return values[0] === values[1] && values[1] === values[2];
}

function topDiscard(state: SkyjoGameState): Card {
  const card = state.discardPile.at(-1);
  assert(card, 'DISCARD_EMPTY', 'Discard pile is empty');
  return card;
}

function refillDeckFromDiscardIfNeeded(state: SkyjoGameState, rng: RngFn): void {
  if (state.deck.length > 0) {
    return;
  }
  assert(state.discardPile.length > 1, 'DECK_EMPTY', 'Deck and discard cannot be replenished');
  const top = state.discardPile.pop()!;
  const rest = state.discardPile.splice(0, state.discardPile.length);
  state.deck = shuffleCards(rest, rng);
  state.discardPile = [top];
}

function maybeOfferColumnDecision(
  state: SkyjoGameState,
  seatIndex: number,
  columnIndex: number,
  result: TransitionResult,
): boolean {
  const player = getPlayer(state, seatIndex);
  if (!columnIsEligible(player, columnIndex)) {
    return false;
  }
  state.turnStage = 'AWAITING_COLUMN_DECISION';
  state.pendingColumnDecision = { seatIndex, columnIndex };
  emit(result, 'game.columnEligible', { seatIndex, columnIndex });
  return true;
}

function autoRevealAll(state: SkyjoGameState, result: TransitionResult): void {
  for (const player of state.players) {
    for (let position = 0; position < player.round.layout.length; position += 1) {
      const slot = player.round.layout[position];
      if (!slot.removed && !slot.revealed && slot.card) {
        slot.revealed = true;
        emit(result, 'game.cardRevealed', { seatIndex: player.seatIndex, position, value: slot.card.value, auto: true });
      }
    }
  }
}

function computeRoundScores(state: SkyjoGameState): { scores: CompletedRoundSummary['scores']; winnerSeatIndex: number } {
  const baseScores = state.players.map((player) => {
    const score = player.round.layout.reduce((sum, slot) => {
      if (slot.removed || !slot.card) {
        return sum;
      }
      return sum + slot.card.value;
    }, 0);
    return { seatIndex: player.seatIndex, score };
  });
  const minScore = Math.min(...baseScores.map((s) => s.score));
  const triggerSeat = state.roundEndTriggerSeat;
  const scores = baseScores.map((item) => {
    const doubled = triggerSeat === item.seatIndex && item.score !== minScore;
    const score = doubled ? item.score * 2 : item.score;
    return {
      seatIndex: item.seatIndex,
      rawScore: item.score,
      score,
      doubled,
      totalScoreAfter: 0,
    };
  });

  for (const entry of scores) {
    const player = state.players[entry.seatIndex];
    player.totalScore += entry.score;
    entry.totalScoreAfter = player.totalScore;
  }

  const lowestTotal = Math.min(...state.players.map((p) => p.totalScore));
  const winnerSeatIndex = state.players
    .filter((p) => p.totalScore === lowestTotal)
    .sort((a, b) => a.seatIndex - b.seatIndex)[0]!.seatIndex;

  return { scores, winnerSeatIndex };
}

function isScoreLimitReached(state: SkyjoGameState): boolean {
  return state.targetScore > 0 && state.players.some((p) => p.totalScore >= state.targetScore);
}

function isRoundLimitReached(state: SkyjoGameState): boolean {
  return state.maxRounds > 0 && state.roundNumber >= state.maxRounds;
}

function shouldEndGameAfterCompletedRound(state: SkyjoGameState): boolean {
  return isScoreLimitReached(state) || isRoundLimitReached(state);
}

function settleRoundForSummary(state: SkyjoGameState, result: TransitionResult, now: () => number): void {
  autoRevealAll(state, result);
  state.turnStage = 'NONE';
  state.currentTurnSeat = null;
  state.pendingColumnDecision = null;
  state.finalTurnsRemaining = [];

  const { scores, winnerSeatIndex } = computeRoundScores(state);
  const endedAt = now();
  state.completedRound = {
    roundId: state.roundId,
    roundNumber: state.roundNumber,
    triggerSeatIndex: state.roundEndTriggerSeat ?? 0,
    scores,
    endedAt,
  };
  emit(result, 'game.roundScored', {
    roundId: state.roundId,
    roundNumber: state.roundNumber,
    triggerSeatIndex: state.roundEndTriggerSeat,
    scores,
  });
  state.winnerSeatIndex = winnerSeatIndex;
  state.phase = 'ROUND_REVEAL_PENDING_SUMMARY';
  emit(result, 'game.roundRevealComplete', {
    roundId: state.roundId,
    roundNumber: state.roundNumber,
    hostMustConfirm: true,
    gameWillEnd: shouldEndGameAfterCompletedRound(state),
  });
}

function applyConfirmEndRound(
  state: SkyjoGameState,
  action: Extract<GameAction, { type: 'game.confirmEndRound' }>,
  result: TransitionResult,
): void {
  assert(
    state.phase === 'ROUND_REVEAL_PENDING_SUMMARY',
    'INVALID_PHASE',
    'Round summary can only be confirmed after round reveal completes',
    { phase: state.phase },
  );
  assert(state.completedRound, 'ROUND_NOT_SCORED', 'Round results are not available yet');
  const thresholdReached = shouldEndGameAfterCompletedRound(state);
  if (thresholdReached) {
    state.phase = 'GAME_ENDED';
    emit(result, 'game.ended', {
      winnerSeatIndex: state.winnerSeatIndex,
      totals: state.players.map((p) => ({ seatIndex: p.seatIndex, totalScore: p.totalScore })),
      confirmedBySeatIndex: action.seatIndex,
    });
    return;
  }
  state.phase = 'ROUND_ENDED';
  emit(result, 'game.roundSummaryReady', {
    roundId: state.completedRound.roundId,
    roundNumber: state.completedRound.roundNumber,
    confirmedBySeatIndex: action.seatIndex,
  });
}

function completeTurn(state: SkyjoGameState, actingSeat: number, result: TransitionResult, now: () => number): void {
  state.pendingColumnDecision = null;

  if (state.phase === 'PLAYING') {
    const actingPlayer = getPlayer(state, actingSeat);
    if (isAllRevealed(actingPlayer)) {
      state.roundEndTriggerSeat = actingSeat;
      const remaining = seatsAfter(state, actingSeat);
      state.finalTurnsRemaining = [...remaining];
      if (remaining.length === 0) {
        settleRoundForSummary(state, result, now);
        return;
      }
      state.phase = 'FINAL_TURNS';
      state.currentTurnSeat = remaining[0];
      state.turnStage = 'AWAITING_ACTION';
      emit(result, 'game.roundFinalTurnsStarted', {
        triggerSeatIndex: actingSeat,
        finalTurnsRemaining: [...remaining],
      });
      emit(result, 'game.turnStarted', { seatIndex: state.currentTurnSeat, phase: state.phase });
      return;
    }

    state.currentTurnSeat = nextSeatClockwise(state, actingSeat);
    state.turnStage = 'AWAITING_ACTION';
    emit(result, 'game.turnStarted', { seatIndex: state.currentTurnSeat, phase: state.phase });
    return;
  }

  if (state.phase === 'FINAL_TURNS') {
    assert(state.finalTurnsRemaining[0] === actingSeat, 'FINAL_TURN_SEQUENCE', 'Unexpected final-turn seat order', {
      expected: state.finalTurnsRemaining[0],
      actingSeat,
    });
    state.finalTurnsRemaining.shift();
    if (state.finalTurnsRemaining.length === 0) {
      settleRoundForSummary(state, result, now);
      return;
    }
    state.currentTurnSeat = state.finalTurnsRemaining[0];
    state.turnStage = 'AWAITING_ACTION';
    emit(result, 'game.turnStarted', { seatIndex: state.currentTurnSeat, phase: state.phase });
    return;
  }

  throw new GameRuleError('INVALID_PHASE', 'Cannot complete turn outside active play phases', { phase: state.phase });
}

function buildInitialRound(
  players: PlayerSpec[],
  prevTotals: Map<number, number>,
  options: EngineOptions = {},
): SkyjoGameState {
  const initialRevealCount = options.initialRevealCount ?? 2;
  const targetScore = options.targetScore ?? 100;
  const maxRounds = options.maxRounds ?? 0;
  assert(
    Number.isInteger(initialRevealCount) && initialRevealCount >= 1 && initialRevealCount <= 12,
    'INVALID_INITIAL_REVEAL_COUNT',
    'Initial reveal count must be between 1 and 12',
    { initialRevealCount },
  );
  assert(Number.isInteger(targetScore) && targetScore >= 0, 'INVALID_TARGET_SCORE', 'Target score must be 0 or greater', {
    targetScore,
  });
  assert(Number.isInteger(maxRounds) && maxRounds >= 0, 'INVALID_MAX_ROUNDS', 'Max rounds must be 0 or greater', {
    maxRounds,
  });
  const rng = options.rng ?? Math.random;
  const idFactory = options.idFactory ?? randomUUID;
  const now = options.now ?? Date.now;
  const shuffled = shuffleCards(createCanonicalDeck(idFactory), rng);

  const roundPlayers: MatchPlayerState[] = players
    .slice()
    .sort((a, b) => a.seatIndex - b.seatIndex)
    .map((spec) => {
      const layout = Array.from({ length: 12 }, () => {
        const card = shuffled.pop();
        assert(card, 'DECK_UNDERFLOW', 'Not enough cards for round deal');
        return { card, revealed: false, removed: false };
      });
      return {
        seatIndex: spec.seatIndex,
        playerId: spec.playerId,
        displayName: spec.displayName,
        totalScore: prevTotals.get(spec.seatIndex) ?? 0,
        connected: spec.connected ?? true,
        round: {
          layout,
          pendingDrawnCard: null,
          initialRevealDone: false,
        },
      };
    });

  const discardStart = shuffled.pop();
  assert(discardStart, 'DECK_UNDERFLOW', 'Cannot start discard pile');

  return {
    gameId: idFactory(),
    rulesVariant: 'canonical',
    targetScore,
    maxRounds,
    initialRevealCount,
    roundId: idFactory(),
    roundNumber: 1,
    roundStartedAt: now(),
    phase: 'WAITING_INITIAL_REVEALS',
    turnStage: 'NONE',
    currentTurnSeat: null,
    roundEndTriggerSeat: null,
    finalTurnsRemaining: [],
    pendingColumnDecision: null,
    initialRevealOrder: roundPlayers.map((p) => p.seatIndex),
    initialRevealSums: {},
    players: roundPlayers,
    deck: shuffled,
    discardPile: [discardStart],
    winnerSeatIndex: null,
    completedRound: null,
  };
}

function emitRoundStarted(result: TransitionResult, state: SkyjoGameState): void {
  emit(result, 'game.roundStarted', {
    roundId: state.roundId,
    roundNumber: state.roundNumber,
    deckCount: state.deck.length,
    discardTop: state.discardPile.at(-1)?.value ?? null,
    initialRevealCount: state.initialRevealCount,
    awaitingInitialReveals: state.initialRevealOrder,
  });
  emit(result, 'game.discardPileUpdated', {
    top: state.discardPile.at(-1)?.value ?? null,
    count: state.discardPile.length,
  });
  emit(result, 'game.deckCountUpdated', { count: state.deck.length });
}

export function createGame(players: PlayerSpec[], options: EngineOptions = {}): TransitionResult {
  assert(players.length >= 2, 'MIN_PLAYERS', 'At least 2 players required');
  assert(players.length <= 8, 'MAX_PLAYERS', 'At most 8 players supported');

  const totals = new Map<number, number>();
  const state = buildInitialRound(players, totals, options);
  const result = createTransition(state);
  emitRoundStarted(result, state);
  return result;
}

export function startNextRound(current: SkyjoGameState, options: EngineOptions = {}): TransitionResult {
  assert(current.phase === 'ROUND_ENDED', 'ROUND_NOT_READY', 'Previous round not finished');
  const totals = new Map<number, number>(current.players.map((p) => [p.seatIndex, p.totalScore]));
  const players: PlayerSpec[] = current.players.map((p) => ({
    seatIndex: p.seatIndex,
    playerId: p.playerId,
    displayName: p.displayName,
    connected: p.connected,
  }));
  const next = buildInitialRound(players, totals, {
    ...options,
    targetScore: options.targetScore ?? current.targetScore,
    maxRounds: options.maxRounds ?? current.maxRounds,
    initialRevealCount: options.initialRevealCount ?? current.initialRevealCount,
  });
  next.gameId = current.gameId;
  next.roundNumber = current.roundNumber + 1;
  next.winnerSeatIndex = null;
  const result = createTransition(next);
  emitRoundStarted(result, next);
  return result;
}

function requireSetupPhase(state: SkyjoGameState): void {
  assert(state.phase === 'WAITING_INITIAL_REVEALS', 'INVALID_PHASE', 'Action only valid during initial reveal setup', {
    phase: state.phase,
  });
}

function maybeStartFirstTurnAfterInitialReveals(state: SkyjoGameState, result: TransitionResult): void {
  if (state.players.some((p) => !p.round.initialRevealDone)) {
    return;
  }
  const ordered = state.players
    .map((p) => ({ seatIndex: p.seatIndex, sum: state.initialRevealSums[p.seatIndex] ?? Number.NEGATIVE_INFINITY }))
    .sort((a, b) => (b.sum - a.sum) || (a.seatIndex - b.seatIndex));
  state.phase = 'PLAYING';
  state.currentTurnSeat = ordered[0]!.seatIndex;
  state.turnStage = 'AWAITING_ACTION';
  emit(result, 'game.initialRevealComplete', {
    startSeatIndex: state.currentTurnSeat,
    revealedSums: state.initialRevealSums,
  });
  emit(result, 'game.turnStarted', { seatIndex: state.currentTurnSeat, phase: state.phase });
}

function applyRevealInitial(
  state: SkyjoGameState,
  action: Extract<GameAction, { type: 'game.revealInitial' }>,
  result: TransitionResult,
): void {
  requireSetupPhase(state);
  const player = getPlayer(state, action.seatIndex);
  assert(!player.round.initialRevealDone, 'INITIAL_REVEAL_ALREADY_DONE', 'Initial reveal already completed for this player');
  assert(
    action.positions.length === state.initialRevealCount,
    'INITIAL_REVEAL_COUNT',
    `Must reveal exactly ${state.initialRevealCount} positions`,
  );
  const unique = new Set(action.positions);
  assert(
    unique.size === state.initialRevealCount,
    'INITIAL_REVEAL_COUNT',
    'Initial reveal positions must be unique',
  );

  let sum = 0;
  for (const position of action.positions) {
    validatePosition(position);
    const slot = player.round.layout[position];
    assert(!slot.removed, 'INVALID_POSITION', 'Cannot reveal removed slot', { position });
    assert(!slot.revealed, 'CARD_ALREADY_REVEALED', 'Card already revealed', { position });
    assert(slot.card, 'CARD_MISSING', 'No card in slot', { position });
    slot.revealed = true;
    sum += slot.card.value;
    emit(result, 'game.cardRevealed', { seatIndex: action.seatIndex, position, value: slot.card.value, initial: true });
  }

  player.round.initialRevealDone = true;
  state.initialRevealSums[action.seatIndex] = sum;
  emit(result, 'game.initialRevealSubmitted', { seatIndex: action.seatIndex, positions: [...action.positions], sum });
  maybeStartFirstTurnAfterInitialReveals(state, result);
}

function applyDrawDeck(
  state: SkyjoGameState,
  action: Extract<GameAction, { type: 'game.drawDeck' }>,
  result: TransitionResult,
  rng: RngFn,
): void {
  assert(state.phase === 'PLAYING' || state.phase === 'FINAL_TURNS', 'INVALID_PHASE', 'Cannot draw deck in this phase', {
    phase: state.phase,
  });
  ensureTurn(state, action.seatIndex);
  ensureStage(state, 'AWAITING_ACTION');
  const player = getPlayer(state, action.seatIndex);
  assert(!player.round.pendingDrawnCard, 'PENDING_DRAWN_EXISTS', 'Already holding a drawn card');
  refillDeckFromDiscardIfNeeded(state, rng);
  const card = state.deck.pop();
  assert(card, 'DECK_EMPTY', 'Deck is empty');
  player.round.pendingDrawnCard = card;
  state.turnStage = 'DRAWN_PENDING';
  emit(result, 'game.cardDrawn', { seatIndex: action.seatIndex, source: 'deck' });
  emitPrivate(result, action.seatIndex, 'game.cardDrawnPrivate', { value: card.value, cardId: card.id });
  emit(result, 'game.deckCountUpdated', { count: state.deck.length });
}

function swapIntoPosition(
  state: SkyjoGameState,
  seatIndex: number,
  targetPosition: number,
  incomingCard: Card,
  source: 'drawn' | 'discard',
  result: TransitionResult,
): number {
  validatePosition(targetPosition);
  const player = getPlayer(state, seatIndex);
  const slot = player.round.layout[targetPosition];
  assert(!slot.removed, 'INVALID_POSITION', 'Cannot target removed slot', { targetPosition });
  assert(slot.card, 'CARD_MISSING', 'No card in target slot', { targetPosition });
  const replaced = slot.card;
  const wasRevealed = slot.revealed;
  slot.card = incomingCard;
  slot.revealed = true;
  state.discardPile.push(replaced);
  emit(result, 'game.swapPerformed', {
    seatIndex,
    targetPosition,
    source,
    placedValue: incomingCard.value,
    discardedValue: replaced.value,
    targetWasRevealed: wasRevealed,
  });
  if (!wasRevealed) {
    emit(result, 'game.cardRevealed', { seatIndex, position: targetPosition, value: incomingCard.value, viaSwap: true });
  }
  emit(result, 'game.discardPileUpdated', { top: state.discardPile.at(-1)?.value ?? null, count: state.discardPile.length });
  return Math.floor(targetPosition / 3);
}

function applySwapDrawn(
  state: SkyjoGameState,
  action: Extract<GameAction, { type: 'game.swapDrawn' }>,
  result: TransitionResult,
  now: () => number,
): void {
  assert(state.phase === 'PLAYING' || state.phase === 'FINAL_TURNS', 'INVALID_PHASE', 'Cannot swap drawn card in this phase');
  ensureTurn(state, action.seatIndex);
  ensureStage(state, 'DRAWN_PENDING');
  const player = getPlayer(state, action.seatIndex);
  const incoming = player.round.pendingDrawnCard;
  assert(incoming, 'NO_PENDING_DRAWN_CARD', 'No pending drawn card');
  player.round.pendingDrawnCard = null;
  const columnIndex = swapIntoPosition(state, action.seatIndex, action.targetPosition, incoming, 'drawn', result);
  if (maybeOfferColumnDecision(state, action.seatIndex, columnIndex, result)) {
    return;
  }
  completeTurn(state, action.seatIndex, result, now);
}

function applyTakeDiscard(
  state: SkyjoGameState,
  action: Extract<GameAction, { type: 'game.takeDiscard' }>,
  result: TransitionResult,
): void {
  assert(state.phase === 'PLAYING' || state.phase === 'FINAL_TURNS', 'INVALID_PHASE', 'Cannot take discard in this phase');
  ensureTurn(state, action.seatIndex);
  ensureStage(state, 'AWAITING_ACTION');
  const player = getPlayer(state, action.seatIndex);
  assert(!player.round.pendingDrawnCard, 'PENDING_DRAWN_EXISTS', 'Already holding a drawn card');
  const taken = topDiscard(state);
  state.discardPile.pop();
  player.round.pendingDrawnCard = taken;
  state.turnStage = 'DRAWN_PENDING';
  emit(result, 'game.cardDrawn', { seatIndex: action.seatIndex, source: 'discard' });
  emitPrivate(result, action.seatIndex, 'game.cardDrawnPrivate', { value: taken.value, cardId: taken.id });
  emit(result, 'game.discardPileUpdated', { top: state.discardPile.at(-1)?.value ?? null, count: state.discardPile.length });
}

function applyDiscardDrawnAndReveal(
  state: SkyjoGameState,
  action: Extract<GameAction, { type: 'game.discardDrawnAndReveal' }>,
  result: TransitionResult,
  now: () => number,
): void {
  assert(state.phase === 'PLAYING' || state.phase === 'FINAL_TURNS', 'INVALID_PHASE', 'Cannot discard drawn card in this phase');
  ensureTurn(state, action.seatIndex);
  ensureStage(state, 'DRAWN_PENDING');
  const player = getPlayer(state, action.seatIndex);
  const pending = player.round.pendingDrawnCard;
  assert(pending, 'NO_PENDING_DRAWN_CARD', 'No pending drawn card');
  validatePosition(action.revealPosition);
  const slot = player.round.layout[action.revealPosition];
  assert(!slot.removed, 'INVALID_POSITION', 'Cannot reveal removed slot', { revealPosition: action.revealPosition });
  assert(!slot.revealed, 'CARD_ALREADY_REVEALED', 'Reveal target must be face-down', {
    revealPosition: action.revealPosition,
  });
  assert(slot.card, 'CARD_MISSING', 'No card in reveal target', { revealPosition: action.revealPosition });

  player.round.pendingDrawnCard = null;
  state.discardPile.push(pending);
  emit(result, 'game.discardPileUpdated', { top: pending.value, count: state.discardPile.length });

  slot.revealed = true;
  emit(result, 'game.cardRevealed', {
    seatIndex: action.seatIndex,
    position: action.revealPosition,
    value: slot.card.value,
  });

  const columnIndex = Math.floor(action.revealPosition / 3);
  if (maybeOfferColumnDecision(state, action.seatIndex, columnIndex, result)) {
    return;
  }
  completeTurn(state, action.seatIndex, result, now);
}

function applyDiscardColumn(
  state: SkyjoGameState,
  action: Extract<GameAction, { type: 'game.discardColumn' }>,
  result: TransitionResult,
  now: () => number,
): void {
  assert(state.phase === 'PLAYING' || state.phase === 'FINAL_TURNS', 'INVALID_PHASE', 'Cannot discard column in this phase');
  ensureTurn(state, action.seatIndex);
  ensureStage(state, 'AWAITING_COLUMN_DECISION');
  const decision = state.pendingColumnDecision;
  assert(decision, 'NO_COLUMN_DECISION', 'No pending column discard decision');
  assert(decision.seatIndex === action.seatIndex, 'NOT_YOUR_TURN', 'Column discard decision belongs to another player');
  assert(decision.columnIndex === action.columnIndex, 'INVALID_COLUMN', 'Only the eligible column can be discarded now', {
    expected: decision.columnIndex,
    got: action.columnIndex,
  });

  const player = getPlayer(state, action.seatIndex);
  assert(columnIsEligible(player, action.columnIndex), 'COLUMN_NOT_ELIGIBLE', 'Column is no longer eligible');
  const positions = columnPositions(action.columnIndex);
  const discardedValues: number[] = [];
  for (const pos of positions) {
    const slot = player.round.layout[pos];
    if (slot.card) {
      state.discardPile.push(slot.card);
      discardedValues.push(slot.card.value);
    }
    slot.card = null;
    slot.revealed = true;
    slot.removed = true;
  }

  emit(result, 'game.columnDiscarded', {
    seatIndex: action.seatIndex,
    columnIndex: action.columnIndex,
    discardedValues,
  });
  emit(result, 'game.discardPileUpdated', { top: state.discardPile.at(-1)?.value ?? null, count: state.discardPile.length });
  completeTurn(state, action.seatIndex, result, now);
}

function applyPassColumnDiscard(
  state: SkyjoGameState,
  action: Extract<GameAction, { type: 'game.passColumnDiscard' }>,
  result: TransitionResult,
  now: () => number,
): void {
  assert(state.phase === 'PLAYING' || state.phase === 'FINAL_TURNS', 'INVALID_PHASE', 'Cannot resolve column decision in this phase');
  ensureTurn(state, action.seatIndex);
  ensureStage(state, 'AWAITING_COLUMN_DECISION');
  const decision = state.pendingColumnDecision;
  assert(decision && decision.seatIndex === action.seatIndex, 'NO_COLUMN_DECISION', 'No pending column decision for player');
  emit(result, 'game.columnDiscardPassed', { seatIndex: action.seatIndex, columnIndex: decision.columnIndex });
  completeTurn(state, action.seatIndex, result, now);
}

export function applyAction(state: SkyjoGameState, action: GameAction, options: EngineOptions = {}): TransitionResult {
  const next = cloneState(state);
  const result = createTransition(next);
  const rng = options.rng ?? Math.random;
  const now = options.now ?? Date.now;

  switch (action.type) {
    case 'game.revealInitial':
      applyRevealInitial(next, action, result);
      break;
    case 'game.drawDeck':
      applyDrawDeck(next, action, result, rng);
      break;
    case 'game.swapDrawn':
      applySwapDrawn(next, action, result, now);
      break;
    case 'game.discardDrawnAndReveal':
      applyDiscardDrawnAndReveal(next, action, result, now);
      break;
    case 'game.takeDiscard':
      applyTakeDiscard(next, action, result);
      break;
    case 'game.confirmEndRound':
      applyConfirmEndRound(next, action, result);
      break;
    case 'game.discardColumn':
      applyDiscardColumn(next, action, result, now);
      break;
    case 'game.passColumnDiscard':
      applyPassColumnDiscard(next, action, result, now);
      break;
    default:
      throw new GameRuleError('UNKNOWN_ACTION', 'Unknown action type');
  }

  emit(result, 'game.deckCountUpdated', { count: next.deck.length });
  return result;
}

export function setPlayerConnected(state: SkyjoGameState, seatIndex: number, connected: boolean): SkyjoGameState {
  const next = cloneState(state);
  const player = getPlayer(next, seatIndex);
  player.connected = connected;
  return next;
}
