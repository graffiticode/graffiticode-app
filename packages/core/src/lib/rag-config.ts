/**
 * RAG Configuration and Feature Flags
 *
 * Centralized configuration for RAG features with graceful degradation support.
 * Allows disabling specific RAG components for debugging or when services are unavailable.
 */

export interface RAGConfig {
  // Feature flags
  enableVectorSearch: boolean;
  enableAnalytics: boolean;
  enableHybridSearch: boolean;
  enableUserFeedback: boolean;

  // DSPy service settings
  enableDSPyService: boolean;
  dspyServiceUrl: string;
  dspyTimeoutMs: number;
  dspyFallbackToLegacy: boolean;

  // Judge (LLM-as-judge code-quality eval) settings
  enableJudge: boolean;
  judgeMode: 'off' | 'async';   // 'inline' gate/selector intentionally not wired this cut
  judgeModel: string;
  judgeTimeoutMs: number;

  // Fallback behavior
  fallbackToKeywordSearch: boolean;
  fallbackToNoExamples: boolean;

  // Performance settings
  maxRetrievalAttempts: number;
  retrievalTimeoutMs: number;

  // Analytics settings
  analyticsEnabled: boolean;
  analyticsBatchSize: number;

  // Debug settings
  debugMode: boolean;
  logFailures: boolean;
}

// Default configuration with all features enabled but with fallbacks
const defaultConfig: RAGConfig = {
  // Feature flags - can be controlled via environment variables
  enableVectorSearch: process.env.DISABLE_VECTOR_SEARCH !== 'true',
  enableAnalytics: process.env.DISABLE_RAG_ANALYTICS !== 'true',
  enableHybridSearch: process.env.DISABLE_HYBRID_SEARCH !== 'true',
  enableUserFeedback: process.env.DISABLE_USER_FEEDBACK !== 'true',

  // DSPy service settings - disabled by default until service is deployed
  enableDSPyService: process.env.ENABLE_DSPY_SERVICE === 'true',
  dspyServiceUrl: process.env.DSPY_SERVICE_URL || 'http://localhost:8080',
  dspyTimeoutMs: parseInt(process.env.DSPY_TIMEOUT_MS || '5000', 10),
  dspyFallbackToLegacy: process.env.DSPY_FALLBACK_TO_LEGACY !== 'false',

  // Judge settings - disabled by default; async logs a quality score with zero user latency
  enableJudge: process.env.JUDGE_ENABLED === 'true',
  judgeMode: process.env.JUDGE_MODE === 'async' ? 'async' : 'off',
  judgeModel: process.env.JUDGE_MODEL || 'claude-opus-5',
  // A reason-before-score judge enumerates every requirement and traces every
  // formula before emitting a verdict; 15s aborted mid-analysis often enough to
  // be the top source of dropped candidates in calibration runs.
  judgeTimeoutMs: parseInt(process.env.JUDGE_TIMEOUT_MS || '90000', 10),

  // Fallback behavior - always enabled for resilience
  fallbackToKeywordSearch: true,
  fallbackToNoExamples: true,

  // Performance settings
  maxRetrievalAttempts: 3,
  retrievalTimeoutMs: 5000,

  // Analytics settings
  analyticsEnabled: process.env.DISABLE_RAG_ANALYTICS !== 'true',
  analyticsBatchSize: 100,

  // Debug settings
  debugMode: process.env.RAG_DEBUG === 'true',
  logFailures: true,
};

// Configuration singleton
let currentConfig: RAGConfig = { ...defaultConfig };

/**
 * Get the current RAG configuration
 */
export function getRAGConfig(): RAGConfig {
  return { ...currentConfig };
}

/**
 * Update RAG configuration
 * Useful for testing or runtime adjustments
 */
export function updateRAGConfig(updates: Partial<RAGConfig>): void {
  currentConfig = { ...currentConfig, ...updates };
}

/**
 * Reset configuration to defaults
 */
export function resetRAGConfig(): void {
  currentConfig = { ...defaultConfig };
}

/**
 * Check if a specific RAG feature is enabled
 */
export function isFeatureEnabled(feature: keyof RAGConfig): boolean {
  return !!currentConfig[feature];
}

/**
 * Judge (LLM-as-judge) config accessor — the subset judge-service needs.
 */
export function getJudgeConfig() {
  const c = getRAGConfig();
  return {
    enableJudge: c.enableJudge,
    judgeMode: c.judgeMode,
    judgeModel: c.judgeModel,
    judgeTimeoutMs: c.judgeTimeoutMs,
  };
}

export function isJudgeEnabled(): boolean {
  return getRAGConfig().enableJudge === true;
}

/**
 * Effective judge mode — 'async' only takes effect when the judge is enabled, else 'off'.
 */
export function getJudgeMode(): 'off' | 'async' {
  const c = getRAGConfig();
  return c.enableJudge ? c.judgeMode : 'off';
}

/**
 * Safe wrapper for RAG operations with fallback
 */
export async function withRAGFallback<T>(
  operation: () => Promise<T>,
  fallback: () => T | Promise<T>,
  operationName: string
): Promise<T> {
  const config = getRAGConfig();

  try {
    // Set a timeout for the operation
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`${operationName} timeout`)), config.retrievalTimeoutMs);
    });

    // Race between operation and timeout
    const result = await Promise.race([operation(), timeoutPromise]);
    return result;
  } catch (error) {
    if (config.logFailures) {
      console.warn(`RAG operation failed: ${operationName}`, error.message);
    }

    // Use fallback
    try {
      return await fallback();
    } catch (fallbackError) {
      if (config.logFailures) {
        console.error(`RAG fallback also failed: ${operationName}`, fallbackError.message);
      }
      throw fallbackError;
    }
  }
}