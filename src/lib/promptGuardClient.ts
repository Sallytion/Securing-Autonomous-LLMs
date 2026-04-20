const PROMPT_GUARD_API_BASE_URL =
  process.env.PROMPT_GUARD_API_BASE_URL?.trim() || 'https://capstone.sallytion.qzz.io';

const REQUEST_ERROR_BODY_LIMIT = 300;
const MALICIOUS_LABEL_PATTERN =
  /(malicious|unsafe|harmful|jailbreak|prompt[\s_-]?injection|label_1)/i;
const SAFE_LABEL_PATTERN = /(safe|benign|allowed|label_0)/i;

type PromptGuardChunk = {
  label?: string;
  score?: number;
};

type PromptGuardPredictResponse = {
  riskScore?: number;
  overall_label?: string;
  max_score?: number;
  chunks?: PromptGuardChunk[];
};

export const PROMPT_GUARD_MODELS = [
  'meta-llama/Llama-Prompt-Guard-2-22M',
  'fine_tuned_prompt_guard',
] as const;

export type PromptGuardModelId = (typeof PROMPT_GUARD_MODELS)[number];

export const DEFAULT_PROMPT_GUARD_MODEL: PromptGuardModelId = PROMPT_GUARD_MODELS[0];

function clamp01(value: number) {
  if (!Number.isFinite(value)) {
    return 0;
  }

  if (value < 0) {
    return 0;
  }

  if (value > 1) {
    return 1;
  }

  return value;
}

function scoreFromLabelAndConfidence(label: string | undefined, confidence: number | undefined) {
  if (typeof confidence !== 'number' || !Number.isFinite(confidence)) {
    return null;
  }

  const normalizedLabel = label?.trim() ?? '';
  const normalizedConfidence = clamp01(confidence);

  if (MALICIOUS_LABEL_PATTERN.test(normalizedLabel)) {
    return normalizedConfidence;
  }

  if (SAFE_LABEL_PATTERN.test(normalizedLabel)) {
    return 1 - normalizedConfidence;
  }

  return null;
}

function extractRiskScore(payload: PromptGuardPredictResponse) {
  if (typeof payload.riskScore === 'number') {
    return clamp01(payload.riskScore);
  }

  if (Array.isArray(payload.chunks) && payload.chunks.length > 0) {
    const chunkScores = payload.chunks
      .map((chunk) => scoreFromLabelAndConfidence(chunk.label, chunk.score))
      .filter((score): score is number => score !== null);

    if (chunkScores.length > 0) {
      return Math.max(...chunkScores);
    }
  }

  const overallScore = scoreFromLabelAndConfidence(payload.overall_label, payload.max_score);
  if (overallScore !== null) {
    return overallScore;
  }

  if (typeof payload.max_score === 'number') {
    return clamp01(payload.max_score);
  }

  return 0;
}

function isPromptGuardModelId(value: string): value is PromptGuardModelId {
  return (PROMPT_GUARD_MODELS as readonly string[]).includes(value);
}

export function resolvePromptGuardModelId(value: unknown) {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmedValue = value.trim();
  if (!trimmedValue) {
    return null;
  }

  return isPromptGuardModelId(trimmedValue) ? trimmedValue : null;
}

export async function scorePromptGuardText(text: string, modelId: PromptGuardModelId) {
  const response = await fetch(`${PROMPT_GUARD_API_BASE_URL}/predict`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model_id: modelId,
      text,
      device: 'cpu',
    }),
  });

  if (!response.ok) {
    let errorBody = '';

    try {
      errorBody = (await response.text()).slice(0, REQUEST_ERROR_BODY_LIMIT).trim();
    } catch {
      errorBody = '';
    }

    const details = errorBody ? ` ${errorBody}` : '';
    throw new Error(`Prompt Guard API request failed (${response.status}).${details}`);
  }

  const payload = (await response.json()) as PromptGuardPredictResponse;

  return {
    riskScore: extractRiskScore(payload),
    payload,
  };
}
