import { NextRequest } from 'next/server';
import { formatSanitizationSummary, sanitizePrompt } from '@/lib/promptSanitizer';
import {
  DEFAULT_PROMPT_GUARD_MODEL,
  PROMPT_GUARD_MODELS,
  resolvePromptGuardModelId,
  scorePromptGuardText,
} from '@/lib/promptGuardClient';

export async function POST(request: NextRequest) {
  const body = await request.json();
  const message = body?.message;
  const requestedModelId = body?.modelId;

  const resolvedModelId = resolvePromptGuardModelId(requestedModelId);
  if (requestedModelId !== undefined && resolvedModelId === null) {
    return new Response(
      JSON.stringify({
        error: `Invalid modelId. Allowed values: ${PROMPT_GUARD_MODELS.join(', ')}`,
      }),
      {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }

  const modelId = resolvedModelId ?? DEFAULT_PROMPT_GUARD_MODEL;

  if (!message || typeof message !== 'string') {
    return new Response(JSON.stringify({ error: 'Message is required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const sanitized = sanitizePrompt(message);
  try {
    const { riskScore } = await scorePromptGuardText(sanitized.sanitizedText, modelId);

    return new Response(
      JSON.stringify({
        riskScore,
        modelId,
        sanitizedMessage: sanitized.sanitizedText,
        sanitizationSummary: formatSanitizationSummary(sanitized),
        sanitizationMeta: {
          totalRedactions: sanitized.totalRedactions,
          categoryCounts: sanitized.categoryCounts,
          truncated: sanitized.truncated,
        },
      }),
      {
        headers: { 'Content-Type': 'application/json' },
      }
    );
  } catch (error) {
    return new Response(
      JSON.stringify({
        error:
          error instanceof Error
            ? error.message
            : 'Prompt Guard request failed',
      }),
      {
        status: 502,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
}
