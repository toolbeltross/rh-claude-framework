import { useEffect, useRef, useState, useCallback } from 'react';

export function useWebSocket(url, onMessage) {
  const wsRef = useRef(null);
  const [connected, setConnected] = useState(false);
  const reconnectTimer = useRef(null);
  const retryCount = useRef(0);
  const onMessageRef = useRef(onMessage);
  onMessageRef.current = onMessage;

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      setConnected(true);
      retryCount.current = 0;
      console.log('[ws] Connected');
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        onMessageRef.current?.(msg);
      } catch (e) {
        console.error('[ws] Parse error:', e);
      }
    };

    ws.onclose = () => {
      setConnected(false);
      // Exponential backoff: 3s → 6s → 12s → max 30s
      const delay = Math.min(3000 * Math.pow(2, retryCount.current), 30000);
      retryCount.current++;
      console.log(`[ws] Disconnected, reconnecting in ${delay / 1000}s...`);
      reconnectTimer.current = setTimeout(connect, delay);
    };

    ws.onerror = () => {
      ws.close();
    };
  }, [url]);

  useEffect(() => {
    connect();
    return () => {
      clearTimeout(reconnectTimer.current);
      wsRef.current?.close();
    };
  }, [connect]);

  return { connected };
}