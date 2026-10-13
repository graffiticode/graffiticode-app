/**
 * Safe wrapper for RAG Analytics Service
 *
 * Provides non-blocking analytics that won't break the main flow if unavailable.
 * All analytics operations are fire-and-forget with error catching.
 */

import { ragAnalytics, UserFeedback } from "./rag-analytics";
import { getRAGConfig } from "./rag-config";

class SafeRAGAnalytics {
  private enabled: boolean = true;

  /**
   * Safely start request tracking
   */
  startRequest(
    requestId: string,
    query: string,
    userId?: string,
    sessionId?: string,
    metadata?: Record<string, any>
  ): void {
    if (!this.isEnabled()) return;

    try {
      ragAnalytics.startRequest(requestId, query, userId, sessionId, metadata);
    } catch (error) {
      this.handleError("startRequest", error);
    }
  }

  /**
   * Safely start a stage
   */
  startStage(requestId: string, stage: string, metadata?: Record<string, any>): void {
    if (!this.isEnabled()) return;

    try {
      ragAnalytics.startStage(requestId, stage, metadata);
    } catch (error) {
      this.handleError("startStage", error);
    }
  }

  /**
   * Safely end a stage
   */
  endStage(requestId: string, stage: string): void {
    if (!this.isEnabled()) return;

    try {
      ragAnalytics.endStage(requestId, stage);
    } catch (error) {
      this.handleError("endStage", error);
    }
  }

  /**
   * Safely track embedding
   */
  trackEmbedding(requestId: string, embeddingVector: number[], latencyMs: number, embeddingText?: string, model?: string): void {
    if (!this.isEnabled()) return;

    try {
      ragAnalytics.trackEmbedding(requestId, embeddingVector, latencyMs, embeddingText, model);
    } catch (error) {
      this.handleError("trackEmbedding", error);
    }
  }

  /**
   * Safely track retrieval
   */
  trackRetrieval(
    requestId: string,
    documents: any[],
    strategy: "vector" | "hybrid" | "keyword",
    latencyMs: number,
    vectorWeight?: number
  ): void {
    if (!this.isEnabled()) return;

    try {
      ragAnalytics.trackRetrieval(requestId, documents, strategy, latencyMs, vectorWeight);
    } catch (error) {
      this.handleError("trackRetrieval", error);
    }
  }

  /**
   * Safely mark documents as used
   */
  markDocumentsUsed(requestId: string, usedDocumentIds: string[]): void {
    if (!this.isEnabled()) return;

    try {
      ragAnalytics.markDocumentsUsed(requestId, usedDocumentIds);
    } catch (error) {
      this.handleError("markDocumentsUsed", error);
    }
  }

  /**
   * Safely track generation
   */
  trackGeneration(requestId: string, metrics: any, generatedCode: string): void {
    if (!this.isEnabled()) return;

    try {
      ragAnalytics.trackGeneration(requestId, metrics, generatedCode);
    } catch (error) {
      this.handleError("trackGeneration", error);
    }
  }

  /**
   * Safely track compilation
   */
  trackCompilation(requestId: string, result: any): void {
    if (!this.isEnabled()) return;

    try {
      ragAnalytics.trackCompilation(requestId, result);
    } catch (error) {
      this.handleError("trackCompilation", error);
    }
  }

  /**
   * Safely track error
   */
  trackError(requestId: string, stage: string, error: Error | string): void {
    if (!this.isEnabled()) return;

    try {
      ragAnalytics.trackError(requestId, stage, error);
    } catch (err) {
      this.handleError("trackError", err);
    }
  }

  /**
   * Safely complete request - async but non-blocking
   */
  async completeRequest(requestId: string, success: boolean = true): Promise<void> {
    if (!this.isEnabled()) return;

    try {
      // Fire and forget - don't await
      ragAnalytics.completeRequest(requestId, success).catch(error => {
        this.handleError("completeRequest", error);
      });
    } catch (error) {
      this.handleError("completeRequest", error);
    }
  }

  /**
   * Safely track user feedback
   */
  async trackUserFeedback(requestId: string, feedback: UserFeedback): Promise<void> {
    if (!this.isEnabled()) return;

    try {
      await ragAnalytics.trackUserFeedback(requestId, feedback);
    } catch (error) {
      this.handleError("trackUserFeedback", error);
    }
  }

  /**
   * Check if analytics is enabled
   */
  private isEnabled(): boolean {
    const config = getRAGConfig();
    return this.enabled && config.enableAnalytics;
  }

  /**
   * Handle errors gracefully
   */
  private handleError(operation: string, error: any): void {
    const config = getRAGConfig();
    if (config.logFailures) {
      console.warn(`RAG Analytics operation failed (${operation}):`, error?.message || error);
    }

    // Optionally disable analytics after repeated failures
    // This prevents spamming logs with errors
    if (this.shouldDisableAfterError(error)) {
      this.enabled = false;
      console.warn("RAG Analytics disabled due to repeated failures");
    }
  }

  /**
   * Determine if analytics should be disabled after an error
   */
  private shouldDisableAfterError(error: any): boolean {
    // Disable if Firestore is not initialized or has auth issues
    const criticalErrors = [
      'Firebase app not initialized',
      'Missing or insufficient permissions',
      'Failed to get document',
      'Firestore not available'
    ];

    const errorMessage = error?.message || '';
    return criticalErrors.some(msg => errorMessage.includes(msg));
  }
}

// Export singleton instance
export const safeRAGAnalytics = new SafeRAGAnalytics();