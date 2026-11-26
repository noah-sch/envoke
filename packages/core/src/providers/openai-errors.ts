import OpenAI from "openai";
import { EnvokeError } from "../errors.ts";

/** Codes returned when a ChatGPT plan is used through Sign in with ChatGPT. */
const PLAN_ERRORS: Record<string, EnvokeError["code"]> = {
  subscription_sharing_usage_limit_exceeded: "usage_limit",
  subscription_sharing_usage_unavailable: "overloaded",
  subscription_sharing_user_unavailable: "overloaded",
  subscription_sharing_user_not_eligible: "not_eligible",
  subscription_sharing_route_not_supported: "not_eligible",
  subscription_sharing_invalid_user: "auth",
  subscription_sharing_unsupported_capability: "bad_request",
};

export function planErrorMessage(code: EnvokeError["code"], detail: string): string {
  switch (code) {
    case "usage_limit":
      return "Limite d'usage de votre forfait ChatGPT atteinte. Détail : chatgpt.com/settings/usage";
    case "not_eligible":
      return "Ce compte ChatGPT n'est pas éligible à l'usage de son forfait dans une autre application.";
    case "overloaded":
      return "Service ChatGPT momentanément indisponible, réessayez dans un instant.";
    case "auth":
      return "Session ChatGPT invalide : reconnectez votre compte.";
    default:
      return `Requête refusée par ChatGPT : ${detail}`;
  }
}

export function fromPlanErrorCode(
  code: string | null | undefined,
  detail: string,
): EnvokeError | null {
  const mapped = code ? PLAN_ERRORS[code] : undefined;
  return mapped ? new EnvokeError(mapped, planErrorMessage(mapped, detail)) : null;
}

export function toOpenAIError(error: unknown, signal: AbortSignal, name: string): EnvokeError {
  if (error instanceof EnvokeError) return error;
  if (error instanceof OpenAI.APIUserAbortError || signal.aborted)
    return new EnvokeError("aborted", "Interrompu.");
  if (error instanceof OpenAI.APIError) {
    const plan = fromPlanErrorCode(error.code, error.message);
    if (plan) return plan;
  }
  if (error instanceof OpenAI.AuthenticationError) {
    return new EnvokeError("auth", `Identifiants ${name} invalides ou absents.`, { cause: error });
  }
  if (error instanceof OpenAI.PermissionDeniedError) {
    return new EnvokeError("auth", `Accès refusé par ${name}.`, { cause: error });
  }
  if (error instanceof OpenAI.RateLimitError) {
    return new EnvokeError(
      "rate_limit",
      `Limite de débit ${name} atteinte, réessayez dans un instant.`,
      { cause: error },
    );
  }
  if (error instanceof OpenAI.InternalServerError) {
    return new EnvokeError("server", `Erreur du serveur ${name}, réessayez dans un instant.`, {
      cause: error,
    });
  }
  if (error instanceof OpenAI.APIConnectionError) {
    return new EnvokeError("network", `Impossible de joindre ${name} : vérifiez votre connexion.`, {
      cause: error,
    });
  }
  if (error instanceof OpenAI.APIError) {
    return new EnvokeError("bad_request", `Requête refusée par ${name} : ${error.message}`, {
      cause: error,
    });
  }
  const message = error instanceof Error ? error.message : String(error);
  return new EnvokeError("server", `Réponse ${name} illisible : ${message}`, { cause: error });
}

/** Tool arguments arrive as a JSON string; invalid JSON is passed on so the tool reports it. */
export function parseArguments(text: string): unknown {
  if (text.trim() === "") return {};
  try {
    return JSON.parse(text);
  } catch {
    return { INVALID_JSON: text };
  }
}
