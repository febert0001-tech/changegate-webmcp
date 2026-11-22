export class TeamError extends Error {
  constructor(readonly code: string, readonly status: number) {
    super(code);
  }
}
