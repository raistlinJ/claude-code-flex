import React, { useState, useEffect } from 'react';
import { Folder, File, ChevronLeft, X, Check } from 'lucide-react';

const FileBrowser = ({ isOpen, onClose, onSelect, initialPath }) => {
  const [currentPath, setCurrentPath] = useState(initialPath || '');
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [selectedPath, setSelectedPath] = useState('');
  const [parentPath, setParentPath] = useState('');
  const [folderName, setFolderName] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (isOpen) {
      fetchDirectory(initialPath || '');
      setFolderName('');
      setError('');
      setIsCreating(false);
    }
  }, [isOpen, initialPath]);

  const fetchDirectory = async (path) => {
    console.log('[FileBrowser] Fetching path:', path);
    setLoading(true);
    try {
      const response = await fetch(`/v1/fs/ls?path=${encodeURIComponent(path)}`);
      if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
      const data = await response.json();
      console.log('[FileBrowser] Data received:', data);
      if (data.items) {
        setItems(data.items);
        setCurrentPath(data.currentPath);
        setParentPath(data.parentPath);
        setSelectedPath(data.currentPath);
        setError('');
      } else if (data.error) {
        console.error('[FileBrowser] Server error:', data.error);
        setError(data.error);
      }
    } catch (err) {
      console.error('[FileBrowser] Error fetching directory:', err);
      setError(err.message || 'Failed to fetch directory');
    } finally {
      setLoading(false);
    }
  };

  const handleItemClick = (item) => {
    console.log('[FileBrowser] Item clicked:', item);
    if (item.isDirectory) {
      fetchDirectory(item.path);
    } else {
      setSelectedPath(item.path);
    }
  };

  const handleBack = () => {
    if (parentPath && parentPath !== currentPath) {
      fetchDirectory(parentPath);
    }
  };

  const handleCreateFolder = async () => {
    const trimmedName = folderName.trim();
    if (!trimmedName) {
      setError('Enter a folder name.');
      return;
    }

    setIsCreating(true);
    setError('');

    try {
      const response = await fetch('/v1/fs/mkdir', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          parentPath: selectedPath || currentPath,
          folderName: trimmedName
        })
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Failed to create folder');
      }

      onSelect(data.path);
    } catch (err) {
      setError(err.message || 'Failed to create folder');
    } finally {
      setIsCreating(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <Folder size={18} color="var(--accent-color)" />
            <span style={{ fontWeight: 600 }}>Select Working Directory</span>
          </div>
          <button className="btn btn-secondary" style={{ padding: 4 }} onClick={onClose}>
            <X size={18} />
          </button>
        </div>

        <div style={{ padding: '8px 16px', background: 'rgba(0,0,0,0.2)', fontSize: '0.75rem', color: 'var(--text-secondary)', wordBreak: 'break-all' }}>
          {currentPath}
        </div>

        <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border-color)', display: 'flex', flexDirection: 'column', gap: 8 }}>
          <label style={{ marginBottom: 0 }}>Create Folder In Current Location</label>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              type="text"
              placeholder="new-folder"
              value={folderName}
              onChange={(e) => setFolderName(e.target.value)}
              style={{ flex: 1 }}
            />
            <button
              className="btn btn-secondary"
              onClick={handleCreateFolder}
              disabled={!selectedPath || !folderName.trim() || isCreating}
            >
              {isCreating ? 'Creating...' : 'Create Folder'}
            </button>
          </div>
          <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
            Creates the folder in the currently selected location and auto-selects it.
          </p>
        </div>

        <div className="modal-body">
          {loading ? (
            <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-secondary)' }}>Loading...</div>
          ) : (
            <div className="file-list">
              {currentPath !== '/' && (
                <div className="file-item" onClick={handleBack}>
                  <div className="file-icon"><ChevronLeft size={16} /></div>
                  <span>..</span>
                </div>
              )}
              {items.map((item, idx) => (
                <div 
                  key={idx} 
                  className={`file-item ${selectedPath === item.path ? 'selected' : ''}`}
                  onClick={() => handleItemClick(item)}
                >
                  <div className="file-icon">
                    {item.isDirectory ? <Folder size={16} /> : <File size={16} />}
                  </div>
                  <span style={{ flex: 1 }}>{item.name}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {error && (
          <div style={{ padding: '8px 16px', color: 'var(--danger-color)', fontSize: '0.8rem' }}>
            {error}
          </div>
        )}

        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button 
            className="btn btn-primary" 
            onClick={() => onSelect(selectedPath)}
            disabled={!selectedPath}
          >
            <Check size={16} style={{ marginRight: 8 }} />
            Select Folder
          </button>
        </div>
      </div>
    </div>
  );
};

export default FileBrowser;
