export class RankError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status = 400,
    readonly details: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = "RankError";
  }
}
