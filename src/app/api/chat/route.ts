import { Groq } from 'groq-sdk';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { sanitizePrompt } from '@/lib/promptSanitizer';
import {
  executeFileTool,
  fileToolDefinitions,
} from '@/lib/fileTools';
import {
  executeWebTool,
  webToolDefinitions,
} from '@/lib/webTools';
import type {
  ChatCompletionAssistantMessageParam,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from 'groq-sdk/resources/chat/completions';

const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY,
});

const model = 'llama-3.1-8b-instant';
const tools = [
  ...webToolDefinitions,
  ...fileToolDefinitions,
] as unknown as ChatCompletionTool[];
const maxToolRounds = 3;
const promptFileCandidates = [
  path.join(process.cwd(), 'system', 'prompt.txt'),
  path.join(process.cwd(), 'System', 'prompt.txt'),
];

type PromptTemplateKey =
  | 'agent_base'
  | 'search_direct'
  | 'search_followup'
  | 'file_followup'
  | 'tool_fallback';

type PromptTemplates = Record<PromptTemplateKey, string>;

const requiredPromptTemplateKeys: PromptTemplateKey[] = [
  'agent_base',
  'search_direct',
  'search_followup',
  'file_followup',
  'tool_fallback',
];

async function readPromptTemplateFile() {
  for (const candidatePath of promptFileCandidates) {
    try {
      return await readFile(candidatePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  }

  const checkedPaths = promptFileCandidates
    .map((candidatePath) => path.relative(process.cwd(), candidatePath))
    .join(', ');

  throw new Error(`Prompt file not found. Checked: ${checkedPaths}`);
}

function parsePromptTemplates(fileContent: string): PromptTemplates {
  const templates: Partial<PromptTemplates> = {};
  const sectionPattern = /\[\[([a-z_]+)\]\]\r?\n([\s\S]*?)\r?\n\[\[\/\1\]\]/g;
  let match: RegExpExecArray | null;

  while ((match = sectionPattern.exec(fileContent)) !== null) {
    const key = match[1] as PromptTemplateKey;

    if (requiredPromptTemplateKeys.includes(key)) {
      templates[key] = match[2].trim();
    }
  }

  const missingKeys = requiredPromptTemplateKeys.filter((key) => !templates[key]);
  if (missingKeys.length > 0) {
    throw new Error(`Missing prompt template sections: ${missingKeys.join(', ')}`);
  }

  return templates as PromptTemplates;
}

async function getPromptTemplates() {
  const promptFileContent = await readPromptTemplateFile();
  return parsePromptTemplates(promptFileContent);
}

function renderPromptTemplate(template: string, replacements: Record<string, string>) {
  return Object.entries(replacements).reduce(
    (output, [key, value]) => output.replaceAll(`{{${key}}}`, value),
    template
  );
}

function getSandboxStatusPrompt(sandboxEnabled: boolean) {
  return sandboxEnabled
    ? 'Filesystem sandboxing is ON: file tools may only access files inside the app temp folder.'
    : 'Filesystem sandboxing is OFF: file tools may access any path allowed by the operating system and Node.js process.';
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  const messages = body?.messages;
  const sandboxEnabled = body?.sandboxEnabled === true;
  const hitlEnabled = body?.hitlEnabled === true;
  const hitlDecision = body?.hitlDecision;

  let promptTemplates: PromptTemplates;

  try {
    promptTemplates = await getPromptTemplates();
  } catch (error) {
    return new Response(
      error instanceof Error
        ? `Failed to load system prompts: ${error.message}`
        : 'Failed to load system prompts',
      { status: 500 }
    );
  }

  if (isHitlDecision(hitlDecision)) {
    return hitlDecisionEventStream(hitlDecision, promptTemplates);
  }

  if (!Array.isArray(messages) || messages.length === 0) {
    return new Response('Messages array is required', { status: 400 });
  }

  const normalizedMessages: ChatCompletionMessageParam[] = [
    {
      role: 'system',
      content: renderPromptTemplate(promptTemplates.agent_base, {
        FILESYSTEM_SANDBOX_STATUS: getSandboxStatusPrompt(sandboxEnabled),
      }),
    },
  ];
  let latestUserContent = '';

  for (const message of messages) {
    const role = message?.role;
    const content = message?.content;

    if ((role !== 'user' && role !== 'assistant' && role !== 'system') || typeof content !== 'string') {
      return new Response('Invalid message shape', { status: 400 });
    }

    if (role === 'user') {
      latestUserContent = content;
      const hasUrl = /https?:\/\/\S+/i.test(content);
      const safeContent = hasUrl || hasFileToolIntent(content)
        ? content
        : sanitizePrompt(content).sanitizedText;
      normalizedMessages.push({ role, content: safeContent });
      continue;
    }

    normalizedMessages.push({ role, content });
  }

  return toolEventStream(
    normalizedMessages,
    latestUserContent,
    sandboxEnabled,
    promptTemplates,
    hitlEnabled
  );
}

type ChatEvent =
  | { type: 'status'; message: string }
  | { type: 'answer'; content: string }
  | { type: 'error'; message: string }
  | {
      type: 'tool_approval_required';
      approvalId: string;
      toolName: string;
      toolArguments: string;
      message: string;
    };

type PendingToolCall = {
  id: string;
  name: string;
  arguments: string;
};

type PendingHitlApproval = {
  normalizedMessages: ChatCompletionMessageParam[];
  latestUserContent: string;
  sandboxEnabled: boolean;
  round: number;
  usedSearchTool: boolean;
  usedFileTool: boolean;
  currentToolCall: PendingToolCall;
  remainingToolCalls: PendingToolCall[];
};

type HitlDecision = {
  approvalId: string;
  allow: boolean;
};

type PendingDirectSearchApproval = {
  normalizedMessages: ChatCompletionMessageParam[];
  directSearchQuery: string;
};

const pendingHitlApprovals = new Map<string, PendingHitlApproval>();
const pendingDirectSearchApprovals = new Map<string, PendingDirectSearchApproval>();

function shouldRunSearchDirectly(userText: string) {
  return /\b(search|web search|look up|latest news|latest updates|find news)\b/i.test(userText);
}

function getDirectSearchQuery(userText: string) {
  return userText
    .replace(/^\/search\s+/i, '')
    .replace(/\b(can you|please|search|web search|look up|tell me|about)\b/gi, ' ')
    .replace(/[?]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim() || userText.trim();
}

function hasFileToolIntent(userText: string) {
  return (
    /\b(file|folder|directory|read|write|list|filesystem|temp)\b/i.test(userText) ||
    /(?:[A-Za-z]:\\|\/[^/\s]+\/|\.\.?[\\/])/.test(userText)
  );
}

function isHitlDecision(value: unknown): value is HitlDecision {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const maybeDecision = value as Record<string, unknown>;
  return (
    typeof maybeDecision.approvalId === 'string' &&
    maybeDecision.approvalId.length > 0 &&
    typeof maybeDecision.allow === 'boolean'
  );
}

function isFileTool(toolName: string) {
  return toolName === 'file_read' || toolName === 'file_write' || toolName === 'file_list';
}

async function executeTool(toolName: string, rawArguments: string, sandboxEnabled: boolean) {
  if (isFileTool(toolName)) {
    return executeFileTool(toolName, rawArguments, { sandboxEnabled });
  }

  return executeWebTool(toolName, rawArguments);
}

function queueToolApproval(
  send: (event: ChatEvent) => void,
  pendingApproval: PendingHitlApproval
) {
  const approvalId = crypto.randomUUID();
  pendingHitlApprovals.set(approvalId, pendingApproval);

  send({
    type: 'tool_approval_required',
    approvalId,
    toolName: pendingApproval.currentToolCall.name,
    toolArguments: pendingApproval.currentToolCall.arguments,
    message: `HITL approval required for tool: ${pendingApproval.currentToolCall.name}`,
  });
}

function createDeniedToolContent(toolName: string) {
  return JSON.stringify({
    denied: true,
    tool: toolName,
    message: `Tool execution denied by the user for ${toolName}.`,
  });
}

async function finalizeAfterToolRound(
  normalizedMessages: ChatCompletionMessageParam[],
  usedSearchTool: boolean,
  usedFileTool: boolean,
  promptTemplates: PromptTemplates,
  send: (event: ChatEvent) => void
) {
  if (usedSearchTool) {
    send({ type: 'status', message: 'Preparing final answer' });
    normalizedMessages.push({
      role: 'system',
      content: promptTemplates.search_followup,
    });

    const finalCompletion = await groq.chat.completions.create({
      messages: normalizedMessages,
      model,
      temperature: 0.4,
      max_completion_tokens: 1024,
      top_p: 1,
      stream: false,
      stop: null,
    });

    send({
      type: 'answer',
      content: finalCompletion.choices[0]?.message?.content ?? '',
    });
    return true;
  }

  if (usedFileTool) {
    send({ type: 'status', message: 'Preparing final answer' });
    normalizedMessages.push({
      role: 'system',
      content: promptTemplates.file_followup,
    });

    const finalCompletion = await groq.chat.completions.create({
      messages: normalizedMessages,
      model,
      temperature: 0.4,
      max_completion_tokens: 1024,
      top_p: 1,
      stream: false,
      stop: null,
    });

    send({
      type: 'answer',
      content: finalCompletion.choices[0]?.message?.content ?? '',
    });
    return true;
  }

  return false;
}

async function runToolRounds({
  normalizedMessages,
  latestUserContent,
  sandboxEnabled,
  promptTemplates,
  hitlEnabled,
  startRound,
  send,
}: {
  normalizedMessages: ChatCompletionMessageParam[];
  latestUserContent: string;
  sandboxEnabled: boolean;
  promptTemplates: PromptTemplates;
  hitlEnabled: boolean;
  startRound: number;
  send: (event: ChatEvent) => void;
}) {
  for (let round = startRound; round < maxToolRounds; round += 1) {
    const completion = await groq.chat.completions.create({
      messages: normalizedMessages,
      model,
      temperature: 1,
      max_completion_tokens: 1024,
      top_p: 1,
      stream: false,
      stop: null,
      tools,
      tool_choice: 'auto',
      parallel_tool_calls: true,
    });

    const assistantMessage = completion.choices[0]?.message;
    const toolCalls = assistantMessage?.tool_calls ?? [];

    if (!toolCalls.length) {
      send({ type: 'answer', content: assistantMessage?.content ?? '' });
      return;
    }

    normalizedMessages.push({
      role: 'assistant',
      content: assistantMessage.content ?? null,
      tool_calls: toolCalls,
    } satisfies ChatCompletionAssistantMessageParam);

    const usedSearchTool = toolCalls.some(
      (toolCall) => toolCall.function.name === 'web_search'
    );
    const usedFileTool = toolCalls.some(
      (toolCall) => isFileTool(toolCall.function.name)
    );

    if (hitlEnabled) {
      const pendingToolCalls = toolCalls.map((toolCall) => ({
        id: toolCall.id,
        name: toolCall.function.name,
        arguments: toolCall.function.arguments,
      }));

      const [currentToolCall, ...remainingToolCalls] = pendingToolCalls;
      queueToolApproval(send, {
        normalizedMessages,
        latestUserContent,
        sandboxEnabled,
        round,
        usedSearchTool,
        usedFileTool,
        currentToolCall,
        remainingToolCalls,
      });
      return;
    }

    const toolResults = await Promise.all(
      toolCalls.map(async (toolCall) => {
        send({
          type: 'status',
          message: `Running tool: ${toolCall.function.name}`,
        });

        return {
          role: 'tool' as const,
          tool_call_id: toolCall.id,
          content: await executeTool(
            toolCall.function.name,
            toolCall.function.arguments,
            sandboxEnabled
          ),
        };
      })
    );

    normalizedMessages.push(...toolResults);

    const finalized = await finalizeAfterToolRound(
      normalizedMessages,
      usedSearchTool,
      usedFileTool,
      promptTemplates,
      send
    );

    if (finalized) {
      return;
    }
  }

  send({ type: 'status', message: 'Preparing final answer' });
  normalizedMessages.push({
    role: 'system',
    content: promptTemplates.tool_fallback,
  });

  const fallbackCompletion = await groq.chat.completions.create({
    messages: normalizedMessages,
    model,
    temperature: 1,
    max_completion_tokens: 1024,
    top_p: 1,
    stream: false,
    stop: null,
  });

  send({
    type: 'answer',
    content: fallbackCompletion.choices[0]?.message?.content ?? '',
  });
}

function toolEventStream(
  normalizedMessages: ChatCompletionMessageParam[],
  latestUserContent: string,
  sandboxEnabled: boolean,
  promptTemplates: PromptTemplates,
  hitlEnabled: boolean
) {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: ChatEvent) => {
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      };

      try {
        if (shouldRunSearchDirectly(latestUserContent)) {
          const directSearchQuery = getDirectSearchQuery(latestUserContent);

          if (hitlEnabled) {
            const approvalId = crypto.randomUUID();
            pendingDirectSearchApprovals.set(approvalId, {
              normalizedMessages,
              directSearchQuery,
            });

            send({
              type: 'tool_approval_required',
              approvalId,
              toolName: 'web_search',
              toolArguments: JSON.stringify({ query: directSearchQuery }),
              message: 'HITL approval required for tool: web_search',
            });
            controller.close();
            return;
          }

          send({ type: 'status', message: 'Running tool: web_search' });
          const toolContent = await executeWebTool(
            'web_search',
            JSON.stringify({ query: directSearchQuery })
          );

          normalizedMessages.push({
            role: 'system',
            content: renderPromptTemplate(promptTemplates.search_direct, {
              TOOL_OUTPUT: toolContent,
            }),
          });

          send({ type: 'status', message: 'Preparing final answer' });
          const finalCompletion = await groq.chat.completions.create({
            messages: normalizedMessages,
            model,
            temperature: 0.4,
            max_completion_tokens: 1024,
            top_p: 1,
            stream: false,
            stop: null,
          });

          send({
            type: 'answer',
            content: finalCompletion.choices[0]?.message?.content ?? '',
          });
          controller.close();
          return;
        }

        await runToolRounds({
          normalizedMessages,
          latestUserContent,
          sandboxEnabled,
          promptTemplates,
          hitlEnabled,
          startRound: 0,
          send,
        });

        controller.close();
      } catch (error) {
        send({
          type: 'error',
          message: error instanceof Error ? error.message : 'Unknown chat error',
        });
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-cache',
    },
  });
}

function hitlDecisionEventStream(
  hitlDecision: HitlDecision,
  promptTemplates: PromptTemplates
) {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: ChatEvent) => {
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      };

      try {
        const pendingDirectSearch = pendingDirectSearchApprovals.get(hitlDecision.approvalId);
        if (pendingDirectSearch) {
          pendingDirectSearchApprovals.delete(hitlDecision.approvalId);

          if (!hitlDecision.allow) {
            send({
              type: 'status',
              message: 'Tool denied by user: web_search',
            });
            send({
              type: 'answer',
              content: 'Tool execution denied by user for web_search. Approve the tool to run the search.',
            });
            controller.close();
            return;
          }

          send({
            type: 'status',
            message: 'Running approved tool: web_search',
          });

          const toolContent = await executeWebTool(
            'web_search',
            JSON.stringify({ query: pendingDirectSearch.directSearchQuery })
          );

          pendingDirectSearch.normalizedMessages.push({
            role: 'system',
            content: renderPromptTemplate(promptTemplates.search_direct, {
              TOOL_OUTPUT: toolContent,
            }),
          });

          send({ type: 'status', message: 'Preparing final answer' });
          const finalCompletion = await groq.chat.completions.create({
            messages: pendingDirectSearch.normalizedMessages,
            model,
            temperature: 0.4,
            max_completion_tokens: 1024,
            top_p: 1,
            stream: false,
            stop: null,
          });

          send({
            type: 'answer',
            content: finalCompletion.choices[0]?.message?.content ?? '',
          });
          controller.close();
          return;
        }

        const pendingApproval = pendingHitlApprovals.get(hitlDecision.approvalId);
        if (!pendingApproval) {
          send({
            type: 'error',
            message: 'Invalid or expired HITL approval request.',
          });
          controller.close();
          return;
        }

        pendingHitlApprovals.delete(hitlDecision.approvalId);

        let toolContent = '';
        if (hitlDecision.allow) {
          send({
            type: 'status',
            message: `Running approved tool: ${pendingApproval.currentToolCall.name}`,
          });
          toolContent = await executeTool(
            pendingApproval.currentToolCall.name,
            pendingApproval.currentToolCall.arguments,
            pendingApproval.sandboxEnabled
          );
        } else {
          send({
            type: 'status',
            message: `Tool denied by user: ${pendingApproval.currentToolCall.name}`,
          });
          toolContent = createDeniedToolContent(pendingApproval.currentToolCall.name);
        }

        pendingApproval.normalizedMessages.push({
          role: 'tool' as const,
          tool_call_id: pendingApproval.currentToolCall.id,
          content: toolContent,
        });

        if (pendingApproval.remainingToolCalls.length > 0) {
          const [nextToolCall, ...remainingToolCalls] = pendingApproval.remainingToolCalls;
          queueToolApproval(send, {
            ...pendingApproval,
            currentToolCall: nextToolCall,
            remainingToolCalls,
          });
          controller.close();
          return;
        }

        const finalized = await finalizeAfterToolRound(
          pendingApproval.normalizedMessages,
          pendingApproval.usedSearchTool,
          pendingApproval.usedFileTool,
          promptTemplates,
          send
        );

        if (!finalized) {
          await runToolRounds({
            normalizedMessages: pendingApproval.normalizedMessages,
            latestUserContent: pendingApproval.latestUserContent,
            sandboxEnabled: pendingApproval.sandboxEnabled,
            promptTemplates,
            hitlEnabled: true,
            startRound: pendingApproval.round + 1,
            send,
          });
        }

        controller.close();
      } catch (error) {
        send({
          type: 'error',
          message: error instanceof Error ? error.message : 'Unknown chat error',
        });
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-cache',
    },
  });
}
