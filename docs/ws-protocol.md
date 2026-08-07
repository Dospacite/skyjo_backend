# WebSocket Protocol

Endpoint: `/v1/ws`

Auth:
- Preferred: query param `?token=<playerToken>`
- Supported: first message `auth`

## Client envelope
```json
{ "type": "string", "requestId": "string", "payload": {} }
```

## Server envelopes
Responses:
```json
{ "type": "response", "requestId": "req-1", "ok": true, "payload": {} }
```
```json
{ "type": "response", "requestId": "req-1", "ok": false, "error": { "code": "...", "message": "...", "details": {} } }
```

Events:
```json
{ "type": "event", "event": "room.snapshot", "payload": {} }
```

## Public vs private data
- Public snapshots/events never include hidden values for other players.
- Each authenticated player receives `private.hiddenValues` for their own unrevealed layout cards and `private.pendingDrawnCard` (if any).
- `game.drawDeck` response payload includes `{ "drawnCard": number }` only to the acting player.

## Important events
Room/lifecycle:
- `hello`
- `room.snapshot`
- `room.playerJoined`
- `room.playerLeft`
- `room.hostChanged`
- `room.readyStatus`
- `room.closed`

Game:
- `game.roundStarted`
- `game.initialRevealSubmitted`
- `game.initialRevealComplete`
- `game.turnStarted`
- `game.cardDrawn`
- `game.cardDrawnPrivate` (private)
- `game.swapPerformed`
- `game.cardRevealed`
- `game.discardPileUpdated`
- `game.deckCountUpdated`
- `game.columnEligible`
- `game.columnDiscarded`
- `game.columnDiscardPassed`
- `game.roundFinalTurnsStarted`
- `game.roundScored`
- `game.ended`

## Client actions
Lobby:
- `room.ready` `{ "ready": boolean }`
- `room.start` `{}` (host-only)
- `room.leave` `{}`

Auth (if not using query token):
- `auth` `{ "token": "..." }`

Setup:
- `game.revealInitial` `{ "positions": [0, 1] }` (exactly 2 unique positions)

Turn:
- `game.takeDiscard` `{ "targetPosition": 0..11 }`
- `game.drawDeck` `{}`
- `game.swapDrawn` `{ "targetPosition": 0..11 }`
- `game.discardDrawnAndReveal` `{ "revealPosition": 0..11 }`
- `game.discardColumn` `{ "columnIndex": 0..3 }`
- `game.passColumnDiscard` `{}` (implementation-specific helper to continue turn when eligible column is offered)

## Example `hello` / snapshot payload
```json
{
  "protocolVersion": 1,
  "room": {
    "roomCode": "AB12CD",
    "status": "IN_ROUND",
    "players": [
      { "seatIndex": 0, "displayName": "Alice", "ready": false, "connected": true }
    ],
    "game": {
      "phase": "PLAYING",
      "turnStage": "AWAITING_ACTION",
      "currentTurnSeat": 0,
      "deckCount": 90,
      "discardTop": 5
    }
  },
  "private": {
    "seatIndex": 0,
    "hiddenValues": [{ "position": 3, "value": 10 }],
    "pendingDrawnCard": null
  }
}
```
