import { randomUUID } from 'node:crypto';
import type { Card, CardValue } from './types';

const deckCounts: Array<[CardValue, number]> = [
  [-2, 5],
  [-1, 10],
  [0, 15],
  [1, 10],
  [2, 10],
  [3, 10],
  [4, 10],
  [5, 10],
  [6, 10],
  [7, 10],
  [8, 10],
  [9, 10],
  [10, 10],
  [11, 10],
  [12, 10],
];

export type RngFn = () => number;

export function createCanonicalDeck(idFactory: () => string = randomUUID): Card[] {
  const deck: Card[] = [];
  for (const [value, count] of deckCounts) {
    for (let i = 0; i < count; i += 1) {
      deck.push({ id: idFactory(), value });
    }
  }
  return deck;
}

export function shuffleCards(cards: Card[], rng: RngFn = Math.random): Card[] {
  const deck = cards.slice();
  for (let i = deck.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

export function countDeckValues(cards: Card[]): Map<number, number> {
  const counts = new Map<number, number>();
  for (const card of cards) {
    counts.set(card.value, (counts.get(card.value) ?? 0) + 1);
  }
  return counts;
}
