import { Either, Schema } from "effect";

export const JsonRpcErrorSchema = Schema.Struct({
  code: Schema.Number,
  message: Schema.String
});

export const JsonRpcRequestSchema = Schema.Struct({
  jsonrpc: Schema.Literal("2.0"),
  id: Schema.optional(Schema.Union(Schema.Number, Schema.String, Schema.Null)),
  method: Schema.String,
  params: Schema.optional(Schema.Unknown)
});

export const JsonRpcResponseSchema = Schema.Struct({
  jsonrpc: Schema.Literal("2.0"),
  id: Schema.Union(Schema.Number, Schema.String, Schema.Null),
  result: Schema.optional(Schema.Unknown),
  error: Schema.optional(JsonRpcErrorSchema)
});

export const JsonRpcMessageSchema = Schema.Union(JsonRpcRequestSchema, JsonRpcResponseSchema);

export type JsonRpcMessage = Schema.Schema.Type<typeof JsonRpcMessageSchema>;
export type JsonRpcRequest = Schema.Schema.Type<typeof JsonRpcRequestSchema>;

export function parseJsonRpcMessage(value: unknown): JsonRpcMessage {
  const decoded = Schema.decodeUnknownEither(JsonRpcMessageSchema)(value);
  if (Either.isLeft(decoded)) {
    throw new Error("Invalid JSON-RPC 2.0 message");
  }
  return decoded.right;
}

export function isJsonRpcRequest(message: JsonRpcMessage): message is JsonRpcRequest {
  return "method" in message;
}
