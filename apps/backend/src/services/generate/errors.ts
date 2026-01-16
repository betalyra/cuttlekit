import { Data } from "effect";
import type { PatchValidationError } from "../vdom/index.js";

export class JsonParseError extends Data.TaggedError("JsonParseError")<{
  readonly line: string;
  readonly message: string;
}> {}

export type GenerationError = PatchValidationError | JsonParseError;
