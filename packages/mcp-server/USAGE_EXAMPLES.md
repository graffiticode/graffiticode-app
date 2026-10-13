# Graffiticode MCP Server — Usage Examples

These examples demonstrate the core workflows for the Graffiticode MCP server. Each can be reproduced by connecting to `https://mcp.graffiticode.org/mcp` from any MCP-compatible client.

Language IDs below (L0159, L0166, L0169) are illustrative — the catalog is dynamic, so always discover it with `list_languages` rather than hard-coding IDs.

> **Generation is asynchronous.** `create_item` and `update_item` return right away with `status: "generating"`. Call `render_item` to wait for and display the finished result — it long-polls, so you don't need your own retry loop, and it keeps language-private `src`/`data` out of the model transcript. Use `get_item` only when you need that raw data for programmatic work.

---

## Example 1: Create a Concept Web Assessment

This example shows the discover → create → await → iterate workflow.

**Step 1: Discover available languages**

```
Tool: list_languages
Args: { "search": "assessment" }
```

Response:
```json
{
  "languages": [
    {
      "id": "L0169",
      "name": "L0169",
      "description": "Interactive concept web assessment diagrams",
      "domains": ["assessments", "diagrams"],
      "when_to_use": "Concept maps and node-link diagrams where the learner is assessed on the relationships between concepts."
    }
  ]
}
```

**Step 2: Create the assessment**

```
Tool: create_item
Args: {
  "language": "L0169",
  "description": "Create a concept web assessment about photosynthesis. Put Photosynthesis at the center, with connected concepts: Sunlight, Carbon Dioxide, Water, Glucose, and Oxygen. Include assessment on all connections."
}
```

Response — note it is not finished yet:
```json
{
  "item_id": "0x1a2b3c…",
  "status": "generating"
}
```

**Step 3: Await the result**

```
Tool: render_item
Args: { "item_id": "0x1a2b3c…" }
```

Blocks until the item is ready, then returns a compact `status: "ready"` result and renders it inline in supported hosts (Claude). Use `get_item` instead if you need the raw compiled `data` and generated code for programmatic work.

**Step 4: Iterate**

```
Tool: update_item
Args: {
  "item_id": "0x1a2b3c…",
  "modification": "Add Chlorophyll as a connected concept between Sunlight and Photosynthesis. Use a dark theme."
}
```

The server maintains conversation history, so the language AI knows the full context of what's been built. Call `render_item` again to await and display the updated result.

---

## Example 2: Build a Spreadsheet

**Step 1: Get language details**

```
Tool: get_language_info
Args: { "language": "L0166" }
```

Returns an inline `authoring_guide`, `supported_item_types`, `not_for` (out-of-scope uses), `example_prompts`, a `spec_url`, and a `user_guide_resource` URI. For deeper reference, read that resource:

```
ReadResource: graffiticode://language/L0166/user-guide
```

**Step 2: Create a spreadsheet**

```
Tool: create_item
Args: {
  "language": "L0166",
  "description": "Create a monthly budget spreadsheet with columns for Category, Budgeted Amount, Actual Amount, and Difference. Include rows for Rent, Groceries, Utilities, Transportation, and Entertainment. Add a totals row at the bottom with SUM formulas."
}
```

**Step 3: Update the spreadsheet**

```
Tool: update_item
Args: {
  "item_id": "<item_id from step 2>",
  "modification": "Add a Savings row after Entertainment with a budgeted amount of 500. Make the header row blue."
}
```

---

## Example 3: Create Flashcards

**Step 1: Discover the flashcard language**

```
Tool: list_languages
Args: { "search": "flashcard" }
```

Response:
```json
{
  "languages": [
    {
      "id": "L0159",
      "name": "L0159",
      "description": "Flashcards, Match and Memory card games",
      "domains": ["assessments"],
      "when_to_use": "Study and recall activities built from term/definition pairs."
    }
  ]
}
```

**Step 2: Create a flashcard set**

```
Tool: create_item
Args: {
  "language": "L0159",
  "description": "Create a set of 8 flashcards for learning Spanish greetings. Include: Hello/Hola, Goodbye/Adiós, Good morning/Buenos días, Good night/Buenas noches, Please/Por favor, Thank you/Gracias, How are you?/¿Cómo estás?, Nice to meet you/Mucho gusto."
}
```

**Step 3: Retrieve the item**

```
Tool: get_item
Args: { "item_id": "<item_id from step 2>" }
```

---

## Example 4: Reuse Content Across Languages (`get_spec`)

Say you have a spreadsheet of vocabulary (L0166) and you want flashcards (L0159) from the same content.

**Do not** pass the spreadsheet's `item_id`, `src`, or `data` to `create_item` — those are private to the language that produced them, and the server will reject an item id passed as a description.

Instead, bridge through a spec:

**Step 1: Get a platform-neutral spec of the existing item**

```
Tool: get_spec
Args: { "item_id": "<spreadsheet item_id>" }
```

Returns a plain-English description of the item's content — the sanctioned cross-language bridge.

**Step 2: Create the new item from that spec**

```
Tool: create_item
Args: {
  "language": "L0159",
  "description": "Create a flashcard set from the following content. <paste the spec text here> Front of each card is the Spanish term, back is the English definition."
}
```

---

## Example 5: Explore the Language Catalog

Browse everything:

```
Tool: list_languages
Args: {}
```

Or narrow by domain:

```
Tool: list_languages
Args: { "domain": "sheets" }
```

Returns language IDs, names, descriptions, `domains` memberships, and a `when_to_use` steering note. The catalog is dynamic and grows as new Graffiticode languages are added.

Some languages are **vendor-gated** — their `when_to_use` says they target a specific vendor or platform. Don't select one unless the user actually named that vendor.

Follow up with `get_language_info` on any language to see its full documentation.
