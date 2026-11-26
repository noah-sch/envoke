export type ErrorCode =
  | "auth"
  | "auth_required"
  | "rate_limit"
  | "overloaded"
  | "usage_limit"
  | "not_eligible"
  | "network"
  | "bad_request"
  | "server"
  | "policy"
  | "config"
  | "not_found"
  | "agent"
  | "aborted";

/** Error shown to the user. `code` lets the UI localize; `message` is a readable French default. */
export class EnvokeError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "EnvokeError";
    this.code = code;
  }
}

export function isAbort(error: unknown): boolean {
  return (
    (error instanceof EnvokeError && error.code === "aborted") ||
    (error instanceof Error && error.name === "AbortError")
  );
}

export function toEnvokeError(error: unknown): EnvokeError {
  if (error instanceof EnvokeError) return error;
  if (isAbort(error)) return new EnvokeError("aborted", "Interrompu.");
  const message = error instanceof Error ? error.message : String(error);
  return new EnvokeError("server", `Erreur inattendue : ${message}`, { cause: error });
}
