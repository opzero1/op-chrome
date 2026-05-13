import { Either, Schema } from "effect";

export const NativeHostStatusSchema = Schema.Struct({
  state: Schema.String,
  hostName: Schema.optional(Schema.String),
  lastChecked: Schema.optional(Schema.Number),
  reconnectAttempt: Schema.optional(Schema.Number),
  error: Schema.optional(Schema.String),
  nextRetryMs: Schema.optional(Schema.Number)
});

export const CursorSchema = Schema.Struct({
  visible: Schema.Boolean,
  x: Schema.Number,
  y: Schema.Number,
  animateMovement: Schema.optional(Schema.Boolean),
  moveSequence: Schema.Number
});

export const CursorStateSchema = Schema.Struct({
  cursor: Schema.Union(CursorSchema, Schema.Null),
  isVisible: Schema.Boolean,
  sessionId: Schema.String,
  turnId: Schema.String
});

export const RuntimeMessageSchema = Schema.Union(
  Schema.Struct({ type: Schema.Literal("GET_NATIVE_HOST_STATUS") }),
  Schema.Struct({ type: Schema.Literal("GET_AGENT_CURSOR_STATE") }),
  Schema.Struct({
    type: Schema.Literal("CONTENT_PING")
  }),
  Schema.Struct({
    type: Schema.Literal("AGENT_CURSOR_STATE"),
    state: CursorStateSchema
  }),
  Schema.Struct({
    type: Schema.Literal("AGENT_CURSOR_ARRIVED"),
    sessionId: Schema.String,
    turnId: Schema.String,
    moveSequence: Schema.Number
  })
);

export type NativeHostStatus = Schema.Schema.Type<typeof NativeHostStatusSchema>;
export type CursorState = Schema.Schema.Type<typeof CursorStateSchema>;
export type RuntimeMessage = Schema.Schema.Type<typeof RuntimeMessageSchema>;

export function parseWithSchema<A, I>(schema: Schema.Schema<A, I, never>, value: unknown): A | null {
  const decoded = Schema.decodeUnknownEither(schema)(value);
  return Either.isRight(decoded) ? decoded.right : null;
}
