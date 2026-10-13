import React, { useCallback } from 'react';
import { useDropzone } from 'react-dropzone';
import { createPortal } from 'react-dom';

interface CsvDropzoneProps {
  state: any; // You may want to type this more specifically
  setShowUploadModal: (show: boolean) => void;
  setUploadNotification: (notification: any) => void;
}

export const CsvDropzone: React.FC<CsvDropzoneProps> = ({
  state,
  setShowUploadModal,
  setUploadNotification
}) => {
  const onDrop = useCallback((acceptedFiles) => {
    if (acceptedFiles.length === 0) return;

    const file = acceptedFiles[0];
    console.log("Uploaded file:", file.name);

    // Read the file contents
    const reader = new FileReader();
    reader.onload = (e) => {
      const fileContent = e.target.result as string;
      let updateSuccess = false;

      // Wait a moment to ensure the editor is accessible
      setTimeout(() => {
        // Try direct DOM manipulation first - most reliable method
        try {
          // Try to find the editor in multiple ways
          const editorElement: HTMLElement =
            document.querySelector("[contenteditable=true]") ||
            document.querySelector(".ProseMirror") ||
            document.querySelector("[role='textbox']");

          if (editorElement) {
              // Focus and clear the editor
            editorElement.focus();

            // Try multiple approaches to insert text
            try {
              // Modern approach
              document.execCommand('selectAll', false, null);
              document.execCommand('delete', false, null);
              document.execCommand('insertText', false, fileContent);
              updateSuccess = true;
              } catch (insertErr) {
              console.error("execCommand insertion failed:", insertErr);

              // Try direct innerHTML approach
              try {
                editorElement.innerHTML = '';
                editorElement.innerHTML = fileContent.replace(/\n/g, '<br>');
                updateSuccess = true;
                console.log("Successfully inserted content via textContent");
              } catch (innerErr) {
                console.error("textContent insertion failed:", innerErr);
              }
            }
          } else {
            console.error("Could not find editor element");
          }
        } catch (err) {
          console.error("DOM manipulation failed:", err);
        }

        // If direct DOM manipulation failed, try state update
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
          try {
            // First try the modern clipboard API
            navigator.clipboard.writeText(fileContent)
              .then(() => {
                setUploadNotification({
                  type: 'warning',
                  message: `File content copied to clipboard. Press Ctrl+V or Cmd+V to paste.`,
                  fileName: file.name
                });
              })
              .catch((clipErr) => {
                console.error("Clipboard API failed:", clipErr);
                // Fallback: show error notification
                setUploadNotification({
                  type: 'error',
                  message: `Could not process file. Please try copying and pasting manually.`,
                  fileName: file.name
                });
              });
          } catch (clipErr) {
            console.error("Clipboard operation failed:", clipErr);
            setUploadNotification({
              type: 'error',
              message: `Could not process file`,
              fileName: file.name
            });
          }
        }

        // Close the modal
        setShowUploadModal(false);

        // Clear notification after 3 seconds
        setTimeout(() => {
          setUploadNotification(null);
        }, 3000);
      }, 100); // Small delay to ensure DOM is ready
    };

    reader.onerror = (error) => {
      console.error("Error reading file:", error);
      setUploadNotification({
        type: 'error',
        message: 'Error reading file',
        fileName: file.name
      });

      // Close the modal
      setShowUploadModal(false);

      // Clear notification after 3 seconds
      setTimeout(() => {
        setUploadNotification(null);
      }, 3000);
    };

    // Read the file as text
    reader.readAsText(file);
  }, [state, setShowUploadModal, setUploadNotification]);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: {
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
    maxFiles: 1
  });

  const modalContent = (
    <div
      className="fixed inset-0 flex items-center justify-center"
      style={{
        position: 'fixed',
        zIndex: 2147483647, // Max possible z-index value
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: 'rgba(0, 0, 0, 0.3)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center'
      }}
      onClick={() => setShowUploadModal(false)}
    >
      <div
        className="bg-white rounded-none p-4 shadow-xl w-[400px] max-w-[90vw]"
        style={{
          position: 'relative',
          zIndex: 2147483647,
          backgroundColor: 'white',
          borderRadius: '0',
          padding: '1rem',
          boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04)'
        }}
        onClick={e => e.stopPropagation()}
      >
        <div className="flex justify-between items-center mb-3">
          <h3 className="text-base font-medium">Upload Text File</h3>
          <button
            onClick={() => setShowUploadModal(false)}
            className="text-gray-400 hover:text-gray-600"
          >
            <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div
          {...getRootProps()}
          className={`border border-dashed rounded-none p-6 text-center cursor-pointer transition-colors ${
            isDragActive ? 'border-gray-400 bg-gray-50' : 'border-gray-300 hover:border-gray-400'
          }`}
          style={{
            border: '1px dashed',
            borderColor: isDragActive ? '#9ca3af' : '#d1d5db',
            borderRadius: '0',
            padding: '1.5rem',
            textAlign: 'center',
            cursor: 'pointer',
            backgroundColor: isDragActive ? '#f9fafb' : 'transparent'
          }}
        >
          <input {...getInputProps()} />
          {isDragActive ? (
            <p className="text-gray-600 text-sm">Drop the text file here...</p>
          ) : (
            <div>
              <svg xmlns="http://www.w3.org/2000/svg" className="mx-auto h-10 w-10 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
              </svg>
              <p className="mt-2 text-sm text-gray-600">
                Drag & drop a text file here, or <span className="text-gray-700 font-medium">click to select</span>
              </p>
              <p className="mt-1 text-xs text-gray-500">
                Text files (.txt, .csv, .json, .py, .js, .md, .gc, etc.)
              </p>
            </div>
          )}
        </div>

        <div className="flex justify-end mt-3">
          <button
            onClick={() => setShowUploadModal(false)}
            className="px-3 py-1.5 text-xs font-medium text-gray-700 bg-gray-100 rounded-none hover:bg-gray-200 transition-colors"
            style={{
              padding: '0.375rem 0.75rem',
              fontSize: '0.75rem',
              fontWeight: '500',
              color: '#374151',
              backgroundColor: '#f3f4f6',
              borderRadius: '0',
              transition: 'background-color 0.2s'
            }}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );

  // Render the modal content as a portal to the document body
  return createPortal(
    modalContent,
    document.body
  );
};