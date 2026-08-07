import { describe, expect, it } from 'vitest';
import {
  applyAction,
  createCanonicalDeck,
  createGame,
  type Card,
  countDeckValues,
  GameRuleError,
  shuffleCards,
  type SkyjoGameState,
} from '../../src/game';

function seededRng(seed = 123456): () => number {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function idFactory() {
  let i = 0;
  return () => `c${i++}`;
}

function startTwoPlayerGame(): SkyjoGameState {
  const init = createGame(
    [
      { playerId: 'p0', displayName: 'A', seatIndex: 0 },
      { playerId: 'p1', displayName: 'B', seatIndex: 1 },
    ],
    { rng: seededRng(1), idFactory: idFactory(), targetScore: 999 },
  );
  let state = init.state;
  state = applyAction(state, { type: 'game.revealInitial', seatIndex: 0, positions: [0, 1] }).state;
  state = applyAction(state, { type: 'game.revealInitial', seatIndex: 1, positions: [0, 1] }).state;
  expect(state.phase).toBe('PLAYING');
  return state;
}

function card(id: string, value: number): Card {
  return { id, value: value as Card['value'] };
}

function makeLayout(values: number[], revealed = true): SkyjoGameState['players'][number]['round']['layout'] {
  return values.map((v, i) => ({ card: card(`L${i}-${v}`, v), revealed, removed: false }));
}

describe('deck', () => {
  it('has canonical distribution and total 150', () => {
    const deck = createCanonicalDeck(idFactory());
    expect(deck).toHaveLength(150);
    const counts = countDeckValues(deck);
    expect(counts.get(-2)).toBe(5);
    expect(counts.get(-1)).toBe(10);
    expect(counts.get(0)).toBe(15);
    for (let v = 1; v <= 12; v += 1) {
      expect(counts.get(v)).toBe(10);
    }
  });

  it('shuffle and deal produce no duplicate card ids', () => {
    const init = createGame(
      [
        { playerId: 'p0', displayName: 'A', seatIndex: 0 },
        { playerId: 'p1', displayName: 'B', seatIndex: 1 },
        { playerId: 'p2', displayName: 'C', seatIndex: 2 },
      ],
      { rng: seededRng(2), idFactory: idFactory() },
    );
    const { state } = init;
    const allIds = [
      ...state.deck.map((c) => c.id),
      ...state.discardPile.map((c) => c.id),
      ...state.players.flatMap((p) => p.round.layout.map((s) => s.card?.id).filter(Boolean) as string[]),
    ];
    expect(new Set(allIds).size).toBe(allIds.length);
    expect(allIds.length).toBe(150);

    const shuffled = shuffleCards(createCanonicalDeck(idFactory()), seededRng(3));
    expect(shuffled).toHaveLength(150);
    expect(new Set(shuffled.map((c) => c.id)).size).toBe(150);
  });
});

describe('rules engine legality', () => {
  it('rejects acting out of turn', () => {
    const state = startTwoPlayerGame();
    const wrongSeat = state.currentTurnSeat === 0 ? 1 : 0;
    expect(() => applyAction(state, { type: 'game.drawDeck', seatIndex: wrongSeat })).toThrowError(GameRuleError);
  });

  it('rejects swapDrawn without pending drawn card', () => {
    const state = startTwoPlayerGame();
    expect(() =>
      applyAction(state, { type: 'game.swapDrawn', seatIndex: state.currentTurnSeat!, targetPosition: 2 }),
    ).toThrowError(GameRuleError);
  });

  it('enforces initial reveal exactly two unique positions', () => {
    const init = createGame(
      [
        { playerId: 'p0', displayName: 'A', seatIndex: 0 },
        { playerId: 'p1', displayName: 'B', seatIndex: 1 },
      ],
      { rng: seededRng(4), idFactory: idFactory() },
    ).state;

    expect(() => applyAction(init, { type: 'game.revealInitial', seatIndex: 0, positions: [0] })).toThrowError(
      /exactly 2/,
    );
    expect(() => applyAction(init, { type: 'game.revealInitial', seatIndex: 0, positions: [0, 0] })).toThrowError(
      /unique/,
    );
  });

  it('enforces configured initial reveal count', () => {
    const init = createGame(
      [
        { playerId: 'p0', displayName: 'A', seatIndex: 0 },
        { playerId: 'p1', displayName: 'B', seatIndex: 1 },
      ],
      { rng: seededRng(44), idFactory: idFactory(), initialRevealCount: 3 },
    ).state;

    expect(() => applyAction(init, { type: 'game.revealInitial', seatIndex: 0, positions: [0, 1] })).toThrowError(
      /exactly 3/,
    );
    expect(() =>
      applyAction(init, { type: 'game.revealInitial', seatIndex: 0, positions: [0, 1, 1] }),
    ).toThrowError(/unique/);
    expect(() =>
      applyAction(init, { type: 'game.revealInitial', seatIndex: 0, positions: [0, 1, 2] }),
    ).not.toThrow();
  });

  it('requires exactly one newly face-down card to be revealed after discarding drawn card', () => {
    let state = startTwoPlayerGame();
    const seat = state.currentTurnSeat!;
    state = applyAction(state, { type: 'game.drawDeck', seatIndex: seat }).state;

    const revealedPos = state.players[seat].round.layout.findIndex((s) => s.revealed);
    expect(revealedPos).toBeGreaterThanOrEqual(0);

    expect(() =>
      applyAction(state, { type: 'game.discardDrawnAndReveal', seatIndex: seat, revealPosition: revealedPos }),
    ).toThrowError(/face-down/);
  });
});

describe('column eligibility and discard', () => {
  it('emits eligibility and allows explicit discardColumn', () => {
    const state: SkyjoGameState = {
      gameId: 'g1',
      rulesVariant: 'canonical',
      targetScore: 999,
      maxRounds: 0,
      initialRevealCount: 2,
      roundId: 'r1',
      roundNumber: 1,
      roundStartedAt: 0,
      phase: 'PLAYING',
      turnStage: 'DRAWN_PENDING',
      currentTurnSeat: 0,
      roundEndTriggerSeat: null,
      finalTurnsRemaining: [],
      pendingColumnDecision: null,
      initialRevealOrder: [0, 1],
      initialRevealSums: { 0: 0, 1: 0 },
      players: [
        {
          seatIndex: 0,
          playerId: 'p0',
          displayName: 'A',
          totalScore: 0,
          connected: true,
          round: {
            layout: [
              { card: card('a0', 5), revealed: true, removed: false },
              { card: card('a1', 5), revealed: true, removed: false },
              { card: card('a2', 9), revealed: false, removed: false },
              ...makeLayout([1, 2, 3, 4, 5, 6, 7, 8, 9], true),
            ],
            pendingDrawnCard: card('drawn', 5),
            initialRevealDone: true,
          },
        },
        {
          seatIndex: 1,
          playerId: 'p1',
          displayName: 'B',
          totalScore: 0,
          connected: true,
          round: { layout: makeLayout([0, 0, 0, 1, 1, 1, 2, 2, 2, 3, 3, 3], true), pendingDrawnCard: null, initialRevealDone: true },
        },
      ],
      deck: [card('d1', 7)],
      discardPile: [card('x', 4)],
      winnerSeatIndex: null,
      completedRound: null,
    };

    const afterSwap = applyAction(state, { type: 'game.swapDrawn', seatIndex: 0, targetPosition: 2 });
    expect(afterSwap.state.turnStage).toBe('AWAITING_COLUMN_DECISION');
    expect(afterSwap.events.some((e) => e.event === 'game.columnEligible')).toBe(true);

    const afterDiscard = applyAction(afterSwap.state, { type: 'game.discardColumn', seatIndex: 0, columnIndex: 0 });
    expect(afterDiscard.events.some((e) => e.event === 'game.columnDiscarded')).toBe(true);
    expect(afterDiscard.state.players[0].round.layout[0].removed).toBe(true);
    expect(afterDiscard.state.turnStage).toBe('AWAITING_ACTION');
    expect(afterDiscard.state.currentTurnSeat).toBe(1);
  });
});

describe('end of round and scoring', () => {
  it('starts final turns when a player reveals all cards', () => {
    const state: SkyjoGameState = {
      gameId: 'g1',
      rulesVariant: 'canonical',
      targetScore: 999,
      maxRounds: 0,
      initialRevealCount: 2,
      roundId: 'r1',
      roundNumber: 1,
      roundStartedAt: 0,
      phase: 'PLAYING',
      turnStage: 'DRAWN_PENDING',
      currentTurnSeat: 0,
      roundEndTriggerSeat: null,
      finalTurnsRemaining: [],
      pendingColumnDecision: null,
      initialRevealOrder: [0, 1],
      initialRevealSums: { 0: 0, 1: 0 },
      players: [
        {
          seatIndex: 0,
          playerId: 'p0',
          displayName: 'A',
          totalScore: 0,
          connected: true,
          round: {
            layout: [
              { card: card('p0-0', 1), revealed: true, removed: false },
              { card: card('p0-1', 1), revealed: true, removed: false },
              { card: card('p0-2', 1), revealed: false, removed: false },
              ...makeLayout([2, 2, 2, 3, 3, 3, 4, 4, 4], true),
            ],
            pendingDrawnCard: card('drawn', 10),
            initialRevealDone: true,
          },
        },
        {
          seatIndex: 1,
          playerId: 'p1',
          displayName: 'B',
          totalScore: 0,
          connected: true,
          round: { layout: makeLayout([5, 5, 5, 6, 6, 6, 7, 7, 7, 8, 8, 8], true), pendingDrawnCard: null, initialRevealDone: true },
        },
      ],
      deck: [card('d', 3)],
      discardPile: [card('disc', 4)],
      winnerSeatIndex: null,
      completedRound: null,
    };

    const next = applyAction(state, { type: 'game.swapDrawn', seatIndex: 0, targetPosition: 2 });
    expect(next.state.phase).toBe('FINAL_TURNS');
    expect(next.state.roundEndTriggerSeat).toBe(0);
    expect(next.state.currentTurnSeat).toBe(1);
    expect(next.state.finalTurnsRemaining).toEqual([1]);
  });

  it('scores round and applies doubling rule when trigger seat is not minimum', () => {
    const state: SkyjoGameState = {
      gameId: 'g1',
      rulesVariant: 'canonical',
      targetScore: 50,
      maxRounds: 0,
      initialRevealCount: 2,
      roundId: 'r1',
      roundNumber: 1,
      roundStartedAt: 0,
      phase: 'FINAL_TURNS',
      turnStage: 'AWAITING_ACTION',
      currentTurnSeat: 1,
      roundEndTriggerSeat: 0,
      finalTurnsRemaining: [1],
      pendingColumnDecision: null,
      initialRevealOrder: [0, 1],
      initialRevealSums: { 0: 0, 1: 0 },
      players: [
        {
          seatIndex: 0,
          playerId: 'p0',
          displayName: 'A',
          totalScore: 0,
          connected: true,
          round: { layout: makeLayout([2, 2, 2, 1, 1, 1, 1, 0, 0, 0, 0, 0], true), pendingDrawnCard: null, initialRevealDone: true },
        },
        {
          seatIndex: 1,
          playerId: 'p1',
          displayName: 'B',
          totalScore: 0,
          connected: true,
          round: { layout: makeLayout([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], true), pendingDrawnCard: null, initialRevealDone: true },
        },
      ],
      deck: [card('d1', 9)],
      discardPile: [card('top', 1)],
      winnerSeatIndex: null,
      completedRound: null,
    };

    const picked = applyAction(state, { type: 'game.takeDiscard', seatIndex: 1 });
    expect(picked.state.turnStage).toBe('DRAWN_PENDING');
    const settled = applyAction(picked.state, { type: 'game.swapDrawn', seatIndex: 1, targetPosition: 0 }, { now: () => 1234 });
    expect(settled.state.phase).toBe('ROUND_REVEAL_PENDING_SUMMARY');
    const res = applyAction(settled.state, { type: 'game.confirmEndRound', seatIndex: 0 });
    expect(res.state.phase).toBe('ROUND_ENDED');
    const round = res.state.completedRound!;
    const trigger = round.scores.find((s) => s.seatIndex === 0)!;
    const other = round.scores.find((s) => s.seatIndex === 1)!;
    expect(other.score).toBeLessThan(trigger.score);
    expect(trigger.doubled).toBe(true);
    expect(trigger.rawScore * 2).toBe(trigger.score);
  });

  it('ends the game when the configured round cap is reached even without a score cap', () => {
    const state: SkyjoGameState = {
      gameId: 'g1',
      rulesVariant: 'canonical',
      targetScore: 0,
      maxRounds: 1,
      initialRevealCount: 2,
      roundId: 'r1',
      roundNumber: 1,
      roundStartedAt: 0,
      phase: 'FINAL_TURNS',
      turnStage: 'AWAITING_ACTION',
      currentTurnSeat: 1,
      roundEndTriggerSeat: 0,
      finalTurnsRemaining: [1],
      pendingColumnDecision: null,
      initialRevealOrder: [0, 1],
      initialRevealSums: { 0: 0, 1: 0 },
      players: [
        {
          seatIndex: 0,
          playerId: 'p0',
          displayName: 'A',
          totalScore: 15,
          connected: true,
          round: { layout: makeLayout([1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1], true), pendingDrawnCard: null, initialRevealDone: true },
        },
        {
          seatIndex: 1,
          playerId: 'p1',
          displayName: 'B',
          totalScore: 10,
          connected: true,
          round: { layout: makeLayout([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], true), pendingDrawnCard: null, initialRevealDone: true },
        },
      ],
      deck: [card('d1', 9)],
      discardPile: [card('top', 1)],
      winnerSeatIndex: null,
      completedRound: null,
    };

    const picked = applyAction(state, { type: 'game.takeDiscard', seatIndex: 1 });
    const settled = applyAction(picked.state, { type: 'game.swapDrawn', seatIndex: 1, targetPosition: 0 }, { now: () => 1234 });
    const confirmed = applyAction(settled.state, { type: 'game.confirmEndRound', seatIndex: 0 });

    expect(confirmed.state.phase).toBe('GAME_ENDED');
    expect(confirmed.state.winnerSeatIndex).toBe(1);
  });
});
