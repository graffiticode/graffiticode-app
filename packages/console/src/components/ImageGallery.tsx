import React, { useState, useEffect, useCallback, useRef } from 'react';
import { getStorage } from 'firebase/storage';
import { useFirebaseApp } from 'reactfire';
import useGraffiticodeAuth, { useToken } from '@graffiticode/auth-react';
import { listUserImages, validateImageFile, uploadImageDeduped, archiveUserImage, fetchArchivedImages } from '../lib/image-upload';
import type { ImageInfo } from '../lib/image-upload';

function fileNameWithoutExt(name: string): string {
  // Strip UUID prefix (uuid_name.ext -> name)
  const withoutUuid = name.replace(/^[a-f0-9-]+_/, '');
  return withoutUuid.replace(/\.[^.]+$/, '');
}

export function ImageGallery() {
  const firebaseApp = useFirebaseApp();
  const { user } = useGraffiticodeAuth();
  const { data: token } = useToken();
  const [images, setImages] = useState<ImageInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  // Listen for external reload requests (e.g. image uploaded from HelpPanel)
  useEffect(() => {
    const handler = () => setReloadKey(k => k + 1);
    window.addEventListener('gc:assets-reload', handler);
    return () => window.removeEventListener('gc:assets-reload', handler);
  }, []);
  const [selectedUrls, setSelectedUrls] = useState<Set<string>>(new Set());
  const [dragging, setDragging] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const dragImageRef = useRef<string | null>(null);
  const dragOverImageRef = useRef<string | null>(null);
  const [dragOverUrl, setDragOverUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!user?.uid || !token) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        setLoading(true);
        setError(null);
        const storage = getStorage(firebaseApp);
        const archivedNames = await fetchArchivedImages(token);
        console.log('[ImageGallery] archived names:', archivedNames.length, archivedNames);
        if (cancelled) return;
        let result = await listUserImages(storage, user.uid, { archivedNames });
        console.log('[ImageGallery] images after filter:', result.length, result.map(i => i.name));
        if (cancelled) return;
        // Apply saved order from localStorage
        const orderKey = `graffiticode:imageOrder:${user.uid}`;
        const savedOrder = localStorage.getItem(orderKey);
        if (savedOrder) {
          try {
            const orderUrls: string[] = JSON.parse(savedOrder);
            const orderMap = new Map(orderUrls.map((url, idx) => [url, idx]));
            result = [...result].sort((a, b) => {
              const aIdx = orderMap.has(a.downloadURL) ? orderMap.get(a.downloadURL)! : Infinity;
              const bIdx = orderMap.has(b.downloadURL) ? orderMap.get(b.downloadURL)! : Infinity;
              return aIdx - bIdx;
            });
          } catch {}
        }
        setImages(result);
      } catch (err) {
        if (!cancelled) {
          setError('Failed to load images');
          console.error(err);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [firebaseApp, user?.uid, token, reloadKey]);

  const handleClick = (img: ImageInfo, e: React.MouseEvent) => {
    const url = img.downloadURL;
    setSelectedUrls(prev => {
      const next = new Set(prev);
      if (e.metaKey || e.ctrlKey) {
        // Toggle individual item
        if (next.has(url)) {
          next.delete(url);
        } else {
          next.add(url);
        }
      } else {
        // Single select: toggle if already the only selection, otherwise select just this
        if (next.size === 1 && next.has(url)) {
          next.clear();
        } else {
          next.clear();
          next.add(url);
        }
      }
      return next;
    });
  };

  const buildMarkdown = (urls: Set<string>) => {
    return images
      .filter(img => urls.has(img.downloadURL))
      .map(img => `![${fileNameWithoutExt(img.name)}](${img.downloadURL})`)
      .join('\n');
  };

  const handleArchive = useCallback(async (img: ImageInfo, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!token) return;
    try {
      await archiveUserImage(token, img.name);
      setImages(prev => prev.filter(i => i.downloadURL !== img.downloadURL));
      setSelectedUrls(prev => {
        const next = new Set(prev);
        next.delete(img.downloadURL);
        return next;
      });
    } catch (err) {
      console.error('Failed to archive image:', err);
    }
  }, [token]);

  const handleFiles = useCallback(async (files: FileList) => {
    if (!user?.uid || files.length === 0) return;
    const file = files[0];
    const validationError = validateImageFile(file);
    if (validationError) {
      setUploadError(validationError);
      return;
    }
    setUploadError(null);
    setUploadProgress(0);
    const storage = getStorage(firebaseApp);
    try {
      // Fetch archived images so we can unarchive on re-upload
      let archivedImages: ImageInfo[] = [];
      if (token) {
        const archivedNames = await fetchArchivedImages(token);
        if (archivedNames.length > 0) {
          archivedImages = await listUserImages(storage, user.uid, { includeArchived: true, archivedNames });
          archivedImages = archivedImages.filter(img => img.archived);
        }
      }
      const result = await uploadImageDeduped(storage, user.uid, file, images, (percent) => {
        setUploadProgress(percent);
      }, { token, archivedImages });
      setUploadProgress(null);
      if (result.skipped) {
        setUploadError('Image already exists');
        setTimeout(() => setUploadError(null), 2000);
      } else {
        setReloadKey(k => k + 1);
      }
    } catch (err) {
      setUploadError('Upload failed');
      setUploadProgress(null);
      console.error(err);
    }
  }, [firebaseApp, user?.uid, token, images]);

  const onDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(true);
  };
  const onDragLeave = () => setDragging(false);
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    handleFiles(e.dataTransfer.files);
  };

  if (!user?.uid) {
    return <div className="p-4 text-sm text-gray-500">Sign in to view images.</div>;
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center p-8">
        <svg className="animate-spin h-5 w-5 text-gray-400" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
      </div>
    );
  }

  return (
    <div
      className={`p-3 min-h-[200px] ${dragging ? 'bg-blue-50 border-2 border-dashed border-blue-300' : ''}`}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {error && <div className="text-sm text-red-500 mb-2">{error}</div>}
      {uploadError && <div className="text-sm text-red-500 mb-2">{uploadError}</div>}
      {uploadProgress !== null && (
        <div className="mb-3">
          <div className="h-1.5 bg-gray-200 rounded">
            <div className="h-1.5 bg-blue-500 rounded" style={{ width: `${uploadProgress}%` }} />
          </div>
        </div>
      )}
      {images.length === 0 ? (
        <div className="text-sm text-gray-400 text-center py-8">
          No assets yet. Drag images here to upload.
        </div>
      ) : (
        <div className="flex flex-wrap gap-3">
          {images.map((img) => {
            const isSelected = selectedUrls.has(img.downloadURL);
            // When dragging, use all selected if this image is selected, otherwise just this image
            const dragUrls = isSelected && selectedUrls.size > 0 ? selectedUrls : new Set([img.downloadURL]);
            const isDragOver = dragOverUrl === img.downloadURL && dragImageRef.current !== img.downloadURL;
            return (
              <button
                key={img.downloadURL}
                onClick={(e) => handleClick(img, e)}
                draggable
                onDragStart={(e) => {
                  dragImageRef.current = img.downloadURL;
                  const markdown = buildMarkdown(dragUrls);
                  e.dataTransfer.setData('text/plain', markdown);
                  e.dataTransfer.setData('application/x-gc-image-reorder', img.downloadURL);
                  e.dataTransfer.setData('application/x-gc-image', 'true');
                  e.dataTransfer.effectAllowed = 'copyMove';
                }}
                onDragOver={(e) => {
                  if (dragImageRef.current) {
                    e.preventDefault();
                    e.dataTransfer.dropEffect = 'move';
                    if (dragOverImageRef.current !== img.downloadURL) {
                      dragOverImageRef.current = img.downloadURL;
                      setDragOverUrl(img.downloadURL);
                    }
                  }
                }}
                onDrop={(e) => {
                  if (dragImageRef.current && dragImageRef.current !== img.downloadURL) {
                    e.preventDefault();
                    e.stopPropagation();
                    const fromIdx = images.findIndex(i => i.downloadURL === dragImageRef.current);
                    const toIdx = images.findIndex(i => i.downloadURL === img.downloadURL);
                    if (fromIdx !== -1 && toIdx !== -1) {
                      const reordered = [...images];
                      const [moved] = reordered.splice(fromIdx, 1);
                      reordered.splice(toIdx, 0, moved);
                      setImages(reordered);
                      const orderKey = `graffiticode:imageOrder:${user.uid}`;
                      localStorage.setItem(orderKey, JSON.stringify(reordered.map(i => i.downloadURL)));
                    }
                  }
                  dragImageRef.current = null;
                  dragOverImageRef.current = null;
                  setDragOverUrl(null);
                }}
                onDragEnd={() => {
                  dragImageRef.current = null;
                  dragOverImageRef.current = null;
                  setDragOverUrl(null);
                }}
                className={`group relative flex flex-col items-center p-2 rounded cursor-pointer border ${
                  isDragOver
                    ? 'border-blue-400 bg-blue-50'
                    : isSelected
                      ? 'border-blue-500 bg-blue-50'
                      : 'border-transparent hover:border-gray-200 hover:bg-gray-50'
                }`}
              >
                <span
                  onClick={(e) => handleArchive(img, e)}
                  className="absolute top-1 right-1 hidden group-hover:flex items-center justify-center w-5 h-5 rounded-full bg-gray-200 hover:bg-red-500 hover:text-white text-gray-500 text-xs cursor-pointer z-10"
                  title="Archive image"
                >
                  ✕
                </span>
                <img
                  src={img.downloadURL}
                  alt={fileNameWithoutExt(img.name)}
                  className="w-[100px] h-[100px] object-contain"
                />
                <span className="text-xs text-gray-500 mt-1 truncate w-full text-center">
                  {fileNameWithoutExt(img.name)}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
