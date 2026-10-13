/**
 * API endpoint for retrieving RAG analytics data
 *
 * This endpoint provides access to aggregated metrics and detailed analytics
 * for monitoring and fine-tuning the RAG system.
 */

import { NextApiRequest, NextApiResponse } from "next";
import { ragAnalytics } from "../../lib/rag-analytics";
import admin from "firebase-admin";

// Initialize Firebase Admin if not already initialized
if (!admin.apps.length) {
  admin.initializeApp();
}

interface AnalyticsQuery {
  action: "metrics" | "details" | "export";
  startDate?: string;
  endDate?: string;
  userId?: string;
  requestId?: string;
  limit?: number;
  minSimilarity?: number;
  onlyWithFeedback?: boolean;
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  // Only allow GET requests
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Operator-only: "details" and "export" return every user's records (user
  // ids, prompt text, generation results). Same shared header as the other
  // internal routes (/api/internal/*); nothing in the app calls this.
  const secret = process.env.INTERNAL_JOB_SECRET || "";
  if (!secret || req.headers["x-internal-job-secret"] !== secret) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const {
      action = "metrics",
      startDate,
      endDate,
      userId,
      requestId,
      limit = "100",
      minSimilarity,
      onlyWithFeedback = "false",
    } = req.query;

    // Ensure query params are strings (not arrays)
    const startDateStr = Array.isArray(startDate) ? startDate[0] : startDate;
    const endDateStr = Array.isArray(endDate) ? endDate[0] : endDate;
    const userIdStr = Array.isArray(userId) ? userId[0] : userId;
    const requestIdStr = Array.isArray(requestId) ? requestId[0] : requestId;
    const limitStr = Array.isArray(limit) ? limit[0] : limit;
    const minSimilarityStr = Array.isArray(minSimilarity) ? minSimilarity[0] : minSimilarity;
    const onlyWithFeedbackStr = Array.isArray(onlyWithFeedback) ? onlyWithFeedback[0] : onlyWithFeedback;

    // Parse dates if provided
    const start = startDateStr ? new Date(startDateStr) : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000); // Default: last 7 days
    const end = endDateStr ? new Date(endDateStr) : new Date();

    switch (action) {
      case "metrics": {
        // Get aggregated metrics
        const metrics = await ragAnalytics.getAggregatedMetrics(start, end);

        // Add additional computed metrics
        const enrichedMetrics = {
          ...metrics,
          period: {
            start: start.toISOString(),
            end: end.toISOString(),
          },
          retrievalEfficiency: metrics.averageSimilarity > 0.7 ? "high" :
                              metrics.averageSimilarity > 0.5 ? "medium" : "low",
          feedbackSentiment: metrics.feedbackScore > 3.5 ? "positive" :
                            metrics.feedbackScore > 2.5 ? "neutral" : "negative",
        };

        return res.status(200).json(enrichedMetrics);
      }

      case "details": {
        // Get detailed records
        const filters: any = {
          userId: userIdStr,
          startDate: start,
          endDate: end,
          minSimilarity: minSimilarityStr ? parseFloat(minSimilarityStr) : undefined,
        };

        const parsedLimit = parseInt(limitStr, 10);
        let records = await ragAnalytics.queryAnalytics(filters, parsedLimit);

        // Filter for only records with feedback if requested
        if (onlyWithFeedbackStr === "true") {
          records = records.filter(r => r.feedback);
        }

        // If specific requestId is provided, get that single record
        if (requestIdStr) {
          records = records.filter(r => r.requestId === requestIdStr);
        }

        return res.status(200).json({
          records,
          count: records.length,
          filters: {
            ...filters,
            onlyWithFeedback,
          },
        });
      }

      case "export": {
        // Export data for analysis
        const records = await ragAnalytics.queryAnalytics(
          {
            startDate: start,
            endDate: end,
            userId: userIdStr,
          },
          1000 // Max export size
        );

        // Transform for CSV or analysis-friendly format
        const exportData = records.map(r => ({
          requestId: r.requestId,
          timestamp: r.timestamp,
          userId: r.userId,
          queryLength: r.query.length,
          language: r.query.language,
          retrievalStrategy: r.retrieval.strategy,
          documentsRetrieved: r.retrieval.documentsRetrieved,
          documentsUsed: r.retrieval.documentsUsed,
          avgSimilarity: r.retrieval.documents.reduce((sum, d) => sum + d.similarity, 0) /
                        (r.retrieval.documents.length || 1),
          maxSimilarity: Math.max(...r.retrieval.documents.map(d => d.similarity)),
          generationModel: r.generation.model,
          generationSuccess: r.generation.success,
          generationLatencyMs: r.generation.latencyMs,
          compilationSuccess: r.compilation?.success || false,
          totalLatencyMs: r.performance.totalLatencyMs,
          feedbackScore: r.feedback?.score,
          userEdited: r.feedback?.edited || false,
          hasErrors: (r.errors?.length || 0) > 0,
        }));

        // Set headers for CSV download
        res.setHeader("Content-Type", "text/csv");
        res.setHeader(
          "Content-Disposition",
          `attachment; filename="rag-analytics-${start.toISOString().split("T")[0]}.csv"`
        );

        // Convert to CSV
        const headers = Object.keys(exportData[0] || {});
        const csv = [
          headers.join(","),
          ...exportData.map(row =>
            headers.map(h => JSON.stringify(row[h] || "")).join(",")
          ),
        ].join("\n");

        return res.status(200).send(csv);
      }

      default:
        return res.status(400).json({ error: "Invalid action" });
    }
  } catch (error) {
    console.error("Error retrieving RAG analytics:", error);
    return res.status(500).json({
      error: "Failed to retrieve analytics",
      message: error.message,
    });
  }
}