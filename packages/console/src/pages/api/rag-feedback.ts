/**
 * API endpoint for collecting user feedback on RAG-generated responses
 *
 * This endpoint allows users to provide feedback on the quality of generated code,
 * which is then stored in the RAG analytics system for analysis and fine-tuning.
 */

import { NextApiRequest, NextApiResponse } from "next";
import { ragAnalytics, UserFeedback } from "../../lib/rag-analytics";
import admin from "firebase-admin";

// Initialize Firebase Admin if not already initialized
if (!admin.apps.length) {
  admin.initializeApp();
}

interface FeedbackRequest {
  requestId: string;
  score?: number; // 1-5 rating or 0/1 for thumbs down/up
  thumbsUp?: boolean; // Alternative to score
  comment?: string;
  edited?: boolean;
  compiledSuccessfully?: boolean;
  editedCode?: string; // If user edited the code
  timeToFeedbackMs?: number;
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  // Only allow POST requests
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const {
      requestId,
      score,
      thumbsUp,
      comment,
      edited = false,
      compiledSuccessfully,
      editedCode,
      timeToFeedbackMs,
    } = req.body as FeedbackRequest;

    // Validate required fields
    if (!requestId) {
      return res.status(400).json({ error: "requestId is required" });
    }

    // Determine score from either score or thumbsUp
    let feedbackScore: number;
    if (score !== undefined) {
      feedbackScore = score;
    } else if (thumbsUp !== undefined) {
      feedbackScore = thumbsUp ? 1 : 0;
    } else {
      return res
        .status(400)
        .json({ error: "Either score or thumbsUp is required" });
    }

    // Create feedback object
    const feedback: UserFeedback = {
      score: feedbackScore,
      comment,
      edited,
      compiledSuccessfully,
      timeToFeedbackMs,
    };

    // Track the feedback in analytics
    await ragAnalytics.trackUserFeedback(requestId, feedback);

    // If user edited the code, we might want to store that separately for learning
    if (editedCode) {
      // Store edited code as a potential training example
      const db = admin.firestore();
      await db.collection("rag_feedback_examples").add({
        requestId,
        originalRequestId: requestId,
        editedCode,
        feedback,
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
      });
    }

    return res.status(200).json({
      success: true,
      message: "Feedback recorded successfully",
      requestId,
    });
  } catch (error) {
    console.error("Error recording RAG feedback:", error);
    return res.status(500).json({
      error: "Failed to record feedback",
      message: error.message,
    });
  }
}