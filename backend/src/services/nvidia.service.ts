/**
 * NVIDIA NIM Service
 * OpenAI-compatible API endpoint for NVIDIA hosted models (e.g. kimi-k2.5)
 * Docs: https://build.nvidia.com/docs
 */

import { config } from '../config.js';
import { logger } from '../logger.js';
import type { LlmProvider, LlmMessage, ToolDefinition, ToolCall, ChatResult } from './llm.types.js';

const NVIDIA_BASE_URL = 'https://integrate.api.nvidia.com/v1';

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---- OpenAI-compatible response types ----------------------------------------

interface OpenAIToolCall {
    id: string;
    type: 'function';
    function: {
        name: string;
        arguments: string;
    };
}

interface OpenAIMessage {
    role: string;
    content: string | null;
    tool_calls?: OpenAIToolCall[];
}

interface OpenAIChoice {
    message: OpenAIMessage;
    finish_reason: string;
}

interface OpenAIResponse {
    choices?: OpenAIChoice[];
    error?: { message: string; type: string; code: string };
}

// ---- Message conversion -------------------------------------------------------

function toOpenAIMessages(messages: LlmMessage[]): Record<string, unknown>[] {
    const result: Record<string, unknown>[] = [];

    for (const msg of messages) {
        switch (msg.role) {
            case 'system':
                result.push({ role: 'system', content: msg.content });
                break;

            case 'user': {
                const content = msg.imageAttachment
                    ? [
                        { type: 'text' as const, text: msg.content || 'What do you see in this image?' },
                        {
                            type: 'image_url' as const,
                            image_url: {
                                url: `data:${msg.imageAttachment.mimeType};base64,${msg.imageAttachment.base64}`,
                            },
                        },
                    ]
                    : msg.content;
                result.push({ role: 'user', content });
                break;
            }

            case 'assistant': {
                const entry: Record<string, unknown> = {
                    role: 'assistant',
                    content: msg.content ?? null,
                };
                if (msg.toolCalls && msg.toolCalls.length > 0) {
                    entry.tool_calls = msg.toolCalls.map((tc, i) => ({
                        id: tc.id ?? `call_${i}`,
                        type: 'function',
                        function: {
                            name: tc.function.name,
                            arguments: JSON.stringify(tc.function.arguments),
                        },
                    }));
                }
                result.push(entry);
                break;
            }

            case 'tool':
                result.push({
                    role: 'tool',
                    tool_call_id: msg.toolCallId ?? 'call_0',
                    name: msg.toolName ?? 'unknown',
                    content: msg.content,
                });
                break;
        }
    }

    return result;
}

function toOpenAITools(tools: ToolDefinition[]): Record<string, unknown>[] {
    return tools.map((t) => ({
        type: 'function',
        function: {
            name: t.function.name,
            description: t.function.description,
            parameters: t.function.parameters,
        },
    }));
}

function parseOpenAIResponse(data: OpenAIResponse): ChatResult {
    if (data.error) {
        throw new Error(`NVIDIA API error [${data.error.code}]: ${data.error.message}`);
    }

    const message = data.choices?.[0]?.message;
    if (!message) throw new Error('NVIDIA API returned empty response');

    const content = message.content ?? '';
    const toolCalls: ToolCall[] = (message.tool_calls ?? []).map((tc) => ({
        id: tc.id,
        function: {
            name: tc.function.name,
            arguments: (() => {
                try {
                    return JSON.parse(tc.function.arguments) as Record<string, unknown>;
                } catch {
                    return {};
                }
            })(),
        },
    }));

    return { content, toolCalls };
}

// ---- Service class ------------------------------------------------------------

export class NvidiaService implements LlmProvider {
    readonly name = 'nvidia';

    async chat(messages: LlmMessage[], tools: ToolDefinition[]): Promise<ChatResult> {
        const apiKey = config.nvidiaApiKey;
        if (!apiKey) throw new Error('NVIDIA_API_KEY is not configured');

        const openAIMessages = toOpenAIMessages(messages);
        const openAITools = tools.length > 0 ? toOpenAITools(tools) : undefined;

        const body: Record<string, unknown> = {
            model: config.nvidiaModel,
            messages: openAIMessages,
            max_tokens: config.nvidiaMaxTokens,
            temperature: 1.0,
            top_p: 1.0,
            stream: false,
        };

        if (openAITools) {
            body.tools = openAITools;
            body.tool_choice = 'auto';
        }

        const max429Retries = config.nvidia429MaxRetries;
        const delayAfter429Ms = config.nvidia429BackoffMs;
        const startedAt = Date.now();

        logger.info(
            { model: config.nvidiaModel, toolCount: tools.length, msgCount: messages.length },
            'Sending request to NVIDIA NIM'
        );

        for (let attempt = 0; attempt <= max429Retries; attempt++) {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), config.nvidiaTimeoutMs);

            try {
                const response = await fetch(`${NVIDIA_BASE_URL}/chat/completions`, {
                    method: 'POST',
                    headers: {
                        Authorization: `Bearer ${apiKey}`,
                        'Content-Type': 'application/json',
                        Accept: 'application/json',
                    },
                    body: JSON.stringify(body),
                    signal: controller.signal,
                });

                if (response.status === 429 && attempt < max429Retries) {
                    await response.text();
                    logger.warn(
                        { attempt: attempt + 1, max429Retries, delayMs: delayAfter429Ms },
                        'NVIDIA NIM rate limited (429), waiting before retry'
                    );
                    await sleep(delayAfter429Ms);
                    continue;
                }

                if (!response.ok) {
                    const text = await response.text();
                    const attemptsNote =
                        response.status === 429 && max429Retries > 0
                            ? ` (after ${max429Retries + 1} attempts)`
                            : '';
                    throw new Error(`NVIDIA HTTP ${response.status}: ${text}${attemptsNote}`);
                }

                const data = (await response.json()) as OpenAIResponse;
                const result = parseOpenAIResponse(data);

                logger.info(
                    {
                        durationMs: Date.now() - startedAt,
                        contentLen: result.content.length,
                        toolCallCount: result.toolCalls.length,
                    },
                    'NVIDIA NIM response received'
                );

                return result;
            } catch (error) {
                if (error instanceof Error && error.name === 'AbortError') {
                    throw new Error(`NVIDIA request timed out after ${config.nvidiaTimeoutMs}ms`);
                }
                throw error;
            } finally {
                clearTimeout(timeout);
            }
        }

        throw new Error('NVIDIA NIM: retry loop exited unexpectedly');
    }

    async healthCheck(): Promise<boolean> {
        if (!config.nvidiaApiKey) return false;
        try {
            // Check models endpoint — lightweight ping
            const response = await fetch(`${NVIDIA_BASE_URL}/models`, {
                headers: { Authorization: `Bearer ${config.nvidiaApiKey}` },
                signal: AbortSignal.timeout(5000),
            });
            return response.ok;
        } catch {
            return false;
        }
    }
}

export const nvidiaService = new NvidiaService();
