# Code Generation Workflow

This document describes the workflow for running code generation over language training examples and updating mark 3 items.

## Scripts

### 1. `scripts/extract-prompts.ts`
Extracts prompts from language repo examples and outputs them as JSON.

**Usage:**
```bash
npx tsx scripts/extract-prompts.ts [options]
```

**Options:**
- `--lang <code>` - Language code (default: 0176)
- `--output <path>` - Output file path (default: `training/data/{lang}-prompts.json`)

**Output:**
Creates a JSON file with extracted prompts from `../l{lang}/packages/core/spec/examples.md`

```json
[
  {
    "id": "0176-example-1",
    "exampleNumber": 1,
    "prompt": "Create a multiple choice question asking ..."
  },
  ...
]
```

**Examples:**
```bash
# Extract L0176 prompts (default)
npx tsx scripts/extract-prompts.ts

# Extract L0170 prompts
npx tsx scripts/extract-prompts.ts --lang 0170 --output training/data/0170-prompts.json
```

### 2. `scripts/run-codegen.ts`
Runs code generation on all prompts and creates a comprehensive mapping file.

**Usage:**
```bash
npx tsx scripts/run-codegen.ts [options]
```

**Options:**
- `--lang <code>` - Language code (default: 0176)
- `--limit <number>` - Maximum number of examples to process (default: all)
- `--output <path>` - Output file path (default: `training/data/{lang}-codegen-mapping.json`)
- `--start <index>` - Start processing from example index (0-based, default: 0)
- `--dry-run` - Print extracted prompts without running code gen

**Requirements:**
- `GC_API_KEY_SECRET` in `.env.local` (your API key, used via eval-env.ts)
- `api.graffiticode.org` must be reachable
- Proper Firebase and Anthropic setup (handled by eval-env.ts)

**Output:**
Creates a JSON file with code generation results for each prompt:

```json
[
  {
    "id": "0176-example-1",
    "exampleNumber": 1,
    "prompt": "Create a multiple choice question asking ...",
    "generatedCode": "set-var \"lrn-id\" get-val-public \"itemId\"\nlearnosity items [...",
    "compiled": true,
    "fixAttempts": 0,
    "cost": 0.0123,
    "taskId": "eyJ0YXNrSWRzIjpbIkRCS0hlQXBjMHAzcjVDTUpTQWd4Il19",
    "verification": { ... },
    "timestamp": "2026-08-19T18:30:00.000Z"
  },
  {
    "id": "0176-example-2",
    "exampleNumber": 2,
    "prompt": "...",
    "generatedCode": "...",
    "compiled": false,
    "fixAttempts": 1,
    "cost": 0.0456,
    "taskId": null,
    "verification": null,
    "timestamp": "2026-08-19T18:30:15.000Z"
  }
]
```

**Examples:**

Dry run L0176 (just extract and display prompts):
```bash
npx tsx scripts/run-codegen.ts --dry-run
```

Process first 10 L0176 examples:
```bash
npx tsx scripts/run-codegen.ts --limit 10
```

Process L0170 from example 20 onward:
```bash
npx tsx scripts/run-codegen.ts --lang 0170 --start 20
```

Process all L0175 examples:
```bash
npx tsx scripts/run-codegen.ts --lang 0175
```

## Workflow

### Step 1: Extract Prompts (Optional Review)
```bash
npx tsx scripts/extract-0176-prompts.ts
cat training/data/0176-prompts.json | jq '.[0:5]'  # Preview first 5
```

### Step 2: Run Code Generation
```bash
# Dry run first to verify setup
npx tsx scripts/run-codegen-0176.ts --dry-run --limit 5

# Run on all 170 examples
EVAL_API_KEY=your-key npx tsx scripts/run-codegen-0176.ts
```

This will:
- Extract all 170 prompts from `../l0176/packages/core/spec/examples.md`
- Run code generation on each prompt
- Track compilation success, fix attempts, and cost
- Write results to `training/data/0176-codegen-mapping.json`
- Print a summary (compilation rate, total cost, etc.)

### Step 3: Review Results
```bash
# Check summary statistics
cat training/data/0176-codegen-mapping.json | \
  jq '[.[] | .compiled] | group_by(.) | map({status: .[0], count: length})'

# View failed examples
cat training/data/0176-codegen-mapping.json | \
  jq '.[] | select(.compiled == false) | {id, error}'
```

### Step 4: Replace Mark 3 Items
After review approval, a separate script will:
- Load the mapping file results
- Update Firestore items tagged with mark=3 on the user's account
- Tag them with the generated code and mark them as processed

(Script to be created after review)

### 3. `scripts/upload-codegen-mapping.ts`
Uploads generated code mappings to Firestore as training items.

**Usage:**
```bash
npx tsx scripts/upload-codegen-mapping.ts --lang <code> --mark <number> [options]
```

**Required:**
- `--lang <code>` - Language code (required)
- `--mark <number>` - Mark to assign (required)

**Options:**
- `--input <path>` - Input mapping file (default: `training/data/{lang}-codegen-mapping.json`)
- `--refresh` - Delete existing items of same lang/mark before uploading
- `--dry-run` - Show what would be uploaded without uploading
- `--limit <number>` - Upload only first N items (default: all)
- `--start <index>` - Start from example index (default: 0)

**Requirements:**
- Mapping file must exist from `run-codegen.ts`
- `GC_API_KEY_UID` in `.env.local` (your user ID)
- Firebase credentials configured

**Examples:**

Dry run on first 10 items with mark 3:
```bash
npx tsx scripts/upload-codegen-mapping.ts --mark 3 --limit 10 --dry-run
```

Upload all L0176 items as mark 3, deleting existing mark 3 items first:
```bash
npx tsx scripts/upload-codegen-mapping.ts --mark 3 --refresh
```

Upload L0170 items as mark 4, replacing existing mark 4 items:
```bash
npx tsx scripts/upload-codegen-mapping.ts --lang 0170 --mark 4 --refresh
```

## Data Files

Located in `training/data/`:

- **{lang}-prompts.json** - Extracted prompts only
- **{lang}-codegen-mapping.json** - Full results with generated code, compilation status, costs, taskIds

## Workflow Summary

```bash
# 1. Extract prompts (optional for review)
npx tsx scripts/extract-prompts.ts --lang 0176

# 2. Generate code and verify compilation
npx tsx scripts/run-codegen.ts --lang 0176

# 3. Review results
cat training/data/0176-codegen-mapping.json | jq '[.[] | .compiled] | group_by(.) | map({status: .[0], count: length})'

# 4. Upload to Firestore as mark 3 (with --refresh to replace existing mark 3 items)
npx tsx scripts/upload-codegen-mapping.ts --mark 3 --lang 0176 --refresh --dry-run
npx tsx scripts/upload-codegen-mapping.ts --mark 3 --lang 0176 --refresh
```

## Notes

- **Compilation Status**: Each item includes a `taskId` (successful compile) or null (failed)
- **Refresh Mode**: Use `--refresh` to delete existing mark 3 items before uploading new ones
- **Dry Run**: Always use `--dry-run` first to verify what will be uploaded
- **Mark Value**: Training marks are configurable; mark 3 is the conventional value for generated examples
- **Item Naming**: Items are named with the example id (e.g., `0176-example-1`)
