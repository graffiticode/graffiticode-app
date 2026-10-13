import React, { useState, useCallback, useRef, useEffect } from 'react';
import { generateCode } from "../utils/swr/fetchers";

/**
 * Build a conversation summary from chat history for DSPy service
 */
const buildConversationSummary = (chatHistory: any[]) => {
  if (!chatHistory || chatHistory.length < 2) {
    return null;
  }

  // Extract previous user requests from chat history
  const previousRequests: string[] = [];
  const previousOutputs: string[] = [];

  for (const item of chatHistory) {
    if (item.type === 'user') {
      previousRequests.push(formatImageReferences(item.user));
    } else if (item.type === 'bot' && item.help?.type === 'code') {
      previousOutputs.push('[Generated code]');
    } else if (item.type === 'bot') {
      previousOutputs.push(item.user || '[Response]');
    }
  }

  const turnCount = Math.ceil(chatHistory.length / 2);

  return {
    turnCount,
    previousRequests,
    previousOutputs,
  };
};

/** Convert image markdown into explicit labeled format for LLM context */
const formatImageReferences = (text: string): string =>
  text.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '[Image name="$1" url="$2"]').trim();

/**
 * Function to generate Graffiticode responses using the generateCode function
 */
const generateBotResponse = async ({message, user, language, chatHistory = [], currentSrc = '', currentData = null, itemId = undefined}) => {
  try {
    // Use our fetcher function directly

    // Format image references for clearer LLM context
    let contextualPrompt = formatImageReferences(message);

    // Build conversation summary for DSPy service
    const conversationSummary = buildConversationSummary(chatHistory);

    // Only add chat history if there's a meaningful amount (at least 1 exchange)
    if (chatHistory.length >= 2) {
      // Build context from the chat history
      let conversationContext = "Previous conversation:\n\n";

      for (let i = 0; i < chatHistory.length; i++) {
        const item = chatHistory[i];
        if (item.type === 'user') {
          conversationContext += `User: ${formatImageReferences(item.user)}\n`;
        } else if (item.type === 'bot') {
          // For bot responses, include either the text (if a description) or a summary (if code)
          if (item.help && item.help.type === 'code') {
            conversationContext += `Assistant: [Generated Graffiticode code]\n`;
            // If there's a description, include it
            if (item.help.description) {
              conversationContext += `Description: ${item.help.description}\n`;
            }
          } else {
            conversationContext += `Assistant: ${item.user}\n`;
          }
        }
      }

      // Include the current code as the Assistant's most recent output
      if (currentSrc && currentSrc.trim().length > 0) {
        conversationContext += "\nAssistant's latest generated code:\n```\n";
        conversationContext += currentSrc;
        conversationContext += "\n```\n";
      }

      conversationContext += "\nNow, please address this new request:\n";
      contextualPrompt = conversationContext + message;
    }

    const result = await generateCode({
      user,
      prompt: contextualPrompt,
      options: {
        temperature: 0.2
        // maxTokens omitted: the server applies DEFAULT_MAX_TOKENS (large
        // enough that most programs finish in one chunk, avoiding the
        // continuation loop). A 2000 cap here used to chop large assessments
        // into chunks, and the model would restart mid-generation.
      },
      language,
      currentSrc,
      // What the current code compiles to. Some dialects keep values outside the
      // program — L0182 names a survey whose ideas the compiler fetches — so an
      // edit that acts on them ("answer it") is unanswerable from the source.
      currentData,
      itemId,
      conversationSummary
    });

    // Code + errors: head code was generated but didn't parse. Route into the
    // editor so the user sees the failing source with inline compile-error
    // decorations, same as if they had typed it themselves.
    if (result.src && result.errors && result.errors.length > 0) {
      return {
        text: result.src,
        type: 'code',
        errors: result.errors,
        language: result.language || 'graffiticode',
        model: result.model,
        usage: result.usage,
        taskId: null,
        upstreamLangs: [],
        timestamp: new Date().toISOString()
      };
    }
    // Errors only (no src): out-of-scope, usage cap, upstream failure, etc.
    if (result.errors && result.errors.length > 0) {
      return {
        text: result.errors.map(e => e.message).join('\n'),
        type: 'error',
        timestamp: new Date().toISOString()
      };
    }
    return {
      text: result.src,
      type: 'code',
      language: result.language || 'graffiticode',
      model: result.model,
      usage: result.usage,
      taskId: result.taskId,
      upstreamLangs: result.upstreamLangs || [],
      timestamp: new Date().toISOString()
    };
  } catch (error) {
    console.error('Error generating code:', error);
    return fallbackResponse(message);
  }
};

/**
 * Fallback response generator used when API calls fail
 */
const fallbackResponse = (message) => {
  const timestamp = new Date().toISOString();
  if (message.toLowerCase().includes('hello') || message.toLowerCase().includes('hi')) {
    return {
      text: 'Hello! What do you want to make with Graffiticode today?',
      type: 'text',
      timestamp
    };
  } else if (message.toLowerCase().includes('help')) {
    return {
      text: 'I can help you make things with Graffiticode. What specific functionality would you like me to implement?',
      type: 'text',
      timestamp
    };
  } else if (message.toLowerCase().includes('example')) {
    return {
      text: `let double = <x: add x x>..
let result = map (double) [1 2 3]..`,
      type: 'code',
      language: 'graffiticode',
      timestamp
    };
  } else {
    return {
      text: `let message = "${message.substring(0, 30)}${message.length > 30 ? '...' : ''}"..
let greeting = <name: concat "Hello, " name>..
greeting "user"..`,
      type: 'code',
      language: 'graffiticode',
      timestamp
    };
  }
};

/**
 * ChatBot component that provides a chat interface
 */
export const ChatBot = ({ onSendMessage, user, language, chatHistory = [], currentSrc = '', currentData = null, itemId = undefined }) => {

  const [isLoading, setIsLoading] = useState(false);

  // Reference to control cancellation
  const cancelGenerationRef = useRef(false);

  // Use refs to always have access to the latest props
  const chatHistoryRef = useRef(chatHistory);
  const currentSrcRef = useRef(currentSrc);
  const currentDataRef = useRef(currentData);

  // Update refs when props change
  useEffect(() => {
    chatHistoryRef.current = chatHistory;
  }, [chatHistory]);

  useEffect(() => {
    currentSrcRef.current = currentSrc;
  }, [currentSrc]);

  // Read through a ref for the same reason the source is: this component is
  // re-created as the chat history changes, and a send in flight must use the
  // data model as it is NOW, not as it was when the handler was created.
  useEffect(() => {
    currentDataRef.current = currentData;
  }, [currentData]);

  // Function to cancel the current code generation
  const cancelGeneration = useCallback(() => {
    cancelGenerationRef.current = true;
    // Immediately set isLoading to false to unblock the UI
    setIsLoading(false);
  }, []);

  const handleSendMessage = useCallback(async (message) => {
    if (!message.trim()) return;

    // Reset cancellation flag
    cancelGenerationRef.current = false;
    setIsLoading(true);

    // Immediately call onSendMessage with just the user message to display it
    // This will update the UI right away while code is being generated
    onSendMessage(message, null);

    try {
      // Access the latest values from refs
      const latestChatHistory = chatHistoryRef.current;
      const latestSrc = currentSrcRef.current;
      const latestData = currentDataRef.current;


      // Check if generation has been cancelled before making the API call
      if (cancelGenerationRef.current) {
        return;
      }

      // Get response from the bot with the latest values
      const response = await generateBotResponse({
        message,
        user,
        language,
        chatHistory: latestChatHistory,
        currentSrc: latestSrc,
        currentData: latestData,
        itemId,
      });

      // Check if generation was cancelled while the API call was in progress
      if (cancelGenerationRef.current) {
        return;
      }

      // Send the bot response to the parent component
      // We're using a special flag to indicate this is just the bot response
      // without needing to add the user message again
      if (response) {
        (response as any).skipUserMessage = true;
      }
      onSendMessage(message, response);
    } catch (error) {
      // Only send error if not cancelled
      if (!cancelGenerationRef.current) {
        console.error('Error getting bot response:', error);
        const errorResponse = {
          text: 'I encountered an error processing your request. Please try again.',
          type: 'text',
          skipUserMessage: true,
          timestamp: new Date().toISOString()
        };
        onSendMessage(message, errorResponse);
      }
    } finally {
      setIsLoading(false);
    }
  }, [onSendMessage, user, language]); // Remove chatHistory and currentCode from dependencies

  return {
    handleSendMessage,
    cancelGeneration,
    isLoading,
  };
};
