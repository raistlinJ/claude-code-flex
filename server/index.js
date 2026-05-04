import express from 'express';
import https from 'https';
import { Server } from 'socket.io';
import os from 'os';
import pty from 'node-pty';
import cors from 'cors';
import { spawn, exec } from 'child_process';
import fs from 'fs';
import { promises as fsPromises } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CONFIG_PATH = path.join(__dirname, 'config.json');
const PORT = process.env.PORT || 3001;
const NODE_PTY_HELPER_PATH = path.join(__dirname, 'node_modules', 'node-pty', 'prebuilds', `darwin-${process.arch}`, 'spawn-helper');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

const options = {
  key: fs.readFileSync(path.join(__dirname, 'key.pem')),
  cert: fs.readFileSync(path.join(__dirname, 'cert.pem'))
};

const httpServer = https.createServer(options, app);
const io = new Server(httpServer, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

const shell = os.platform() === 'win32' ? 'powershell.exe' : 'zsh';

const nodePtyStatus = {
  available: true,
  reason: 'not-tested'
};

let activePtyProcess = null;
let activeSessionConfig = null;
let terminalHistory = '';
const MAX_TERMINAL_HISTORY = 200000;

const isValidPid = (pid) => Number.isInteger(pid) && pid > 1;

const killPidTree = (pid, signal = 'SIGTERM') => {
  if (!isValidPid(pid)) return;

  try {
    process.kill(-pid, signal);
  } catch (_) {
    // Ignore when no process group exists.
  }

  try {
    process.kill(pid, signal);
  } catch (_) {
    // Ignore if already exited.
  }

  exec(`pkill -${signal === 'SIGKILL' ? 'KILL' : 'TERM'} -P ${pid}`, () => {});
};

const terminateActiveSessionProcess = (reason = 'manual-stop') => {
  if (!activePtyProcess) return false;

  const proc = activePtyProcess;
  const pid = Number(proc.pid);

  try {
    proc.write('\x03');
    proc.write('exit\r');
  } catch (_) {
    // Some fallback adapters may not support write during shutdown.
  }

  setTimeout(() => {
    try {
      proc.kill();
    } catch (_) {
      // Ignore if already closed.
    }
  }, 100);

  setTimeout(() => killPidTree(pid, 'SIGTERM'), 150);
  setTimeout(() => killPidTree(pid, 'SIGKILL'), 900);

  setTimeout(() => {
    if (activePtyProcess === proc) {
      clearActiveSession(0, reason);
    }
  }, 1200);

  return true;
};

const appendTerminalHistory = (data) => {
  terminalHistory += data;
  if (terminalHistory.length > MAX_TERMINAL_HISTORY) {
    terminalHistory = terminalHistory.slice(-MAX_TERMINAL_HISTORY);
  }
};

const broadcastTerminalData = (data) => {
  appendTerminalHistory(data);
  io.emit('terminal-data', data);
};

const emitSessionState = (socket) => {
  socket.emit('session-state', {
    active: !!activePtyProcess,
    config: activeSessionConfig
  });
};

const clearActiveSession = (exitCode = 0, signal = 'session-closed') => {
  activePtyProcess = null;
  activeSessionConfig = null;
  io.emit('session-closed', { exitCode, signal });
  io.emit('session-state', { active: false, config: null });
};

const detectNodePtyAvailability = () => {
  try {
    const test = pty.spawn('/bin/zsh', [], {
      name: 'xterm-color',
      cols: 80,
      rows: 24,
      cwd: process.cwd(),
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        TERM: 'xterm-256color'
      }
    });
    test.kill();
    nodePtyStatus.available = true;
    nodePtyStatus.reason = 'ok';
  } catch (err) {
    nodePtyStatus.available = false;
    nodePtyStatus.reason = err?.message || 'unknown-error';
  }
};

const ensureNodePtyHelperPermissions = () => {
  try {
    if (process.platform !== 'darwin') return;
    if (!fs.existsSync(NODE_PTY_HELPER_PATH)) return;
    fs.chmodSync(NODE_PTY_HELPER_PATH, 0o755);
  } catch (err) {
    console.warn(`[PTY] Failed to chmod spawn-helper: ${err?.message || err}`);
  }
};

const buildClaudeSessionEnv = (config) => {
  const provider = config.provider || 'anthropic';
  const baseUrl = config.baseUrl || '';
  const sessionEnv = {
    ...process.env,
    ANTHROPIC_BASE_URL: (provider === 'ollama' || provider === 'openai-compatible')
      ? `https://localhost:${PORT}`
      : (baseUrl || 'https://api.anthropic.com'),
    CLAUDE_CODE_MODEL: config.model || '',
    NODE_TLS_REJECT_UNAUTHORIZED: '0'
  };

  // Auth behavior is provider-aware:
  // - anthropic: preserve normal Claude auth flow (OAuth/session or explicit key)
  // - ollama/openai-compatible: provide a placeholder key when none is set so Claude does not require /login
  const explicitApiKey = config.apiKey && String(config.apiKey).trim()
    ? String(config.apiKey).trim()
    : '';

  if (explicitApiKey) {
    sessionEnv.ANTHROPIC_API_KEY = explicitApiKey;
  } else if (provider !== 'anthropic') {
    sessionEnv.ANTHROPIC_API_KEY = 'local-provider-key';
  } else {
    delete sessionEnv.ANTHROPIC_API_KEY;
  }

  return sessionEnv;
};

const buildSessionBanner = (config, sessionEnv) => {
  const provider = config.provider || 'anthropic';
  const authMode = provider === 'anthropic'
    ? (sessionEnv.ANTHROPIC_API_KEY ? 'api-key' : 'claude-login')
    : (sessionEnv.ANTHROPIC_API_KEY ? 'bridge-key' : 'none');

  return [
    '[Session] Claude WebUI runtime',
    `[Session] provider=${provider}`,
    `[Session] model=${config.model || '(not set)'}`,
    `[Session] base_url=${sessionEnv.ANTHROPIC_BASE_URL}`,
    `[Session] auth_mode=${authMode}`,
    `[Session] api_key_set=${sessionEnv.ANTHROPIC_API_KEY ? 'yes' : 'no'}`,
    `[Session] bypass_permissions=${config.allowBypassPermissions ? 'on' : 'off'}`,
    `[Session] claude_exec=${getClaudeExecutable(config)}`,
    `[Session] pty_backend=${nodePtyStatus.available ? 'node-pty' : 'python-fallback'}`,
    ...(nodePtyStatus.available ? [] : [`[Session] pty_reason=${nodePtyStatus.reason}`]),
    ''
  ].join('\r\n');
};

const buildClaudeCliArgs = (config) => {
  const modelArg = config.model
    ? ` --model "${String(config.model).replace(/"/g, '\\"')}"`
    : '';
  const bypassArg = config.allowBypassPermissions
    ? ' --dangerously-skip-permissions'
    : '';
  return `${modelArg}${bypassArg}`;
};

const getClaudeExecutable = (config = {}) => {
  const fromConfig = config?.claudePath && String(config.claudePath).trim();
  if (fromConfig) return fromConfig;

  const fromEnv = process.env.CLAUDE_PATH && String(process.env.CLAUDE_PATH).trim();
  return fromEnv || 'claude';
};

const quoteForBash = (value) => `'${String(value).replace(/'/g, `'"'"'`)}'`;
const quoteForPowerShell = (value) => `'${String(value).replace(/'/g, "''")}'`;
const quoteForInteractiveShell = (value) => {
  const text = String(value);
  return /\s/.test(text) ? `"${text.replace(/"/g, '\\"')}"` : text;
};

const buildClaudeShellCommand = (config) => `${quoteForInteractiveShell(getClaudeExecutable(config))}${buildClaudeCliArgs(config)}`;

const loadConfig = () => {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    }
  } catch (err) {
    console.error('Error loading config:', err);
  }
  return {};
};

const saveConfig = (config) => {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  } catch (err) {
    console.error('Error saving config:', err);
  }
};

io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  // Send current config to client
  const initialConfig = loadConfig();
  if (!initialConfig.cwd) initialConfig.cwd = process.cwd();
  socket.emit('config-loaded', initialConfig);
  emitSessionState(socket);
  if (activePtyProcess && terminalHistory) {
    socket.emit('terminal-history', terminalHistory);
  }

  socket.on('update-config', (newConfig) => {
    saveConfig(newConfig);
  });

  socket.on('start-session', (config) => {
    if (activePtyProcess) {
      terminateActiveSessionProcess('restarted');
      clearActiveSession(0, 'restarted');
    }

    console.log(`[Session] Starting session for ${socket.id} (AutoStart: ${config.autoStart})`);
    // Keep bridge config in sync with the exact values used to start this session.
    saveConfig(config);
    activeSessionConfig = config;
    terminalHistory = '';
    const sessionEnv = buildClaudeSessionEnv(config);
    broadcastTerminalData(`\r\n${buildSessionBanner(config, sessionEnv)}\r\n`);
    io.emit('session-state', { active: true, config: activeSessionConfig });

    const spawnWithFallback = (shells, currentEnv) => {
      if (shells.length === 0) {
        console.log('[Session] All PTY attempts failed. Falling back to child_process.spawn');
        spawnChildProcessFallback(currentEnv);
        return;
      }
      
      const currentShell = shells[0];
      try {
        console.log(`[Session] Attempting PTY spawn: ${currentShell}`);
        activePtyProcess = pty.spawn(currentShell, [], {
          name: 'xterm-color',
          cols: 80,
          rows: 24,
          cwd: config.cwd || process.env.HOME || '/',
          env: currentEnv
        });

        console.log(`[Session] Success! PTY spawned (PID: ${activePtyProcess.pid})`);
        setupPtyHandlers(activePtyProcess);

      } catch (err) {
        console.warn(`[Session Warning] PTY spawn failed for ${currentShell}:`, err.message);
        spawnWithFallback(shells.slice(1), currentEnv);
      }
    };

    const setupPtyHandlers = (proc) => {
      if (config.autoStart) {
        setTimeout(() => {
          if (proc) proc.write(`${buildClaudeShellCommand(config)}\r`);
        }, 1200);
      }

      proc.onData((data) => broadcastTerminalData(data));
      proc.onExit(({ exitCode, signal }) => {
        if (activePtyProcess !== proc) return;
        clearActiveSession(exitCode, signal);
      });
    };

    const spawnChildProcessFallback = (currentEnv) => {
      broadcastTerminalData('\r\n[System] node-pty failed. Attempting Python PTY fallback...\r\n');
      
      // Use Python's built-in pty module to create a real PTY
      const cp = spawn('python3', ['-c', "import pty; pty.spawn(['/bin/zsh', '-i'])"], {
        env: currentEnv,
        cwd: config.cwd || process.env.HOME,
        stdio: ['pipe', 'pipe', 'pipe']
      });

      const fallbackProc = {
        write: (data) => cp.stdin.write(data),
        kill: () => cp.kill(),
        resize: () => {},
        pid: cp.pid
      };
      activePtyProcess = fallbackProc;

      cp.stdout.on('data', (data) => broadcastTerminalData(data.toString()));
      cp.stderr.on('data', (data) => broadcastTerminalData(data.toString()));
      
      cp.on('exit', (code) => {
        if (activePtyProcess !== fallbackProc) return;
        clearActiveSession(code, 'exit');
      });

      if (config.autoStart) {
        setTimeout(() => {
          console.log('[Fallback] Starting claude via Python PTY');
          cp.stdin.write(`${buildClaudeShellCommand(config)}\n`);
        }, 1500);
      }
    };

    if (!nodePtyStatus.available) {
      broadcastTerminalData(`\r\n[System] node-pty unavailable (${nodePtyStatus.reason}). Using Python PTY fallback.\r\n`);
      spawnChildProcessFallback(sessionEnv);
      return;
    }

    spawnWithFallback(['/bin/zsh', '/bin/bash', 'sh'], sessionEnv);
  });

  socket.on('terminal-input', (data) => {
    if (activePtyProcess) {
      activePtyProcess.write(data);
    }
  });

  socket.on('terminal-resize', (size) => {
    if (activePtyProcess) {
      activePtyProcess.resize(size.cols, size.rows);
    }
  });

  socket.on('terminal-sync-request', () => {
    emitSessionState(socket);
    if (activePtyProcess && terminalHistory) {
      socket.emit('terminal-history', terminalHistory);
    }
  });

  socket.on('stop-session', () => {
    if (terminateActiveSessionProcess('manual-stop')) return;
    socket.emit('session-state', { active: false, config: null });
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});

// Native Terminal Launcher (cross-platform)
app.post('/v1/terminal/launch', (req, res) => {
  const config = req.body;
  // Keep bridge config in sync with native-launch session settings.
  saveConfig(config);

  const sessionEnv = buildClaudeSessionEnv(config);
  const provider = config.provider || 'anthropic';
  const authMode = provider === 'anthropic'
    ? (sessionEnv.ANTHROPIC_API_KEY ? 'api-key' : 'claude-login')
    : (sessionEnv.ANTHROPIC_API_KEY ? 'bridge-key' : 'none');
  const envStr = [
    `ANTHROPIC_BASE_URL="${sessionEnv.ANTHROPIC_BASE_URL}"`,
    `CLAUDE_CODE_MODEL="${sessionEnv.CLAUDE_CODE_MODEL}"`,
    `NODE_TLS_REJECT_UNAUTHORIZED="${sessionEnv.NODE_TLS_REJECT_UNAUTHORIZED}"`
  ].join(' ');

  const apiKeyEnv = sessionEnv.ANTHROPIC_API_KEY
    ? `ANTHROPIC_API_KEY="${String(sessionEnv.ANTHROPIC_API_KEY).replace(/"/g, '\\"')}" `
    : '';

  const claudeExec = getClaudeExecutable(config);
  const banner = [
    '[Session] Claude WebUI runtime',
    `[Session] provider=${provider}`,
    `[Session] model=${config.model || '(not set)'}`,
    `[Session] base_url=${sessionEnv.ANTHROPIC_BASE_URL}`,
    `[Session] auth_mode=${authMode}`,
    `[Session] api_key_set=${sessionEnv.ANTHROPIC_API_KEY ? 'yes' : 'no'}`,
    `[Session] bypass_permissions=${config.allowBypassPermissions ? 'on' : 'off'}`,
    ''
  ];

  if (process.platform === 'darwin') {
    const command = `cd "${config.cwd}" && printf '%s\\n' "${banner.join('\\n').replace(/"/g, '\\"')}" && env ${apiKeyEnv}${envStr} ${quoteForBash(claudeExec)}${buildClaudeCliArgs(config)}`;
    const appleScript = `
      tell application "Terminal"
        do script "${command.replace(/"/g, '\\"')}"
        activate
      end tell
    `;

    exec(`osascript -e '${appleScript.replace(/'/g, "'\\''")}'`, (err) => {
      if (err) {
        console.error('[Terminal Launch Error]', err);
        return res.status(500).json({ error: err.message });
      }
      res.json({ success: true });
    });
    return;
  }

  if (process.platform === 'win32') {
    const psLines = [
      `$env:ANTHROPIC_BASE_URL=${quoteForPowerShell(sessionEnv.ANTHROPIC_BASE_URL)}`,
      `$env:CLAUDE_CODE_MODEL=${quoteForPowerShell(sessionEnv.CLAUDE_CODE_MODEL)}`,
      `$env:NODE_TLS_REJECT_UNAUTHORIZED=${quoteForPowerShell(sessionEnv.NODE_TLS_REJECT_UNAUTHORIZED)}`,
      ...(sessionEnv.ANTHROPIC_API_KEY ? [`$env:ANTHROPIC_API_KEY=${quoteForPowerShell(sessionEnv.ANTHROPIC_API_KEY)}`] : []),
      `Set-Location -Path ${quoteForPowerShell(config.cwd)}`,
      ...banner.filter(Boolean).map((line) => `Write-Host ${quoteForPowerShell(line)}`),
      `& ${quoteForPowerShell(claudeExec)}${buildClaudeCliArgs(config)}`
    ];

    const powershellArgs = ['-NoExit', '-ExecutionPolicy', 'Bypass', '-Command', psLines.join('; ')];
    const child = spawn('powershell.exe', powershellArgs, {
      detached: true,
      stdio: 'ignore',
      windowsHide: false
    });

    child.on('error', (err) => {
      console.error('[Terminal Launch Error]', err);
      if (!res.headersSent) {
        res.status(500).json({ error: err.message });
      }
    });

    child.unref();
    res.json({ success: true });
    return;
  }

  const envPairs = [
    `ANTHROPIC_BASE_URL=${quoteForBash(sessionEnv.ANTHROPIC_BASE_URL)}`,
    `CLAUDE_CODE_MODEL=${quoteForBash(sessionEnv.CLAUDE_CODE_MODEL)}`,
    `NODE_TLS_REJECT_UNAUTHORIZED=${quoteForBash(sessionEnv.NODE_TLS_REJECT_UNAUTHORIZED)}`,
    ...(sessionEnv.ANTHROPIC_API_KEY ? [`ANTHROPIC_API_KEY=${quoteForBash(sessionEnv.ANTHROPIC_API_KEY)}`] : [])
  ];
  const linuxBanner = banner.filter(Boolean).map((line) => `echo ${quoteForBash(line)}`).join('; ');
  const linuxCommand = `cd ${quoteForBash(config.cwd)}; ${linuxBanner}; export ${envPairs.join(' ')}; ${quoteForBash(claudeExec)}${buildClaudeCliArgs(config)}; exec bash`;
  const linuxChild = spawn('x-terminal-emulator', ['-e', 'bash', '-lc', linuxCommand], {
    detached: true,
    stdio: 'ignore'
  });

  linuxChild.on('error', (err) => {
    console.error('[Terminal Launch Error]', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'No supported terminal launcher found. Install x-terminal-emulator or use web terminal.' });
    }
  });

  linuxChild.unref();
  res.json({ success: true });
});
app.get('/v1/fs/ls', async (req, res) => {
  const targetPath = req.query.path || process.cwd();
  try {
    const absolutePath = path.resolve(targetPath);
    const files = await fsPromises.readdir(absolutePath, { withFileTypes: true });
    
    const items = files
      .filter(file => !file.name.startsWith('.')) // Hide hidden files
      .map(file => ({
        name: file.name,
        isDirectory: file.isDirectory(),
        path: path.join(absolutePath, file.name)
      }))
      .sort((a, b) => {
        if (a.isDirectory && !b.isDirectory) return -1;
        if (!a.isDirectory && b.isDirectory) return 1;
        return a.name.localeCompare(b.name);
      });

    res.json({
      currentPath: absolutePath,
      parentPath: path.dirname(absolutePath),
      items
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/v1/fs/mkdir', async (req, res) => {
  const { parentPath, folderName } = req.body || {};

  if (!parentPath || typeof parentPath !== 'string') {
    return res.status(400).json({ error: 'parentPath is required' });
  }

  if (!folderName || typeof folderName !== 'string' || !folderName.trim()) {
    return res.status(400).json({ error: 'folderName is required' });
  }

  const sanitizedFolderName = folderName.trim();
  if (sanitizedFolderName.includes('/') || sanitizedFolderName.includes('\\')) {
    return res.status(400).json({ error: 'folderName must be a single folder name' });
  }

  try {
    const absoluteParentPath = path.resolve(parentPath);
    const stat = await fsPromises.stat(absoluteParentPath);
    if (!stat.isDirectory()) {
      return res.status(400).json({ error: 'parentPath must be a directory' });
    }

    const newFolderPath = path.join(absoluteParentPath, sanitizedFolderName);
    await fsPromises.mkdir(newFolderPath, { recursive: false });

    res.json({
      success: true,
      path: newFolderPath
    });
  } catch (err) {
    if (err?.code === 'EEXIST') {
      return res.status(409).json({ error: 'Folder already exists' });
    }
    res.status(500).json({ error: err.message });
  }
});

// --- Protocol Bridge: Anthropic -> OpenAI ---
app.get('/v1/models', async (req, res) => {
  const config = loadConfig();
  const provider = config.provider || 'anthropic';
  const targetUrl = config.baseUrl || 'http://localhost:11434/v1';

  console.log(`[Bridge] Fetching models for ${provider} from ${targetUrl}`);

  if (provider === 'anthropic') {
    return res.json({
      models: [
        { id: 'claude-3-5-sonnet-20241022', name: 'Claude 3.5 Sonnet' },
        { id: 'claude-3-5-haiku-20241022', name: 'Claude 3.5 Haiku' },
        { id: 'claude-3-opus-20240229', name: 'Claude 3 Opus' },
        { id: 'claude-3-sonnet-20240229', name: 'Claude 3 Sonnet' },
        { id: 'claude-3-haiku-20240307', name: 'Claude 3 Haiku' }
      ]
    });
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    let url = '';
    if (provider === 'ollama') {
      const base = targetUrl.replace('/v1', '');
      url = `${base}/api/tags`;
      const response = await fetch(url, { signal: controller.signal });
      clearTimeout(timeout);
      const data = await response.json();
      const models = data.models.map(m => ({ id: m.name, name: m.name }));
      return res.json({ models });
    } else {
      url = `${targetUrl}/models`;
      const response = await fetch(url, {
        headers: { 'Authorization': `Bearer ${config.apiKey || 'dummy'}` },
        signal: controller.signal
      });
      clearTimeout(timeout);
      const data = await response.json();
      const models = data.data.map(m => ({ id: m.id, name: m.id }));
      return res.json({ models });
    }
  } catch (err) {
    console.error('[Models Fetch Error]', err);
    res.status(500).json({ error: err.name === 'AbortError' ? 'Request timed out' : err.message });
  }
});

app.post('/v1/messages', async (req, res) => {
  const config = loadConfig();
  const { messages, system, tools, model, stream, max_tokens, temperature } = req.body;
  const provider = config.provider || 'anthropic';
  const targetUrl = config.baseUrl || 'http://localhost:11434/v1';

  let effectiveModel = model || config.model;

  // Claude Code may send internal Claude model IDs (for title generation/metadata calls).
  // Ollama cannot serve those IDs, so force fallback to the configured local model.
  if (provider === 'ollama' && typeof model === 'string' && /^claude-/i.test(model)) {
    effectiveModel = config.model;
    console.log(`[Bridge] Overriding unsupported Ollama model '${model}' -> '${effectiveModel}'`);
  }

  console.log(`[Bridge] Proxying request to ${targetUrl} (Provider: ${provider})`);

  // 1. Map Anthropic messages to OpenAI format
  const openaiMessages = [];
  if (system) {
    openaiMessages.push({ role: 'system', content: system });
  }
  
    messages.forEach(msg => {
      let content = msg.content;
      if (Array.isArray(content)) {
        content = content.map(block => {
          if (block.type === 'text') return block.text;
          if (block.type === 'tool_use') return `[Tool Use: ${block.name}]`;
          if (block.type === 'tool_result') return `[Tool Result: ${block.content}]`;
          return '';
        }).join('\n');
      }
      openaiMessages.push({ role: msg.role, content });
    });

    console.log('[Bridge] Formatted OpenAI Messages:', JSON.stringify(openaiMessages, null, 2));

  // 2. Map tools
  const openaiTools = tools?.map(t => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema
    }
  }));

  try {
    console.log(`[Bridge] Proxying request to ${targetUrl} (Model: ${effectiveModel})`);
    console.log(`[Bridge] Messages count: ${messages.length}`);

    const response = await fetch(`${targetUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey || 'dummy'}`
      },
      body: JSON.stringify({
        model: effectiveModel,
        messages: openaiMessages,
        tools: openaiTools,
        stream: stream || false,
        max_tokens: max_tokens,
        temperature: temperature
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[Bridge Error] Provider returned ${response.status}: ${errorText}`);
      return res.status(response.status).json({ error: { message: `Provider error: ${errorText}` } });
    }

    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      
      // Send initial message_start in Anthropic-compatible shape.
      res.write(`data: ${JSON.stringify({ type: 'message_start', message: { id: 'msg_' + Date.now(), type: 'message', role: 'assistant', content: [], model: model || config.model || 'unknown', stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } })}\n\n`);

      let currentBlockType = null;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        
        const chunk = decoder.decode(value);
        const lines = chunk.split('\n').filter(line => line.trim() !== '');
        
        for (const line of lines) {
          if (line.includes('[DONE]')) continue;
          if (line.startsWith('data: ')) {
            try {
              const data = JSON.parse(line.slice(6));
              const delta = data.choices[0]?.delta;
              
              if (delta?.content) {
                console.log(`[Bridge] Token: ${delta.content}`);
                if (currentBlockType !== 'text') {
                  if (currentBlockType) res.write(`data: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`);
                  res.write(`data: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}\n\n`);
                  currentBlockType = 'text';
                }
                res.write(`data: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: delta.content } })}\n\n`);
              }
              
              if (delta?.tool_calls) {
                const tc = delta.tool_calls[0];
                console.log(`[Bridge] Tool Call: ${tc.function?.name || 'delta'}`);
                if (currentBlockType !== 'tool_use') {
                  if (currentBlockType) res.write(`data: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`);
                  res.write(`data: ${JSON.stringify({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: tc.id || 'tc_'+Date.now(), name: tc.function?.name || '' } })}\n\n`);
                  currentBlockType = 'tool_use';
                }
                if (tc.function?.arguments) {
                  res.write(`data: ${JSON.stringify({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: tc.function.arguments } })}\n\n`);
                }
              }
            } catch (e) {
              console.error('[Bridge] JSON Parse Error in stream:', e.message, line);
            }
          }
        }
      }
      if (currentBlockType) res.write(`data: ${JSON.stringify({ type: 'content_block_stop', index: currentBlockType === 'text' ? 0 : 1 })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 0 } })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: 'message_stop' })}\n\n`);
      res.end();
    } else {
      const data = await response.json();
      const choice = data.choices[0].message;

      const usage = data.usage
        ? {
            input_tokens: data.usage.prompt_tokens || 0,
            output_tokens: data.usage.completion_tokens || 0
          }
        : {
            input_tokens: 0,
            output_tokens: 0
          };
      
      const anthropicResponse = {
        id: data.id || `msg_${Date.now()}`,
        type: 'message',
        role: 'assistant',
        model: data.model || effectiveModel || config.model || 'unknown',
        content: [
          { type: 'text', text: choice.content || '' }
        ],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage
      };

      if (choice.tool_calls) {
        choice.tool_calls.forEach(tc => {
          anthropicResponse.content.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.function.name,
            input: JSON.parse(tc.function.arguments)
          });
        });
        anthropicResponse.stop_reason = 'tool_use';
      }

      res.json(anthropicResponse);
    }
  } catch (err) {
    console.error('[Bridge Error]', err);
    res.status(500).json({ error: { message: err.message } });
  }
});

httpServer.listen(PORT, () => {
  ensureNodePtyHelperPermissions();
  detectNodePtyAvailability();
  if (nodePtyStatus.available) {
    console.log('[PTY] node-pty self-test: OK');
  } else {
    console.warn(`[PTY] node-pty self-test failed: ${nodePtyStatus.reason}`);
    console.warn('[PTY] Falling back to Python PTY mode for web sessions.');
  }
  console.log(`Server running on port ${PORT}`);
});
