# RAG (Retrieval-Augmented Generation) Setup Guide

This guide explains how to set up and use the RAG system with Firebase Vector Search for the Claude-based code generator.

## Overview

The RAG system enhances code generation by:
1. Converting prompts and examples into vector embeddings
2. Finding semantically similar examples using vector search
3. Providing relevant context to Claude for better code generation

## Prerequisites

1. **OpenAI API Key** - Required for generating embeddings
2. **Firebase Project** - Must have Firestore enabled
3. **Node.js 18+** - Required for running scripts

## Setup Instructions

### 1. Environment Variables

Add the following to your `.env` file:

```bash
# Required for embeddings
OPENAI_API_KEY=your_openai_api_key_here

# Existing variables (should already be set)
ANTHROPIC_API_KEY=your_anthropic_api_key_here
```

### 2. Deploy Firestore Indexes

The vector search requires specific indexes. Deploy them using:

```bash
# Deploy only the Firestore indexes
firebase deploy --only firestore:indexes

# Or deploy everything including indexes
firebase deploy
```

This creates indexes for:
- `training_examples` collection with vector search on `embedding` field
- `successful_generations` collection with vector search on `embedding` field

### 3. Generate Embeddings for Existing Data

The `training_examples` corpus is built from the eval account's `mark=1` items:

```bash
# All languages
npx tsx scripts/generate-embeddings-from-examples.ts

# One language
npx tsx scripts/generate-embeddings-from-examples.ts --lang 0002

# Smaller batches (default is 10)
npx tsx scripts/generate-embeddings-from-examples.ts --batch-size 5
```

It upserts only; docs for items that are no longer marked must be deleted by hand.

### 4. Initialize Training Examples (Optional)

If you need to populate the database with training examples from markdown files:

```bash
# Initialize all languages
node -e "import('./src/lib/code-generation-service.js').then(m => m.initializeTrainingExamples())"

# Initialize specific language
node -e "import('./src/lib/code-generation-service.js').then(m => m.initializeTrainingExamples('0002'))"
```

## How It Works

### Embedding Generation

When a new example is added:
1. Text is extracted from the example (task, code, description)
2. OpenAI's `text-embedding-3-small` model generates a 1536-dimensional vector
3. The vector is stored in Firestore alongside the example

### Vector Search Process

When generating code:
1. User prompt is converted to an embedding
2. Firebase Vector Search finds the most similar examples using cosine similarity
3. Hybrid search combines vector similarity with keyword matching
4. Top 3-5 examples are retrieved and passed to Claude

### Fallback Mechanism

If vector search fails (e.g., indexes not deployed):
- System automatically falls back to keyword-based search
- Uses existing markdown files for examples
- Ensures code generation continues working

## Architecture

```
User Prompt
    ↓
Generate Embedding (OpenAI)
    ↓
Vector Search (Firebase)
    ↓
Retrieve Similar Examples
    ↓
Enhanced Prompt with Examples
    ↓
Claude Code Generation
    ↓
Store Successful Generation (with embedding)
```

## Key Files

- `src/lib/embedding-service.js` - Core embedding and vector search functionality
- `src/lib/code-generation-service.js` - Updated to use RAG
- `scripts/generate-embeddings-from-examples.ts` - Build `training_examples` from corpus items
- `firestore.indexes.json` - Vector search index definitions

## Performance Considerations

1. **Embedding Generation**: ~100ms per text
2. **Vector Search**: ~50-200ms depending on collection size
3. **Batch Processing**: Process embeddings in batches of 10-100
4. **Index Building**: Initial index creation may take several minutes

## Monitoring

Check the logs for:
- "Found X relevant examples using vector search" - Vector search working
- "Vector search failed, falling back to keyword search" - Using fallback
- "Stored successful generation with embedding" - New examples being indexed

## Troubleshooting

### Vector Search Not Working

1. Check if indexes are deployed:
   ```bash
   firebase firestore:indexes
   ```

2. Verify OpenAI API key is set:
   ```bash
   echo $OPENAI_API_KEY
   ```

3. Check Firestore rules allow read/write access

### Embeddings Not Generated

1. Check OpenAI API quota and billing
2. Verify document structure has required fields
3. Check logs for specific error messages

### Performance Issues

1. Reduce batch size if timeouts occur
2. Implement caching for frequently used embeddings
3. Consider using smaller embedding models

## Cost Estimation

- **OpenAI Embeddings**: ~$0.0001 per 1K tokens
- **Firestore Vector Storage**: Standard Firestore pricing + vector field storage
- **Vector Search Queries**: Counted as Firestore reads

For 10,000 examples:
- Initial embedding generation: ~$1-2
- Storage: ~10MB additional
- Monthly queries (1000/day): ~$10-20

## Future Enhancements

1. **Embedding Cache**: Cache frequently used embeddings
2. **Feedback Loop**: Track which examples lead to successful generations
3. **Multi-Modal**: Support image embeddings for visual examples
4. **Custom Models**: Fine-tune embedding models for code
5. **Advanced Reranking**: Use cross-encoders for better relevance