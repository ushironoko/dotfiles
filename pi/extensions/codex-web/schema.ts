import { isIP } from "node:net";

const MAX_QUERY_LENGTH = 2_000;
const MAX_URL_LENGTH = 2_048;
const MAX_SOURCES = 8;

const SENSITIVE_QUERY_NAMES = new Set([
  "access_token",
  "api_key",
  "apikey",
  "auth",
  "authorization",
  "client_assertion",
  "client_secret",
  "code",
  "credential",
  "id_token",
  "jwt",
  "key",
  "password",
  "refresh_token",
  "samlresponse",
  "secret",
  "session_token",
  "sig",
  "signature",
  "token",
]);

const NON_PUBLIC_DNS_SUFFIXES = [
  ".arpa",
  ".corp",
  ".home",
  ".internal",
  ".invalid",
  ".lan",
  ".local",
  ".localhost",
  ".onion",
  ".test",
] as const;

const CREDENTIAL_PATTERNS = [
  /\bBearer\s+\S{12,}/iu,
  /\b(?:gh[opusr]|github_pat|sk|sess|xox[baprs])[-_][A-Za-z0-9_-]{12,}\b/iu,
  /\bAIza[0-9A-Za-z_-]{20,}\b/u,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/u,
] as const;

interface WebSearchInput {
  query: string;
  maxSources: number;
}

interface WebFetchInput {
  url: string;
  question: string;
  maxSources: number;
}

const WebSearchParameters = {
  type: "object",
  properties: {
    query: {
      type: "string",
      minLength: 1,
      maxLength: MAX_QUERY_LENGTH,
      description: "Search query. Do not include credentials or private data.",
    },
    maxSources: {
      type: "integer",
      minimum: 1,
      maximum: MAX_SOURCES,
      description:
        "Maximum number of normalized source URLs to return (default: 5)",
    },
  },
  required: ["query"],
  additionalProperties: false,
} as const;

const WebFetchParameters = {
  type: "object",
  properties: {
    url: {
      type: "string",
      minLength: 1,
      maxLength: MAX_URL_LENGTH,
      description:
        "One public HTTPS URL without credentials, sensitive query parameters, or a fragment",
    },
    question: {
      type: "string",
      minLength: 1,
      maxLength: MAX_QUERY_LENGTH,
      description:
        "Question to answer from the page (default: summarize its relevant content)",
    },
    maxSources: {
      type: "integer",
      minimum: 1,
      maximum: MAX_SOURCES,
      description:
        "Maximum number of normalized source URLs to return (default: 5)",
    },
  },
  required: ["url"],
  additionalProperties: false,
} as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const hasUnsupportedTextControl = (value: string): boolean =>
  /\p{Cf}/u.test(value) ||
  [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return (code < 32 && code !== 9 && code !== 10) || code === 127;
  });

const hasUnsupportedUrlControl = (value: string): boolean => {
  if (/[\p{Cc}\p{Cf}]/u.test(value)) return true;
  try {
    return /[\p{Cc}\p{Cf}]/u.test(decodeURIComponent(value));
  } catch {
    return false;
  }
};

const hasCredentialLikeText = (value: string): boolean => {
  let decoded = value;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    // Invalid percent encoding is not useful for bypassing the raw-text check.
  }
  return CREDENTIAL_PATTERNS.some(
    (pattern) => pattern.test(value) || pattern.test(decoded),
  );
};

const requireBoundedText = (
  value: unknown,
  field: string,
  fallback?: string,
): string => {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  const normalized = value.trim();
  if (normalized.length === 0) throw new Error(`${field} must not be empty`);
  if (normalized.length > MAX_QUERY_LENGTH) {
    throw new Error(`${field} exceeds ${MAX_QUERY_LENGTH} characters`);
  }
  if (hasUnsupportedTextControl(normalized)) {
    throw new Error(`${field} contains unsupported control characters`);
  }
  if (hasCredentialLikeText(normalized)) {
    throw new Error(`${field} appears to contain a credential`);
  }
  return normalized;
};

const parseMaxSources = (value: unknown): number => {
  if (value === undefined) return 5;
  if (
    !Number.isInteger(value) ||
    (value as number) < 1 ||
    (value as number) > MAX_SOURCES
  ) {
    throw new Error(
      `maxSources must be an integer between 1 and ${MAX_SOURCES}`,
    );
  }
  return value as number;
};

const hasSensitiveQueryName = (url: URL): boolean => {
  for (const name of url.searchParams.keys()) {
    const normalized = name.toLowerCase();
    if (
      SENSITIVE_QUERY_NAMES.has(normalized) ||
      normalized.endsWith("_credential") ||
      normalized.endsWith("_key") ||
      normalized.endsWith("_secret") ||
      normalized.endsWith("_signature") ||
      normalized.endsWith("_token") ||
      normalized.startsWith("x-amz-") ||
      normalized.startsWith("x-goog-")
    ) {
      return true;
    }
  }
  return false;
};

const isPublicDnsHostname = (hostname: string): boolean => {
  const normalized = hostname.toLowerCase().replace(/\.$/, "");
  if (!normalized || isIP(normalized.replace(/^\[|\]$/g, "")) !== 0) {
    return false;
  }
  if (
    normalized === "localhost" ||
    NON_PUBLIC_DNS_SUFFIXES.some(
      (suffix) => normalized === suffix.slice(1) || normalized.endsWith(suffix),
    )
  ) {
    return false;
  }
  return normalized.includes(".");
};

const canonicalizePublicUrl = (url: URL): string => {
  url.hash = "";
  const trackingNames: string[] = [];
  for (const name of url.searchParams.keys()) {
    const lower = name.toLowerCase();
    if (lower.startsWith("utm_") || lower === "ref" || lower === "referrer") {
      trackingNames.push(name);
    }
  }
  for (const name of trackingNames) url.searchParams.delete(name);
  url.searchParams.sort();
  return url.toString();
};

const normalizePublicHttpsUrl = (value: unknown): string => {
  if (typeof value !== "string") throw new Error("url must be a string");
  const normalized = value.trim();
  if (normalized.length === 0) throw new Error("url must not be empty");
  if (normalized.length > MAX_URL_LENGTH) {
    throw new Error(`url exceeds ${MAX_URL_LENGTH} characters`);
  }
  if (hasUnsupportedUrlControl(normalized)) {
    throw new Error("url contains unsupported control characters");
  }

  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    throw new Error("url must be an absolute HTTPS URL");
  }

  if (url.protocol !== "https:") throw new Error("url must use HTTPS");
  if (url.username || url.password)
    throw new Error("url must not contain credentials");
  if (!isPublicDnsHostname(url.hostname)) {
    throw new Error(
      "url must use a public DNS hostname, not a local or literal IP address",
    );
  }
  if (hasSensitiveQueryName(url)) {
    throw new Error(
      "url contains a sensitive query parameter and will not be sent to Codex",
    );
  }
  if (hasCredentialLikeText(url.toString())) {
    throw new Error("url appears to contain a credential");
  }
  if (url.hash) throw new Error("url must not contain a fragment");

  return canonicalizePublicUrl(url);
};

const normalizeProviderSourceUrl = (value: unknown): string | undefined => {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_URL_LENGTH ||
    hasUnsupportedUrlControl(value)
  ) {
    return undefined;
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:") return undefined;
  if (url.username || url.password || !isPublicDnsHostname(url.hostname)) {
    return undefined;
  }
  if (hasSensitiveQueryName(url) || hasCredentialLikeText(url.toString())) {
    return undefined;
  }

  return canonicalizePublicUrl(url);
};

const parseWebSearchInput = (value: unknown): WebSearchInput => {
  if (!isRecord(value)) throw new Error("web_search input must be an object");
  return {
    query: requireBoundedText(value.query, "query"),
    maxSources: parseMaxSources(value.maxSources),
  };
};

const parseWebFetchInput = (value: unknown): WebFetchInput => {
  if (!isRecord(value)) throw new Error("web_fetch input must be an object");
  return {
    url: normalizePublicHttpsUrl(value.url),
    question: requireBoundedText(
      value.question,
      "question",
      "Summarize the page content relevant to a software developer.",
    ),
    maxSources: parseMaxSources(value.maxSources),
  };
};

export {
  normalizeProviderSourceUrl,
  normalizePublicHttpsUrl,
  parseWebFetchInput,
  parseWebSearchInput,
  WebFetchParameters,
  WebSearchParameters,
};
export type { WebFetchInput, WebSearchInput };
