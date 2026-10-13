// Function to format token usage display
export const formatTokenUsage = (usage) => {
  if (!usage) return "";
  return `Input: ${usage.input_tokens} | Output: ${usage.output_tokens} | Total: ${usage.input_tokens + usage.output_tokens}`;
};

// Convert CSV data to markdown table, with support for values that contain spaces
export const formatAsMarkdownTable = (text) => {
  const lines = text.trim().split('\n');

  // Filter out empty lines
  const nonEmptyLines = lines.filter(line => line.trim().length > 0);
  // Function to extract cell content preserving commas inside quotes
  const extractCellsFromLine = (line) => {
    // Fast path for simple cases
    if (!line.includes('"')) {
      return line.split(',').map(cell => cell.trim());
    }
    // Use parseCSVLine for proper handling of quoted values
    return parseCSVLine(line);
  };
  // Single line data should NOT be formatted as a table - requires at least 2 rows
  if (nonEmptyLines.length === 1) {
    return text;
  }
  // For multi-line CSV data
  if (nonEmptyLines.length < 2) return text; // Return original if not enough data

  // Parse each line to extract cells properly
  const rows = nonEmptyLines.map(line => {
    // Extract cells preserving quoted content
    const cells = extractCellsFromLine(line);
    // Clean up and escape cells for markdown table
    return cells.map(cell => {
      let cleanCell = cell.trim().replace(/\|/g, '\\|');
      // Handle parentheses for negative values in financial data
      if (cleanCell.includes('(') && cleanCell.includes(')')) {
        // Convert (123) format to -123 for better readability if it looks like a number
        if (/^\(\s*\d[\d\s,.]*\)$/.test(cleanCell)) {
          cleanCell = '-' + cleanCell.replace(/[()]/g, '').trim();
        }
      }
      return cleanCell;
    });
  });

  // Create the markdown table
  let markdownTable = '';

  // Get max column count (in case rows have different column counts)
  const maxColumnCount = rows.reduce((max, row) => Math.max(max, row.length), 0);

  // First row is always the header in CSV
  const headerRow = [...rows[0]];
  const dataStartIndex = 1;

  // Ensure header has enough columns
  while (headerRow.length < maxColumnCount) {
    headerRow.push('Column ' + (headerRow.length + 1)); // Add default header names
  }
  markdownTable += '| ' + headerRow.join(' | ') + ' |\n';
  markdownTable += '| ' + headerRow.map(() => '---').join(' | ') + ' |\n';

  // Data rows
  for (let i = dataStartIndex; i < rows.length; i++) {
    // Ensure consistent column count by padding if necessary
    const paddedRow = [...rows[i]];
    while (paddedRow.length < maxColumnCount) {
      paddedRow.push('');
    }
    markdownTable += '| ' + paddedRow.join(' | ') + ' |\n';
  }

  return markdownTable;
};

// Process mixed content with text and tables
export const processMixedContent = (text) => {
  if (!text || typeof text !== 'string') return text;

  // Check if this might be an entire CSV table from the first line
  const lines = text.trim().split('\n');
  // Check if any lines contain quoted values that might include commas
  const hasQuotedValues = lines.some(line => /"[^"]*"/.test(line));

    // Special handling for content that looks like a CSV table from the start
    if (lines.length >= 2) {
      if (hasQuotedValues) {
        // For CSV with quotes, we need to use our proper CSV parser
        try {
          // Parse the first line to see if it has multiple cells
          const firstLineCells = parseCSVLine(lines[0]);
          if (firstLineCells.length >= 2) {
            // Now try to parse subsequent lines and check consistency
            let validCellsCount = 0;
            for (let i = 1; i < lines.length; i++) {
              if (lines[i].trim() === '') continue;
              try {
                const cells = parseCSVLine(lines[i]);
                // If this line has roughly the same number of cells as the first line,
                // it's likely part of the same CSV table
                if (Math.abs(cells.length - firstLineCells.length) <= 1 && cells.length >= 2) {
                  validCellsCount++;
                }
              } catch (e) {
                // Skip parsing errors
              }
            }
            const nonEmptyLines = lines.slice(1).filter(line => line.trim() !== '').length; // Count non-empty lines after first
            const validRatio = nonEmptyLines > 0 ? validCellsCount / nonEmptyLines : 0;
            // If at least 50% of non-empty lines have a similar cell structure,
            // this is likely a CSV table from the start
            if (validRatio >= 0.5 || validCellsCount >= 2) {
              return formatAsMarkdownTable(text);
            }
          }
        } catch (e) {
          console.error("Error parsing potential CSV with quotes:", e);
        }
      } else {
        // For regular CSV without quotes, check comma patterns
        const firstLineHasCommas = lines[0].includes(',');
        const commaCount = (lines[0].match(/,/g) || []).length;
        if (firstLineHasCommas && commaCount >= 1) {
          // Count how many lines have similar comma patterns
          const linesWithCommas = lines.filter(line => {
            const lineCommaCount = (line.match(/,/g) || []).length;
            // Allow some variation in comma count (±1)
            return lineCommaCount >= commaCount - 1 && lineCommaCount <= commaCount + 1;
          });
          const csvConsistencyRatio = linesWithCommas.length / lines.length;
          // If at least 60% of lines have consistent comma patterns and there are at least 2 columns,
          // this is likely a CSV table from the start
          if (csvConsistencyRatio >= 0.6 && commaCount >= 1) {
            return formatAsMarkdownTable(text);
          }
        }
      }
    }
    // Single-line input should not be treated as CSV - requires at least 2 rows
    if (!text.includes('\n')) {
      return text;
    }

    // Look for mixed content with text followed by a table
    // This will check after each newline to see if the remaining content looks like a CSV table
    for (let i = 0; i < lines.length - 2; i++) {
      // Need at least 2 lines for a table, so don't check near the end
      if (i >= lines.length - 2) break;

      // Get the text before and after this position
      const textPart = lines.slice(0, i + 1).join('\n');
      const tablePart = lines.slice(i + 1).join('\n');

      // Skip if either part is too short
      if (!textPart.trim() || !tablePart.trim()) continue;

      // Check if the table part contains CSV-like data
      const tableLines = tablePart.split('\n').filter(line => line.trim() !== '');
      // Check if there are quoted values in the table part
      const hasQuotedValues = tableLines.some(line => /"[^"]*"/.test(line));
  // For content with quoted values, use our CSV parser instead of simple comma counting
  if (hasQuotedValues) {
    try {
      // Check if first line can be parsed as CSV with multiple cells
      const firstLineCells = parseCSVLine(tableLines[0]);
      if (firstLineCells.length >= 2 && tableLines.length >= 2) {
        // Try to parse subsequent lines and count how many match the pattern
        let validLinesCount = 0;
        for (let j = 1; j < tableLines.length; j++) {
          try {
            const cells = parseCSVLine(tableLines[j]);
            if (Math.abs(cells.length - firstLineCells.length) <= 1 && cells.length >= 2) {
              validLinesCount++;
            }
          } catch (e) {
            // Skip parsing errors
          }
        }
        const validRatio = validLinesCount / (tableLines.length - 1);
        // Also check if the last line of text ends with a colon - this is a stronger indicator
        const endsWithColon = textPart.trim().endsWith(':');
        // For quoted CSV, accept it if either:
        // 1. The text ends with a colon and we have at least one valid line, OR
        // 2. At least 50% of lines match the pattern
        if ((endsWithColon && validLinesCount > 0) || validRatio >= 0.5) {
          // Format just the table part as a table
          const formattedTable = formatAsMarkdownTable(tablePart);
          // Return the text part with the formatted table
          return textPart + "\n\n" + formattedTable;
        }
      }
    } catch (e) {
      console.error("Error checking for quoted CSV in mixed content:", e);
    }
  } else {
    // Regular CSV check for content without quotes
    // Check if we have enough CSV-like lines and they contain commas
    const commaLines = tableLines.filter(line => line.includes(','));
    const hasEnoughLines = tableLines.length >= 2;
    const hasEnoughCommas = commaLines.length >= Math.ceil(tableLines.length * 0.4); // At least 40% of lines should have commas


    // Also check if the last line of text ends with a colon - this is a stronger indicator
    const endsWithColon = textPart.trim().endsWith(':');

    // The best boundary would be text ending with a colon, but we'll accept other boundaries too
    if (hasEnoughLines && hasEnoughCommas && (endsWithColon || commaLines.length >= 3)) {

      // Format just the table part as a table
      const formattedTable = formatAsMarkdownTable(tablePart);

      // Return the text part with the formatted table
      return textPart + "\n\n" + formattedTable;
    }
  }
}

// If the colon pattern didn't match or wasn't valid CSV, proceed with normal detection

// First check: If it's a simple all-table content, process it directly
if (isTabularData(text)) {
  return formatAsMarkdownTable(text);
}

// For mixed content, identify the sections
const sections = identifyTabularSections(text);

// If no mixed content is detected, return the original text
if (sections.length <= 1) {
  // Special case: if we have exactly one section and it's a table section
  if (sections.length === 1 && sections[0].type === 'table') {
    const tableText = sections[0].lines.join('\n');
    return formatAsMarkdownTable(tableText);
  }
  return text;
}

// Check if any section is identified as a table
const hasTableSection = sections.some(section => section.type === 'table');
if (!hasTableSection) {
  return text;
}

// Process each section
const processedText = sections.map(section => {
  if (section.type === 'table') {
    const tableText = section.lines.join('\n');

    // For single-line tables, we've already validated them during section identification
    if (section.lines.length === 1) {
      return formatAsMarkdownTable(tableText);
    }
    // For multi-line tables, do an extra validation
    if (section.lines.length >= 2 && isTabularData(tableText)) {
      return formatAsMarkdownTable(tableText);
    } else {
      return tableText;
    }
  } else {
    // For text sections, just join the lines back
    return section.lines.join('\n');
  }
}).join('\n\n');

return processedText;
};

// Parse CSV with proper handling of quoted values and values with spaces
export const parseCSVLine = (line) => {
  if (!line) return [];
  const result = [];
  let cell = '';
  let inQuotes = false;
  let isQuotedCell = false;

  // If there are no commas, treat it as a single cell
  if (!line.includes(',')) {
    const trimmed = line.trim();
    // Handle case of a single quoted value
    if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length > 2) {
      return [trimmed.substring(1, trimmed.length - 1)];
    }
    return [trimmed];
  }

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    const nextChar = line[i + 1];

    if (char === '"' && (i === 0 || line[i - 1] === ',' || /\s/.test(line[i - 1]))) {
      // Start of quoted cell
      inQuotes = true;
      isQuotedCell = true;
      // Skip the opening quote (don't add to cell)
      continue;
    } else if (char === '"' && nextChar === '"' && inQuotes) {
      // Escaped quote inside quoted cell (RFC 4180)
      cell += '"';
      i++; // Skip next quote
      continue;
    } else if (char === '"' && (nextChar === ',' || !nextChar || /\s/.test(nextChar)) && inQuotes) {
      // End of quoted cell
      inQuotes = false;
      // Skip the closing quote (don't add to cell)
      if (nextChar === ',') i++; // Skip next comma
      result.push(cell.trim()); // Trim whitespace
      cell = '';
      isQuotedCell = false;
      continue;
    } else if (char === ',' && !inQuotes) {
      // Unquoted cell delimiter
      result.push(cell.trim()); // Trim whitespace
      cell = '';
      isQuotedCell = false;
      continue;
    }

    // Add character to current cell
    cell += char;
  }

  // Add the last cell
  if (cell !== '') {
    result.push(cell.trim()); // Trim whitespace
  }

  return result;
};

// Check if a single line looks like CSV data
export const isLineTabular = (line) => {
  if (!line || typeof line !== 'string') return false;

  // Trim the line to remove whitespace that might affect detection
  const trimmedLine = line.trim();
  if (trimmedLine === '') return false;
  // Check if line starts with characters that suggest it's a heading, not data
  const isPotentialHeading = /^(#|\*|-|\d+\.|>)/.test(trimmedLine);
  // Check for quoted values that may contain commas
  const hasQuotedValues = /"[^"]*"/.test(trimmedLine);
  // If we have quoted values, try parsing with our CSV parser to get actual cell count
  if (hasQuotedValues) {
    try {
      const cells = parseCSVLine(trimmedLine);
      // If we have at least 2 columns after parsing, it's likely CSV
      if (cells.length >= 2) {
        return true;
      }
    } catch (e) {
      console.error("Error parsing line with quotes for CSV detection:", e);
    }
  }
  // Count commas for CSV detection (for non-quoted values or as fallback)
  const commaCount = trimmedLine.split(',').length - 1;

  // If it looks like a markdown heading or list item and only has 0-1 commas, don't treat as CSV
  if (isPotentialHeading && commaCount <= 1) return false;

  // Basic heuristic: if line has multiple commas, it's likely CSV
  // Note: We require at least 1 comma (2 fields) for better accuracy
  return commaCount >= 1;
};

// Identify tabular sections within mixed content
export const identifyTabularSections = (text) => {
  if (!text || typeof text !== 'string') return [];

  const lines = text.trim().split('\n');
  const sections = [];
  let currentSection = null;

  // Store consecutive non-table line count to better handle transitions
  let consecutiveNonTableLines = 0;

  // Single-line input should never be treated as a table
  if (lines.length === 1) {
    return [{
      type: 'text',
      startLine: 0,
      endLine: 0,
      lines: [lines[0]]
    }];
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const isTableLine = isLineTabular(line);

    // Empty lines don't break table sections, just skip them for analysis
    if (line.trim() === '') {
      if (currentSection) {
        // Add empty lines to current section
        currentSection.lines.push(line);
        currentSection.endLine = i;
      }
      continue;
    }

    if (isTableLine) {
      // Reset the counter when we find a table line
      consecutiveNonTableLines = 0;

      if (!currentSection) {
        // Start a new table section
        currentSection = {
          type: 'table',
          startLine: i,
          endLine: i,
          lines: [line]
        };
      } else if (currentSection.type === 'table') {
        // Continue existing table section
        currentSection.lines.push(line);
        currentSection.endLine = i;
      } else {
        // End text section and start table section
        sections.push(currentSection);
        currentSection = {
          type: 'table',
          startLine: i,
          endLine: i,
          lines: [line]
        };
      }
    } else {
      // It's a non-table line
      consecutiveNonTableLines++;

      if (!currentSection) {
        // Start a new text section
        currentSection = {
          type: 'text',
          startLine: i,
          endLine: i,
          lines: [line]
        };
      } else if (currentSection.type === 'text') {
        // Continue existing text section
        currentSection.lines.push(line);
        currentSection.endLine = i;
      } else {
        // Currently in a table section

        // End table section if:
        // 1. We have consecutive non-table lines, or
        // 2. This line is completely empty and follows a table
        if (consecutiveNonTableLines >= 2) {
          sections.push(currentSection);
          currentSection = {
            type: 'text',
            startLine: i,
            endLine: i,
            lines: [line]
          };
        } else {
          // Otherwise treat it as header/description text that's part of the table
          currentSection.lines.push(line);
          currentSection.endLine = i;
        }
      }
    }
  }

  // Add the last section
  if (currentSection) {
    sections.push(currentSection);
  }

  // Post-process: merge very small table sections into text and ensure sections are properly separated
  const processedSections = sections.map(section => {
    // Single-line tables can be valid if they have enough columns
    if (section.type === 'table' && section.lines.length === 1) {
      const line = section.lines[0];
      // Check if this single line has enough commas to be a valid table
      const commaCount = (line.match(/,/g) || []).length;
      const hasQuotedValues = /"[^"]*"/.test(line);
      // Keep as table if it has enough commas or quoted values with commas
      if (commaCount >= 2 || (commaCount >= 1 && hasQuotedValues)) {
        try {
          const cells = parseCSVLine(line);
          if (cells.length >= 2) {
            return section; // Keep as table if it has at least 2 cells
          }
        } catch (e) {
          console.error("Error parsing single-line table section:", e);
        }
      }
      return { ...section, type: 'text' }; // Convert to text if not a valid table
    }
    // Multi-line tables need at least 2 lines to be valid
    if (section.type === 'table' && section.lines.length < 2) {
      return { ...section, type: 'text' };
    }
    return section;
  });

  return processedSections;
};

// Check if text is CSV data, with support for values that contain spaces
export const isTabularData = (text) => {
  if (!text || typeof text !== 'string') return false;

  // Simple check for CSV across multiple lines
  const lines = text.trim().split('\n');
  // Filter out empty lines
  const nonEmptyLines = lines.filter(line => line.trim().length > 0);
  // Check if any lines contain quoted values
  const linesWithQuotes = nonEmptyLines.filter(line => /"[^"]*"/.test(line));
  const hasQuotedValues = linesWithQuotes.length > 0;
  // Check for adjacent rows with matching cell counts - required for CSV detection
  if (nonEmptyLines.length >= 2) {
    try {
      // Parse all lines to get cell counts
      const parsedLines = nonEmptyLines.map(line => {
        try {
          return parseCSVLine(line);
        } catch (e) {
          return [line]; // If parsing fails, treat as single cell
        }
      });

      // Find at least one pair of adjacent rows with matching cell counts (and >= 2 cells)
      let hasAdjacentMatch = false;
      for (let i = 0; i < parsedLines.length - 1; i++) {
        const currentCellCount = parsedLines[i].length;
        const nextCellCount = parsedLines[i + 1].length;

        // Both rows must have at least 2 cells and same count (±1 for flexibility)
        if (currentCellCount >= 2 && nextCellCount >= 2 &&
            Math.abs(currentCellCount - nextCellCount) <= 1) {
          hasAdjacentMatch = true;
          break;
        }
      }

      if (hasAdjacentMatch) {
        // Additional check: ensure at least 60% of lines have similar cell counts
        const cellCounts = parsedLines.map(cells => cells.length);
        const mostCommonCount = cellCounts.sort((a, b) =>
          cellCounts.filter(v => v === a).length - cellCounts.filter(v => v === b).length
        ).pop();

        const consistentLines = cellCounts.filter(count =>
          count >= 2 && Math.abs(count - mostCommonCount) <= 1
        ).length;
        const consistentRatio = consistentLines / cellCounts.length;


        if (consistentRatio >= 0.6) {
          return true;
        }
      } else {
      }
    } catch (e) {
      console.error("Error checking for adjacent row matches:", e);
    }
  }
  // Single line check - NEVER consider a single line as CSV, regardless of commas
  if (nonEmptyLines.length === 1) {
    return false;
  }
  // If we don't have at least 2 non-empty lines, it's not a multi-line CSV
  if (nonEmptyLines.length < 2) return false;

  // For text with quoted values, we need a more careful approach
  if (hasQuotedValues) {
    try {
      // Parse each line using our CSV parser that properly handles quoted values
      const parsedLines = nonEmptyLines.map(line => parseCSVLine(line));
      // Count how many lines have at least 2 cells after parsing
      const validLines = parsedLines.filter(cells => cells.length >= 2);
      const validRatio = validLines.length / nonEmptyLines.length;
      // If at least 50% of lines have 2+ cells, it's likely CSV
      if (validRatio >= 0.5) {
        return true;
      }
      // Get the most common column count to handle inconsistencies
      const columnCounts = parsedLines.map(cols => cols.length);
      const mostCommonColumnCount = columnCounts.sort((a, b) =>
        columnCounts.filter(v => v === a).length - columnCounts.filter(v => v === b).length
      ).pop();

      // Check if most lines have a similar column count (allow ±1 for CSV tables)
      const consistentLines = parsedLines.filter(
        cols => Math.abs(cols.length - mostCommonColumnCount) <= 1
      );

      const consistentRatio = consistentLines.length / parsedLines.length;

      // More lenient threshold (50%) for quoted content and at least 2 columns
      if (consistentRatio >= 0.5 && mostCommonColumnCount >= 2) {
        return true;
      }
    } catch (e) {
      console.error("Error parsing CSV data with quotes:", e);
    }
  } else {
    // For content without quotes, use comma-based checks
    // Basic check: does text contain commas?
    if (!text.includes(',')) return false;

    // Check if this might be just descriptive text with some commas
    // Count lines that are likely CSV rows (have similar comma counts)
    const totalCommaCount = nonEmptyLines.reduce((sum, line) => sum + (line.match(/,/g) || []).length, 0);
    const avgCommasPerLine = totalCommaCount / nonEmptyLines.length;

    // More lenient check for comma frequency - allow as low as 0.7 commas per line on average
    if (avgCommasPerLine < 0.7) {
      return false;
    }

    // Parse each line using our CSV parser
    try {
      const parsedLines = nonEmptyLines.map(line => parseCSVLine(line));

      // Get the most common column count to handle slight inconsistencies
      const columnCounts = parsedLines.map(cols => cols.length);
      const mostCommonColumnCount = columnCounts.sort((a, b) =>
        columnCounts.filter(v => v === a).length - columnCounts.filter(v => v === b).length
      ).pop();

      // Check if most lines have a similar column count (allow ±1 for CSV tables)
      const consistentLines = parsedLines.filter(
        cols => Math.abs(cols.length - mostCommonColumnCount) <= 1
      );

      const consistentRatio = consistentLines.length / parsedLines.length;

      // At least 60% of lines should have consistent columns and there should be at least 2 columns
      if (consistentRatio >= 0.6 && mostCommonColumnCount >= 2) {
        return true;
      }
    } catch (e) {
      console.error("Error parsing CSV data:", e);
    }
  }

  // Finally, check using the isLineTabular to detect if most lines look like CSV
  const tabularLineCount = nonEmptyLines.filter(isLineTabular).length;
  const tabularRatio = tabularLineCount / nonEmptyLines.length;

  // Reduced threshold to 50% to be more lenient with mixed content, especially with quoted values
  return tabularRatio >= 0.5;
};
