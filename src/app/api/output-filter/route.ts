import { Groq } from 'groq-sdk';
import { NextRequest } from 'next/server';

const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY,
});

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
      }),
      {
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }

  const completion = await groq.chat.completions.create({
    messages: [
      {
        role: 'user',
        content: prepared.text,
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
      threshold: OUTPUT_FILTER_THRESHOLD,
      allowed: riskScore <= OUTPUT_FILTER_THRESHOLD,
      truncated: prepared.truncated,
      wordsAnalyzed: Math.min(prepared.originalWordCount, OUTPUT_FILTER_MAX_WORDS),
      originalWordCount: prepared.originalWordCount,
    }),
    {
      headers: { 'Content-Type': 'application/json' },
    }
  );
}
