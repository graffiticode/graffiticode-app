/**
 * DSPy Service HTTP Client
 *
 * Provides functions to communicate with the Python DSPy service for prompt
 * specification compilation. Includes timeout handling and fallback support.
 */

import axios from "axios";
import { getRAGConfig } from "./rag-config";
import { ragLog } from "./logger";

/**
 * Represents a chunk of retrieved context from RAG
 */
export interface RetrievedChunk {
  id: string;
  prompt: string;
  code: string;
  similarity?: number;
  keywordScore?: number;
  combinedScore?: number;
  tags?: string[];
}

/**
 * Conversation summary for multi-turn context
 */
export interface ConversationSummary {
  turnCount: number;
  previousRequests: string[];
  previousOutputs?: string[];
}

/**
 * Constraints for code generation
 */
export interface Constraints {
  dialect: string;
  allowedBuiltins?: string[];
  maxOutputTokens?: number;
}

/**
 * Context pack sent to DSPy service
 */
export interface ContextPack {
  latestAsk: string;
  currentCode: string | null;
  conversationSummary: ConversationSummary | null;
  retrievedChunks: RetrievedChunk[];
  constraints: Constraints;
  taskType: "codegen" | "repair";
  // Additional fields for repair task type
  lastModelOutput?: string;
  structuredCompilerErrors?: CompilerError[];
}

/**
 * Structured compiler error for repair requests
 */
export interface CompilerError {
  type: "syntax" | "semantic" | "unknown";
  message: string;
  line?: number;
  column?: number;
  expected?: string;
  found?: string;
}

/**
 * Few-shot demonstration example
 */
export interface FewShotDemo {
  prompt: string;
  code: string;
}

/**
 * Output contract specifying expected format
 */
export interface OutputContract {
  format: string;
  requiredMarkers: string[];
}

/**
 * Validator hints for post-processing
 */
export interface ValidatorHints {
  mustCompile: boolean;
  mustEndWithDoubleDot: boolean;
}

/**
 * PromptSpec returned by DSPy service
 */
export interface PromptSpec {
  version: string;
  specId: string;
  systemInstructions: string;
  developerInstructions: string;
  fewShotDemos: FewShotDemo[];
  userTemplate: string;
  outputContract: OutputContract;
  validatorHints: ValidatorHints;
}

/**
 * DSPy service response wrapper
 */
interface DSPyResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
}

/**
 * Get the DSPy service URL from configuration
 *
 * DO NOT "FIX" A 404 FROM THIS URL BY REPOINTING IT AT THE LIVE SERVICE.
 *
 * The deployed dspy-service is an unfinished Phase-1 scaffold: it imports no
 * dspy at all (dspy-ai is an optional extra, commented out of requirements.txt
 * as "Phase 4"), and it answers every dialect with one generic base-Graffiticode
 * template that string-substitutes L{dialect} into a sentence. Last deployed
 * 2026-01-20 and untouched since — it predates several dialects it would be
 * asked about.
 *
 * That matters because a returned PromptSpec REPLACES formattedPrompt outright
 * (see the isDSPyEnabled branch in code-generation-service.ts): the
 * dialect-specific system block from getSystemPromptForDialect — the per-language
 * guide that makes up the bulk of a real prompt — is discarded in favour of the
 * generic one. Enabling this against the scaffold makes generation WORSE, for
 * every language.
 *
 * Production has been pointed at a hostname that 404s, so DSPY_FALLBACK_TO_LEGACY
 * has silently kept the legacy path in service. Keep ENABLE_DSPY_SERVICE=false
 * until the service is actually built out; the reason it looks broken is that it
 * is not finished.
 */
function getDSPyServiceUrl(): string {
  return process.env.DSPY_SERVICE_URL || "http://localhost:8080";
}

/**
 * Get the DSPy timeout from configuration
 */
function getDSPyTimeout(): number {
  return parseInt(process.env.DSPY_TIMEOUT_MS || "5000", 10);
}

/**
 * Get the internal API key for service-to-service auth
 */
function getInternalApiKey(): string {
  return process.env.INTERNAL_API_KEY || "";
}

/**
 * Check if DSPy service is enabled
 */
export function isDSPyEnabled(): boolean {
  const config = getRAGConfig();
  return config.enableDSPyService === true;
}

/**
 * Check if fallback to legacy prompt construction is enabled
 */
export function shouldFallbackToLegacy(): boolean {
  const config = getRAGConfig();
  return config.dspyFallbackToLegacy !== false; // Default to true
}

/**
 * Compile a PromptSpec for code generation
 *
 * @param contextPack - The context pack containing all information for prompt compilation
 * @param rid - Optional request ID for logging
 * @returns PromptSpec or null if DSPy is disabled/unavailable
 */
export async function compilePromptSpec(
  contextPack: ContextPack,
  rid?: string | null
): Promise<PromptSpec | null> {
  if (!isDSPyEnabled()) {
    if (rid) {
      ragLog(rid, "dspy.skipped", { reason: "disabled" });
    }
    return null;
  }

  const serviceUrl = getDSPyServiceUrl();
  const timeout = getDSPyTimeout();

  if (rid) {
    ragLog(rid, "dspy.compile.start", {
      taskType: contextPack.taskType,
      dialect: contextPack.constraints.dialect,
      chunkCount: contextPack.retrievedChunks.length,
      hasCurrentCode: !!contextPack.currentCode,
      hasSummary: !!contextPack.conversationSummary,
    });
  }

  const startTime = Date.now();

  try {
    // Convert context pack to snake_case for Python service
    const requestBody = {
      latest_ask: contextPack.latestAsk,
      current_code: contextPack.currentCode,
      conversation_summary: contextPack.conversationSummary
        ? {
            turn_count: contextPack.conversationSummary.turnCount,
            previous_requests: contextPack.conversationSummary.previousRequests,
            previous_outputs: contextPack.conversationSummary.previousOutputs,
          }
        : null,
      retrieved_chunks: contextPack.retrievedChunks.map((chunk) => ({
        id: chunk.id,
        prompt: chunk.prompt,
        code: chunk.code,
        similarity: chunk.similarity,
        keyword_score: chunk.keywordScore,
        combined_score: chunk.combinedScore,
        tags: chunk.tags,
      })),
      constraints: {
        dialect: contextPack.constraints.dialect,
        allowed_builtins: contextPack.constraints.allowedBuiltins,
        max_output_tokens: contextPack.constraints.maxOutputTokens,
      },
      task_type: contextPack.taskType,
    };

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    const apiKey = getInternalApiKey();
    if (apiKey) {
      headers["X-API-Key"] = apiKey;
    }

    const response = await axios.post<DSPyResponse<any>>(
      `${serviceUrl}/compile-prompt-spec`,
      requestBody,
      {
        timeout,
        headers,
      }
    );

    const latency = Date.now() - startTime;

    if (!response.data || !response.data.success) {
      throw new Error(response.data?.error || "Unknown DSPy service error");
    }

    // Convert response from snake_case to camelCase
    const data = response.data.data;
    const promptSpec: PromptSpec = {
      version: data.version,
      specId: data.spec_id,
      systemInstructions: data.system_instructions,
      developerInstructions: data.developer_instructions,
      fewShotDemos: (data.few_shot_demos || []).map((demo: any) => ({
        prompt: demo.prompt,
        code: demo.code,
      })),
      userTemplate: data.user_template,
      outputContract: {
        format: data.output_contract?.format || "code_block",
        requiredMarkers: data.output_contract?.required_markers || ["```", ".."],
      },
      validatorHints: {
        mustCompile: data.validator_hints?.must_compile ?? true,
        mustEndWithDoubleDot: data.validator_hints?.must_end_with_double_dot ?? true,
      },
    };

    if (rid) {
      ragLog(rid, "dspy.compile.success", {
        specId: promptSpec.specId,
        version: promptSpec.version,
        latency,
        demosCount: promptSpec.fewShotDemos.length,
      });
    }

    return promptSpec;
  } catch (error: any) {
    const latency = Date.now() - startTime;

    if (rid) {
      ragLog(rid, "dspy.compile.error", {
        error: error.message,
        latency,
        isTimeout: error.code === "ECONNABORTED",
      });
    }

    // Log warning but don't throw - allow fallback to legacy
    console.warn(
      `DSPy service error (${latency}ms):`,
      error.message
    );

    return null;
  }
}

/**
 * Compile a PromptSpec for error repair
 *
 * @param contextPack - The context pack with repair-specific information
 * @param rid - Optional request ID for logging
 * @returns PromptSpec or null if DSPy is disabled/unavailable
 */
export async function compileRepairPromptSpec(
  contextPack: ContextPack & {
    lastModelOutput: string;
    structuredCompilerErrors: CompilerError[];
  },
  rid?: string | null
): Promise<PromptSpec | null> {
  if (!isDSPyEnabled()) {
    if (rid) {
      ragLog(rid, "dspy.repair.skipped", { reason: "disabled" });
    }
    return null;
  }

  const serviceUrl = getDSPyServiceUrl();
  const timeout = getDSPyTimeout();

  if (rid) {
    ragLog(rid, "dspy.repair.start", {
      dialect: contextPack.constraints.dialect,
      errorCount: contextPack.structuredCompilerErrors.length,
      errorTypes: contextPack.structuredCompilerErrors.map((e) => e.type),
    });
  }

  const startTime = Date.now();

  try {
    // Convert context pack to snake_case for Python service
    const requestBody = {
      latest_ask: contextPack.latestAsk,
      current_code: contextPack.currentCode,
      conversation_summary: contextPack.conversationSummary
        ? {
            turn_count: contextPack.conversationSummary.turnCount,
            previous_requests: contextPack.conversationSummary.previousRequests,
            previous_outputs: contextPack.conversationSummary.previousOutputs,
          }
        : null,
      retrieved_chunks: contextPack.retrievedChunks.map((chunk) => ({
        id: chunk.id,
        prompt: chunk.prompt,
        code: chunk.code,
        similarity: chunk.similarity,
        keyword_score: chunk.keywordScore,
        combined_score: chunk.combinedScore,
        tags: chunk.tags,
      })),
      constraints: {
        dialect: contextPack.constraints.dialect,
        allowed_builtins: contextPack.constraints.allowedBuiltins,
        max_output_tokens: contextPack.constraints.maxOutputTokens,
      },
      task_type: "repair",
      last_model_output: contextPack.lastModelOutput,
      structured_compiler_errors: contextPack.structuredCompilerErrors.map(
        (err) => ({
          type: err.type,
          message: err.message,
          line: err.line,
          column: err.column,
          expected: err.expected,
          found: err.found,
        })
      ),
    };

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    const apiKey = getInternalApiKey();
    if (apiKey) {
      headers["X-API-Key"] = apiKey;
    }

    const response = await axios.post<DSPyResponse<any>>(
      `${serviceUrl}/compile-repair-prompt-spec`,
      requestBody,
      {
        timeout,
        headers,
      }
    );

    const latency = Date.now() - startTime;

    if (!response.data || !response.data.success) {
      throw new Error(response.data?.error || "Unknown DSPy service error");
    }

    // Convert response from snake_case to camelCase
    const data = response.data.data;
    const promptSpec: PromptSpec = {
      version: data.version,
      specId: data.spec_id,
      systemInstructions: data.system_instructions,
      developerInstructions: data.developer_instructions,
      fewShotDemos: (data.few_shot_demos || []).map((demo: any) => ({
        prompt: demo.prompt,
        code: demo.code,
      })),
      userTemplate: data.user_template,
      outputContract: {
        format: data.output_contract?.format || "code_block",
        requiredMarkers: data.output_contract?.required_markers || ["```", ".."],
      },
      validatorHints: {
        mustCompile: data.validator_hints?.must_compile ?? true,
        mustEndWithDoubleDot: data.validator_hints?.must_end_with_double_dot ?? true,
      },
    };

    if (rid) {
      ragLog(rid, "dspy.repair.success", {
        specId: promptSpec.specId,
        version: promptSpec.version,
        latency,
      });
    }

    return promptSpec;
  } catch (error: any) {
    const latency = Date.now() - startTime;

    if (rid) {
      ragLog(rid, "dspy.repair.error", {
        error: error.message,
        latency,
        isTimeout: error.code === "ECONNABORTED",
      });
    }

    console.warn(
      `DSPy repair service error (${latency}ms):`,
      error.message
    );

    return null;
  }
}

/**
 * Build a context pack from available data
 *
 * @param params - Parameters for building the context pack
 * @returns ContextPack ready for DSPy service
 */
export function buildContextPack({
  latestAsk,
  currentCode,
  conversationSummary,
  retrievedChunks,
  constraints,
  taskType = "codegen",
}: {
  latestAsk: string;
  currentCode: string | null;
  conversationSummary: ConversationSummary | null;
  retrievedChunks: RetrievedChunk[];
  constraints: Constraints;
  taskType?: "codegen" | "repair";
}): ContextPack {
  return {
    latestAsk,
    currentCode,
    conversationSummary,
    retrievedChunks,
    constraints,
    taskType,
  };
}

/**
 * Classify a compiler error as mechanical or semantic
 *
 * @param verificationResult - The result from code verification
 * @returns "mechanical" | "semantic" | "unknown"
 */
export function classifyCompilerError(
  verificationResult: any
): "mechanical" | "semantic" | "unknown" {
  if (!verificationResult) return "unknown";

  // Extract error message from various formats
  let errorMessage = "";

  if (verificationResult.error?.message) {
    errorMessage = verificationResult.error.message;
  } else if (verificationResult.errors?.message) {
    errorMessage = verificationResult.errors.message;
  } else if (verificationResult.errors?.details) {
    errorMessage =
      typeof verificationResult.errors.details === "string"
        ? verificationResult.errors.details
        : JSON.stringify(verificationResult.errors.details);
  } else if (typeof verificationResult === "string") {
    errorMessage = verificationResult;
  }

  errorMessage = errorMessage.toLowerCase();

  // Mechanical errors: syntax errors, missing tokens, parse failures
  const mechanicalPatterns = [
    /unexpected token/i,
    /expected.*found/i,
    /missing.*\.\./i,
    /parse error/i,
    /syntax error/i,
    /unterminated string/i,
    /unexpected end/i,
    /expected.*but.*found/i,
    /unexpected.*at/i,
  ];

  for (const pattern of mechanicalPatterns) {
    if (pattern.test(errorMessage)) {
      return "mechanical";
    }
  }

  // Semantic errors: undefined identifiers, type mismatches, arity errors
  const semanticPatterns = [
    /undefined.*identifier/i,
    /type mismatch/i,
    /unknown function/i,
    /arity mismatch/i,
    /not defined/i,
    /unknown identifier/i,
    /incompatible type/i,
    /wrong number of arguments/i,
    /cannot apply/i,
  ];

  for (const pattern of semanticPatterns) {
    if (pattern.test(errorMessage)) {
      return "semantic";
    }
  }

  return "unknown";
}

/**
 * Parse verification result into structured compiler errors
 *
 * @param verificationResult - The result from code verification
 * @returns Array of structured compiler errors
 */
export function parseStructuredErrors(
  verificationResult: any
): CompilerError[] {
  const errors: CompilerError[] = [];

  if (!verificationResult) return errors;

  // Handle different error formats
  let rawErrors: any[] = [];

  // A real compile failure arrives as `{ data: null, errors: [...] }` — the
  // envelope the language server returns, passed through by getData. That shape
  // matched none of the branches below, so every genuine compiler error parsed
  // as zero structured errors: the repair path saw an empty list and the
  // fix.attempt log reported errorCount 0.
  if (Array.isArray(verificationResult.errors) && verificationResult.errors.length > 0) {
    rawErrors = verificationResult.errors;
  } else if (verificationResult.data?.errors) {
    rawErrors = Array.isArray(verificationResult.data.errors)
      ? verificationResult.data.errors
      : [verificationResult.data.errors];
  } else if (verificationResult.errors?.details) {
    rawErrors = Array.isArray(verificationResult.errors.details)
      ? verificationResult.errors.details
      : [verificationResult.errors.details];
  } else if (verificationResult.error) {
    rawErrors = [verificationResult.error];
  }

  for (const rawError of rawErrors) {
    if (typeof rawError === "string") {
      const classifiedType = classifyCompilerError({ error: { message: rawError } });
      // Map "mechanical" to "syntax" for CompilerError type
      const errorType: "syntax" | "semantic" | "unknown" =
        classifiedType === "mechanical" ? "syntax" :
        classifiedType === "unknown" ? "syntax" : classifiedType;
      errors.push({
        type: errorType,
        message: rawError,
      });
    } else if (rawError && typeof rawError === "object") {
      const message = rawError.message || JSON.stringify(rawError);
      const classifiedType = classifyCompilerError({ error: { message } });
      // Map "mechanical" to "syntax" for CompilerError type
      const errorType: "syntax" | "semantic" | "unknown" =
        classifiedType === "mechanical" ? "syntax" :
        classifiedType === "unknown" ? "syntax" : classifiedType;
      errors.push({
        type: errorType,
        message,
        line: rawError.line,
        column: rawError.col || rawError.column,
        expected: rawError.expected,
        found: rawError.found,
      });
    }
  }

  return errors;
}

/**
 * Check DSPy service health
 *
 * @returns true if service is healthy, false otherwise
 */
export async function checkDSPyHealth(): Promise<boolean> {
  if (!isDSPyEnabled()) {
    return false;
  }

  const serviceUrl = getDSPyServiceUrl();
  const timeout = getDSPyTimeout();

  try {
    const response = await axios.get(`${serviceUrl}/health`, {
      timeout: Math.min(timeout, 2000), // Quick health check
    });
    return response.status === 200;
  } catch {
    return false;
  }
}
