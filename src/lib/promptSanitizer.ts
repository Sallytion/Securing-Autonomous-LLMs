export type SanitizationCategory =
  | "obfuscation"
  | "jailbreak"
  | "roleLeakage"
  | "scriptInjection"
  | "secret"
  | "pii"
  | "infrastructure";

export type SanitizationEvent = {
  category: SanitizationCategory;
  ruleId: string;
  count: number;
};

export type SanitizationResult = {
  sanitizedText: string;
  events: SanitizationEvent[];
  categoryCounts: Record<SanitizationCategory, number>;
  totalRedactions: number;
  normalized: boolean;
  truncated: boolean;
};

type SanitizationRule = {
  category: SanitizationCategory;
  ruleId: string;
  pattern: RegExp;
  replacement: string;
};

const MAX_PROMPT_LENGTH = 8000;
const REDACTED = "[redacted]";

const rules: SanitizationRule[] = [
  {
    category: "jailbreak",
    ruleId: "ignore-previous-instructions",
    pattern: /\b(ignore|disregard|forget)\s+(all\s+)?(previous|prior|above)\s+(instructions?|prompts?)\b/gi,
    replacement: REDACTED,
  },
  {
    category: "jailbreak",
    ruleId: "bypass-system-prompt",
    pattern: /\b(ignore|disregard|bypass|override)\s+(the\s+)?(system|hidden|developer)\s+(prompt|instructions?)\b/gi,
    replacement: REDACTED,
  },
  {
    category: "roleLeakage",
    ruleId: "role-labels",
    pattern: /\b(system|assistant|developer)\s*:/gi,
    replacement: REDACTED,
  },
  {
    category: "roleLeakage",
    ruleId: "xml-role-tags",
    pattern: /<\/?\s*(system|assistant|developer|tool)\b[^>]*>/gi,
    replacement: REDACTED,
  },
  {
    category: "scriptInjection",
    ruleId: "script-tags",
    pattern: /<\/?\s*script\b[^>]*>/gi,
    replacement: REDACTED,
  },
  {
    category: "scriptInjection",
    ruleId: "inline-events",
    pattern: /\bon[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi,
    replacement: REDACTED,
  },
  {
    category: "scriptInjection",
    ruleId: "javascript-uri",
    pattern: /javascript\s*:/gi,
    replacement: REDACTED,
  },
  {
    category: "scriptInjection",
    ruleId: "html-comments",
    pattern: /<!--([\s\S]*?)-->/g,
    replacement: REDACTED,
  },
  {
    category: "secret",
    ruleId: "bearer-token",
    pattern: /\bBearer\s+[A-Za-z0-9\-._~+/]+=*\b/gi,
    replacement: REDACTED,
  },
  {
    category: "secret",
    ruleId: "api-key-assignment",
    pattern: /\b(api[_-]?key|token|secret|access[_-]?token)\s*[:=]\s*["']?[^\s"']+["']?/gi,
    replacement: REDACTED,
  },
  {
    category: "secret",
    ruleId: "password-otp-assignment",
    pattern: /\b(password|passcode|otp|one[ -]?time\s+code|pin)\s*[:=]\s*["']?[^\s"']+["']?/gi,
    replacement: REDACTED,
  },
  {
    category: "secret",
    ruleId: "common-key-prefixes",
    pattern: /\b(?:sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/g,
    replacement: REDACTED,
  },
  {
    category: "pii",
    ruleId: "email",
    pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
    replacement: "[masked-email]",
  },
  {
    category: "pii",
    ruleId: "ssn",
    pattern: /\b\d{3}-\d{2}-\d{4}\b/g,
    replacement: "[masked-ssn]",
  },
  {
    category: "pii",
    ruleId: "credit-card",
    pattern: /\b(?:\d[ -]*?){13,19}\b/g,
    replacement: "[masked-card]",
  },
  {
    category: "infrastructure",
    ruleId: "env-var-names",
    pattern: /\b[A-Z][A-Z0-9_]{2,}(?:KEY|TOKEN|SECRET|PASSWORD|PRIVATE|DATABASE|DB|ENDPOINT|URL)\b/g,
    replacement: REDACTED,
  },
  {
    category: "infrastructure",
    ruleId: "private-ip",
    pattern:
      /\b(?:10\.(?:\d{1,3}\.){2}\d{1,3}|192\.168\.(?:\d{1,3}\.)\d{1,3}|172\.(?:1[6-9]|2\d|3[0-1])\.(?:\d{1,3}\.)\d{1,3})\b/g,
    replacement: REDACTED,
  },
  {
    category: "infrastructure",
    ruleId: "internal-hostname",
    pattern: /\b(?:[a-z0-9-]+\.)+(?:internal|local|lan|corp|intranet)\b/gi,
    replacement: REDACTED,
  },
  {
    category: "infrastructure",
    ruleId: "file-paths",
    pattern: /(?:\b[A-Za-z]:\\+(?:[^\\\s]+\\+)*[^\\\s]+|\/(?:[^\/\s]+\/)+[^\/\s]+)/g,
    replacement: REDACTED,
  },
];

const emptyCounts = (): Record<SanitizationCategory, number> => ({
  obfuscation: 0,
  jailbreak: 0,
  roleLeakage: 0,
  scriptInjection: 0,
  secret: 0,
  pii: 0,
  infrastructure: 0,
});

const escapeSequencePattern = /(?:\\x[0-9a-fA-F]{2}|\\u[0-9a-fA-F]{4})+/g;

function applyObfuscationNormalization(text: string) {
  let out = text;
  let count = 0;

  const applyReplacement = (pattern: RegExp, replacement: string) => {
    const matches = out.match(pattern);
    if (matches?.length) {
      count += matches.length;
      out = out.replace(pattern, replacement);
    }
  };

  applyReplacement(/[\u200B-\u200D\uFEFF]/g, "");
  applyReplacement(/[\u202A-\u202E\u2066-\u2069]/g, "");
  applyReplacement(/([!?.,:;])\1{3,}/g, "$1$1$1");
  applyReplacement(escapeSequencePattern, REDACTED);
  applyReplacement(/`{4,}/g, "```");

  return { out, count };
}

function applyRule(text: string, rule: SanitizationRule) {
  const matches = text.match(rule.pattern);
  if (!matches?.length) {
    return { out: text, count: 0 };
  }

  return {
    out: text.replace(rule.pattern, rule.replacement),
    count: matches.length,
  };
}

function cleanupRedactionArtifacts(text: string) {
  return text
    .replace(/(?:\[redacted\]\s*){2,}/gi, `${REDACTED} `)
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function sanitizePrompt(text: string): SanitizationResult {
  const categoryCounts = emptyCounts();
  const events: SanitizationEvent[] = [];

  let out = typeof text === "string" ? text : "";
  const normalizedInput = out.replace(/\r\n?/g, "\n");
  let truncated = false;

  out = normalizedInput;
  if (out.length > MAX_PROMPT_LENGTH) {
    out = out.slice(0, MAX_PROMPT_LENGTH);
    truncated = true;
  }

  const obfuscation = applyObfuscationNormalization(out);
  out = obfuscation.out;
  if (obfuscation.count > 0) {
    categoryCounts.obfuscation += obfuscation.count;
    events.push({
      category: "obfuscation",
      ruleId: "normalization",
      count: obfuscation.count,
    });
  }

  for (const rule of rules) {
    const result = applyRule(out, rule);
    if (result.count > 0) {
      categoryCounts[rule.category] += result.count;
      events.push({
        category: rule.category,
        ruleId: rule.ruleId,
        count: result.count,
      });
      out = result.out;
    }
  }

  out = cleanupRedactionArtifacts(out);

  const totalRedactions = events.reduce((sum, event) => sum + event.count, 0);

  return {
    sanitizedText: out,
    events,
    categoryCounts,
    totalRedactions,
    normalized: out !== normalizedInput,
    truncated,
  };
}

export function formatSanitizationSummary(result: SanitizationResult) {
  if (!result.totalRedactions) {
    return "No unsafe pattern found";
  }

  const parts = Object.entries(result.categoryCounts)
    .filter(([, count]) => count > 0)
    .map(([category, count]) => `${category}:${count}`)
    .join(", ");

  return `Sanitized ${result.totalRedactions} match(es) (${parts})`;
}
