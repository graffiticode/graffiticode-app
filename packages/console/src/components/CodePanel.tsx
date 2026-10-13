import { useState, useEffect } from "react";
import { EditorView, gutter, GutterMarker } from "@codemirror/view";
import { Decoration, ViewPlugin } from "@codemirror/view";
import { StateField, StateEffect, RangeSet } from "@codemirror/state";
import useCodeMirror from "../utils/cm/use-codemirror";
import { debounce } from "lodash";
import useGraffiticodeAuth from '@graffiticode/auth-react';

const getCode = view => {
  if (view === undefined) {
    return "";
  }
  const doc = view.state.doc;
  const lines = [];
  for (const text of doc.iter()) {
    lines.push(text);
  }
  return lines.join("");
};

const debouncedStartCompletion = debounce(({ view, setCode }) => {
  const doc = view.state.doc;
  const lines = [];
  for (const text of doc.iter()) {
    lines.push(text);
  }
  const user = 'public';
  const code = getCode(view);
  if (code !== '') {
    setCode(code);
  }
}, 300);

function customCompletionDisplay({ setCode }) {
  return EditorView.updateListener.of(({ view, docChanged, transactions }) => {
    if (docChanged) {
      // when a completion is active each keystroke triggers the
      // completion source function, to avoid it we close any open
      // completion inmediatly.
      //closeCompletion(view);
      debouncedStartCompletion({ view, setCode });
    }
  });
}

// Create custom effects to update error decorations and gutter markers
const addErrorMarksEffect = StateEffect.define<any>();
const addGutterMarkersEffect = StateEffect.define<any>();

// Custom gutter marker for errors
class ErrorMarker extends GutterMarker {
  message: string;

  constructor(message: string) {
    super();
    this.message = message;
  }

  // Define how the marker is displayed
  toDOM() {
    const marker = document.createElement("div");
    marker.className = "cm-gutter-error-marker";
    marker.textContent = "⚠️";
    return marker;
  }
}

// Create a state field to track error marks
const errorMarksField = StateField.define({
  create() {
    return Decoration.none;
  },
  update(value, tr) {
    // Clear marks when document changes
    value = value.map(tr.changes);

    // Check for our custom effect
    for (const effect of tr.effects) {
      if (effect.is(addErrorMarksEffect)) {
        value = effect.value;
      }
    }

    return value;
  },
  provide: field => EditorView.decorations.from(field)
});

// Create a state field to track gutter markers
const gutterMarkersField = StateField.define({
  create() {
    return RangeSet.empty;
  },
  update(value, tr) {
    // Clear markers when document changes
    value = value.map(tr.changes);

    // Check for our custom effect
    for (const effect of tr.effects) {
      if (effect.is(addGutterMarkersEffect)) {
        value = effect.value;
      }
    }

    return value;
  }
});

// Define the error gutter
const errorGutter = gutter({
  class: "cm-error-gutter",
  markers: view => view.state.field(gutterMarkersField)
});

// Create a ViewPlugin to handle error tooltip positioning
const errorTooltipPlugin = ViewPlugin.fromClass(class {
  view: any;
  tooltipHandlers: any[];
  observer: MutationObserver;

  constructor(view: any) {
    this.view = view;
    this.tooltipHandlers = [];

    // Create a MutationObserver to detect error markers being added to the DOM
    this.observer = new MutationObserver(this.handleDOMChanges.bind(this));
    this.observer.observe(view.dom, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class']
    });
  }

  handleDOMChanges(mutations) {
    // Find any newly added error markers
    for (const mutation of mutations) {
      if (mutation.type === 'childList') {
        for (const node of mutation.addedNodes) {
          if (node.nodeType === Node.ELEMENT_NODE) {
            this.setupErrorMarkers(node);
          }
        }
      } else if (mutation.type === 'attributes' &&
                mutation.attributeName === 'class' &&
                mutation.target.classList.contains('cm-error-highlight')) {
        this.setupErrorMarkers(mutation.target);
      }
    }
  }

  setupErrorMarkers(node) {
    // Check if node is an error marker or contains error markers
    const errorMarkers = node.classList?.contains('cm-error-highlight')
                  ? [node]
                  : Array.from(node.querySelectorAll('.cm-error-highlight'));

    // Also check for gutter markers
    const gutterMarkers = node.classList?.contains('cm-gutter-error-marker')
                  ? [node]
                  : Array.from(node.querySelectorAll('.cm-gutter-error-marker'));

    // Process all markers
    const allMarkers = [...errorMarkers, ...gutterMarkers];

    // For each marker, add mouseover and mouseout event listeners
    for (const marker of allMarkers) {
      if (!marker._hasTooltipHandler) {
        marker._hasTooltipHandler = true;

        const handleMouseOver = () => {
          // Get marker position relative to editor
          const rect = marker.getBoundingClientRect();
          const editorRect = this.view.dom.getBoundingClientRect();

          // Calculate if marker is in the top or bottom third of the editor
          const relativePosition = (rect.top - editorRect.top) / editorRect.height;

          // Remove existing positioning classes
          marker.classList.remove('tooltip-top', 'tooltip-bottom');

          // Add appropriate positioning class
          if (relativePosition < 0.3) {
            // If in top third, position tooltip below
            marker.classList.add('tooltip-bottom');
          } else {
            // Otherwise, position tooltip above
            marker.classList.add('tooltip-top');
          }
        };

        marker.addEventListener('mouseover', handleMouseOver);
        this.tooltipHandlers.push({ element: marker, handler: handleMouseOver });
      }
    }
  }

  destroy() {
    // Clean up event listeners and observer
    this.observer.disconnect();
    for (const {element, handler} of this.tooltipHandlers) {
      element.removeEventListener('mouseover', handler);
    }
  }
});

// Create a decoration for an error
const createErrorMark = (from, to, message) => {
  // Ensure message is a string and escape any quotes
  const safeMessage = typeof message === 'string'
    ? message.replace(/"/g, '&quot;')
    : String(message).replace(/"/g, '&quot;');

  return Decoration.mark({
    attributes: {
      class: "cm-error-highlight",
      'data-error': safeMessage // Use data attribute for custom popup
    },
    inclusiveStart: true,
    inclusiveEnd: true
  }).range(from, to);
};

export const CodePanel = ({
  code,
  setCode,
  compiledData
}) => {
  const [ view, setView ] = useState<any>(null);

  const extensions = [
    customCompletionDisplay({ setCode }),
    errorMarksField,
    gutterMarkersField,
    errorGutter,
    errorTooltipPlugin
  ];

  const { ref } = useCodeMirror(extensions, setView, code);

  // Update editor content when code changes
  useEffect(() => {
    if (view) {
      const editorValue = view.state.doc.toString();

      if (code !== editorValue) {
        view.dispatch({
          changes: {
            from: 0,
            to: editorValue.length,
            insert: code || "",
          },
        });
      }
    }
  }, [code, view]);

  // Update error marks when compiledData changes
  useEffect(() => {
    if (!view) return;

    try {
      // Check if we have valid error data - support both "errors" and "error" arrays
      const errors = compiledData?.errors || compiledData?.error || [];
      if (Array.isArray(errors) && errors.length > 0) {

        // Create decoration sets for errors and gutter markers
        let errorDecorations = [];

        // Track which lines already have gutter markers to avoid duplicates
        const markedLines = new Set();
        let gutterMarkers = [];

        // First, sort errors by line to group them
        const sortedErrors = [...errors].filter(Boolean).sort((a, b) => {
          const fromA = parseInt(a.from, 10) || 0;
          const fromB = parseInt(b.from, 10) || 0;
          return fromA - fromB;
        });

        // Group errors by line
        const errorsByLine = {};

        sortedErrors.forEach((error, idx) => {
          if (!error) return;

          // Use the from/to properties directly from the error object
          let from = parseInt(error.from, 10);
          if (isNaN(from) || from < 0) return; // Skip errors without valid positions

          let to = parseInt(error.to, 10);
          to = isNaN(to) || to < 0 ? from + 1 : to;

          // Ensure the range is valid - to must be greater than from
          if (to <= from) {
            to = from + 1;
          }

          // Ensure positions are within document bounds
          const docLength = view.state.doc.length;
          if (from >= docLength) from = Math.max(0, docLength - 1);
          if (to > docLength) to = docLength;

          // Format the error message
          const errorMessage = typeof error.message === 'string' ? error.message :
                             (error.message ? JSON.stringify(error.message) : "Unknown error");
          // 1. Create a decoration for this error (inline highlighting)
          errorDecorations.push(createErrorMark(from, to, errorMessage));

          // 2. Group errors by line for gutter markers
          const line = view.state.doc.lineAt(from);
          const lineNumber = line.number;

          if (!errorsByLine[lineNumber]) {
            errorsByLine[lineNumber] = [];
          }
          errorsByLine[lineNumber].push(errorMessage);
        });

        // Create one gutter marker per line with errors
        Object.entries(errorsByLine).forEach(([lineNumber, messages]: [string, any]) => {
          const linePos = view.state.doc.line(parseInt(lineNumber, 10)).from;

          // If multiple errors on this line, combine them into a single message
          let combinedMessage;
          if (messages.length === 1) {
            combinedMessage = messages[0];
          } else {
            combinedMessage = messages.map((msg, i) => `${i+1}. ${msg}`).join('\n\n');
          }

          // Add a gutter marker for this line
          gutterMarkers.push(new ErrorMarker(combinedMessage).range(linePos));

        });

        // Apply error decorations and gutter markers
        view.dispatch({
          effects: [
            addErrorMarksEffect.of(Decoration.set(errorDecorations)),
            addGutterMarkersEffect.of(RangeSet.of(gutterMarkers, true))
          ]
        });
      } else {
        // Clear error marks and gutter markers if no errors
        view.dispatch({
          effects: [
            addErrorMarksEffect.of(Decoration.none),
            addGutterMarkersEffect.of(RangeSet.empty)
          ]
        });
      }
    } catch (err) {
      console.error("Error setting error marks:", err);
      // Clear error marks and gutter markers on error
      view.dispatch({
        effects: [
          addErrorMarksEffect.of(Decoration.none),
          addGutterMarkersEffect.of(RangeSet.empty)
        ]
      });
    }
  }, [compiledData, view]);

  return (
    <>
      <style jsx global>{`
        /* Editor container styles */
        #editor {
          height: 100%;
          display: flex;
          flex-direction: column;
        }
        #editor .cm-editor {
          flex: 1;
          height: 100%;
        }
        .cm-scroller {
          flex: 1;
          padding-bottom: 4px;
        }
        /* Inline error highlighting */
        .cm-error-highlight {
          background-color: rgba(255, 0, 0, 0.2);
          text-decoration: wavy underline red;
          cursor: text; /* Use normal text/edit cursor */
          position: relative;
        }
        /* Error popup styling - positioned for maximum visibility */
        .cm-error-highlight {
          position: relative; /* Ensure relative positioning for absolute children */
        }
        /* Position tooltip below error near top of editor, above error near bottom */
        /* First, create a rule for all error highlights to check tooltip positioning */
        .cm-error-highlight {
          container-type: inline-size; /* Enable container queries */
        }
        .cm-error-highlight:hover::after {
          content: attr(data-error);
          position: absolute;
          left: 0;
          top: calc(100% + 5px);
          max-height: 300px;
          overflow-y: auto;
          width: max-content;
          max-width: 400px;
          background-color: #f44336;
          color: white;
          padding: 10px 15px;
          border-radius: 6px;
          z-index: 10000;
          box-shadow: none;
          pointer-events: none;
        }
        /* Position tooltip above for errors at the bottom of the editor */
        .cm-error-highlight.tooltip-top:hover::after {
          bottom: calc(100% + 5px);
          top: auto;
        }
        /* Gutter error markers */
        .cm-error-gutter {
          width: 20px;
          text-align: center;
        }
        .cm-gutter-error-marker {
          color: #f44336;
          cursor: pointer;
          text-shadow: none;
          box-shadow: none;
          filter: none;
        }
      `}</style>
      <div
        id="editor"
        ref={ref}
        style={{ height: '100%' }}
      />
    </>
  );
};
