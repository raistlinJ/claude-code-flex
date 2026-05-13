import express from 'express';
import https from 'https';
import { Server } from 'socket.io';
import os from 'os';
import pty from 'node-pty';
import cors from 'cors';
import { spawn, spawnSync, exec } from 'child_process';
import fs from 'fs';
import { promises as fsPromises } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CONFIG_PATH = path.join(__dirname, 'config.json');
const PORT = process.env.PORT || 3001;

// Allow self-signed certificates for local provider bridges
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

// Helper to handle cyclic structures during JSON.stringify
const getCircularReplacer = () => {
  const seen = new WeakSet();
  return (key, value) => {
    if (typeof value === "object" && value !== null) {
      if (seen.has(value)) {
        return "[Circular]";
      }
      seen.add(value);
    }
    return value;
  };
};

const safeJsonStringify = (obj, indent = 2) => {
  try {
    return JSON.stringify(obj, null, indent);
  } catch (err) {
    return JSON.stringify(obj, getCircularReplacer(), indent);
  }
};
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

const getDefaultCwd = () => process.env.HOME || process.env.USERPROFILE || process.cwd();

const isPowerShellShell = (command) => /(?:^|\\)(powershell|pwsh)\.exe$/i.test(command);

const getShellCandidates = () => {
  if (process.platform === 'win32') {
    const windowsShells = [
      process.env.ComSpec || 'cmd.exe',
      'cmd.exe',
      'powershell.exe',
      'pwsh.exe',
      'powershell.exe'
    ].filter((command, index, commands) => command && commands.indexOf(command) === index);

    return windowsShells.map((command) => ({
      command,
      args: isPowerShellShell(command) ? ['-NoLogo'] : []
    }));
  }

  return ['/bin/zsh', '/bin/bash', 'sh'].map((command) => ({ command, args: [] }));
};

const buildPtyEnv = (baseEnv = process.env) => ({
  ...baseEnv,
  HOME: baseEnv.HOME || process.env.HOME || os.homedir(),
  TERM: baseEnv.TERM || 'xterm-256color'
});

const getPtySpawnOptions = (cwd, env) => ({
  name: 'xterm-color',
  cols: 80,
  rows: 24,
  cwd,
  env: buildPtyEnv(env),
  ...(process.platform === 'win32' ? { useConpty: false } : {})
});

const nodePtyStatus = {
  available: true,
  reason: 'not-tested',
  shell: null
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
  const state = {
    active: !!activePtyProcess,
    config: activeSessionConfig
  };
  socket.emit('session-state', JSON.parse(safeJsonStringify(state, 0)));
};

const clearActiveSession = (exitCode = 0, signal = 'session-closed') => {
  activePtyProcess = null;
  activeSessionConfig = null;
  io.emit('session-closed', { exitCode, signal });
  io.emit('session-state', { active: false, config: null });
};

const detectNodePtyAvailability = () => {
  const shellCandidates = getShellCandidates();

  for (const shellCandidate of shellCandidates) {
    try {
      const test = pty.spawn(
        shellCandidate.command,
        shellCandidate.args,
        getPtySpawnOptions(process.cwd(), process.env)
      );
      test.kill();
      nodePtyStatus.available = true;
      nodePtyStatus.reason = 'ok';
      nodePtyStatus.shell = shellCandidate;
      return;
    } catch (err) {
      nodePtyStatus.available = false;
      nodePtyStatus.reason = `${shellCandidate.command}: ${err?.message || 'unknown-error'}`;
      nodePtyStatus.shell = null;
    }
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

  if (provider === 'anthropic' && explicitApiKey) {
    sessionEnv.ANTHROPIC_API_KEY = explicitApiKey;
  } else if (provider !== 'anthropic') {
    // Bridge providers authenticate upstream in the local backend, so Claude only
    // needs a stable placeholder key here to bypass interactive login prompts.
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
    `[Session] auto_approve_implementation=${config.autoApproveImplementation ? 'on' : 'off'}`,
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
  const autoApproveArg = config.autoApproveImplementation
    ? ' --permission-mode auto'
    : '';
  return `${modelArg}${bypassArg}${autoApproveArg}`;
};

const getClaudeExecutable = (config = {}) => {
  const fromConfig = config?.claudePath && String(config.claudePath).trim();
  if (fromConfig) return fromConfig;

  if (process.platform === 'win32') {
    const localInstallPath = path.join(os.homedir(), '.local', 'bin', 'claude.exe');
    if (fs.existsSync(localInstallPath)) {
      return localInstallPath;
    }
  }

  const fromEnv = process.env.CLAUDE_PATH && String(process.env.CLAUDE_PATH).trim();
  return fromEnv || 'claude';
};

const quoteForBash = (value) => `'${String(value).replace(/'/g, `'"'"'`)}'`;
const quoteForCmd = (value) => `"${String(value).replace(/"/g, '""')}"`;
const escapeForCmdValue = (value) => String(value).replace(/%/g, '%%').replace(/"/g, '""');
const quoteForInteractiveShell = (value) => {
  const text = String(value);
  return /\s/.test(text) ? `"${text.replace(/"/g, '\\"')}"` : text;
};

const buildClaudeShellCommand = (config) => `${quoteForInteractiveShell(getClaudeExecutable(config))}${buildClaudeCliArgs(config)}`;

const DEFAULT_SESSION_CONFIG = {
  apiKey: '',
  claudePath: '',
  baseUrl: '',
  model: '',
  provider: 'anthropic',
  cwd: process.cwd(),
  autoStart: true,
  allowBypassPermissions: false,
  autoApproveImplementation: false
};

const normalizeStoredConfig = (config = {}) => ({
  ...DEFAULT_SESSION_CONFIG,
  ...config,
  provider: typeof config.provider === 'string' && config.provider.trim()
    ? config.provider
    : DEFAULT_SESSION_CONFIG.provider,
  cwd: typeof config.cwd === 'string' && config.cwd.trim()
    ? config.cwd
    : DEFAULT_SESSION_CONFIG.cwd,
  autoStart: true,
  allowBypassPermissions: config.allowBypassPermissions ?? DEFAULT_SESSION_CONFIG.allowBypassPermissions,
  autoApproveImplementation: config.autoApproveImplementation ?? DEFAULT_SESSION_CONFIG.autoApproveImplementation
});

const preferLaunchString = (incomingValue, savedValue, fallback = '') => {
  if (typeof incomingValue === 'string' && incomingValue.trim()) return incomingValue;
  if (typeof savedValue === 'string' && savedValue.trim()) return savedValue;
  return fallback;
};

const loadConfig = () => {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      return normalizeStoredConfig(JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')));
    }
  } catch (err) {
    console.error('Error loading config:', err);
  }
  return normalizeStoredConfig();
};

const saveConfig = (config) => {
  try {
    fs.writeFileSync(CONFIG_PATH, safeJsonStringify(normalizeStoredConfig(config), 2));
  } catch (err) {
    console.error('Error saving config:', err);
  }
};

const buildLaunchConfig = (incomingConfig = {}) => {
  const savedConfig = loadConfig();

  return normalizeStoredConfig({
    ...savedConfig,
    ...incomingConfig,
    claudePath: preferLaunchString(incomingConfig.claudePath, savedConfig.claudePath, ''),
    model: preferLaunchString(incomingConfig.model, savedConfig.model, ''),
    cwd: preferLaunchString(incomingConfig.cwd, savedConfig.cwd, DEFAULT_SESSION_CONFIG.cwd),
    autoStart: true,
    allowBypassPermissions: incomingConfig.allowBypassPermissions ?? savedConfig.allowBypassPermissions,
    autoApproveImplementation: incomingConfig.autoApproveImplementation ?? savedConfig.autoApproveImplementation
  });
};

io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  // Send current config to client
  const initialConfig = loadConfig();
  socket.emit('config-loaded', JSON.parse(safeJsonStringify(initialConfig, 0)));
  emitSessionState(socket);
  if (activePtyProcess && terminalHistory) {
    socket.emit('terminal-history', terminalHistory);
  }

  socket.on('update-config', (newConfig) => {
    saveConfig(newConfig);
  });

  socket.on('start-session', (requestedConfig) => {
    if (activePtyProcess) {
      terminateActiveSessionProcess('restarted');
      clearActiveSession(0, 'restarted');
    }

    const config = buildLaunchConfig(requestedConfig);

    console.log(`[Session] Starting session for ${socket.id} (AutoStart: ${config.autoStart})`);
    // Keep bridge config in sync with the exact values used to start this session.
    saveConfig(config);
    activeSessionConfig = config;
    terminalHistory = '';
    const sessionEnv = buildClaudeSessionEnv(config);
    const shellCandidates = nodePtyStatus.shell
      ? [
          nodePtyStatus.shell,
          ...getShellCandidates().filter((candidate) => candidate.command !== nodePtyStatus.shell.command)
        ]
      : getShellCandidates();
    broadcastTerminalData(`\r\n${buildSessionBanner(config, sessionEnv)}\r\n`);
    io.emit('session-state', JSON.parse(safeJsonStringify({ active: true, config: activeSessionConfig }, 0)));

    const spawnWithFallback = (shells, currentEnv) => {
      if (shells.length === 0) {
        console.log('[Session] All PTY attempts failed. Falling back to child_process.spawn');
        spawnChildProcessFallback(currentEnv);
        return;
      }
      
      const currentShell = shells[0];
      try {
        console.log(`[Session] Attempting PTY spawn: ${currentShell.command}`);
        activePtyProcess = pty.spawn(
          currentShell.command,
          currentShell.args,
          getPtySpawnOptions(config.cwd || getDefaultCwd(), currentEnv)
        );

        console.log(`[Session] Success! PTY spawned (PID: ${activePtyProcess.pid})`);
        setupPtyHandlers(activePtyProcess);

      } catch (err) {
        console.warn(`[Session Warning] PTY spawn failed for ${currentShell.command}:`, err.message);
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
      const fallbackShell = shellCandidates[0] || { command: 'powershell.exe', args: ['-NoLogo'] };
      let cp;

      if (process.platform === 'win32') {
        broadcastTerminalData(`\r\n[System] node-pty failed. Attempting pipe fallback with ${fallbackShell.command}.\r\n`);
        cp = spawn(fallbackShell.command, fallbackShell.args, {
          env: buildPtyEnv(currentEnv),
          cwd: config.cwd || getDefaultCwd(),
          stdio: ['pipe', 'pipe', 'pipe']
        });
      } else {
        const interactiveArgs = [...fallbackShell.args, '-i'];
        const pythonCommand = `import pty; pty.spawn(${JSON.stringify([fallbackShell.command, ...interactiveArgs])})`;
        broadcastTerminalData(`\r\n[System] node-pty failed. Attempting Python PTY fallback with ${fallbackShell.command}.\r\n`);
        cp = spawn('python3', ['-c', pythonCommand], {
          env: buildPtyEnv(currentEnv),
          cwd: config.cwd || getDefaultCwd(),
          stdio: ['pipe', 'pipe', 'pipe']
        });
      }

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

    spawnWithFallback(shellCandidates, sessionEnv);
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

const handleModelsRequest = async (req, res) => {
  const config = loadConfig();
  const provider = req.query.provider || req.body?.provider || config.provider || 'anthropic';
  const targetUrl = req.query.baseUrl || req.body?.baseUrl || config.baseUrl || (provider === 'ollama' ? 'http://localhost:11434/v1' : '');
  const apiKey = req.query.apiKey || req.body?.apiKey || config.apiKey;

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
    const timeout = setTimeout(() => controller.abort(), 10000);

    let url = '';
    if (provider === 'ollama') {
      const base = targetUrl.replace('/v1', '');
      url = `${base}/api/tags`;
      const headers = {};
      if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
      const response = await fetch(url, { headers, signal: controller.signal });
      clearTimeout(timeout);

      if (!response.ok) {
        const errorText = await response.text().catch(() => 'No error body');
        console.error(`[Models Fetch Error] Ollama returned ${response.status}: ${errorText}`);
        return res.status(response.status).json({
          error: `Server returned HTTP ${response.status}. ${errorText || 'Check your URL and credentials.'}`
        });
      }

      const data = await response.json();
      const models = (data.models || []).map(m => ({ id: m.name, name: m.name }));
      return res.json({ models });
    }

    // --- OpenAI-compatible provider ---
    url = `${targetUrl}/models`;
    const authHeaders = { 'Authorization': `Bearer ${apiKey || 'dummy'}` };
    const response = await fetch(url, {
      headers: authHeaders,
      signal: controller.signal
    });
    clearTimeout(timeout);

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'No error body');
      console.error(`[Models Fetch Error] Provider returned ${response.status}: ${errorText}`);
      return res.status(response.status).json({
        error: `Server returned HTTP ${response.status}. ${errorText || 'Check your URL and credentials.'}`
      });
    }

    const data = await response.json();
    if (!data || (!data.data && !data.models)) {
      console.error('[Models Fetch Error] Invalid response format:', data);
      return res.status(500).json({ error: 'Invalid response format from provider. Is this an OpenAI-compatible endpoint?' });
    }

    const modelsData = data.data || data.models || [];
    const models = modelsData.map(m => ({ id: m.id || m.name, name: m.id || m.name }));

    // --- API Key Validation Probe ---
    // Some servers (e.g. llama.cpp) don't enforce auth on /models but do on /chat/completions.
    // Send a minimal request to verify the API key actually works before the user starts a session.
    if (apiKey && models.length > 0) {
      try {
        const probeController = new AbortController();
        const probeTimeout = setTimeout(() => probeController.abort(), 8000);
        const probeModel = models[0].id;
        console.log(`[Bridge] Validating API key against ${targetUrl}/chat/completions with model ${probeModel}`);

        const probeResponse = await fetch(`${targetUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
          },
          body: safeJsonStringify({
            model: probeModel,
            messages: [{ role: 'user', content: 'Hi' }],
            max_tokens: 1
          }),
          signal: probeController.signal
        });
        clearTimeout(probeTimeout);

        if (probeResponse.status === 401 || probeResponse.status === 403) {
          const probeError = await probeResponse.text().catch(() => '');
          console.error(`[Bridge] API key validation failed (${probeResponse.status}): ${probeError}`);
          return res.json({
            models: JSON.parse(safeJsonStringify(models, 0)),
            authError: `API key rejected: The server returned HTTP ${probeResponse.status} on a test request. Your key may be invalid.`
          });
        }
        console.log(`[Bridge] API key validation passed (HTTP ${probeResponse.status})`);
      } catch (probeErr) {
        // Probe failed for non-auth reasons (timeout, network) – don't block model listing
        console.warn(`[Bridge] API key probe failed (non-auth): ${probeErr.message}`);
      }
    }

    return res.json({ models: JSON.parse(safeJsonStringify(models, 0)) });
  } catch (err) {
    console.error('[Models Fetch Error]', err);
    let message = err.message;
    const causeCode = err.cause?.code || err.code;
    if (causeCode === 'ECONNRESET') message = 'Connection reset by remote host. The server may require HTTPS — check your Base URL protocol.';
    if (causeCode === 'ECONNREFUSED') message = 'Connection refused. Check if the remote server is running and accessible.';
    if (causeCode === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' || causeCode === 'DEPTH_ZERO_SELF_SIGNED_CERT') message = 'SSL certificate verification failed. The server may be using a self-signed certificate.';
    res.status(500).json({ error: err.name === 'AbortError' ? 'Request timed out after 10s. Check that the URL is reachable.' : message });
  }
};

// Native Terminal Launcher (cross-platform)
app.post('/v1/terminal/launch', (req, res) => {
  const config = buildLaunchConfig(req.body);
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
    `[Session] auto_approve_implementation=${config.autoApproveImplementation ? 'on' : 'off'}`,
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
    const cmdExecutable = process.env.ComSpec || 'cmd.exe';
    const launchCwd = fs.existsSync(config.cwd)
      ? path.win32.normalize(path.resolve(config.cwd))
      : path.win32.normalize(process.cwd());
    const envSetupCommands = [
      `set "ANTHROPIC_BASE_URL=${escapeForCmdValue(sessionEnv.ANTHROPIC_BASE_URL)}"`,
      `set "CLAUDE_CODE_MODEL=${escapeForCmdValue(sessionEnv.CLAUDE_CODE_MODEL)}"`,
      `set "NODE_TLS_REJECT_UNAUTHORIZED=${escapeForCmdValue(sessionEnv.NODE_TLS_REJECT_UNAUTHORIZED)}"`,
      ...(sessionEnv.ANTHROPIC_API_KEY ? [`set "ANTHROPIC_API_KEY=${escapeForCmdValue(sessionEnv.ANTHROPIC_API_KEY)}"`] : [])
    ];
    const bannerCommands = banner.filter(Boolean).map((line) => `echo ${quoteForCmd(line)}`);
    const nativeCommand = [
      'title Claude Code WebUI',
      ...envSetupCommands,
      ...bannerCommands,
      `${quoteForCmd(claudeExec)}${buildClaudeCliArgs(config)}`
    ].join(' && ');
    const launchEnv = buildPtyEnv(sessionEnv);
    const hasWindowsTerminal = spawnSync('where', ['wt.exe'], {
      windowsHide: true,
      stdio: 'ignore',
      shell: false
    }).status === 0;

    const launchViaCmdStart = () => {
      const startCommand = `start "Claude Code WebUI" /d ${quoteForCmd(launchCwd)} ${quoteForCmd(cmdExecutable)} /d /k ${quoteForCmd(nativeCommand)}`;
      const startArguments = ['/d', '/s', '/c', startCommand];

      console.log('[Native Terminal] Launching Windows terminal via cmd start', {
        cmdExecutable,
        cwd: launchCwd,
        claudeExec,
        startCommand,
        startArguments
      });

      const child = spawn(cmdExecutable, startArguments, {
        detached: true,
        stdio: 'ignore',
        windowsHide: false,
        cwd: launchCwd,
        env: launchEnv,
        windowsVerbatimArguments: true
      });

      child.on('error', (err) => {
        console.error('[Terminal Launch Error]', err);
      });

      child.unref();
    };
    let launcherUsed = 'cmd-start';

    if (hasWindowsTerminal) {
      const wtArgs = ['-d', launchCwd, 'cmd.exe', '/d', '/k', nativeCommand];
      console.log('[Native Terminal] Launching Windows terminal via wt.exe', {
        cwd: launchCwd,
        claudeExec,
        wtArgs
      });

      const wtChild = spawn('wt.exe', wtArgs, {
        detached: true,
        stdio: 'ignore',
        windowsHide: false,
        cwd: launchCwd,
        env: launchEnv
      });

      wtChild.on('error', (err) => {
        console.warn('[Native Terminal] wt.exe launch failed, falling back to cmd start', err);
        launcherUsed = 'cmd-start-fallback';
        launchViaCmdStart();
      });

      wtChild.unref();
      launcherUsed = 'wt';
    } else {
      launchViaCmdStart();
    }

    res.json({ success: true, launcher: launcherUsed, serverPort: PORT });
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
app.get('/v1/models', handleModelsRequest);
app.post('/v1/models', handleModelsRequest);

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
    if (typeof msg.content === 'string') {
      openaiMessages.push({ role: msg.role, content: msg.content });
      return;
    }
    
    if (Array.isArray(msg.content)) {
      if (msg.role === 'user' && msg.content.some(b => b.type === 'tool_result')) {
        let textParts = msg.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
        if (textParts) {
          openaiMessages.push({ role: 'user', content: textParts });
        }
        msg.content.filter(b => b.type === 'tool_result').forEach(block => {
          let toolContent = block.content;
          if (Array.isArray(toolContent)) {
             toolContent = toolContent.map(c => typeof c === 'string' ? c : (c.text || JSON.stringify(c))).join('\n');
          } else if (typeof toolContent !== 'string') {
             toolContent = JSON.stringify(toolContent);
          }
          openaiMessages.push({
            role: 'tool',
            tool_call_id: block.tool_use_id,
            content: toolContent
          });
        });
        return;
      }

      if (msg.role === 'assistant') {
        let textParts = msg.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
        let toolUses = msg.content.filter(b => b.type === 'tool_use');
        
        let assistantMsg = { role: 'assistant', content: textParts || null };
        if (toolUses.length > 0) {
          assistantMsg.tool_calls = toolUses.map(block => ({
            id: block.id,
            type: 'function',
            function: {
              name: block.name,
              arguments: JSON.stringify(block.input || {})
            }
          }));
        }
        openaiMessages.push(assistantMsg);
        return;
      }

      // Fallback
      let contentStr = msg.content.map(block => {
        if (block.type === 'text') return block.text;
        if (block.type === 'tool_use') return `[Tool Use: ${block.name}]`;
        if (block.type === 'tool_result') return `[Tool Result: ${block.content}]`;
        return '';
      }).join('\n');
      openaiMessages.push({ role: msg.role, content: contentStr });
    }
  });

  console.log('[Bridge] Formatted OpenAI Messages:', safeJsonStringify(openaiMessages, 2));

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
      body: safeJsonStringify({
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
      res.write(`data: ${safeJsonStringify({ type: 'message_start', message: { id: 'msg_' + Date.now(), type: 'message', role: 'assistant', content: [], model: model || config.model || 'unknown', stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } })}\n\n`);

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
                  if (currentBlockType) res.write(`data: ${safeJsonStringify({ type: 'content_block_stop', index: 0 })}\n\n`);
                  res.write(`data: ${safeJsonStringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}\n\n`);
                  currentBlockType = 'text';
                }
                res.write(`data: ${safeJsonStringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: delta.content } })}\n\n`);
              }
              
              if (delta?.tool_calls) {
                const tc = delta.tool_calls[0];
                console.log(`[Bridge] Tool Call: ${tc.function?.name || 'delta'}`);
                if (currentBlockType !== 'tool_use') {
                  if (currentBlockType) res.write(`data: ${safeJsonStringify({ type: 'content_block_stop', index: 0 })}\n\n`);
                  res.write(`data: ${safeJsonStringify({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: tc.id || 'tc_'+Date.now(), name: tc.function?.name || '' } })}\n\n`);
                  currentBlockType = 'tool_use';
                }
                if (tc.function?.arguments) {
                  res.write(`data: ${safeJsonStringify({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: tc.function.arguments } })}\n\n`);
                }
              }
            } catch (e) {
              console.error('[Bridge] JSON Parse Error in stream:', e.message, line);
            }
          }
        }
      }
      if (currentBlockType) res.write(`data: ${safeJsonStringify({ type: 'content_block_stop', index: currentBlockType === 'text' ? 0 : 1 })}\n\n`);
      const finalStopReason = currentBlockType === 'tool_use' ? 'tool_use' : 'end_turn';
      res.write(`data: ${safeJsonStringify({ type: 'message_delta', delta: { stop_reason: finalStopReason, stop_sequence: null }, usage: { output_tokens: 0 } })}\n\n`);
      res.write(`data: ${safeJsonStringify({ type: 'message_stop' })}\n\n`);
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

      res.json(JSON.parse(safeJsonStringify(anthropicResponse, 0)));
    }
  } catch (err) {
    console.error('[Bridge Error]', err);
    let message = err.message;
    if (err.code === 'ECONNRESET') message = 'Connection reset by remote host. Check if you are using the correct protocol (http/https) and that your API key is correct.';
    if (err.code === 'ECONNREFUSED') message = 'Connection refused. Check if the remote LLM server is running and accessible.';
    res.status(500).json({ error: { message: message } });
  }
});

httpServer.on('error', (err) => {
  if (err?.code === 'EADDRINUSE') {
    console.warn(`[Server] Port ${PORT} is already in use. Keeping existing backend process and skipping duplicate start.`);
    return;
  }

  console.error('[Server] Failed to start HTTPS server:', err);
  process.exit(1);
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
