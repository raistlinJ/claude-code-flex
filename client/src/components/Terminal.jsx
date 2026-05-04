import React, { useEffect, useRef } from 'react';
import { Terminal as XTerm } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import 'xterm/css/xterm.css';

const Terminal = ({ socket, isConnected, isSessionActive, resetKey, onSizeChange, history }) => {
  const terminalRef = useRef(null);
  const xtermRef = useRef(null);
  const fitAddonRef = useRef(null);
  const isSessionActiveRef = useRef(isSessionActive);
  const lastHistoryRef = useRef('');

  const emitTerminalSize = () => {
    const xterm = xtermRef.current;
    if (!xterm) return;

    onSizeChange?.({ cols: xterm.cols, rows: xterm.rows });

    if (socket) {
      socket.emit('terminal-resize', {
        cols: xterm.cols,
        rows: xterm.rows
      });
    }
  };

  const fitAndEmit = () => {
    const fitAddon = fitAddonRef.current;
    if (!fitAddon) return;
    fitAddon.fit();
    emitTerminalSize();
  };

  useEffect(() => {
    isSessionActiveRef.current = isSessionActive;
  }, [isSessionActive]);

  useEffect(() => {
    const xterm = new XTerm({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: 'JetBrains Mono, Fira Code, monospace',
      theme: {
        background: '#0d1117',
        foreground: '#c9d1d9',
        cursor: '#58a6ff',
        selectionBackground: 'rgba(88, 166, 255, 0.3)',
        black: '#484f58',
        red: '#ff7b72',
        green: '#3fb950',
        yellow: '#d29922',
        blue: '#58a6ff',
        magenta: '#bc8cff',
        cyan: '#39c5cf',
        white: '#b1bac4',
      }
    });

    const fitAddon = new FitAddon();
    xterm.loadAddon(fitAddon);

    xterm.open(terminalRef.current);
    fitAddon.fit();

    xtermRef.current = xterm;
    fitAddonRef.current = fitAddon;

    const handleResize = () => fitAndEmit();

    const resizeObserver = new ResizeObserver(() => {
      fitAndEmit();
    });

    resizeObserver.observe(terminalRef.current);

    window.addEventListener('resize', handleResize);

    xterm.onData((data) => {
      if (socket && isSessionActiveRef.current) {
        socket.emit('terminal-input', data);
      }
    });

    const handleTerminalData = (data) => {
      xterm.write(data);
    };

    if (socket) {
      socket.on('terminal-data', handleTerminalData);
      socket.emit('terminal-sync-request');
    }

    // Ensure first render and initial dimensions are synchronized.
    fitAndEmit();

    return () => {
      resizeObserver.disconnect();
      window.removeEventListener('resize', handleResize);
      if (socket) {
        socket.off('terminal-data', handleTerminalData);
      }
      xterm.dispose();
    };
  }, [socket]);

  useEffect(() => {
    if (!xtermRef.current) return;
    if (!history) return;
    if (history === lastHistoryRef.current) return;

    lastHistoryRef.current = history;
    xtermRef.current.reset();
    xtermRef.current.clear();
    xtermRef.current.write(history);
    fitAndEmit();
  }, [history]);

  useEffect(() => {
    if (!isSessionActive) return;
    // PTY is created after start-session, so resize again on activation.
    setTimeout(() => fitAndEmit(), 50);
  }, [isSessionActive]);

  useEffect(() => {
    if (xtermRef.current) {
      lastHistoryRef.current = '';
      xtermRef.current.reset();
      xtermRef.current.clear();
      xtermRef.current.write('\r\n[System] Starting new terminal session...\r\n\r\n');
      fitAndEmit();
    }
  }, [resetKey]);

  return (
    <div style={{ height: '100%', width: '100%', position: 'relative', flex: 1, minHeight: 0 }}>
      <div ref={terminalRef} className="xterm" />
      {!isSessionActive && (
        <div className="terminal-overlay">
          Session stopped. Start Web Terminal to enable input.
        </div>
      )}
    </div>
  );
};

export default Terminal;
