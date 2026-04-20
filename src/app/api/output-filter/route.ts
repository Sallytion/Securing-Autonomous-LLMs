import { NextRequest } from 'next/server';
import {
  DEFAULT_PROMPT_GUARD_MODEL,
  PROMPT_GUARD_MODELS,
  resolvePromptGuardModelId,
  scorePromptGuardText,
} from '@/lib/promptGuardClient';

const OUTPUT_FILTER_THRESHOLD = 0.5;
const OUTPUT_FILTER_MAX_WORDS = 500;
const OUTPUT_FILTER_MAX_CHARS = 3500;

function truncateForOutputFilter(text: string) {
  const normalized = text.trim().replace(/\s+/g, ' ');
  const words = normalized ? normalized.split(' ') : [];

  const limitedWords = words.slice(0, OUTPUT_FILTER_MAX_WORDS);
  let limitedText = limitedWords.join(' ');

  if (limitedText.length > OUTPUT_FILTER_MAX_CHARS) {
    limitedText = limitedText.slice(0, OUTPUT_FILTER_MAX_CHARS).trimEnd();
  }

  return {
    text: limitedText,
    originalWordCount: words.length,
    truncated: words.length > OUTPUT_FILTER_MAX_WORDS || normalized.length > OUTPUT_FILTER_MAX_CHARS,
  };
}

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

  const prepared = truncateForOutputFilter(message);

  if (!prepared.text) {
    return new Response(
      JSON.stringify({
        riskScore: 0,
        threshold: OUTPUT_FILTER_THRESHOLD,
        allowed: true,
        truncated: false,
        wordsAnalyzed: 0,
        modelId,
      }),
      {
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }

  try {
    const { riskScore } = await scorePromptGuardText(prepared.text, modelId);

    return new Response(
      JSON.stringify({
        riskScore,
        threshold: OUTPUT_FILTER_THRESHOLD,
        allowed: riskScore <= OUTPUT_FILTER_THRESHOLD,
        truncated: prepared.truncated,
        wordsAnalyzed: Math.min(prepared.originalWordCount, OUTPUT_FILTER_MAX_WORDS),
        originalWordCount: prepared.originalWordCount,
        modelId,
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
