# Graffiticode Vector Database Optimization Guide

A comprehensive guide for optimizing vector search across all Graffiticode language implementations.

## Table of Contents
1. [Understanding Hybrid Search](#1-understanding-hybrid-search)
2. [Corpus Architecture](#2-corpus-architecture)
3. [Creating Optimal Embedding Texts](#3-creating-optimal-embedding-texts)
4. [Language-Specific Strategies](#4-language-specific-strategies)
5. [Database Sizing Guidelines](#5-database-sizing-guidelines)
6. [Anti-Patterns and Practices to Avoid](#6-anti-patterns-and-practices-to-avoid)
7. [Performance Optimization](#7-performance-optimization)
8. [Monitoring and Iteration](#8-monitoring-and-iteration)

---

## 1. Understanding Hybrid Search

### 1.1 Why Pure Vector Search Isn't Enough

Vector embeddings excel at semantic understanding but have limitations:

| Challenge | Vector Search Behavior | Impact on Code Generation |
|-----------|------------------------|---------------------------|
| **Exact Identifiers** | Treats `var1`, `var2`, `varX` as similar | Misses precise variable/function references |
| **Syntax Elements** | Groups all operators together | Can't distinguish `+` from `-` or `*` |
| **Domain Terms** | Conflates similar concepts | `draw_circle` vs `draw_square` seen as equivalent |
| **Short Queries** | Insufficient context for embedding | "red box" lacks semantic richness |
| **Language Keywords** | Treats as generic English | `let`, `def`, `loop` lose special meaning |

### 1.2 The Power of Hybrid Search

Combining vector and keyword matching addresses these limitations:

```javascript
// Optimal weighting for code generation
const hybridScore = vectorScore * 0.7 + keywordScore * 0.3;
```

This 70/30 split provides:
- **Semantic understanding** (70%): Captures user intent and conceptual similarity
- **Precision matching** (30%): Ensures exact terms, identifiers, and syntax elements match

### 1.3 When to Adjust the Weights

Different Graffiticode languages may benefit from different weightings:

```javascript
// Visual languages (drawing, graphics): More semantic
const visualLanguageWeight = { vector: 0.8, keyword: 0.2 };

// Data languages (spreadsheets, databases): Balanced
const dataLanguageWeight = { vector: 0.7, keyword: 0.3 };

// DSL/Technical languages: More keyword-focused
const technicalLanguageWeight = { vector: 0.6, keyword: 0.4 };
```

---

## 2. Corpus Architecture

### 2.1 What Gets Searched

The keyword matching searches **embedding texts**, not raw code:

```javascript
function createEmbeddingText(example) {
  return [
    languageContext(),      // "L0001 graphics language"
    taskDescription(),      // "Task: Draw a red circle"
    operations(),          // "Operations: create shape, apply color"
    domainFeatures(),      // "Features: circle, color-red, size-100"
    technicalElements()    // "Elements: draw_circle, fill_color"
  ].join(". ");
}
```

### 2.2 Universal Corpus Components

Every Graffiticode language should include these in embedding texts:

1. **Language Identifier**: `L[NUMBER] [TYPE]` (e.g., "L0001 graphics")
2. **Task/Intent**: What the user wants to accomplish
3. **Operations**: Actions performed by the code
4. **Domain Features**: Language-specific concepts used
5. **Technical Elements**: Actual function/method names (when relevant)

### 2.3 What NOT to Include

**Never include these in embedding texts:**
- ❌ Raw code syntax (brackets, quotes, semicolons)
- ❌ Whitespace-dependent formatting
- ❌ Comments that don't add semantic value
- ❌ Implementation details (internal variable names)
- ❌ Error messages or stack traces
- ❌ File paths or system-specific information

---

## 3. Creating Optimal Embedding Texts

### 3.1 Universal Template

```javascript
function createOptimalEmbeddingText(example, languageSpec) {
  const parts = [];
  
  // 1. Language context (ALWAYS first)
  parts.push(`${languageSpec.id} ${languageSpec.type}`);
  
  // 2. User intent
  parts.push(`Task: ${extractIntent(example)}`);
  
  // 3. What it does (operations)
  const operations = extractOperations(example, languageSpec);
  if (operations.length) {
    parts.push(`Operations: ${operations.join(", ")}`);
  }
  
  // 4. Domain-specific features
  const features = extractDomainFeatures(example, languageSpec);
  if (features.length) {
    parts.push(`Features: ${features.join(", ")}`);
  }
  
  // 5. Technical elements (if applicable)
  const technical = extractTechnicalElements(example, languageSpec);
  if (technical.length) {
    parts.push(`Elements: ${technical.join(", ")}`);
  }
  
  // 6. Complexity indicator
  parts.push(`Complexity: ${assessComplexity(example)}`);
  
  return parts.join(". ");
}
```

### 3.2 Feature Extraction Patterns

```javascript
// Universal feature extraction framework
const FEATURE_EXTRACTORS = {
  // Structural patterns
  structural: {
    hasNesting: /\{[^}]*\{/,
    hasIteration: /loop|for|while|map|each/i,
    hasCondition: /if|when|case|cond/i,
    hasFunction: /def|func|function|proc/i,
  },
  
  // Data patterns
  data: {
    hasNumbers: /\b\d+\.?\d*\b/,
    hasStrings: /"[^"]*"|'[^']*'/,
    hasArrays: /\[.*\]/,
    hasObjects: /\{.*:/,
  },
  
  // Domain patterns (customize per language)
  domain: {
    // Add language-specific patterns
  }
};
```

### 3.3 Complexity Assessment

Include complexity to help match appropriate examples:

```javascript
function assessComplexity(example) {
  const indicators = {
    simple: ['basic', 'single', 'direct'],
    moderate: ['multiple', 'combined', 'nested'],
    complex: ['advanced', 'recursive', 'multi-step']
  };
  
  // Return: "simple" | "moderate" | "complex"
  return calculateComplexityLevel(example, indicators);
}
```

---

## 4. Language-Specific Strategies

### 4.1 Visual Languages (Drawing, Graphics, UI)

```javascript
const visualLanguageStrategy = {
  focus: ['shapes', 'colors', 'positions', 'transformations'],
  
  extractors: {
    shapes: /circle|rect|line|path|polygon/gi,
    colors: /red|blue|#[0-9a-f]{6}|rgb\(/gi,
    positions: /top|left|center|x:\d+|y:\d+/gi,
    transforms: /rotate|scale|translate|skew/gi
  },
  
  embeddingTemplate: (example) => {
    return `Visual composition: ${extractShapes()}. ` +
           `Colors: ${extractColors()}. ` +
           `Layout: ${extractPositions()}. ` +
           `Effects: ${extractTransforms()}.`;
  }
};
```

### 4.2 Data Languages (Spreadsheets, Databases, Tables)

```javascript
const dataLanguageStrategy = {
  focus: ['structure', 'calculations', 'references', 'formats'],
  
  extractors: {
    cells: /[A-Z]+\d+/g,  // A1, B12
    formulas: /=\w+\(/g,   // =SUM(, =AVG(
    ranges: /[A-Z]\d+:[A-Z]\d+/g,  // A1:B10
    operations: /sum|avg|count|max|min/gi
  },
  
  embeddingTemplate: (example) => {
    return `Data structure: ${extractStructure()}. ` +
           `Calculations: ${extractFormulas()}. ` +
           `References: ${extractReferences()}. ` +
           `Formatting: ${extractFormats()}.`;
  }
};
```

### 4.3 Algorithm Languages (Logic, Computation)

```javascript
const algorithmLanguageStrategy = {
  focus: ['control-flow', 'data-structures', 'operations', 'complexity'],
  
  extractors: {
    controlFlow: /if|loop|while|for|recursion/gi,
    dataStructures: /list|array|tree|graph|map/gi,
    operations: /sort|search|filter|reduce|transform/gi
  },
  
  embeddingTemplate: (example) => {
    return `Algorithm type: ${extractAlgorithmType()}. ` +
           `Control flow: ${extractControlFlow()}. ` +
           `Data structures: ${extractDataStructures()}. ` +
           `Time complexity: ${estimateComplexity()}.`;
  }
};
```

### 4.4 DSL/Domain Languages (Music, Math, Chemistry)

```javascript
const domainLanguageStrategy = {
  focus: ['domain-terms', 'notation', 'relationships', 'constraints'],
  
  extractors: {
    // Highly specific to domain
    musicTerms: /note|chord|scale|tempo|measure/gi,
    mathTerms: /integral|derivative|matrix|vector/gi,
    chemTerms: /molecule|bond|reaction|element/gi
  },
  
  embeddingTemplate: (example) => {
    return `Domain: ${identifyDomain()}. ` +
           `Concepts: ${extractDomainConcepts()}. ` +
           `Notation: ${extractNotation()}. ` +
           `Constraints: ${extractConstraints()}.`;
  }
};
```

---

## 5. Database Sizing Guidelines

### 5.1 Universal Sizing Formula

```javascript
function calculateOptimalSize(languageSpec) {
  const factors = {
    coreConcepts: languageSpec.concepts.length,      // Number of main concepts
    variations: 3,                                    // Variations per concept
    combinations: Math.min(languageSpec.concepts.length * 2, 50), // Concept combinations
    edgeCases: Math.ceil(coreConcepts * 0.2),       // 20% for edge cases
    antiPatterns: Math.ceil(coreConcepts * 0.1)      // 10% for what not to do
  };
  
  const minimum = factors.coreConcepts * factors.variations;
  const recommended = minimum + factors.combinations + factors.edgeCases;
  const comprehensive = recommended + factors.antiPatterns + (minimum * 0.5);
  
  return { minimum, recommended, comprehensive };
}
```

### 5.2 Size Recommendations by Language Type

| Language Type | Minimum | Recommended | Comprehensive |
|---------------|---------|-------------|---------------|
| **Simple DSL** (< 20 concepts) | 100-200 | 300-500 | 800-1000 |
| **Visual Language** | 200-400 | 500-800 | 1500-2000 |
| **Data Language** | 300-500 | 800-1200 | 2000-3000 |
| **General Purpose** | 500-800 | 1500-2000 | 5000+ |
| **Complex Domain** | 800-1200 | 2000-3000 | 8000+ |

### 5.3 Distribution Strategy

```javascript
const OPTIMAL_DISTRIBUTION = {
  core: 0.40,      // 40% - Most common patterns
  variations: 0.25, // 25% - Different ways to do same thing
  advanced: 0.20,   // 20% - Complex combinations
  edge: 0.10,      // 10% - Edge cases and unusual patterns
  negative: 0.05   // 5% - Anti-patterns and errors
};
```

---

## 6. Anti-Patterns and Practices to Avoid

### 6.1 Embedding Text Anti-Patterns

**❌ DON'T: Include raw code**
```javascript
// BAD
"{ draw: 'circle', color: 'red', size: 100 }"

// GOOD
"L0001 graphics. Task: Draw red circle. Features: circle, color-red, size-100"
```

**❌ DON'T: Use generic descriptions**
```javascript
// BAD
"Create some graphics"

// GOOD
"L0001 graphics. Task: Create animated logo. Operations: draw shapes, apply animation. Features: logo, animation-rotate, duration-2s"
```

**❌ DON'T: Mix languages**
```javascript
// BAD
"L0001 and L0002 combination for graphics and data"

// GOOD (separate documents for each language)
"L0001 graphics. Task: Create chart visualization..."
"L0002 data. Task: Process chart data..."
```

**❌ DON'T: Include user-specific information**
```javascript
// BAD
"John's spreadsheet for Q3 2024 sales data"

// GOOD
"L0165 spreadsheet. Task: Create sales tracking table. Features: quarterly-data, sum-formulas"
```

### 6.2 Database Anti-Patterns

**❌ DON'T: Duplicate identical examples**
- Each example should offer unique value
- Vary complexity, approach, or feature combination

**❌ DON'T: Create synthetic examples without testing**
- All examples should produce valid, working code
- Test each example in the actual language runtime

**❌ DON'T: Ignore negative examples**
- Include examples of what NOT to do
- Help the model learn boundaries and constraints

**❌ DON'T: Use inconsistent terminology**
- Establish a glossary for your language
- Use consistent terms across all embeddings

### 6.3 Search Configuration Anti-Patterns

**❌ DON'T: Use pure vector search for code**
```javascript
// BAD - Loses precision
const results = await vectorSearch(query);

// GOOD - Combines semantic and keyword
const results = await hybridSearch(query, { vectorWeight: 0.7 });
```

**❌ DON'T: Retrieve too many examples**
```javascript
// BAD - Overwhelms context window
const examples = await search(query, { limit: 20 });

// GOOD - Quality over quantity
const examples = await search(query, { limit: 3 });
```

**❌ DON'T: Ignore similarity scores**
```javascript
// BAD - Uses low-quality matches
const examples = results.slice(0, 3);

// GOOD - Filters by quality
const examples = results.filter(r => r.similarity > 0.7).slice(0, 3);
```

---

## 7. Performance Optimization

### 7.1 Embedding Generation Optimization

```javascript
// Cache frequently used embeddings
const embeddingCache = new Map();

async function getEmbedding(text) {
  if (embeddingCache.has(text)) {
    return embeddingCache.get(text);
  }
  
  const embedding = await generateEmbedding(text);
  embeddingCache.set(text, embedding);
  return embedding;
}
```

### 7.2 Search Optimization

```javascript
// Pre-filter before vector search
async function optimizedSearch(query, lang) {
  // 1. Language-specific collection
  const collection = `examples_${lang}`;
  
  // 2. Metadata filtering (faster than vector search)
  let searchQuery = db.collection(collection)
    .where('lang', '==', lang)
    .where('complexity', '<=', inferredComplexity);
  
  // 3. Vector search on filtered set
  return await vectorSearch(searchQuery, query);
}
```

### 7.3 Retrieval Optimization

```javascript
// Smart example selection
function selectOptimalExamples(results, query) {
  const selected = [];
  const usedPatterns = new Set();
  
  for (const result of results) {
    // Skip similar examples
    const pattern = extractPattern(result);
    if (usedPatterns.has(pattern)) continue;
    
    // Ensure diversity
    selected.push(result);
    usedPatterns.add(pattern);
    
    if (selected.length >= 3) break;
  }
  
  return selected;
}
```

---

## 8. Monitoring and Iteration

### 8.1 Key Metrics to Track

```javascript
const METRICS = {
  retrieval: {
    avgSimilarityScore: 0.75,    // Target > 0.7
    retrievalCoverage: 0.85,      // % queries with good matches
    diversityScore: 0.6,          // Variety in retrieved examples
  },
  
  effectiveness: {
    codeGenerationSuccess: 0.9,   // % successful generations
    compilationRate: 0.95,        // % that compile/run
    userSatisfaction: 0.8,        // % accepted by users
  },
  
  performance: {
    embeddingLatency: 100,        // Target < 100ms
    searchLatency: 200,           // Target < 200ms
    endToEndLatency: 1000,        // Target < 1s
  }
};
```

### 8.2 Continuous Improvement Process

```javascript
async function analyzeAndImprove() {
  // 1. Identify gaps
  const lowScoreQueries = await findLowSimilarityQueries();
  const failedGenerations = await findFailedGenerations();
  
  // 2. Analyze patterns
  const missingPatterns = extractMissingPatterns(lowScoreQueries);
  const commonErrors = extractCommonErrors(failedGenerations);
  
  // 3. Generate new examples
  const newExamples = await createExamplesForPatterns(missingPatterns);
  
  // 4. Update embeddings
  await updateEmbeddings(newExamples);
  
  // 5. Adjust weights if needed
  const optimalWeights = await tuneHybridWeights();
  
  return { newExamples, optimalWeights };
}
```

### 8.3 A/B Testing Framework

```javascript
// Test different configurations
const configurations = [
  { name: 'baseline', vectorWeight: 0.7, limit: 3 },
  { name: 'semantic-heavy', vectorWeight: 0.85, limit: 3 },
  { name: 'keyword-heavy', vectorWeight: 0.55, limit: 3 },
  { name: 'more-examples', vectorWeight: 0.7, limit: 5 }
];

async function runABTest(query, configs) {
  const results = {};
  
  for (const config of configs) {
    const startTime = Date.now();
    const generation = await generateWithConfig(query, config);
    
    results[config.name] = {
      success: generation.success,
      quality: await assessQuality(generation.code),
      latency: Date.now() - startTime,
      similarity: generation.avgSimilarity
    };
  }
  
  return results;
}
```

---

## 9. Advanced Techniques

### 9.1 Multi-Modal Embeddings

For languages that include visual or structural elements:

```javascript
function createMultiModalEmbedding(example) {
  const textEmbedding = createTextEmbedding(example.description);
  const structureEmbedding = createStructureEmbedding(example.ast);
  const visualEmbedding = example.visual ? 
    createVisualEmbedding(example.visual) : null;
  
  // Combine embeddings with weights
  return combineEmbeddings({
    text: { embedding: textEmbedding, weight: 0.5 },
    structure: { embedding: structureEmbedding, weight: 0.3 },
    visual: { embedding: visualEmbedding, weight: 0.2 }
  });
}
```

### 9.2 Contextual Reranking

Rerank results based on user context:

```javascript
function rerankByContext(results, context) {
  return results.map(result => {
    let contextBoost = 1.0;
    
    // Boost based on user's previous queries
    if (context.history.includes(result.pattern)) {
      contextBoost *= 1.2;
    }
    
    // Boost based on user's skill level
    if (result.complexity === context.userLevel) {
      contextBoost *= 1.1;
    }
    
    // Boost based on recency
    const daysSinceUpdate = getDaysSince(result.lastUpdated);
    contextBoost *= Math.max(0.8, 1 - (daysSinceUpdate / 365));
    
    return {
      ...result,
      adjustedScore: result.combinedScore * contextBoost
    };
  }).sort((a, b) => b.adjustedScore - a.adjustedScore);
}
```

### 9.3 Feedback Loop Integration

```javascript
async function integrateUserFeedback(requestId, feedback) {
  const session = await getSession(requestId);
  
  if (feedback.accepted) {
    // Boost similar patterns in future
    await boostPattern(session.retrievedPatterns);
    
    // Add to training set if novel
    if (isNovelSolution(session)) {
      await addToTrainingSet(session);
    }
  } else {
    // Reduce weight of this pattern
    await reducePattern(session.retrievedPatterns);
    
    // Log for manual review
    await logForReview(session, feedback.reason);
  }
}
```

---

## 10. Quick Reference Checklist

### For Every Graffiticode Language:

- [ ] **Embedding Text Structure**
  - [ ] Starts with language identifier (L#### type)
  - [ ] Includes task/intent description
  - [ ] Lists operations performed
  - [ ] Extracts domain-specific features
  - [ ] Avoids raw code syntax

- [ ] **Database Content**
  - [ ] 40% common patterns
  - [ ] 25% variations
  - [ ] 20% advanced combinations
  - [ ] 10% edge cases
  - [ ] 5% anti-patterns

- [ ] **Search Configuration**
  - [ ] Hybrid search enabled (70/30 default)
  - [ ] Retrieving 3-5 examples
  - [ ] Filtering by similarity > 0.7
  - [ ] Language-specific collection

- [ ] **Quality Metrics**
  - [ ] Average similarity > 0.7
  - [ ] Retrieval coverage > 80%
  - [ ] Generation success > 90%
  - [ ] Search latency < 200ms

- [ ] **Continuous Improvement**
  - [ ] Tracking low-similarity queries
  - [ ] Adding missing patterns
  - [ ] Tuning hybrid weights
  - [ ] Regular embedding updates

---

## Summary

Successful vector search for Graffiticode languages requires:

1. **Hybrid approach**: 70% semantic + 30% keyword matching
2. **Structured embeddings**: Focus on intent and features, not syntax
3. **Right-sized database**: 500-2000 high-quality examples for most languages
4. **Language-specific optimization**: Tailor extraction to your domain
5. **Continuous monitoring**: Track metrics and iterate based on real usage
6. **Avoid anti-patterns**: Don't embed raw code or use pure vector search

The key is creating rich, searchable embedding texts that describe **what the code does** and **what features it uses**, not the syntax itself. This makes your vector database effective at finding relevant examples for any Graffiticode language.