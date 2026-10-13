/**
 * Prompt Renderer
 *
 * Transforms PromptSpec objects from the DSPy service into Claude API message format.
 * Handles template interpolation, few-shot demo formatting, and message structuring.
 */

import { PromptSpec, ConversationSummary, RetrievedChunk } from "./dspy-service";

/**
 * Context for rendering templates
 */
export interface RenderContext {
  userRequest: string;
  currentCode: string | null;
  conversationSummary: ConversationSummary | null;
  retrievedChunks: RetrievedChunk[];
  dialect: string;
}

/**
 * Claude message format
 */
export interface ClaudeMessage {
  role: "user" | "assistant";
  content: string;
}

/**
 * Rendered prompt result ready for Claude API
 */
export interface RenderedPrompt {
  systemPrompt: string;
  messages: ClaudeMessage[];
}

/**
 * Render a PromptSpec to Claude messages format
 *
 * @param spec - The PromptSpec from DSPy service
 * @param context - The context for template rendering
 * @returns Rendered prompt with system and messages
 */
export function renderPromptSpecToMessages(
  spec: PromptSpec,
  context: RenderContext
): RenderedPrompt {
  // Build the system prompt from system and developer instructions
  let systemPrompt = spec.systemInstructions;

  // Add developer instructions if present
  if (spec.developerInstructions) {
    systemPrompt += "\n\n" + spec.developerInstructions;
  }

  // Build messages array
  const messages: ClaudeMessage[] = [];

  // Add few-shot demos as user/assistant message pairs
  for (const demo of spec.fewShotDemos) {
    messages.push({
      role: "user",
      content: demo.prompt,
    });
    messages.push({
      role: "assistant",
      content: formatCodeResponse(demo.code),
    });
  }

  // Render the user template with context
  const userContent = renderUserTemplate(spec.userTemplate, context);

  messages.push({
    role: "user",
    content: userContent,
  });

  return {
    systemPrompt,
    messages,
  };
}

/**
 * Render a user template by filling in tagged sections
 *
 * Templates use tags like:
 * - {user_request} - The user's current request
 * - {current_code} - The current code (if any)
 * - {conversation_summary} - Summary of conversation history
 * - {retrieved_context} - Retrieved similar examples
 * - {output_format} - Instructions for output format
 *
 * @param template - The template string with tags
 * @param context - The context for filling tags
 * @returns Rendered template string
 */
export function renderUserTemplate(
  template: string,
  context: RenderContext
): string {
  let rendered = template;

  // Replace {user_request}
  rendered = rendered.replace(/\{user_request\}/gi, context.userRequest);

  // Replace {current_code}
  if (context.currentCode) {
    rendered = rendered.replace(
      /\{current_code\}/gi,
      "```\n" + context.currentCode + "\n```"
    );
  } else {
    rendered = rendered.replace(/\{current_code\}/gi, "(no current code)");
  }

  // Replace {conversation_summary}
  if (context.conversationSummary) {
    const summary = formatConversationSummary(context.conversationSummary);
    rendered = rendered.replace(/\{conversation_summary\}/gi, summary);
  } else {
    rendered = rendered.replace(
      /\{conversation_summary\}/gi,
      "(first turn of conversation)"
    );
  }

  // Replace {retrieved_context}
  if (context.retrievedChunks && context.retrievedChunks.length > 0) {
    const retrievedContext = formatRetrievedContext(context.retrievedChunks);
    rendered = rendered.replace(/\{retrieved_context\}/gi, retrievedContext);
  } else {
    rendered = rendered.replace(
      /\{retrieved_context\}/gi,
      "(no similar examples found)"
    );
  }

  // Replace {dialect}
  rendered = rendered.replace(/\{dialect\}/gi, context.dialect);

  return rendered;
}

/**
 * Format a code response with markdown code blocks
 *
 * @param code - The code to format
 * @returns Formatted code string
 */
function formatCodeResponse(code: string): string {
  // Ensure code is wrapped in code blocks
  if (!code.includes("```")) {
    return "```\n" + code.trim() + "\n```";
  }
  return code;
}

/**
 * Format conversation summary for template
 *
 * @param summary - The conversation summary
 * @returns Formatted summary string
 */
function formatConversationSummary(summary: ConversationSummary): string {
  let text = `Turn ${summary.turnCount} of conversation.`;

  if (summary.previousRequests && summary.previousRequests.length > 0) {
    text += "\n\nPrevious requests:";
    for (const req of summary.previousRequests.slice(-3)) {
      // Last 3 requests
      text += `\n- ${req}`;
    }
  }

  return text;
}

/**
 * Format retrieved context chunks for template
 *
 * @param chunks - The retrieved chunks
 * @returns Formatted context string
 */
function formatRetrievedContext(chunks: RetrievedChunk[]): string {
  if (!chunks || chunks.length === 0) {
    return "(no similar examples)";
  }

  const parts: string[] = [];

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    let part = `Example ${i + 1}:`;

    if (chunk.prompt) {
      part += `\nPrompt: ${chunk.prompt}`;
    }

    if (chunk.code) {
      part += `\nCode:\n\`\`\`\n${chunk.code}\n\`\`\``;
    }

    if (chunk.similarity !== undefined) {
      part += `\n(similarity: ${(chunk.similarity * 100).toFixed(1)}%)`;
    }

    parts.push(part);
  }

  return parts.join("\n\n");
}

/**
 * Build a default user template when DSPy service is unavailable
 *
 * @returns Default user template string
 */
export function buildDefaultUserTemplate(): string {
  return `<USER_REQUEST>
{user_request}

<CURRENT_CODE>
{current_code}

<CONVERSATION_SUMMARY>
{conversation_summary}

<RETRIEVED_CONTEXT>
{retrieved_context}

<OUTPUT_FORMAT>
Return ONLY Graffiticode between triple backticks. Must end with ".."`;
}

/**
 * Convert a legacy formatted prompt to the new message format
 *
 * This is used when falling back from DSPy to legacy prompt construction.
 * It extracts system prompt and messages from the JSON-formatted prompt.
 *
 * @param legacyPrompt - The legacy JSON-formatted prompt string
 * @returns Rendered prompt object
 */
export function convertLegacyPromptToRendered(
  legacyPrompt: string
): RenderedPrompt | null {
  try {
    const parsed = JSON.parse(legacyPrompt);

    return {
      systemPrompt: parsed.system || "",
      messages: (parsed.messages || []).map((msg: any) => ({
        role: msg.role,
        content: msg.content,
      })),
    };
  } catch (error) {
    console.warn("Failed to parse legacy prompt:", error);
    return null;
  }
}

/**
 * Merge PromptSpec with legacy examples
 *
 * When DSPy provides a PromptSpec but we also have legacy RAG examples,
 * this function merges them appropriately.
 *
 * @param spec - The PromptSpec from DSPy
 * @param legacyExamples - Legacy examples from RAG
 * @returns Updated PromptSpec with merged examples
 */
export function mergeWithLegacyExamples(
  spec: PromptSpec,
  legacyExamples: Array<{ task?: string; prompt?: string; code: string }>
): PromptSpec {
  // Convert legacy examples to FewShotDemo format
  const additionalDemos = legacyExamples
    .filter((ex) => ex.code && (ex.task || ex.prompt))
    .map((ex) => ({
      prompt: ex.task || ex.prompt || "",
      code: ex.code,
    }));

  // Merge with existing demos, avoiding duplicates
  const existingPrompts = new Set(spec.fewShotDemos.map((d) => d.prompt));
  const uniqueAdditionalDemos = additionalDemos.filter(
    (d) => !existingPrompts.has(d.prompt)
  );

  return {
    ...spec,
    fewShotDemos: [...spec.fewShotDemos, ...uniqueAdditionalDemos],
  };
}

/**
 * Format PromptSpec for logging (redacts long content)
 *
 * @param spec - The PromptSpec to format
 * @returns Loggable object with truncated content
 */
export function formatPromptSpecForLog(
  spec: PromptSpec
): Record<string, unknown> {
  return {
    version: spec.version,
    specId: spec.specId,
    systemInstructionsLength: spec.systemInstructions.length,
    developerInstructionsLength: spec.developerInstructions.length,
    fewShotDemosCount: spec.fewShotDemos.length,
    userTemplateLength: spec.userTemplate.length,
    outputContract: spec.outputContract,
    validatorHints: spec.validatorHints,
  };
}
