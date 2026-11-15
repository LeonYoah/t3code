import * as Schema from "effect/Schema";

export class DeepAIAccountError extends Schema.TaggedError<DeepAIAccountError>()(
  "DeepAIAccountError",
  {
    operation: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message() {
    return `DeepAI ${this.operation} failed. Please try again.`;
  }
}
