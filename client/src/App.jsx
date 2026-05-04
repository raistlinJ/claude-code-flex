import React, { useState, useEffect, useRef } from 'react';
import io from 'socket.io-client';
import { Settings, Play, Square, Terminal as TerminalIcon, Shield, Server, Cpu } from 'lucide-react';
import Terminal from './components/Terminal';
import FileBrowser from './components/FileBrowser';

const App = () => {
  const [socket, setSocket] = useState(null);
  const [isConnected, setIsConnected] = useState(false);
  const [isSessionActive, setIsSessionActive] = useState(false);
  const [sessionResetKey, setSessionResetKey] = useState(0);
  const [isBrowserOpen, setIsBrowserOpen] = useState(false);
  const [isMobileBrowser, setIsMobileBrowser] = useState(false);
  const [mobileActiveTab, setMobileActiveTab] = useState(() => {
    const saved = localStorage.getItem('claude_mobileActiveTab');
    return saved === 'config' || saved === 'terminal' ? saved : 'terminal';
  });
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(localStorage.getItem('claude_sidebarCollapsed') === 'true');
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const saved = Number(localStorage.getItem('claude_sidebarWidth'));
    return Number.isFinite(saved) && saved >= 260 && saved <= 620 ? saved : 320;
  });
  const [isResizingSidebar, setIsResizingSidebar] = useState(false);
  const [terminalSize, setTerminalSize] = useState({ cols: 80, rows: 24 });
  const [terminalHistory, setTerminalHistory] = useState('');
  const sidebarWidthRef = useRef(sidebarWidth);
  const [config, setConfig] = useState({
    apiKey: localStorage.getItem('claude_apiKey') || '',
    claudePath: localStorage.getItem('claude_claudePath') || '',
    baseUrl: localStorage.getItem('claude_baseUrl') || '',
    model: localStorage.getItem('claude_model') || '',
    provider: localStorage.getItem('claude_provider') || 'anthropic',
    cwd: localStorage.getItem('claude_cwd') || '',
    autoStart: true,
    allowBypassPermissions: localStorage.getItem('claude_allowBypassPermissions') === 'true'
  });

  const [models, setModels] = useState([]);
  const [isFetchingModels, setIsFetchingModels] = useState(false);

  useEffect(() => {
    const newSocket = io({
      path: '/socket.io'
    });
    setSocket(newSocket);

    newSocket.on('connect', () => {
      setIsConnected(true);
      fetchModels(); // Auto-fetch on connect
      newSocket.emit('terminal-sync-request');
    });

    newSocket.on('config-loaded', (serverConfig) => {
      console.log('Server config received:', serverConfig);
      if (serverConfig && Object.keys(serverConfig).length > 0) {
        setConfig(prev => ({
          ...prev,
          ...serverConfig
        }));
      }
    });

    newSocket.on('disconnect', () => {
      setIsConnected(false);
      setIsSessionActive(false);
    });

    newSocket.on('session-state', (state) => {
      setIsSessionActive(!!state?.active);
    });

    newSocket.on('terminal-history', (history) => {
      setTerminalHistory(history || '');
    });

    newSocket.on('session-closed', () => {
      setIsSessionActive(false);
    });

    return () => newSocket.close();
  }, []);

  useEffect(() => {
    const ua = navigator.userAgent || '';
    const mobileUA = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(ua);
    const coarsePointer = window.matchMedia('(pointer: coarse)').matches;
    setIsMobileBrowser(mobileUA || coarsePointer);
  }, []);

  useEffect(() => {
    sidebarWidthRef.current = sidebarWidth;
    localStorage.setItem('claude_sidebarWidth', String(Math.round(sidebarWidth)));
  }, [sidebarWidth]);

  useEffect(() => {
    localStorage.setItem('claude_sidebarCollapsed', isSidebarCollapsed ? 'true' : 'false');
  }, [isSidebarCollapsed]);

  useEffect(() => {
    localStorage.setItem('claude_mobileActiveTab', mobileActiveTab);
  }, [mobileActiveTab]);

  useEffect(() => {
    if (!isResizingSidebar) return;

    const onMouseMove = (event) => {
      const maxWidth = Math.min(620, window.innerWidth - 320);
      const nextWidth = Math.max(260, Math.min(maxWidth, event.clientX));
      if (Number.isFinite(nextWidth)) {
        setSidebarWidth(nextWidth);
      }
    };

    const onMouseUp = () => {
      setIsResizingSidebar(false);
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);

    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, [isResizingSidebar]);

  const fetchModels = async () => {
    if (isSessionActive) return;
    setIsFetchingModels(true);
    try {
      const response = await fetch('/v1/models');
      const data = await response.json();
      if (data.models) {
        setModels(data.models);
        // If current model is not in the list, select the first one
        if (!config.model || !data.models.find(m => m.id === config.model)) {
          saveConfig('model', data.models[0].id);
        }
      }
    } catch (err) {
      console.error('Error fetching models:', err);
    } finally {
      setIsFetchingModels(false);
    }
  };

  const saveConfig = (key, value) => {
    if (isSessionActive) return;
    const newConfig = { ...config, [key]: value };
    
    // Auto-fill defaults for providers
    if (key === 'provider') {
      setModels([]);
      if (value === 'ollama') {
        newConfig.baseUrl = 'http://localhost:11434/v1';
        // Don't auto-set model here, let them fetch
        newConfig.model = ''; 
      } else if (value === 'anthropic') {
        newConfig.baseUrl = '';
      }
    }

    // Save to local state
    setConfig(newConfig);

    // Save to localStorage
    Object.keys(newConfig).forEach(k => {
      if (k !== 'autoStart') localStorage.setItem(`claude_${k}`, newConfig[k]);
    });

    // Save to server
    if (socket) {
      console.log('Sending config update to server:', newConfig);
      socket.emit('update-config', newConfig);
    }
  };

  const launchNativeTerminal = async () => {
    try {
      await fetch('/v1/terminal/launch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config)
      });
    } catch (err) {
      console.error('Error launching native terminal:', err);
    }
  };

  const startSession = () => {
    if (socket) {
      setSessionResetKey(prev => prev + 1);
      setTerminalHistory('');
      socket.emit('start-session', config);
      setIsSessionActive(true);
      setMobileActiveTab('terminal');
    }
  };

  const stopSession = () => {
    if (socket) {
      socket.emit('stop-session');
      setIsSessionActive(false);
    }
  };

  const getLabels = () => {
    switch (config.provider) {
      case 'ollama':
        return {
          apiLabel: 'Ollama Auth (Optional)',
          urlLabel: 'Ollama Host',
          modelLabel: 'Model Name',
          urlPlaceholder: 'http://localhost:11434/v1'
        };
      case 'openai-compatible':
        return {
          apiLabel: 'OpenAI API Key',
          urlLabel: 'API Base URL',
          modelLabel: 'Model Name',
          urlPlaceholder: 'https://api.openai.com/v1'
        };
      default:
        return {
          apiLabel: 'Anthropic API Key',
          urlLabel: 'Base URL (Optional)',
          modelLabel: 'Model Override',
          urlPlaceholder: 'http://localhost:11434/v1'
        };
    }
  };

  const labels = getLabels();
  const isConfigLocked = isSessionActive;
  const sidebarStyle = isSidebarCollapsed
    ? { width: 0 }
    : { width: `${sidebarWidth}px` };
  const showConfigPane = !isMobileBrowser || mobileActiveTab === 'config';
  const showTerminalPane = !isMobileBrowser || mobileActiveTab === 'terminal';

  return (
    <div id="root" className={`app-root ${isMobileBrowser ? 'mobile-tabbed' : ''}`}>
      {isMobileBrowser && (
        <div className="mobile-tabs" role="tablist" aria-label="Mobile panels">
          <button
            className={`mobile-tab-btn ${mobileActiveTab === 'config' ? 'active' : ''}`}
            onClick={() => setMobileActiveTab('config')}
            role="tab"
            aria-selected={mobileActiveTab === 'config'}
          >
            Config
          </button>
          <button
            className={`mobile-tab-btn ${mobileActiveTab === 'terminal' ? 'active' : ''}`}
            onClick={() => setMobileActiveTab('terminal')}
            role="tab"
            aria-selected={mobileActiveTab === 'terminal'}
          >
            Terminal
          </button>
        </div>
      )}

      <div
        className={`sidebar-shell ${isSidebarCollapsed ? 'collapsed' : ''} ${showConfigPane ? '' : 'mobile-pane-hidden'}`}
        style={sidebarStyle}
      >
      <div className="sidebar">
        <div style={{ marginBottom: '32px' }}>
          <h1>Claude WebUI</h1>
          <p className="subtitle">Run Claude Code anywhere</p>
          {isConfigLocked && (
            <p style={{ fontSize: '0.75rem', color: 'var(--danger-color)', marginTop: 8 }}>
              Configuration is locked while the web terminal session is running.
            </p>
          )}
        </div>

        <div className="form-group">
          <label><Cpu size={14} style={{ marginRight: 6, verticalAlign: 'middle' }} /> LLM Provider</label>
          <select 
            value={config.provider}
            onChange={(e) => saveConfig('provider', e.target.value)}
            disabled={isConfigLocked}
          >
            <option value="anthropic">Anthropic Claude</option>
            <option value="ollama">Ollama</option>
            <option value="openai-compatible">OpenAI Compatible</option>
          </select>
          <p style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', marginTop: 4 }}>
            {config.provider === 'anthropic'
              ? 'Anthropic mode requires Claude login or an API key.'
              : 'Bridge mode can run without Claude login when provider API key is optional.'}
          </p>
        </div>

        <div className="form-group" style={{ display: config.provider === 'ollama' && !config.apiKey ? 'none' : 'block' }}>
          <label><Shield size={14} style={{ marginRight: 6, verticalAlign: 'middle' }} /> {labels.apiLabel}</label>
          <input 
            type="password" 
            placeholder="sk-..." 
            value={config.apiKey}
            onChange={(e) => saveConfig('apiKey', e.target.value)}
            disabled={isConfigLocked}
          />
        </div>

        <div className="form-group">
          <label><TerminalIcon size={14} style={{ marginRight: 6, verticalAlign: 'middle' }} /> Claude Executable Path (Optional)</label>
          <input
            type="text"
            placeholder="claude"
            value={config.claudePath}
            onChange={(e) => saveConfig('claudePath', e.target.value)}
            disabled={isConfigLocked}
          />
          <p style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', marginTop: 4 }}>
            Leave blank to use PATH default. Set a full path if Claude is installed in a custom location.
          </p>
        </div>

        <div className="form-group">
          <label><Server size={14} style={{ marginRight: 6, verticalAlign: 'middle' }} /> {labels.urlLabel}</label>
          <input 
            type="text" 
            placeholder={labels.urlPlaceholder}
            value={config.baseUrl}
            onChange={(e) => saveConfig('baseUrl', e.target.value)}
            disabled={isConfigLocked}
          />
          {config.provider === 'ollama' && (
            <p style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', marginTop: 4 }}>
              Ensure Ollama is running with OLLAMA_ORIGINS="*"
            </p>
          )}
        </div>

        <div className="form-group">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <label style={{ marginBottom: 0 }}><Cpu size={14} style={{ marginRight: 6, verticalAlign: 'middle' }} /> {labels.modelLabel}</label>
            <button 
              className="btn btn-secondary" 
              style={{ padding: '2px 8px', fontSize: '0.7rem' }}
              onClick={fetchModels}
              disabled={isFetchingModels || isConfigLocked}
            >
              {isFetchingModels ? 'Fetching...' : 'Fetch Models'}
            </button>
          </div>
          
          <select 
            value={config.model}
            onChange={(e) => saveConfig('model', e.target.value)}
            disabled={models.length === 0 || isFetchingModels || isConfigLocked}
          >
            {models.length === 0 ? (
              <option value="">Fetch models to begin...</option>
            ) : (
              models.map(m => (
                <option key={m.id} value={m.id}>{m.name}</option>
              ))
            )}
          </select>
        </div>

        <div className="form-group">
          <label><Settings size={14} style={{ marginRight: 6, verticalAlign: 'middle' }} /> Working Directory</label>
          <div style={{ display: 'flex', gap: 8 }}>
            <input 
              type="text" 
              placeholder="Select a folder..." 
              value={config.cwd}
              readOnly
              style={{ flex: 1, cursor: 'default' }}
            />
            <button 
              className="btn btn-secondary" 
              style={{ padding: '4px 12px' }}
              onClick={() => setIsBrowserOpen(true)}
              disabled={isConfigLocked}
            >
              Browse
            </button>
          </div>
        </div>

        <div className="form-group">
          <div className="toggle-row">
            <span className="toggle-label">Allow Bypass Permissions</span>
            <label className="switch" aria-label="Allow Bypass Permissions">
              <input
                type="checkbox"
                checked={!!config.allowBypassPermissions}
                onChange={(e) => saveConfig('allowBypassPermissions', e.target.checked)}
                disabled={isConfigLocked}
              />
              <span className="slider" />
            </label>
          </div>
          <p style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', marginTop: 4 }}>
            Disabled by default. Enable only for trusted local workflows.
          </p>
        </div>

        <FileBrowser 
          isOpen={isBrowserOpen && !isConfigLocked}
          onClose={() => setIsBrowserOpen(false)}
          initialPath={config.cwd}
          onSelect={(path) => {
            if (isConfigLocked) return;
            saveConfig('cwd', path);
            setIsBrowserOpen(false);
          }}
        />

        <div className="sidebar-actions" style={{ marginTop: 'auto', display: 'flex', flexDirection: 'column', gap: 12 }}>
          {!isMobileBrowser && (
            <button 
              className="btn btn-primary" 
              onClick={launchNativeTerminal}
              disabled={!config.model || !config.cwd}
              style={{ background: 'linear-gradient(135deg, #4facfe 0%, #00f2fe 100%)', color: '#000', fontWeight: 700 }}
            >
              <TerminalIcon size={16} style={{ marginRight: 8 }} />
              Launch in Native Terminal
            </button>
          )}

          <button 
            className="btn btn-secondary" 
            onClick={startSession}
            disabled={isSessionActive || !isConnected || !config.model || !config.cwd}
          >
            <Play size={16} style={{ marginRight: 8 }} />
            {!config.model ? 'Select a Model' : !config.cwd ? 'Enter Directory' : 'Start Web Terminal'}
          </button>

          {isSessionActive && (
            <button className="btn btn-secondary" onClick={stopSession} style={{ borderColor: 'var(--danger-color)', color: 'var(--danger-color)' }}>
              <Square size={16} style={{ marginRight: 8 }} /> Stop Session
            </button>
          )}
          
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 12 }}>
            <span className={`status-badge ${isConnected ? 'status-online' : 'status-offline'}`}>
              <span className="dot"></span> {isConnected ? 'Server Online' : 'Server Offline'}
            </span>
            <a href="https://github.com/anthropic-ai/claude-code" target="_blank" rel="noreferrer" style={{ color: 'var(--text-secondary)' }}>
              Source
            </a>
          </div>
        </div>
      </div>

      <button
        className={`sidebar-toggle ${isSidebarCollapsed ? 'collapsed' : ''}`}
        onClick={() => {
          if (isSidebarCollapsed) {
            setSidebarWidth(Math.max(260, sidebarWidthRef.current || 320));
          }
          setIsSidebarCollapsed((prev) => !prev);
        }}
        aria-label={isSidebarCollapsed ? 'Show settings panel' : 'Hide settings panel'}
      >
        {isSidebarCollapsed ? '>' : '<'}
      </button>

      {!isSidebarCollapsed && (
        <div
          className={`sidebar-resizer ${isResizingSidebar ? 'active' : ''}`}
          onMouseDown={() => setIsResizingSidebar(true)}
          aria-hidden="true"
        />
      )}
      </div>

      <div className={`main-content ${showTerminalPane ? '' : 'mobile-pane-hidden'}`}>
        <header className="header">
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <TerminalIcon size={20} color="var(--accent-color)" />
            <span style={{ fontWeight: 600 }}>Terminal Session</span>
          </div>
          <div className="status-badge" style={{ background: 'rgba(255,255,255,0.05)' }}>
            {isSessionActive ? 'Running: claude-code' : 'Idle'}
          </div>
        </header>

        <div className={`terminal-container fade-in ${isSessionActive ? '' : 'inactive'}`}>
          <div className="terminal-header">
            <span>{`bash - ${terminalSize.cols}x${terminalSize.rows}`}</span>
            <span>UTF-8</span>
          </div>
          <Terminal 
            socket={socket}
            isConnected={isConnected}
            isSessionActive={isSessionActive}
            resetKey={sessionResetKey}
            onSizeChange={setTerminalSize}
            history={terminalHistory}
          />
        </div>
      </div>
    </div>
  );
};

export default App;
