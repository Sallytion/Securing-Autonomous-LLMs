import { Groq } from 'groq-sdk';
import { NextRequest } from 'next/server';
import { formatSanitizationSummary, sanitizePrompt } from '@/lib/promptSanitizer';

const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY,
});

export async function POST(request: NextRequest) {
  const body = await request.json();
  const message = body?.message;

  if (!message || typeof message !== 'string') {
    return new Response(JSON.stringify({ error: 'Message is required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const sanitized = sanitizePrompt(message);

  const completion = await groq.chat.completions.create({
    messages: [
      {
        role: 'user',
        content: sanitized.sanitizedText,
      },
    ],
    model: 'meta-llama/llama-prompt-guard-2-22m',
    temperature: 1,
    max_completion_tokens: 1,
    top_p: 1,
    stream: false,
    stop: null,
  });

  const riskScore = parseFloat(completion.choices[0]?.message?.content ?? '0') || 0;

  return new Response(
    JSON.stringify({
      riskScore,
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
}
