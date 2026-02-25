import { z } from 'zod';

export const CreateRoomBodySchema = z.object({
  displayName: z.string().trim().min(1).max(32),
  maxPlayers: z.number().int().min(2).max(8),
  rulesVariant: z.literal('canonical'),
});

export const JoinRoomBodySchema = z.object({
  displayName: z.string().trim().min(1).max(32),
});

export const ClientEnvelopeSchema = z.object({
  type: z.string().min(1).max(64),
  requestId: z.string().min(1).max(128),
  payload: z.record(z.string(), z.unknown()).default({}),
});

export const AuthPayloadSchema = z.object({ token: z.string().min(1) });
export const RoomReadyPayloadSchema = z.object({ ready: z.boolean() });
export const RevealInitialPayloadSchema = z.object({ positions: z.array(z.number().int()).length(2) });
export const DrawDeckPayloadSchema = z.object({}).default({});
export const ConfirmEndRoundPayloadSchema = z.object({}).default({});
export const TargetPosPayloadSchema = z.object({ targetPosition: z.number().int().min(0).max(11) });
export const DiscardDrawnAndRevealPayloadSchema = z.object({ revealPosition: z.number().int().min(0).max(11) });
export const DiscardColumnPayloadSchema = z.object({ columnIndex: z.number().int().min(0).max(3) });
