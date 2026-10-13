/*
  -- Add a delete button to each text box so the user can prune the dialog
  -- On save record the mapping from inputs to outputs in a vector database
  -- Use the vector database to generate a few-shot context for the prompt
  -- share the vector database across languages
  -- use compiler errors to give feedback to the lm
 */

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import useSWR from 'swr';
import { TextEditor } from "./TextEditor";
import { createState } from "../lib/state";
import { ChatBot } from './ChatBot';
import { CsvDropzone } from './CsvDropzone';
import useGraffiticodeAuth, { useToken } from '@graffiticode/auth-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import SyntaxHighlighter from 'react-syntax-highlighter/dist/cjs/prism';
import tomorrow from 'react-syntax-highlighter/dist/cjs/styles/prism/tomorrow';
import { useDropzone } from 'react-dropzone';
import { createPortal } from 'react-dom';
import { getStorage } from 'firebase/storage';
import { useFirebaseApp } from 'reactfire';
import { validateImageFile, uploadImageDeduped, listUserImages, fetchArchivedImages } from '../lib/image-upload';
import type { ImageInfo } from '../lib/image-upload';
import { getLanguageAsset } from "../lib/api";
import useLocalStorage from '../hooks/use-local-storage';
import {
  parseCSVLine,
  isTabularData,
  identifyTabularSections,
  formatAsMarkdownTable,
  processMixedContent,
  formatTokenUsage,
} from "../utils/helpPanelUtils";
import { buildTranscriptRows, versionSourceLabel } from "../utils/itemVersions";
import { useVersionSrc } from "../hooks/use-version-src";
import { VersionDiff } from "./VersionDiff";
import { elideCompoundId } from "../utils";

// Add custom CSS for dropzone (removed duplicate overlay to prevent flashing)
const dropzoneStyles = ``;

const isNullOrEmptyObject = (obj) => !obj || Object.keys(obj).length === 0;

// A row's "+N −M lines". When the pair is diffable it becomes the control that
// opens the diff — the row itself is a click target that loads the version, so
// the toggle has to stop the click from getting there.
const StatsLine = ({ stats, diffKey, expanded, onToggle }) => {
  if (!stats) return null;
  if (!diffKey) return <div className="text-xs text-gray-500">{stats}</div>;
  return (
    <button
      type="button"
      className="flex items-center gap-1 text-xs text-gray-500 hover:text-gray-700"
      title={expanded ? 'Hide changes' : 'Show changes'}
      onClick={(event) => {
        event.stopPropagation();
        onToggle();
      }}
    >
      <svg
        className={`w-3 h-3 text-gray-400 transform transition-transform flex-shrink-0 ${expanded ? 'rotate-90' : ''}`}
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
      >
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
      </svg>
      {stats}
    </button>
  );
};

const getHelp = prompt => (
  prompt.indexOf("code:") >= 0 && {
    type: "code",
    text: prompt.slice(prompt.indexOf("code:") + "code:".length).trim()
  } || {
    text: prompt,
  }
);

export const HelpPanel = ({
  help,
  setHelp,
  language,
  code,
  setCode,
  setTaskId,
  setUpstreamLangs,
  onLoadTaskFromHelp,
  onError,
  taskId,
  itemId,
  itemVersions,
  // What `code` compiles to, as the editor already fetched it for the Data tab.
  compiledData,
}) => {
  const [data, setData] = useState({});
  const messageInputRef = useRef(null);
  const { user } = useGraffiticodeAuth();
  const { data: authToken } = useToken();
  const firebaseApp = useFirebaseApp();
  const [showUploadModal, setShowUploadModal] = useState(false);
  const [imageUploadProgress, setImageUploadProgress] = useState<number | null>(null);

  // Resizable panel state
  const isResizing = useRef(false);
  const containerRef = useRef(null);
  const [uploadNotification, setUploadNotification] = useState(null);
  const [maxHeaderHeight, setMaxHeaderHeight] = useState(null);  // Will be set to initial content height

  // Property editor state - will be populated from focus events
  const [contextProperties, setContextProperties] = useState({});
  const [focusedElement, setFocusedElement] = useState(null);
  const [languageSchema, setLanguageSchema] = useState(null);
  // Track initial property values to detect changes
  const [initialProperties, setInitialProperties] = useState({});
  const [schemaLoading, setSchemaLoading] = useState(false);
  // Track collapsed state for property groups - initialize as collapsed
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});
  // Track which groups have been manually toggled by the user
  const [manuallyToggledGroups, setManuallyToggledGroups] = useState<Set<string>>(new Set());
  // Track collapsed state for nested objects - initialize as expanded
  const [collapsedNestedObjects, setCollapsedNestedObjects] = useState<Record<string, boolean>>({});
  // Track which nested objects have been manually toggled by the user
  const [manuallyToggledNestedObjects, setManuallyToggledNestedObjects] = useState<Set<string>>(new Set());

  // Create a ref for the state to avoid circular dependencies
  const stateRef = useRef(null);
  // Create a ref to store setHeaderHeight function
  const setHeaderHeightRef = useRef(null);

  // Fetch language schema when language changes
  useEffect(() => {
    const fetchSchema = async () => {
      if (!language) {
        return;
      }

      setSchemaLoading(true);
      try {
        const langCode = language.startsWith('L') ? language : `L${language}`;
        const schemaText = await getLanguageAsset(langCode, "schema.json", authToken);
        const schema = JSON.parse(schemaText || "{}");
        setLanguageSchema(schema);
      } catch (error) {
        console.error(`HelpPanel: Failed to load schema for language ${language}:`, error);
        setLanguageSchema(null);
      } finally {
        setSchemaLoading(false);
      }
    };

    fetchSchema();
  }, [language, authToken]);

  // Function to get schema definition for a given context
  // Helper function to resolve JSON Schema $ref
  const resolveSchemaRef = useCallback((ref, schema) => {
    if (!ref || !schema) return null;

    // Remove the # prefix and split the path
    const path = ref.replace(/^#\//, '').split('/');

    // Navigate through the schema to find the referenced definition
    let current = schema;
    for (const segment of path) {
      current = current[segment];
      if (!current) return null;
    }
    return current;
  }, []);

  // Function to get schema definition for a given context
  const getSchemaForContext = useCallback((focusData) => {
    if (!languageSchema || !focusData) {
      return null;
    }

    const { type, subclass } = focusData;

    // Simple convention: Check definitions[type]
    const schema = languageSchema.definitions?.[type];

    if (schema) {
      // Resolve $ref if present
      let resolvedSchema = schema;
      if (schema.$ref) {
        resolvedSchema = resolveSchemaRef(schema.$ref, languageSchema);
      }

      // Filter properties based on subclass context
      if (subclass && resolvedSchema?.properties) {
        const filteredProperties = {};
        Object.entries(resolvedSchema.properties).forEach(([key, propSchema]: [string, any]) => {
          // Include property if no context field or if context includes subclass
          if (!propSchema.context || propSchema.context.includes(subclass)) {
            filteredProperties[key] = propSchema;
          }
        });

        return {
          ...resolvedSchema,
          properties: filteredProperties
        };
      }

      return resolvedSchema;
    }

    return null;
  }, [languageSchema, resolveSchemaRef]);

  // Function to process focus data and update properties
  const processFocusData = useCallback((focusData, preserveEdits = false, resetInitial = true) => {

    // Get schema for this context
    const contextSchema = getSchemaForContext(focusData);

    // If no schema is available, don't show any properties
    if (!contextSchema || !contextSchema.properties) {
      setContextProperties({});
      if (resetInitial) {
        setInitialProperties({});
      }
      return;
    }

    // Build properties based on schema and focus data
    let properties = {};

    if (contextSchema && contextSchema.properties) {
          // Use schema to define ALL properties for this context
          Object.entries(contextSchema.properties).forEach(([key, propSchema]) => {

            // Handle $ref if present
            let resolvedSchema: any = propSchema;
            if (propSchema && typeof propSchema === 'object' && '$ref' in propSchema) {
              const refResolved = resolveSchemaRef((propSchema as any).$ref, languageSchema);
              if (refResolved) {
                // Merge the resolved reference with the original schema to preserve metadata
                resolvedSchema = {
                  ...refResolved,
                  ...propSchema,
                  // Ensure properties from the resolved ref are used
                  properties: refResolved.properties || (propSchema as any).properties,
                  type: refResolved.type || (propSchema as any).type
                };
                // Remove the $ref from the merged result
                delete resolvedSchema.$ref;
              } else {
                resolvedSchema = propSchema;
              }
            }

            // Get value from focus data
            let value;
            if (focusData.type === 'column' && focusData.value && typeof focusData.value === 'object') {
              // Column values are nested under the column name (e.g., focusData.value.B.width)
              const columnData = focusData.value[focusData.name];
              if (columnData) {
                value = columnData[key];
              }
            } else {
              // For cells and other types, look for nested property values
              value = focusData.value?.[key];
            }

            // Handle oneOf for top-level properties (like width/height in size group)
            if (resolvedSchema.oneOf) {
              const selectedOption = resolvedSchema.oneOf.find(option => {
                if (value !== undefined) {
                  if (option.type === typeof value) return true;
                  if (option.type === 'number' && !isNaN(Number(value))) return true;
                  if (option.format === 'date' && !isNaN(Date.parse(value))) return true;
                }
                return false;
              }) || resolvedSchema.oneOf[0];

              // Merge the selected option with the parent schema, preserving metadata like group
              resolvedSchema = {
                ...resolvedSchema,
                ...selectedOption,
                // Preserve important parent properties
                group: resolvedSchema.group,
                description: resolvedSchema.description,
                title: resolvedSchema.title,
                label: resolvedSchema.label,
                context: resolvedSchema.context,
                readonly: resolvedSchema.readonly || resolvedSchema.readOnly,
                hidden: resolvedSchema.hidden,
                placeholder: resolvedSchema.placeholder
              };
            }

            // Check if this is a nested object with properties
            if (resolvedSchema.type === 'object' && resolvedSchema.properties) {

              // Initialize the value as an object if undefined
              if (value === undefined) {
                value = {};
                // Only initialize with schema defaults if explicitly provided
                Object.entries(resolvedSchema.properties).forEach(([nestedKey, nestedSchema]) => {
                  if ((nestedSchema as any).default !== undefined) {
                    value[nestedKey] = (nestedSchema as any).default;
                  }
                  // Don't initialize other values - leave them undefined/empty
                });
              }

              // Create nested properties structure
              properties[key] = {
                value,
                type: 'nested-object',
                label: resolvedSchema.title || resolvedSchema.label || key,  // Keep original case
                description: resolvedSchema.description,
                schema: resolvedSchema,
                properties: {},
                // Use the group from schema, or default to the property key if not specified
                group: resolvedSchema.group !== undefined ? resolvedSchema.group : key,
                hidden: resolvedSchema.hidden || false,
                readonly: resolvedSchema.readonly || resolvedSchema.readOnly || false,
                required: contextSchema.required?.includes(key) || false
              };

              // Process nested properties
              Object.entries(resolvedSchema.properties).forEach(([nestedKey, nestedSchema]) => {
                // Handle nested $ref
                let resolvedNestedSchema: any = nestedSchema;
                if (nestedSchema && typeof nestedSchema === 'object' && '$ref' in nestedSchema) {
                  const refResolved = resolveSchemaRef((nestedSchema as any).$ref, languageSchema);
                  if (refResolved) {
                    // Merge the resolved reference with the original schema to preserve metadata
                    resolvedNestedSchema = {
                      ...refResolved,
                      ...nestedSchema,
                      // Ensure properties from the resolved ref are used
                      properties: refResolved.properties || (nestedSchema as any).properties,
                      type: refResolved.type || (nestedSchema as any).type
                    };
                    // Remove the $ref from the merged result
                    delete resolvedNestedSchema.$ref;
                  } else {
                    resolvedNestedSchema = nestedSchema;
                  }
                }

                // Handle oneOf for nested properties (like expected in assess)
                if (resolvedNestedSchema.oneOf) {
                  const currentValue = value?.[nestedKey];
                  resolvedNestedSchema = resolvedNestedSchema.oneOf.find(option => {
                    if (currentValue !== undefined) {
                      if (option.type === typeof currentValue) return true;
                      if (option.type === 'number' && !isNaN(Number(currentValue))) return true;
                      if (option.format === 'date' && !isNaN(Date.parse(currentValue))) return true;
                    }
                    return false;
                  }) || resolvedNestedSchema.oneOf[0];
                }

                properties[key].properties[nestedKey] = {
                  value: value?.[nestedKey] ?? resolvedNestedSchema.default ?? '',
                  type: resolvedNestedSchema.type || 'string',
                  format: resolvedNestedSchema.format,
                  label: resolvedNestedSchema.title || nestedKey,  // Keep original case
                  description: resolvedNestedSchema.description,
                  enum: resolvedNestedSchema.enum,
                  min: resolvedNestedSchema.minimum,
                  max: resolvedNestedSchema.maximum,
                  required: resolvedSchema.required?.includes(nestedKey) || false,
                  readonly: resolvedNestedSchema.readOnly || false,
                  placeholder: resolvedNestedSchema.placeholder
                };
              });
            } else {
              // Non-nested property - handle as before
              if (value === undefined) {
                value = resolvedSchema.default ?? '';
              }

              properties[key] = {
                value,
                type: resolvedSchema.type || 'string',
                label: resolvedSchema.title || resolvedSchema.label || key,  // Keep original case
                description: resolvedSchema.description,
                enum: resolvedSchema.enum,
                min: resolvedSchema.minimum,
                max: resolvedSchema.maximum,
                required: contextSchema.required?.includes(key) || false,
                readonly: resolvedSchema.readOnly || resolvedSchema.readonly || false,
                hidden: resolvedSchema.hidden || false,
                placeholder: resolvedSchema.placeholder,
                pattern: resolvedSchema.pattern,
                group: resolvedSchema.group !== undefined ? resolvedSchema.group : ''
              };
            }
          });

          // Don't add additional properties that aren't in the schema
          // Only show properties defined in schema.json
        } else {
          // No schema available - don't show any properties
          // This should not happen as we check for schema at the beginning
          properties = {};
        }

    setContextProperties(properties);
    // Store the initial values for comparison only when requested
    if (resetInitial) {
      setInitialProperties(JSON.parse(JSON.stringify(properties)));
    }
  }, [getSchemaForContext, languageSchema, resolveSchemaRef]);

  // Track the last processed focus element to avoid unnecessary reprocessing
  const lastProcessedElementRef = useRef(null);

  // Re-process focus data when schema loads or focused element actually changes
  useEffect(() => {
    if (focusedElement && languageSchema && !schemaLoading) {
      // Only process if the focused element has actually changed
      const elementKey = `${focusedElement.type}-${focusedElement.name}`;
      if (lastProcessedElementRef.current !== elementKey) {
        // Reset initial properties when focusing a different element
        processFocusData(focusedElement, false, true);
        lastProcessedElementRef.current = elementKey;
      }
    }
  }, [languageSchema, schemaLoading, focusedElement, processFocusData]);

  // Track the previous focused element type to detect type changes
  const prevFocusedTypeRef = useRef(null);
  const prevTaskIdRef = useRef(taskId);

  // Clear manual toggles when element type changes or new task is loaded
  useEffect(() => {
    // Check if task changed
    if (prevTaskIdRef.current !== taskId) {
      setManuallyToggledGroups(new Set());
      // Reset initial properties when a new task is loaded
      // This ensures we start fresh with the new task's values
      setInitialProperties({});
      prevTaskIdRef.current = taskId;
      prevFocusedTypeRef.current = null; // Reset type tracking on new task
      return;
    }

    // Check if element type changed (e.g., cell to column)
    if (focusedElement && prevFocusedTypeRef.current && focusedElement.type !== prevFocusedTypeRef.current) {
      setManuallyToggledGroups(new Set());
    }

    if (focusedElement) {
      prevFocusedTypeRef.current = focusedElement.type;
    }
  }, [focusedElement, taskId]);

  // Auto-expand groups that have properties with values when context changes
  useEffect(() => {
    if (Object.keys(contextProperties).length === 0) return;

    // Build groups to check which ones have values
    const groupsWithValues = new Set<string>();
    // Track nested objects and whether they have values
    const nestedObjectsWithValues = new Set<string>();

    Object.entries(contextProperties).forEach(([key, prop]: [string, any]) => {
      if (!prop.hidden) {
        const group = prop.group === "" || prop.group === undefined || prop.group === 'default' ? 'no-group' : prop.group;

        // Check if property has a meaningful value or should be shown
        let hasValue = false;
        if (prop.type === 'nested-object') {
          // Check if any nested property has a value
          hasValue = Object.values(prop.properties || {}).some((nestedProp: any) => {
            return nestedProp.value !== undefined &&
                   nestedProp.value !== '' &&
                   nestedProp.value !== null &&
                   nestedProp.value !== false &&
                   nestedProp.value !== 0;
          });
          // Track whether this nested object has values
          if (hasValue) {
            nestedObjectsWithValues.add(key);
          }
        } else {
          // Check if regular property has a value
          // For strings, only consider non-empty values as "having value" for auto-expand
          hasValue = prop.value !== undefined &&
                     prop.value !== '' &&
                     prop.value !== null &&
                     prop.value !== false &&
                     (prop.type !== 'number' || prop.value !== 0);
        }

        if (hasValue) {
          groupsWithValues.add(group);
        }
      }
    });

    // Update collapsed state to expand groups with values
    setCollapsedGroups(prev => {
      const newState = { ...prev };

      // Expand groups that have values (unless manually toggled)
      groupsWithValues.forEach(group => {
        if (group !== 'no-group' && !manuallyToggledGroups.has(group)) { // no-group is always expanded
          newState[group] = false; // false means expanded
        }
      });

      // Collapse groups without values (unless manually toggled)
      const allGroups = new Set<string>();
      Object.entries(contextProperties).forEach(([key, prop]: [string, any]) => {
        if (!prop.hidden) {
          const group = prop.group === "" || prop.group === undefined || prop.group === 'default' ? 'no-group' : prop.group;
          allGroups.add(group);
        }
      });

      allGroups.forEach(group => {
        if (!groupsWithValues.has(group) && group !== 'no-group' && !manuallyToggledGroups.has(group)) {
          newState[group] = true; // true means collapsed
        }
      });

      return newState;
    });

    // Update collapsed state for nested objects
    setCollapsedNestedObjects(prev => {
      const newState = { ...prev };

      // Go through all nested object properties
      Object.entries(contextProperties).forEach(([key, prop]: [string, any]) => {
        if (prop.type === 'nested-object' && !manuallyToggledNestedObjects.has(key)) {
          // If it has values, expand it (false = expanded)
          // If it doesn't have values, collapse it (true = collapsed)
          newState[key] = !nestedObjectsWithValues.has(key);
        }
      });

      return newState;
    });
  }, [contextProperties, manuallyToggledGroups, manuallyToggledNestedObjects]);

  // Listen for focus events from FormIFrame
  useEffect(() => {
    const handleFormFocus = (event) => {
      if (event.detail) {
        const focusData = event.detail.focus;
        const isTaskChange = event.detail.isTaskChange;

        // Handle null focus
        if (!focusData) {
          // If this is a task change, clear all focus-related state
          if (isTaskChange) {
            setFocusedElement(null);
            setContextProperties({});
            setInitialProperties({});
            lastProcessedElementRef.current = null;
            // Reset the properties panel height
            if (setHeaderHeightRef.current) {
              setHeaderHeightRef.current(null);
            }
          }
          // Otherwise keep properties intact for when Enter is pressed
          return;
        }

        // Check if this is a different element
        const elementKey = `${focusData.type}-${focusData.name}`;
        const isDifferentElement = lastProcessedElementRef.current !== elementKey;

        // Update the focused element
        setFocusedElement(focusData);

        // Process immediately if schema is loaded, otherwise it will be processed when schema loads
        if (languageSchema && !schemaLoading) {
          if (isDifferentElement) {
            // New element focused - clear old state and load new element's properties
            // This resets everything for the new element
            processFocusData(focusData, false, true);
            lastProcessedElementRef.current = elementKey;
          } else {
            // Same element re-focused - update current values but keep initial values
            // This preserves the ability to detect changes
            processFocusData(focusData, false, false);
          }
        }
      }
    };

    // Listen for custom focus events
    window.addEventListener('formIFrameFocus', handleFormFocus);

    // Request focus when component mounts (e.g., when returning to Make tab)
    // Send a message to request the current focus state
    const requestFocusEvent = new CustomEvent('requestFormFocus');
    setTimeout(() => {
      window.dispatchEvent(requestFocusEvent);
    }, 100);

    return () => {
      window.removeEventListener('formIFrameFocus', handleFormFocus);
    };
  }, [languageSchema, schemaLoading, processFocusData, lastProcessedElementRef]);

  // Function to get the current text from the editor
  const getCurrentEditorText = () => {
    const editorElement = document.querySelector("[contenteditable=true]") as HTMLElement;
    if (editorElement) {
      // Check if this is a ProseMirror editor
      if (editorElement.classList.contains('ProseMirror')) {
        // For ProseMirror, we need to handle line breaks properly
        // Get all the text nodes and preserve structure
        const lines: string[] = [];
        const blocks = editorElement.querySelectorAll('p, div, pre');

        if (blocks.length > 0) {
          blocks.forEach((block, index) => {
            const text = (block as HTMLElement).innerText || block.textContent || '';
            lines.push(text);
          });
          return lines.join('\n').trim();
        } else {
          // Fallback for inline text
          return editorElement.innerText || '';
        }
      } else {
        // For regular contenteditable elements
        // innerText preserves line breaks, textContent does not
        const content = editorElement.innerText || '';
        return content.trim();
      }
    }
    return '';
  };

  // Function to clear the text editor
  const clearTextEditor = () => {
    const editorElement = document.querySelector("[contenteditable=true]") as HTMLElement;
    if (editorElement) {
      editorElement.focus();
      document.execCommand('selectAll', false, null);
      document.execCommand('delete', false, null);
    }
  };

  // Function to combine text input and property changes and send them
  const sendCombinedMessage = useCallback((textContent: string = '') => {
    // Get the handleSendMessage from the state data
    const stateData = stateRef.current?.data;
    if (!stateData?.handleSendMessage || stateData?.isLoading) return;

    // Get text content if not provided
    const messageText = textContent || getCurrentEditorText();

    // Check if there's an active input element and capture its current value
    let activeInputKey: string | null = null;
    let activeInputValue: any = null;
    const activeElement = document.activeElement as HTMLInputElement;

    if (activeElement && (activeElement.tagName === 'INPUT' || activeElement.tagName === 'SELECT' || activeElement.tagName === 'TEXTAREA')) {
      // Get the property key from the data attribute
      const propertyKey = activeElement.getAttribute('data-property-key');
      if (propertyKey) {
        activeInputKey = propertyKey;
        // Get the current value based on input type
        if (activeElement.type === 'checkbox') {
          activeInputValue = activeElement.checked;
        } else if (activeElement.type === 'number') {
          activeInputValue = parseFloat(activeElement.value) || 0;
        } else {
          activeInputValue = activeElement.value;
        }
      }
    }

    // Check for property changes
    const changedValues: Record<string, any> = {};

    // Only detect changes if initialProperties has been set (not empty)
    // If initialProperties is empty, it means we haven't established a baseline yet
    const hasInitialBaseline = Object.keys(initialProperties).length > 0;

    Object.entries(contextProperties).forEach(([key, prop]: [string, any]) => {
      // Use the active input's current value if this is the active property
      const currentValue = (key === activeInputKey && activeInputValue !== null) ? activeInputValue : prop.value;
      const initialProp = initialProperties[key];

      // Compare current value with initial value (treating undefined as no value)
      const initialValue = initialProp?.value;

      // Only consider it changed if we have an initial baseline to compare against
      const hasChanged = hasInitialBaseline && JSON.stringify(currentValue) !== JSON.stringify(initialValue);

      if (hasChanged) {
        // For nested objects, only include changed children
        if (prop.type === 'nested-object' && typeof prop.value === 'object') {
          const changedNested: any = {};
          const initialNested = initialProp?.value || {};

          Object.entries(prop.value).forEach(([nestedKey, nestedValue]) => {
            // Only include if this nested property has changed
            if (JSON.stringify(nestedValue) !== JSON.stringify(initialNested[nestedKey])) {
              // Include the value even if it's empty (user cleared it)
              changedNested[nestedKey] = nestedValue;
            }
          });

          // Only add the nested object if it has changed properties
          if (Object.keys(changedNested).length > 0) {
            changedValues[key] = changedNested;
          }
        } else {
          // Include the value even if it's empty (user cleared it)
          // Empty string means the user wants to clear the property
          changedValues[key] = currentValue;
        }
      }
    });

    // Build the combined message
    let fullMessage = '';

    // Add text message if present
    if (messageText) {
      fullMessage = messageText;
    }

    // Add property changes if present
    if (Object.keys(changedValues).length > 0) {
      const contextType = focusedElement?.type || 'context';
      const contextName = focusedElement?.name || '';

      if (fullMessage) {
        fullMessage += '\n\n';
      }

      // Build context-aware message
      if (contextType && contextName) {
        fullMessage += `Update the code for ${contextType} ${contextName} using these property values`;
      } else if (contextType) {
        fullMessage += `Update the code for ${contextType} using these property values`;
      } else {
        fullMessage += `Update the code using these property values`;
      }
      // Use more compact JSON formatting (2-space indent instead of 4)
      const jsonString = Object.keys(changedValues).length === 1 &&
            JSON.stringify(changedValues) ||
            JSON.stringify(changedValues, null, 2);
      fullMessage += `:\n\`\`\`json\n${jsonString}\n\`\`\`\nNote: Only the properties shown above have changed and need to be updated.`;

      // Check if any property has an empty string value
      const hasEmptyStringValue = Object.values(changedValues).some(value =>
        value === '' ||
        (typeof value === 'object' && value !== null && Object.values(value).some(v => v === ''))
      );

      if (hasEmptyStringValue) {
        fullMessage += ' Empty strings ("") mean the property should be cleared/removed.';
      }
    }

    // Only send if we have something to send
    if (fullMessage) {
      stateData.handleSendMessage(fullMessage);
      // Clear the text editor after sending
      clearTextEditor();
      // After sending, update initial properties to the current values
      setInitialProperties(JSON.parse(JSON.stringify(contextProperties)));
    }
  }, [focusedElement, contextProperties, initialProperties]);

  // Integration with TextEditor component - will be properly initialized after ChatBot setup
  const [state] = useState(createState({}, (data, { type, args }) => {
    switch (type) {
      case "update":
        // Handle message sending with both text and property changes
        if (args.content && data.handleSendMessage && !data.isLoading) {
          // Send combined message with text from editor and property changes
          data.sendCombinedMessage(args.content);
        }
        return {
          ...data,
          ...args,
        };
      case "csv-upload":
        // For CSV uploads, we don't want to trigger handleSendMessage
        // We just want to update the editor content
        return {
          ...data,
          content: args.content,
        };
      case "config":
        // For configuring the state with handlers
        return {
          ...data,
          ...args
        };
      default:
        console.error(false, `Unimplemented action type: ${type}`);
        return data;
    }
  }));

  // Handle image file drop - upload to Firebase Storage and add to assets
  const handleImageDrop = useCallback(async (file: File) => {
    const error = validateImageFile(file);
    if (error) {
      setUploadNotification({ type: 'error', message: error, fileName: file.name });
      setTimeout(() => setUploadNotification(null), 3000);
      return;
    }
    if (!user?.uid) {
      setUploadNotification({ type: 'error', message: 'Sign in to upload images', fileName: file.name });
      setTimeout(() => setUploadNotification(null), 3000);
      return;
    }

    setImageUploadProgress(0);
    try {
      const storage = getStorage(firebaseApp);
      // Fetch existing images for dedup
      const archivedNames = authToken ? await fetchArchivedImages(authToken) : [];
      const existingImages = await listUserImages(storage, user.uid, { archivedNames });
      let archivedImages: ImageInfo[] = [];
      if (authToken && archivedNames.length > 0) {
        const allImages = await listUserImages(storage, user.uid, { includeArchived: true, archivedNames });
        archivedImages = allImages.filter(img => img.archived);
      }

      const result = await uploadImageDeduped(storage, user.uid, file, existingImages, (percent) => {
        setImageUploadProgress(percent);
      }, { token: authToken, archivedImages });
      setImageUploadProgress(null);

      // Signal ImageGallery to reload
      window.dispatchEvent(new Event('gc:assets-reload'));

      // Insert image URL into the text editor
      const editorElement = document.querySelector("[contenteditable=true]") as HTMLElement;
      if (editorElement) {
        editorElement.focus();
        const sel = window.getSelection();
        sel?.selectAllChildren(editorElement);
        sel?.collapseToEnd();
        const existing = editorElement.innerText?.trim();
        if (existing) {
          document.execCommand('insertText', false, '\n' + result.downloadURL);
        } else {
          document.execCommand('insertText', false, result.downloadURL);
        }
      }

      const fileName = file.name;
      if (result.skipped) {
        setUploadNotification({ type: 'success', message: `Image "${fileName}" already exists`, fileName });
      } else {
        setUploadNotification({ type: 'success', message: `Image "${fileName}" uploaded`, fileName });
      }
      setTimeout(() => setUploadNotification(null), 3000);
    } catch (err: any) {
      setImageUploadProgress(null);
      setUploadNotification({
        type: 'error',
        message: `Upload failed: ${err.message || 'unknown error'}`,
        fileName: file.name,
      });
      setTimeout(() => setUploadNotification(null), 3000);
    }
  }, [firebaseApp, user, authToken]);

  // Insert text content into the editor
  const insertTextIntoEditor = useCallback((content: string) => {
    let updateSuccess = false;
    try {
      const editorElement: HTMLElement =
        document.querySelector("[contenteditable=true]") ||
        document.querySelector(".ProseMirror") ||
        document.querySelector("[role='textbox']");
      if (editorElement) {
        editorElement.focus();
        try {
          document.execCommand('selectAll', false, null);
          document.execCommand('delete', false, null);
          document.execCommand('insertText', false, content);
          updateSuccess = true;
        } catch {
          try {
            editorElement.innerHTML = '';
            editorElement.innerHTML = content.replace(/\n/g, '<br>');
            updateSuccess = true;
          } catch {}
        }
      }
    } catch {}

    if (!updateSuccess && state && typeof state.apply === 'function') {
      try {
        state.apply({ type: 'csv-upload', args: { content } });
        updateSuccess = true;
      } catch {}
    }
    return updateSuccess;
  }, [state]);

  // Handle file drop functionality for the entire panel
  const onDrop = useCallback((acceptedFiles) => {
    if (acceptedFiles.length === 0) return;

    const imageFiles = acceptedFiles.filter(f => f.type.startsWith('image/'));
    const textFiles = acceptedFiles.filter(f => !f.type.startsWith('image/'));

    // Upload all images in parallel
    imageFiles.forEach(file => handleImageDrop(file));

    // Concatenate and load text files into editor
    if (textFiles.length > 0) {
      const readPromises = textFiles.map(file =>
        new Promise<{ name: string; content: string }>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = (e) => resolve({ name: file.name, content: e.target.result as string });
          reader.onerror = () => reject(new Error(`Error reading ${file.name}`));
          reader.readAsText(file);
        })
      );

      Promise.all(readPromises).then(results => {
        setTimeout(() => {
          const combined = results.map(r => r.content).join('\n\n');
          const names = results.map(r => r.name).join(', ');
          const success = insertTextIntoEditor(combined);
          setShowUploadModal(false);

          if (success) {
            setUploadNotification({
              type: 'success',
              message: results.length === 1
                ? `File "${names}" loaded into editor`
                : `${results.length} files loaded into editor`,
              fileName: names,
            });
          } else {
            navigator.clipboard.writeText(combined)
              .then(() => {
                setUploadNotification({
                  type: 'warning',
                  message: 'File content copied to clipboard. Press Ctrl+V or Cmd+V to paste.',
                  fileName: names,
                });
              })
              .catch(() => {
                setUploadNotification({
                  type: 'error',
                  message: 'Could not process files',
                  fileName: names,
                });
              });
          }
          setTimeout(() => setUploadNotification(null), 3000);
        }, 100);
      }).catch((error) => {
        console.error("Error reading files:", error);
        setUploadNotification({ type: 'error', message: 'Error reading files', fileName: '' });
        setShowUploadModal(false);
        setTimeout(() => setUploadNotification(null), 3000);
      });
    }
  }, [handleImageDrop, insertTextIntoEditor]);

  // ChatBot integration
  const { handleSendMessage, cancelGeneration, isLoading } = ChatBot({
    onSendMessage: (userMessage, botResponse) => {
      // When we receive a message from the chatbot
      handleMessage(userMessage, botResponse);
    },
    user,
    language,
    chatHistory: help, // Pass the current help array as chat history
    currentSrc: code, // Pass the current source from the code panel
    // ...and what that source compiles to. A dialect can keep values outside the
    // program — L0182 names a survey whose ideas the compiler fetches — and then
    // an edit acting on them ("answer it") cannot be served from the source.
    currentData: compiledData,
    itemId,
  });

  // Setup dropzone for the entire panel
  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: {
      'image/png': ['.png'],
      'image/jpeg': ['.jpg', '.jpeg'],
      'image/gif': ['.gif'],
      'image/webp': ['.webp'],
      'text/*': ['.txt', '.csv', '.json', '.xml', '.md', '.log', '.conf', '.cfg', '.ini', '.yaml', '.yml', '.toml', '.gc'],
      'application/json': ['.json'],
      'application/xml': ['.xml'],
      'application/x-yaml': ['.yaml', '.yml'],
      'application/toml': ['.toml'],
      'text/plain': ['.txt', '.text', '.log', '.gc'],
      'text/csv': ['.csv'],
      'text/markdown': ['.md', '.markdown'],
      'text/x-python': ['.py'],
      'text/x-java': ['.java'],
      'text/javascript': ['.js', '.mjs', '.jsx'],
      'text/typescript': ['.ts', '.tsx'],
      'text/x-c': ['.c', '.h'],
      'text/x-c++': ['.cpp', '.cc', '.cxx', '.hpp', '.hxx'],
      'text/x-ruby': ['.rb'],
      'text/x-go': ['.go'],
      'text/x-rust': ['.rs'],
      'text/html': ['.html', '.htm'],
      'text/css': ['.css', '.scss', '.sass'],
      'application/x-sh': ['.sh', '.bash'],
      'text/x-sql': ['.sql']
    },
    noClick: true, // Don't open file dialog on click, only accept drops
    noKeyboard: true // Disable keyboard interaction
  });

  // Handle sending a new message
  const handleMessage = useCallback(async (userMessage, botResponse = null) => {
    // If there's no bot response yet, this is the initial message from the user
    if (!botResponse) {
      // Check if the message contains code blocks
      const containsCodeBlock = userMessage.includes("```");
      // Skip CSV processing for messages with code blocks as they should be preserved as-is
      let processedUserMessage;
      if (containsCodeBlock) {
        processedUserMessage = userMessage;
      } else {
        // Process message to handle mixed content and format tables
        processedUserMessage = processMixedContent(userMessage);
      }

      // Add user message to the chat in chronological order (at the end)
      setHelp(prev => [
        ...prev,
        {
          user: processedUserMessage,
          help: getHelp(processedUserMessage),
          type: 'user',
          timestamp: new Date().toISOString()
        }
      ]);

      return;
    }

    // If we have a bot response but need to skip adding user message (to avoid duplication)
    const skipUserMessage = botResponse.skipUserMessage;

    // If the bot response is code, automatically update the code panel
    // Skip if text is null/empty (e.g., compile error) to keep current code
    if (botResponse?.type === 'code' && botResponse.text && typeof setCode === 'function') {
      setCode(botResponse.text);
    }

    // Propagate errors to parent (gallery alert)
    if (botResponse?.type === 'error' && botResponse.text) {
      onError?.(botResponse.text);
    }

    // The bot response carries a chained taskId when the planner composed
    // multiple languages. Surface it (and the upstream langs) to gallery so
    // the form preview compiles the chain and the saved item retains the
    // composition.
    if (botResponse?.type === 'code' && botResponse.taskId && typeof setTaskId === 'function') {
      setTaskId(botResponse.taskId);
    }
    if (botResponse?.type === 'code' && Array.isArray(botResponse.upstreamLangs) && typeof setUpstreamLangs === 'function') {
      setUpstreamLangs(botResponse.upstreamLangs);
    }

    // If the bot response includes a taskId or timestamp, update the last user message
    if (botResponse?.taskId || botResponse?.timestamp) {
      setHelp(prev => {
        const newHelp = [...prev];
        // Find the last user message and update it
        for (let i = newHelp.length - 1; i >= 0; i--) {
          if (newHelp[i].type === 'user') {
            if (botResponse.taskId) {
              newHelp[i].taskId = botResponse.taskId;
            }
            // Only set timestamp if the user message doesn't already have one
            // (changing timestamp changes the React key, causing image flash)
            if (botResponse.timestamp && !newHelp[i].timestamp) {
              newHelp[i].timestamp = botResponse.timestamp;
            }
            break;
          }
        }
        return newHelp;
      });
    }
  }, [setCode, setTaskId, setUpstreamLangs, onError]);

  // State for the input field
  const [messageText, setMessageText] = useState('');

  // CsvDropzone component moved to separate file

  // Handle CSV file upload (legacy method for direct input handling)
  const handleCsvUpload = (event) => {
    if (!event.target.files || event.target.files.length === 0) {
      return;
    }

    try {
      const file = event.target.files[0];
      // Read the file contents
      const reader = new FileReader();
      reader.onload = (e) => {
        const fileContent = e.target.result as string;
        let updateSuccess = false;
        // Try direct DOM manipulation first - most reliable method
        try {
          const editorElement: HTMLElement = document.querySelector("[contenteditable=true]");
          if (editorElement) {
            // Focus and clear the editor
            editorElement.focus();
            document.execCommand('selectAll', false, null);
            document.execCommand('delete', false, null);
            // Insert the content
            document.execCommand('insertText', false, fileContent);
            updateSuccess = true;
          }
        } catch (err) {
          console.error("DOM manipulation failed:", err);
        }
        // Try state update as a fallback
        if (!updateSuccess && state && typeof state.apply === 'function') {
          try {
            state.apply({
              type: 'csv-upload',
              args: {
                content: fileContent
              }
            });
            updateSuccess = true;
          } catch (err) {
            console.error("State update failed:", err);
          }
        }
        // Show appropriate notification
        if (updateSuccess) {
          setUploadNotification({
            type: 'success',
            message: `File "${file.name}" loaded into editor`,
            fileName: file.name
          });
        } else {
          // Last resort: copy to clipboard
          navigator.clipboard.writeText(fileContent)
            .then(() => {
              setUploadNotification({
                type: 'warning',
                message: `File content copied to clipboard. Press Ctrl+V or Cmd+V to paste.`,
                fileName: file.name
              });
            })
            .catch(() => {
              setUploadNotification({
                type: 'error',
                message: `Could not process file`,
                fileName: file.name
              });
            });
        }
        // Clear notification after 3 seconds
        setTimeout(() => {
          setUploadNotification(null);
        }, 3000);
        // Clear the file input
        event.target.value = null;
      };
      reader.onerror = () => {
        console.error("Error reading file");
        // Show error notification
        setUploadNotification({
          type: 'error',
          message: 'Error reading file',
          fileName: file.name
        });
        // Clear notification after 3 seconds
        setTimeout(() => {
          setUploadNotification(null);
        }, 3000);
        // Clear the file input
        event.target.value = null;
      };
      // Read the file as text
      reader.readAsText(file);
    } catch (error) {
      console.error("Error handling CSV upload:", error);
      // Show error notification
      setUploadNotification({
        type: 'error',
        message: 'Error uploading file',
        fileName: event.target.files?.[0]?.name || 'Unknown file'
      });
      // Clear notification after 3 seconds
      setTimeout(() => {
        setUploadNotification(null);
      }, 3000);
    }
  };

  // Re-create ChatBot when help (chat history) changes
  // This ensures that new messages are included in the context
  useEffect(() => {
  }, [help]);

  // Update state handler after ChatBot is initialized
  useEffect(() => {
    if (handleSendMessage && state) {
      stateRef.current = state;
      // Now we can update the state to properly handle messages
      state.apply({
        type: 'config',
        args: {
          handleSendMessage,
          sendCombinedMessage,
          isLoading
        }
      });
    }
  }, [handleSendMessage, sendCombinedMessage, isLoading, state]);

  // Resize handlers
  const handleMouseDown = useCallback((e) => {
    e.preventDefault();
    isResizing.current = true;
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
  }, []);

  const handleMouseMove = useCallback((e) => {
    if (!isResizing.current || !containerRef.current) return;

    const containerRect = containerRef.current.getBoundingClientRect();
    const newHeight = e.clientY - containerRect.top;

    // Set min and max heights
    const minHeight = 80;  // Allow smaller header
    const maxHeight = maxHeaderHeight || window.innerHeight * 0.8; // Use dynamic max or 80% of window

    const clampedHeight = Math.min(Math.max(newHeight, minHeight), maxHeight);
    // Use the ref to call setHeaderHeight
    if (setHeaderHeightRef.current) {
      setHeaderHeightRef.current(clampedHeight);
      // Mark as manual resize - this will be preserved until content from form changes
      isManualResizeRef.current = true;
    }
  }, [maxHeaderHeight]);

  const handleMouseUp = useCallback(() => {
    if (isResizing.current) {
      isResizing.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    }
  }, []);

  // Add global mouse event listeners for resize
  useEffect(() => {
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [handleMouseMove, handleMouseUp]);

  // Function to handle deleting a message
  const handleDeleteMessagePair = (index) => {
    // Check if this is a pending message
    const isPendingMessage = isLoading &&
                            help[index].type === 'user' &&
                            (index === help.length - 1 || help[index + 1]?.type !== 'bot');

    // If this is a pending message, cancel code generation first
    if (isPendingMessage) {
      cancelGeneration();

      // Clear the timer if it's running
      if (processingTimeRef.current) {
        clearInterval(processingTimeRef.current);
        processingTimeRef.current = null;
      }
    }

    // Update help array to remove the message(s)
    setHelp(prev => {
      const newHelp = [...prev];
      // If it's a user message and has a bot response after it, delete both
      if (newHelp[index].type === 'user' && index + 1 < newHelp.length && newHelp[index + 1].type === 'bot') {
        newHelp.splice(index, 2);
      } else {
        // Otherwise just delete the message
        newHelp.splice(index, 1);
      }
      return newHelp;
    });
  };


  // Parse help if it's a string
  if (typeof help === "string" && help.trim() !== "") {
    try {
      help = JSON.parse(help);
      if (typeof help === "string" && help.trim() !== "") {
        help = JSON.parse(help);
      }
    } catch (e) {
      console.error("Error parsing help string:", e);
      help = [];
    }
  }

  // Ensure help is always an array
  if (!Array.isArray(help)) {
    help = [];
  }

  // Create refs and state for UI elements
  const headerRef = useRef(null);
  const [headerHeight, setHeaderHeight] = useState(null);  // Start with auto-fit
  const [processingTime, setProcessingTime] = useState(0);
  const processingTimeRef = useRef(null);
  const lastContentHeightRef = useRef(null);  // Track last content height to detect changes
  const isManualResizeRef = useRef(false);  // Track if user manually resized (or task loaded)
  const justLoadedTaskRef = useRef(false);  // Track if we just loaded a task (cleared on first focus)
  const lastTaskIdRef = useRef(taskId);  // Track the last taskId to detect changes

  // Update the ref when setHeaderHeight is available
  useEffect(() => {
    setHeaderHeightRef.current = setHeaderHeight;
  }, [setHeaderHeight]);

  // Track when taskId changes (task is being loaded)
  useEffect(() => {
    if (taskId && taskId !== lastTaskIdRef.current) {

      // When taskId changes, ALWAYS treat it as if the height was manually set
      // Never change the height, just like we do for manual resizes
      isManualResizeRef.current = true;
      justLoadedTaskRef.current = true;  // Set flag - will be cleared on first context change
      lastTaskIdRef.current = taskId;
    }
  }, [taskId]);

  // Adjust height and max height when content changes
  useEffect(() => {
    const adjustHeight = () => {
      if (headerRef.current) {
        // Temporarily set height to auto to get true content height
        const originalHeight = headerRef.current.style.height;
        headerRef.current.style.height = 'auto';

        // Force a reflow to get accurate measurement
        headerRef.current.offsetHeight;

        // Measure the natural height of the content including padding
        const computedStyle = window.getComputedStyle(headerRef.current);
        const paddingTop = parseFloat(computedStyle.paddingTop);
        const paddingBottom = parseFloat(computedStyle.paddingBottom);
        const contentHeight = headerRef.current.scrollHeight;

        // Restore the original height
        headerRef.current.style.height = originalHeight;

        // Get available window height (leave some space for the message area)
        const windowHeight = window.innerHeight;
        const availableHeight = Math.max(windowHeight * 0.8, 200); // Use 80% of window or min 200px

        // Update max height to exact content height
        const exactHeight = contentHeight;
        const newMaxHeight = Math.min(exactHeight, availableHeight);
        setMaxHeaderHeight(newMaxHeight);

        // Check if this is first measurement
        if (lastContentHeightRef.current === null) {
          // First measurement - set exact height
          setHeaderHeight(newMaxHeight);
          lastContentHeightRef.current = contentHeight;
          return;
        }

        // Check if content height has actually changed significantly
        // Use a larger threshold to avoid resetting on minor changes
        if (Math.abs(lastContentHeightRef.current - contentHeight) < 10) {
          // Content hasn't changed meaningfully, keep current height (could be manual)
          return;
        }

        // Content has changed significantly, update to fit
        lastContentHeightRef.current = contentHeight;

        // Only resize if not manually resized (help content changes)
        // Manual resize is always respected
        if (!isManualResizeRef.current) {
          setHeaderHeight(newMaxHeight);
        }
      }
    };

    // Delay initial measurement slightly to ensure content is rendered
    const timeoutId = setTimeout(() => {
      requestAnimationFrame(() => adjustHeight());
    }, 10);

    // Set up MutationObserver to watch for content changes
    let observer;
    if (headerRef.current) {
      observer = new MutationObserver(() => {
        // Debounce the height adjustment
        requestAnimationFrame(() => adjustHeight());
      });

      observer.observe(headerRef.current, {
        childList: true,
        subtree: true,
        attributes: true,
        characterData: true
      });
    }

    return () => {
      clearTimeout(timeoutId);
      if (observer) {
        observer.disconnect();
      }
    };
  }, [help.length]); // Re-measure when help messages change

  // Track the previous properties count to detect when going from empty to populated
  const previousPropertiesCountRef = useRef(0);

  // Function to adjust property editor height
  const adjustPropertyEditorHeight = useCallback(() => {
    if (!headerRef.current) return;

    // Clear the manual resize flag since this is user interaction in the form
    isManualResizeRef.current = false;

    // Temporarily set height to auto to get true content height
    const originalHeight = headerRef.current.style.height;
    headerRef.current.style.height = 'auto';

    // Measure the natural height of the content
    const contentHeight = headerRef.current.scrollHeight;

    // Restore the original height
    headerRef.current.style.height = originalHeight;

    // Get available window height
    const windowHeight = window.innerHeight;
    const availableHeight = Math.max(windowHeight * 0.8, 200);

    // Update to exact content height
    const newMaxHeight = Math.min(contentHeight, availableHeight);
    setMaxHeaderHeight(newMaxHeight);
    setHeaderHeight(newMaxHeight);
    lastContentHeightRef.current = contentHeight;

    // Reset manual resize flag when we auto-resize from form focus
    isManualResizeRef.current = false;
  }, []);

  // Separate effect for contextProperties changes - skip resize if just loaded task
  useEffect(() => {
    const currentPropertiesCount = Object.keys(contextProperties).length;

    if (headerRef.current && currentPropertiesCount > 0) {
      // Check if this is the first time showing properties (going from 0 to > 0)
      const isInitialPropertyLoad = previousPropertiesCountRef.current === 0 && currentPropertiesCount > 0;

      // Check if this is the first context change after loading a task
      if (justLoadedTaskRef.current) {
        justLoadedTaskRef.current = false;  // Clear the flag - next focus will trigger resize

        // Even when loading a task, we should resize if this is the first property display
        // Only skip if we're updating properties that were already visible
        if (!isInitialPropertyLoad) {
          // Don't resize - the height is locked because we're treating taskId changes
          // the same as manual resizes (isManualResizeRef is true)
          previousPropertiesCountRef.current = currentPropertiesCount;
          return;
        }
        // If it's initial property load, fall through to resize logic
      }

      // Proceed with resize logic (both for normal focus and initial load after task)
      if (isInitialPropertyLoad) {
        // For initial property load, use a MutationObserver to detect when the property editor is actually rendered
        const observer = new MutationObserver((mutations) => {
          // Check if the property editor div was added
          const propertyEditorExists = headerRef.current?.querySelector('.bg-gray-50.rounded-none.border-gray-200');
          if (propertyEditorExists) {
            // Property editor is now in the DOM, measure it
            requestAnimationFrame(() => {
              adjustPropertyEditorHeight();
            });
            observer.disconnect();
          }
        });

        // Start observing for DOM changes
        observer.observe(headerRef.current, {
          childList: true,
          subtree: true
        });

        // Also schedule fallback resize attempts
        const timeoutId = setTimeout(() => {
          requestAnimationFrame(adjustPropertyEditorHeight);
          observer.disconnect();
        }, 100);

        const secondTimeoutId = setTimeout(() => {
          requestAnimationFrame(adjustPropertyEditorHeight);
        }, 300);

        // Update the previous count for next comparison
        previousPropertiesCountRef.current = currentPropertiesCount;

        return () => {
          observer.disconnect();
          clearTimeout(timeoutId);
          clearTimeout(secondTimeoutId);
        };
      } else {
        // For updates to existing properties, use a shorter delay
        const timeoutId = setTimeout(() => {
          requestAnimationFrame(adjustPropertyEditorHeight);
        }, 10);

        // Update the previous count for next comparison
        previousPropertiesCountRef.current = currentPropertiesCount;

        return () => {
          clearTimeout(timeoutId);
        };
      }
    }

    // Update count even when no properties
    previousPropertiesCountRef.current = currentPropertiesCount;
  }, [contextProperties, adjustPropertyEditorHeight]); // Resize when context properties change (conditionally)

  // Adjust height when window resizes
  useEffect(() => {
    const handleWindowResize = () => {
      if (headerRef.current && headerHeight) {
        const windowHeight = window.innerHeight;
        const availableHeight = Math.max(windowHeight * 0.6, 200);

        // Only adjust if current height exceeds available space
        if (headerHeight > availableHeight) {
          const naturalHeight = headerRef.current.scrollHeight;
          const clampedHeight = Math.min(Math.max(naturalHeight, 80), availableHeight);
          setHeaderHeight(clampedHeight);
        }
      }
    };

    window.addEventListener('resize', handleWindowResize);
    return () => window.removeEventListener('resize', handleWindowResize);
  }, [headerHeight]);

  // Update header height when loading state changes
  useEffect(() => {

    // Track processing time when isLoading changes
    if (isLoading) {
      // Reset the time and start the timer
      setProcessingTime(0);
      processingTimeRef.current = setInterval(() => {
        setProcessingTime(prevTime => prevTime + 1);
      }, 1000);
    } else {
      // Clear the timer when loading is done
      if (processingTimeRef.current) {
        clearInterval(processingTimeRef.current);
        processingTimeRef.current = null;
      }
    }

    // Clean up on unmount
    return () => {
      if (processingTimeRef.current) {
        clearInterval(processingTimeRef.current);
      }
    };
  }, [isLoading]);

  // Stable remarkPlugins array to prevent re-renders
  const remarkPlugins = useMemo(() => [remarkGfm], []);

  // Stable ReactMarkdown components to prevent image remounting on re-render
  const markdownComponents = useMemo(() => ({
    img({ src, alt, ...props }) {
      const displayName = alt && alt !== 'uploaded image'
        ? alt.replace(/\.[^.]+$/, '') : null;
      return (
        <span className="block mt-2">
          <img
            src={src}
            alt={alt || 'uploaded image'}
            className="max-w-full h-auto rounded"
            style={{ maxHeight: '300px', objectFit: 'contain' as const }}
            loading="lazy"
            {...props}
          />
          {displayName && (
            <span className="block text-xs text-gray-500 leading-tight mt-1">{displayName}</span>
          )}
        </span>
      );
    },
    code({className, children, ...props}) {
      const match = /language-(\w+)/.exec(className || '');
      return match ? (
        <SyntaxHighlighter
          style={tomorrow}
          language={match[1]}
          PreTag="div"
          {...props}
        >{String(children).replace(/\n$/, '')}</SyntaxHighlighter>
      ) : (
        <code className={className} {...props}>
          {children}
        </code>
      );
    },
    table({node, className, children, ...props}) {
      return (
        <div className="overflow-x-auto my-2 w-full">
          <table className="table-auto border-collapse w-full text-xs" {...props}>
            {children}
          </table>
        </div>
      );
    },
    thead({node, children, ...props}) {
      return (
        <thead className="bg-gray-50" {...props}>
          {children}
        </thead>
      );
    },
    tbody({node, children, ...props}) {
      return (
        <tbody className="divide-y divide-gray-100" {...props}>
          {children}
        </tbody>
      );
    },
    tr({node, children, ...props}) {
      return (
        <tr className="hover:bg-gray-50" {...props}>
          {children}
        </tr>
      );
    },
    th({node, children, ...props}) {
      return (
        <th className="px-2 py-1 text-left text-xs font-medium text-gray-600 uppercase tracking-wider border border-gray-200 whitespace-nowrap" {...props}>
          {children}
        </th>
      );
    },
    td({node, children, ...props}) {
      return (
        <td className="px-2 py-1 text-xs text-gray-700 border border-gray-200" {...props}>
          {children}
        </td>
      );
    }
  }), []);

  // The transcript is the chat history merged with the item's recorded version
  // history: a prompt bubble for each generation, plus a row for every version
  // that has no prompt of its own (hand edits, MCP edits, a shared item's v1).
  // Version records are pointer-only, so a row's "+N −M lines" has to be derived
  // from the task sources — fetched once per taskId and cached forever.
  const versionSrc = useVersionSrc({ user, versions: itemVersions, itemId });
  const transcript = useMemo(
    () => buildTranscriptRows({ help, versions: itemVersions, itemId, srcByTaskId: versionSrc }),
    [help, itemVersions, itemId, versionSrc]
  );

  // Which rows have their diff open. Keyed by row, not taskId: a version can
  // appear as its prompt bubble, and the same id shouldn't open two rows.
  const [expandedDiffs, setExpandedDiffs] = useState<Set<string>>(new Set());
  useEffect(() => {
    setExpandedDiffs(new Set());
  }, [itemId]);
  const toggleDiff = useCallback((rowKey) => {
    setExpandedDiffs(prev => {
      const next = new Set(prev);
      if (!next.delete(rowKey)) next.add(rowKey);
      return next;
    });
  }, []);

  // Calculate if there are any changes to send
  const hasChangesToSend = useMemo(() => {
    // Check for property changes
    const changedValues: Record<string, any> = {};

    // Only detect changes if initialProperties has been set (not empty)
    const hasInitialBaseline = Object.keys(initialProperties).length > 0;

    Object.entries(contextProperties).forEach(([key, prop]: [string, any]) => {
      const initialProp = initialProperties[key];

      // Compare current value with initial value (treating undefined as no value)
      const currentValue = prop.value;
      const initialValue = initialProp?.value;

      // Only consider it changed if we have an initial baseline to compare against
      const hasChanged = hasInitialBaseline && JSON.stringify(currentValue) !== JSON.stringify(initialValue);

      if (hasChanged) {
        changedValues[key] = currentValue;
      }
    });

    return Object.keys(changedValues).length > 0;
  }, [contextProperties, initialProperties]);

  // Handle image asset markdown dropped from Assets panel
  const handleAssetDrop = useCallback((e: React.DragEvent) => {
    if (e.dataTransfer.types.includes('application/x-gc-image')) {
      e.preventDefault();
      e.stopPropagation();
      const markdown = e.dataTransfer.getData('text/plain');
      if (markdown) {
        insertTextIntoEditor(markdown);
      }
    }
  }, [insertTextIntoEditor]);

  return (
    <div {...getRootProps({
      onDrop: (e) => {
        // Handle asset drops from Assets panel; let react-dropzone handle file drops
        if (e.dataTransfer.types.includes('application/x-gc-image')) {
          handleAssetDrop(e);
        }
      },
      onDragOver: (e) => {
        if (e.dataTransfer.types.includes('application/x-gc-image')) {
          e.preventDefault();
          e.stopPropagation();
        }
      },
    })} ref={containerRef} className="flex flex-col h-[calc(100vh-120px)]"
    >

      <input {...getInputProps()} />

      {/* Drag overlay with smooth transition */}
      <div
        className={`fixed inset-0 pointer-events-none z-50 transition-opacity duration-200 ${isDragActive ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
        style={{ display: isDragActive ? 'block' : 'none' }}
      >
        <div className="absolute inset-0 bg-gray-50 bg-opacity-40 flex items-center justify-center">
          <div className="bg-white p-6 rounded-none shadow-xl text-center transform transition-transform duration-200 scale-100">
            <svg xmlns="http://www.w3.org/2000/svg" className="mx-auto h-12 w-12 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
            </svg>
            <p className="mt-4 text-lg font-semibold text-gray-700">Drop text file here</p>
          </div>
        </div>
      </div>

      {/* Input field at the top - resizable */}
      <div
        ref={headerRef}
        className="flex-none bg-white px-4 py-3 overflow-y-auto"
        style={{
          height: headerHeight ? `${headerHeight}px` : 'auto',
          maxHeight: headerHeight ? `${headerHeight}px` : maxHeaderHeight ? `${maxHeaderHeight}px` : '80vh',
          minHeight: '80px',
          boxSizing: 'border-box'
        }}>
        <div className="flex justify-between items-start text-xs mb-2 gap-2">
          <div className="font-light text-gray-500 flex items-center flex-wrap">
            <span className="font-medium">CSV</span>
            <span className="mx-1">for tables,</span>
            <span className="font-medium py-0.5 px-1 rounded-none bg-[#f8f8f8] font-mono">```</span>
            <span className="mx-1">for code. Drag & drop to</span>
            <span title="Drag & drop to upload file" className="text-gray-500 inline-flex items-center">
              <svg xmlns="http://www.w3.org/2000/svg" className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
              </svg>
            </span>
            <span className="ml-1">file.</span>
          </div>
        </div>
        <div className="rounded-none border border-gray-200 bg-white shadow-sm">
          <div className="p-1 pb-0">
            <TextEditor
              key={help.length === 0 ? 'empty' : 'has-content'}
              state={state}
              disabled={isLoading}
              placeholder={help.length > 0 ? "Reply to make changes..." : "What do you want to make today?"}
              onSubmit={sendCombinedMessage}
            />
          </div>
        </div>

        {/* Property Editor */}
        {Object.keys(contextProperties).length > 0 && (
          <div className="mt-3 p-3 bg-gray-50 rounded-none border border-gray-200">
            <div className="flex justify-between items-center mb-2">
              <div className="text-xs font-semibold text-gray-600">
                {focusedElement?.type && focusedElement?.name ?
                  (() => {
                    const capitalizedType = focusedElement.type.charAt(0).toUpperCase() + focusedElement.type.slice(1);
                    const isPlural = (focusedElement.type === 'column' || focusedElement.type === 'row') &&
                                     focusedElement.name?.includes(',');
                    const typeLabel = isPlural ? capitalizedType + 's' : capitalizedType;
                    return `${typeLabel} ${focusedElement.name}`;
                  })() :
                  focusedElement.type.charAt(0).toUpperCase() + focusedElement.type.slice(1)}
                {schemaLoading && <span className="ml-2 text-gray-400">(Loading schema...)</span>}
              </div>
              <button
                onClick={() => {
                  // Send combined message with text from editor and property changes
                  sendCombinedMessage();
                }}
                disabled={isLoading || !hasChangesToSend}
                className="px-4 py-1.5 text-xs bg-gray-600 text-white rounded-none hover:bg-gray-700 focus:outline-none focus:ring-2 focus:ring-gray-500 disabled:opacity-50 disabled:cursor-not-allowed flex items-center space-x-2 flex-shrink-0"
              >
                {isLoading ? (
                  <>
                    <span>Applying</span>
                    <div className="flex items-center">
                      <div className="w-1 h-1 bg-white rounded-full animate-bounce" style={{ animationDelay: '0ms', animationDuration: '1s' }}></div>
                      <div className="w-1 h-1 bg-white rounded-full mx-0.5 animate-bounce" style={{ animationDelay: '200ms', animationDuration: '1s' }}></div>
                      <div className="w-1 h-1 bg-white rounded-full animate-bounce" style={{ animationDelay: '400ms', animationDuration: '1s' }}></div>
                    </div>
                    <div className="text-white text-xs">{`${processingTime}s`}</div>
                  </>
                ) : (
                  'Apply'
                )}
              </button>
            </div>
            <div className="space-y-2">
              {/* Group properties by their group attribute from schema */}
              {(() => {
                const groupedProps: any = {};

                // Group properties based on their group field from schema
                Object.entries(contextProperties).forEach(([key, prop]: [string, any]) => {
                  if (!prop.hidden) {
                    // Use the group value from schema for all properties including nested objects
                    const group = prop.group === "" || prop.group === undefined || prop.group === 'default' ? 'no-group' : prop.group;
                    if (!groupedProps[group]) groupedProps[group] = {};
                    groupedProps[group][key] = prop;
                  }
                });

                // Sort groups to show no-group first, then alphabetically
                const sortedGroups = Object.entries(groupedProps).sort(([a], [b]) => {
                  if (a === 'no-group') return -1;
                  if (b === 'no-group') return 1;
                  return a.localeCompare(b);
                });

                return sortedGroups.map(([groupName, groupProps]) => {
                  // Initialize collapsed state - true means collapsed by default
                  // First click will set it to false (expanded)
                  // IMPORTANT: 'no-group' should never be collapsed since it has no header
                  const isCollapsed = groupName === 'no-group' ? false : (collapsedGroups[groupName] ?? true);
                  // Check if this group contains a nested object
                  const hasNestedObject = Object.values(groupProps).some((prop: any) => prop.type === 'nested-object');
                  // For nested object groups, count the child properties instead of the parent
                  let propertyCount = Object.keys(groupProps).length;
                  let propertyNames: string[] = [];
                  if (hasNestedObject && propertyCount === 1) {
                    const nestedProp = Object.values(groupProps)[0] as any;
                    if (nestedProp.type === 'nested-object' && nestedProp.properties) {
                      propertyCount = Object.keys(nestedProp.properties).length;
                      // Get nested property names
                      propertyNames = Object.keys(nestedProp.properties);
                    }
                  } else {
                    // Get regular property names
                    propertyNames = Object.keys(groupProps);
                  }
                  // Create a sample of property names
                  const propertySample = propertyNames.slice(0, 3).join(', ') + (propertyNames.length > 3 ? ', ...' : '');
                  // Show header for: actual groups (not 'no-group') AND (multiple properties OR nested object)
                  const showGroupHeader = groupName !== 'no-group' && (propertyCount > 1 || hasNestedObject);

                  return (
                    <div key={groupName} className="space-y-2">
                      {showGroupHeader && (
                        <div
                          className="flex items-center justify-between mt-2 mb-1 cursor-pointer hover:bg-gray-100 -mx-2 px-2 py-1 rounded-none"
                          onClick={() => {
                            // Mark this group as manually toggled
                            setManuallyToggledGroups(prev => new Set(prev).add(groupName));
                            // Toggle the collapsed state
                            setCollapsedGroups(prev => ({
                              ...prev,
                              [groupName]: !isCollapsed
                            }));
                          }}
                        >
                          <div className="flex items-center space-x-1 flex-1 min-w-0">
                            <svg
                              className={`w-3 h-3 text-gray-400 transform transition-transform flex-shrink-0 ${isCollapsed ? '' : 'rotate-90'}`}
                              fill="none"
                              viewBox="0 0 24 24"
                              stroke="currentColor"
                            >
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                            </svg>
                            <div className="text-xs font-semibold text-gray-400 tracking-wider flex-shrink-0">
                              {groupName}
                            </div>
                            {isCollapsed && propertySample && (
                              <div className="text-xs text-gray-300 truncate">
                                ({propertySample})
                              </div>
                            )}
                          </div>
                          <div className="text-xs text-gray-400 flex-shrink-0">
                            ({propertyCount})
                          </div>
                        </div>
                      )}
                      {!isCollapsed && (
                        <div className={showGroupHeader ? 'pl-4 space-y-2' : 'space-y-2'}>
                    {Object.entries(groupProps).map(([key, propDef]) => {
                      // For nested objects in their own group, only show the child properties
                      if (propDef.type === 'nested-object' && groupName === key) {
                        // Only render the nested properties, not the parent label
                        return (
                          <div key={key} className="space-y-2">
                            {Object.entries(propDef.properties || {}).map(([nestedKey, nestedProp]: [string, any]) => (
                              <div key={nestedKey} className="flex items-center space-x-3 mb-2">
                                <label
                                  className="text-xs font-medium text-gray-500 min-w-[120px] flex-shrink-0"
                                  title={nestedProp.description}
                                >
                                  {nestedProp.label}:
                                  {/*nestedProp.required && <span className="text-red-400 ml-0.5">*</span>*/}
                                </label>
                                {/* Render nested property input */}
                                {nestedProp.enum ? (
                                  <select
                                    value={nestedProp.value || ''}
                                    onChange={(e) => {
                                      // Build the complete nested value from all nested properties
                                      const newNestedValue = {};
                                      Object.entries(propDef.properties || {}).forEach(([nKey, nProp]: [string, any]) => {
                                        if (nKey === nestedKey) {
                                          newNestedValue[nKey] = e.target.value;
                                        } else {
                                          newNestedValue[nKey] = nProp.value;
                                        }
                                      });
                                      setContextProperties(prev => {
                                        const updated = {
                                          ...prev,
                                          [key]: {
                                            ...propDef,
                                            value: newNestedValue,
                                            properties: {
                                              ...propDef.properties,
                                              [nestedKey]: {
                                                ...propDef.properties[nestedKey],
                                                value: e.target.value
                                              }
                                            }
                                          }
                                        };
                                        return updated;
                                      });
                                    }}
                                    disabled={nestedProp.readonly}
                                    className="flex-1 px-2 py-1 text-xs border border-gray-300 rounded-none focus:outline-none focus:ring-1 focus:ring-gray-500 disabled:bg-gray-100"
                                  >
                                    <option value=""></option>
                                    {nestedProp.enum.map(option => (
                                      <option key={option} value={option}>
                                        {option}
                                      </option>
                                    ))}
                                  </select>
                                ) : nestedProp.type === 'boolean' ? (
                                  <input
                                    type="checkbox"
                                    checked={nestedProp.value}
                                    onChange={(e) => {
                                      // Build the complete nested value from all nested properties
                                      const newNestedValue = {};
                                      Object.entries(propDef.properties || {}).forEach(([nKey, nProp]: [string, any]) => {
                                        if (nKey === nestedKey) {
                                          newNestedValue[nKey] = e.target.checked;
                                        } else {
                                          newNestedValue[nKey] = nProp.value;
                                        }
                                      });
                                      setContextProperties(prev => ({
                                        ...prev,
                                        [key]: {
                                          ...propDef,
                                          value: newNestedValue,
                                          properties: {
                                            ...propDef.properties,
                                            [nestedKey]: {
                                              ...propDef.properties[nestedKey],
                                              value: e.target.checked
                                            }
                                          }
                                        }
                                      }));
                                    }}
                                    disabled={nestedProp.readonly}
                                    className="h-4 w-4 text-gray-600 border-gray-300 rounded-none focus:ring-gray-500 disabled:opacity-50"
                                  />
                                ) : nestedProp.type === 'number' ? (
                                  <input
                                    type="number"
                                    value={nestedProp.value}
                                    min={nestedProp.min}
                                    max={nestedProp.max}
                                    onChange={(e) => {
                                      // Build the complete nested value from all nested properties
                                      const newNestedValue = {};
                                      Object.entries(propDef.properties || {}).forEach(([nKey, nProp]: [string, any]) => {
                                        if (nKey === nestedKey) {
                                          newNestedValue[nKey] = parseFloat(e.target.value) || 0;
                                        } else {
                                          newNestedValue[nKey] = nProp.value;
                                        }
                                      });
                                      setContextProperties(prev => ({
                                        ...prev,
                                        [key]: {
                                          ...propDef,
                                          value: newNestedValue,
                                          properties: {
                                            ...propDef.properties,
                                            [nestedKey]: {
                                              ...propDef.properties[nestedKey],
                                              value: parseFloat(e.target.value) || 0
                                            }
                                          }
                                        }
                                      }));
                                    }}
                                    disabled={nestedProp.readonly}
                                    placeholder={nestedProp.placeholder}
                                    className="flex-1 px-2 py-1 text-xs border border-gray-300 rounded-none focus:outline-none focus:ring-1 focus:ring-gray-500 disabled:bg-gray-100"
                                  />
                                ) : (
                                  <input
                                    type={nestedProp.format === 'date' ? 'date' : 'text'}
                                    value={nestedProp.value || ''}
                                    onChange={(e) => {
                                      // Build the complete nested value from all nested properties
                                      const newNestedValue = {};
                                      Object.entries(propDef.properties || {}).forEach(([nKey, nProp]: [string, any]) => {
                                        if (nKey === nestedKey) {
                                          newNestedValue[nKey] = e.target.value;
                                        } else {
                                          newNestedValue[nKey] = nProp.value;
                                        }
                                      });
                                      setContextProperties(prev => {
                                        const updated = {
                                          ...prev,
                                          [key]: {
                                            ...propDef,
                                            value: newNestedValue,
                                            properties: {
                                              ...propDef.properties,
                                              [nestedKey]: {
                                                ...propDef.properties[nestedKey],
                                                value: e.target.value
                                              }
                                            }
                                          }
                                        };
                                        return updated;
                                      });
                                    }}
                                    disabled={nestedProp.readonly}
                                    placeholder={nestedProp.placeholder}
                                    className="flex-1 px-2 py-1 text-xs border border-gray-300 rounded-none focus:outline-none focus:ring-1 focus:ring-gray-500 disabled:bg-gray-100"
                                  />
                                )}
                              </div>
                            ))}
                          </div>
                        );
                      }

                      // For nested objects not in their own group, or regular properties
                      return (
                        <div key={key} className="flex flex-col space-y-1">
                          {propDef.type === 'nested-object' ? (
                            // Render nested object properties with parent label
                            <>
                              <div
                                className="flex items-center text-xs font-medium text-gray-500 mb-1 whitespace-nowrap cursor-pointer hover:text-gray-700"
                                onClick={() => {
                                  setManuallyToggledNestedObjects(prev => new Set(prev).add(key));
                                  setCollapsedNestedObjects(prev => ({
                                    ...prev,
                                    [key]: !prev[key]
                                  }));
                                }}
                              >
                                <svg
                                  className={`w-3 h-3 mr-1 text-gray-400 transform transition-transform ${collapsedNestedObjects[key] ? '' : 'rotate-90'}`}
                                  fill="none"
                                  viewBox="0 0 24 24"
                                  stroke="currentColor"
                                  strokeWidth={2}
                                >
                                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                                </svg>
                                {propDef.label}:
                                {/*propDef.required && <span className="text-red-400 ml-0.5">*</span>*/}
                              </div>
                              {!collapsedNestedObjects[key] && (
                                <div className="pl-3 ml-2">
                                  {Object.entries(propDef.properties || {}).map(([nestedKey, nestedProp]: [string, any]) => (
                                  <div key={nestedKey} className="flex items-center space-x-3 mb-2">
                                    <label
                                      className="text-xs font-medium text-gray-500 min-w-[120px] flex-shrink-0"
                                      title={nestedProp.description}
                                    >
                                      {nestedProp.label}:
                                      {/*nestedProp.required && <span className="text-red-400 ml-0.5">*</span>*/}
                                    </label>
                                    {/* Render nested property input */}
                                    {nestedProp.enum ? (
                                      <select
                                        value={nestedProp.value || ''}
                                        onChange={(e) => {
                                          // Build the complete nested value from all nested properties
                                          const newNestedValue = {};
                                          Object.entries(propDef.properties || {}).forEach(([nKey, nProp]: [string, any]) => {
                                            if (nKey === nestedKey) {
                                              newNestedValue[nKey] = e.target.value;
                                            } else {
                                              newNestedValue[nKey] = nProp.value;
                                            }
                                          });
                                          setContextProperties(prev => ({
                                            ...prev,
                                            [key]: {
                                              ...propDef,
                                              value: newNestedValue,
                                              properties: {
                                                ...propDef.properties,
                                                [nestedKey]: {
                                                  ...propDef.properties[nestedKey],
                                                  value: e.target.value
                                                }
                                              }
                                            }
                                          }));
                                        }}
                                        disabled={nestedProp.readonly}
                                        className="flex-1 px-2 py-1 text-xs border border-gray-300 rounded-none focus:outline-none focus:ring-1 focus:ring-gray-500 disabled:bg-gray-100"
                                      >
                                        <option value=""></option>
                                        {nestedProp.enum.map(option => (
                                          <option key={option} value={option}>
                                            {option}
                                          </option>
                                        ))}
                                      </select>
                                    ) : nestedProp.type === 'boolean' ? (
                                      <input
                                        type="checkbox"
                                        checked={nestedProp.value}
                                        onChange={(e) => {
                                          // Build the complete nested value from all nested properties
                                          const newNestedValue = {};
                                          Object.entries(propDef.properties || {}).forEach(([nKey, nProp]: [string, any]) => {
                                            if (nKey === nestedKey) {
                                              newNestedValue[nKey] = e.target.checked;
                                            } else {
                                              newNestedValue[nKey] = nProp.value;
                                            }
                                          });
                                          setContextProperties(prev => ({
                                            ...prev,
                                            [key]: {
                                              ...propDef,
                                              value: newNestedValue,
                                              properties: {
                                                ...propDef.properties,
                                                [nestedKey]: {
                                                  ...propDef.properties[nestedKey],
                                                  value: e.target.checked
                                                }
                                              }
                                            }
                                          }));
                                        }}
                                        disabled={nestedProp.readonly}
                                        className="h-4 w-4 text-gray-600 border-gray-300 rounded-none focus:ring-gray-500 disabled:opacity-50"
                                      />
                                    ) : nestedProp.type === 'number' ? (
                                      <input
                                        type="number"
                                        value={nestedProp.value}
                                        min={nestedProp.min}
                                        max={nestedProp.max}
                                        onChange={(e) => {
                                          // Build the complete nested value from all nested properties
                                          const newNestedValue = {};
                                          Object.entries(propDef.properties || {}).forEach(([nKey, nProp]: [string, any]) => {
                                            if (nKey === nestedKey) {
                                              newNestedValue[nKey] = parseFloat(e.target.value) || 0;
                                            } else {
                                              newNestedValue[nKey] = nProp.value;
                                            }
                                          });
                                          setContextProperties(prev => ({
                                            ...prev,
                                            [key]: {
                                              ...propDef,
                                              value: newNestedValue,
                                              properties: {
                                                ...propDef.properties,
                                                [nestedKey]: {
                                                  ...propDef.properties[nestedKey],
                                                  value: parseFloat(e.target.value) || 0
                                                }
                                              }
                                            }
                                          }));
                                        }}
                                        disabled={nestedProp.readonly}
                                        placeholder={nestedProp.placeholder}
                                        className="flex-1 px-2 py-1 text-xs border border-gray-300 rounded-none focus:outline-none focus:ring-1 focus:ring-gray-500 disabled:bg-gray-100"
                                      />
                                    ) : (
                                      <input
                                        type={nestedProp.format === 'date' ? 'date' : 'text'}
                                        value={nestedProp.value || ''}
                                        onChange={(e) => {
                                          // Build the complete nested value from all nested properties
                                          const newNestedValue = {};
                                          Object.entries(propDef.properties || {}).forEach(([nKey, nProp]: [string, any]) => {
                                            if (nKey === nestedKey) {
                                              newNestedValue[nKey] = e.target.value;
                                            } else {
                                              newNestedValue[nKey] = nProp.value;
                                            }
                                          });
                                          setContextProperties(prev => ({
                                            ...prev,
                                            [key]: {
                                              ...propDef,
                                              value: newNestedValue,
                                              properties: {
                                                ...propDef.properties,
                                                [nestedKey]: {
                                                  ...propDef.properties[nestedKey],
                                                  value: e.target.value
                                                }
                                              }
                                            }
                                          }));
                                        }}
                                        disabled={nestedProp.readonly}
                                        placeholder={nestedProp.placeholder}
                                        className="flex-1 px-2 py-1 text-xs border border-gray-300 rounded-none focus:outline-none focus:ring-1 focus:ring-gray-500 disabled:bg-gray-100"
                                      />
                                    )}
                                  </div>
                                ))}
                                </div>
                              )}
                            </>
                          ) : (
                          // Render regular property
                          <>
                            <div className="flex items-center space-x-3">
                              <label
                                className="text-xs font-medium text-gray-500 min-w-[140px] flex-shrink-0"
                                title={propDef.description}
                              >
                                {propDef.label || key.replace(/([A-Z])/g, ' $1').replace(/^./, str => str.toUpperCase()).trim()}:
                                {/*propDef.required && <span className="text-red-400 ml-0.5">*</span>*/}
                              </label>

                              {propDef.enum ? (
                                <select
                                  data-property-key={key}
                                  value={propDef.value}
                                  onChange={(e) => setContextProperties(prev => ({
                                    ...prev,
                                    [key]: { ...propDef, value: e.target.value }
                                  }))}
                                  disabled={propDef.readonly}
                                  className="flex-1 px-2 py-1 text-xs border border-gray-300 rounded-none focus:outline-none focus:ring-1 focus:ring-gray-500 disabled:bg-gray-100"
                                >
                                  <option value=""></option>
                                  {propDef.enum.map(option => (
                                    <option key={option} value={option}>
                                      {option}
                                    </option>
                                  ))}
                                </select>
                              ) : propDef.type === 'boolean' ? (
                                <input
                                  type="checkbox"
                                  data-property-key={key}
                                  checked={propDef.value}
                                  onChange={(e) => setContextProperties(prev => ({
                                    ...prev,
                                    [key]: { ...propDef, value: e.target.checked }
                                  }))}
                                  disabled={propDef.readonly}
                                  className="h-4 w-4 text-blue-600 border-gray-300 rounded-none focus:ring-gray-500 disabled:opacity-50"
                                />
                              ) : propDef.type === 'number' || propDef.type === 'integer' ? (
                                // Number input
                                <input
                                  type="number"
                                  data-property-key={key}
                                  value={propDef.value}
                                  min={propDef.min}
                                  max={propDef.max}
                                  step={propDef.type === 'integer' ? 1 : 'any'}
                                  onChange={(e) => setContextProperties(prev => ({
                                    ...prev,
                                    [key]: { ...propDef, value: propDef.type === 'integer' ? parseInt(e.target.value) || 0 : parseFloat(e.target.value) || 0 }
                                  }))}
                                  disabled={propDef.readonly}
                                  placeholder={propDef.placeholder}
                                  className="flex-1 px-2 py-1 text-xs border border-gray-300 rounded-none focus:outline-none focus:ring-1 focus:ring-gray-500 disabled:bg-gray-100"
                                />
                              ) : propDef.type === 'array' ? (
                                // Array input - show as JSON for now
                                <textarea
                                  value={JSON.stringify(propDef.value || [], null, 2)}
                                  onChange={(e) => {
                                    try {
                                      const parsed = JSON.parse(e.target.value);
                                      setContextProperties(prev => ({
                                        ...prev,
                                        [key]: { ...propDef, value: parsed }
                                      }));
                                    } catch (err) {
                                      // Invalid JSON, don't update
                                    }
                                  }}
                                  disabled={propDef.readonly}
                                  placeholder={propDef.placeholder || '[]'}
                                  className="flex-1 px-2 py-1 text-xs border border-gray-300 rounded-none focus:outline-none focus:ring-1 focus:ring-gray-500 disabled:bg-gray-100 font-mono"
                                  rows={2}
                                />
                              ) : propDef.type === 'object' ? (
                                // Object input - show as JSON for now
                                <textarea
                                  value={JSON.stringify(propDef.value || {}, null, 2)}
                                  onChange={(e) => {
                                    try {
                                      const parsed = JSON.parse(e.target.value);
                                      setContextProperties(prev => ({
                                        ...prev,
                                        [key]: { ...propDef, value: parsed }
                                      }));
                                    } catch (err) {
                                      // Invalid JSON, don't update
                                    }
                                  }}
                                  disabled={propDef.readonly}
                                  placeholder={propDef.placeholder || '{}'}
                                  className="flex-1 px-2 py-1 text-xs border border-gray-300 rounded-none focus:outline-none focus:ring-1 focus:ring-gray-500 disabled:bg-gray-100 font-mono"
                                  rows={2}
                                />
                              ) : (
                                // Text input (default)
                                <input
                                  type="text"
                                  data-property-key={key}
                                  value={propDef.value || ''}
                                  onChange={(e) => setContextProperties(prev => ({
                                    ...prev,
                                    [key]: { ...propDef, value: e.target.value }
                                  }))}
                                  disabled={propDef.readonly}
                                  placeholder={propDef.placeholder}
                                  pattern={propDef.pattern}
                                  className="flex-1 px-2 py-1 text-xs border border-gray-300 rounded-none focus:outline-none focus:ring-1 focus:ring-gray-500 disabled:bg-gray-100"
                                />
                              )}
                        </div>
                        </>
                        )}
                        </div>
                      );
                    })}
                        </div>
                      )}
                    </div>
                  );
                });
              })()}
            </div>
          </div>
        )}

        {/* Send button when no properties are visible */}
        {Object.keys(contextProperties).length === 0 && (
          <div className="mt-3 flex justify-end">
            <button
              onClick={() => {
                // Send combined message with text from editor and property changes
                sendCombinedMessage();
              }}
              disabled={isLoading}
              className="px-4 py-1.5 text-xs bg-gray-600 text-white rounded-none hover:bg-gray-700 focus:outline-none focus:ring-2 focus:ring-gray-500 disabled:opacity-50 disabled:cursor-not-allowed flex items-center space-x-2 flex-shrink-0"
            >
              {isLoading ? (
                <>
                  <span>Applying</span>
                  <div className="flex items-center">
                    <div className="w-1 h-1 bg-white rounded-full animate-bounce" style={{ animationDelay: '0ms', animationDuration: '1s' }}></div>
                    <div className="w-1 h-1 bg-white rounded-full mx-0.5 animate-bounce" style={{ animationDelay: '200ms', animationDuration: '1s' }}></div>
                    <div className="w-1 h-1 bg-white rounded-full animate-bounce" style={{ animationDelay: '400ms', animationDuration: '1s' }}></div>
                  </div>
                  <div className="text-white text-xs">{`${processingTime}s`}</div>
                </>
              ) : (
                'Apply'
              )}
            </button>
          </div>
        )}

        {/* Image Upload Progress */}
        {imageUploadProgress !== null && (
          <div className="absolute left-1/2 transform -translate-x-1/2 top-24 px-4 py-2 rounded-none shadow-md z-50 bg-blue-50 border border-blue-200 text-sm text-blue-800">
            <div className="flex items-center gap-2 mb-1">
              <svg className="animate-spin h-4 w-4 text-blue-500" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              Uploading image... {Math.round(imageUploadProgress)}%
            </div>
            <div className="w-48 bg-blue-200 rounded-full h-1.5">
              <div className="bg-blue-500 h-1.5 rounded-full transition-all" style={{ width: `${imageUploadProgress}%` }} />
            </div>
          </div>
        )}

        {/* File Upload Notification */}
        {uploadNotification && (
          <div className={`absolute left-1/2 transform -translate-x-1/2 top-24 px-4 py-2 rounded-none shadow-md z-50 flex items-center text-sm ${
            uploadNotification.type === 'success' ? 'bg-green-50 text-green-800 border border-green-200' : 'bg-red-50 text-red-800 border border-red-200'
          }`}>
            <div className="mr-2">
              {uploadNotification.type === 'success' ? (
                <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 text-green-500" viewBox="0 0 20 20" fill="currentColor">
                  <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                </svg>
              ) : (
                <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 text-red-500" viewBox="0 0 20 20" fill="currentColor">
                  <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
                </svg>
              )}
            </div>
            <div>
              {uploadNotification.message}
            </div>
          </div>
        )}

        {/* File Upload Modal */}
        {showUploadModal && (
          <CsvDropzone
            state={state}
            setShowUploadModal={setShowUploadModal}
            setUploadNotification={setUploadNotification}
          />
        )}
      </div>

      {/* Resize handle */}
      <div
        className="h-1 bg-gray-300 hover:bg-gray-400 cursor-row-resize transition-colors relative my-1"
        onMouseDown={handleMouseDown}
      >
        <div className="absolute inset-x-0 -top-1 -bottom-1 flex items-center justify-center">
          <div className="w-16 h-1 bg-gray-400 rounded-full opacity-50"></div>
        </div>
      </div>

      {/* Scrollable messages container - dynamically sized */}
      <div
        className="flex-1 overflow-auto px-4 py-4"
      >
        {transcript.rows.length > 0 && (
          /* Newest first — the merge helper owns the ordering. */
          <div className="space-y-2">
            {transcript.rows.map((row) => {
              // A version with no prompt of its own: a hand edit, an agent edit,
              // or the v1 of a shared/claimed item. Rendered outlined-on-white to
              // read as a record rather than a message, and with no delete
              // affordance — version history is append-only.
              if (row.kind === 'version') {
                const version = row.version || {};
                const isCurrent = row.taskId && row.taskId === taskId;
                // A hand edit's stored label IS a line delta, so it would just
                // repeat row.stats — but it's the only stat available before the
                // sources land, so it stands in until they do. Every other
                // source's label is prose (a generation job's is the prompt).
                const isEditLabel = version.source === 'editor';
                const description = isEditLabel ? null : version.label;
                const stats = row.stats || (isEditLabel ? version.label : null);
                const expanded = expandedDiffs.has(row.key);
                return (
                  <div key={row.key} className="mb-2 w-full">
                    <div
                      className={`bg-white rounded-none overflow-hidden ${
                        isCurrent ? 'border-2 border-gray-500' : 'border border-gray-200'
                      } ${onLoadTaskFromHelp ? 'cursor-pointer hover:bg-gray-50 transition-all' : ''}`}
                      onClick={() => {
                        if (onLoadTaskFromHelp) onLoadTaskFromHelp(row.taskId);
                      }}
                      title={onLoadTaskFromHelp ? 'Click to load this version' : ''}
                    >
                      {/* Timestamp header — same shape as a prompt bubble's */}
                      <div className="px-3 pt-2 pb-1 flex items-baseline gap-2">
                        <span className="text-xs text-gray-500">
                          {row.ts ? new Date(row.ts).toLocaleString() : ''}
                        </span>
                        <span className="text-[10px] font-medium uppercase tracking-wide text-gray-500">
                          {versionSourceLabel(version.source)}
                        </span>
                      </div>

                      {/* What changed. The task id is the last resort — shown
                          only when neither a description nor a delta resolved. */}
                      <div className="px-3 pb-3 pt-0">
                        {description ? (
                          <div className="text-sm text-gray-700 truncate">
                            {description}
                          </div>
                        ) : !stats && (
                          <div className="text-sm text-gray-700 truncate font-mono">
                            {elideCompoundId(row.taskId)}
                          </div>
                        )}
                        <StatsLine
                          stats={stats}
                          diffKey={row.diffKey}
                          expanded={expanded}
                          onToggle={() => toggleDiff(row.key)}
                        />
                        {row.collapsedCount > 1 && (
                          <div className="text-xs text-gray-500">{`${row.collapsedCount} edits`}</div>
                        )}
                      </div>

                      {expanded && row.diffKey && (
                        <div onClick={(event) => event.stopPropagation()}>
                          <VersionDiff
                            diffKey={row.diffKey}
                            before={row.diffBase ? versionSrc.get(row.diffBase) ?? '' : ''}
                            after={versionSrc.get(row.taskId) ?? ''}
                          />
                        </div>
                      )}
                    </div>
                  </div>
                );
              }

              const message = row.message;
              // Check if this message is pending (waiting for a response)
              const isPending = isLoading &&
                               (row.index === help.length - 1 ||
                                help[row.index + 1]?.type !== 'bot');
              // A prompt bubble is a code generation, so it carries the same
              // provenance chip a version row does. System rows are notices,
              // not generations.
              const sourceChip = message.role === 'system' ? null : 'Agent';
              const showHeader = message.timestamp || sourceChip;
              const rowKey = `help-${row.index}`;
              const expanded = expandedDiffs.has(rowKey);

              return (
                <div key={rowKey} className="mb-2 w-full">
                  <div className="relative group">
                    {/* Delete button for each user message */}
                    {message.role !== 'system' && (
                      <button
                        className={`absolute top-0 right-0 p-1 opacity-0 group-hover:opacity-100 transition-opacity -mt-2 -mr-2 z-10 ${isPending ? 'text-red-400 hover:text-red-600 bg-white rounded-full shadow-sm' : 'text-gray-400 hover:text-gray-600 bg-white rounded-full shadow-sm'}`}
                        onClick={() => handleDeleteMessagePair(row.index)}
                        title={isPending ? "Cancel and delete request" : "Delete message"}
                      >
                        <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                        </svg>
                      </button>
                    )}

                    <div
                      className={`${message.role === 'system' ? 'bg-gray-100' : 'bg-gray-200'} rounded-none overflow-hidden ${isPending ? 'border-2 border-gray-300' : ''} ${
                        message.taskId && message.taskId === taskId ? 'border-2 border-gray-500' : ''
                      } ${message.taskId && onLoadTaskFromHelp ? 'cursor-pointer hover:brightness-95 transition-all' : ''}`}
                      onClick={() => {
                        if (message.taskId && onLoadTaskFromHelp) {
                          onLoadTaskFromHelp(message.taskId);
                        }
                      }}
                      title={message.taskId && onLoadTaskFromHelp ? 'Click to load task' : ''}
                    >
                      {/* Timestamp + source header — same shape as a version row's */}
                      {showHeader && (
                        <div className="px-3 pt-2 pb-1 flex items-baseline gap-2">
                          {message.timestamp && (
                            <span className="text-xs text-gray-500">
                              {new Date(message.timestamp).toLocaleString()}
                            </span>
                          )}
                          {sourceChip && (
                            <span className="text-[10px] font-medium uppercase tracking-wide text-gray-500">
                              {sourceChip}
                            </span>
                          )}
                        </div>
                      )}

                      {/* Content */}
                      <div className={`px-3 pb-3 ${showHeader ? 'pt-0' : 'pt-3'}`}>
                        <div className="text-sm prose prose-sm prose-blue max-w-none prose-img:mb-0">
                          <ReactMarkdown
                            remarkPlugins={remarkPlugins}
                            components={markdownComponents}
                          >
                            {message.role === 'system' ? message.content : message.user}
                          </ReactMarkdown>
                        </div>
                        {/* What the generation this prompt produced changed */}
                        {row.stats && (
                          <div className="mt-1">
                            <StatsLine
                              stats={row.stats}
                              diffKey={row.diffKey}
                              expanded={expanded}
                              onToggle={() => toggleDiff(rowKey)}
                            />
                          </div>
                        )}
                      </div>

                      {expanded && row.diffKey && (
                        <div onClick={(event) => event.stopPropagation()}>
                          <VersionDiff
                            diffKey={row.diffKey}
                            before={row.diffBase ? versionSrc.get(row.diffBase) ?? '' : ''}
                            after={versionSrc.get(row.taskId) ?? ''}
                          />
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};
