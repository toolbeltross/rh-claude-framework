import { useState, useEffect, useCallback, useRef } from 'react';

export function usePictureInPicture() {
  const [pipWindow, setPipWindow] = useState(null);
  const pipRef = useRef(null);
  const observerRef = useRef(null);

  const isSupported =
    typeof window !== 'undefined' && 'documentPictureInPicture' in window;
  const isOpen = !!pipWindow;

  // Copy a single <style> or <link rel="stylesheet"> node into targetDoc
  const cloneStyleNode = useCallback((node, targetDoc) => {
    if (node.tagName === 'STYLE') {
      const clone = targetDoc.createElement('style');
      clone.textContent = node.textContent;
      // Mirror Vite's data-vite-dev-id so we can track HMR updates
      const viteId = node.dataset.viteDevId || '';
      clone.dataset.pipCloneOf = viteId || node.textContent.slice(0, 40);
      targetDoc.head.appendChild(clone);
    } else if (node.tagName === 'LINK' && node.rel === 'stylesheet') {
      const link = targetDoc.createElement('link');
      link.rel = 'stylesheet';
      link.href = node.href;
      targetDoc.head.appendChild(link);
    }
  }, []);

  // Copy all existing styles from the parent document
  const copyAllStyles = useCallback((targetDoc) => {
    // Method 1: Read parsed CSS rules from document.styleSheets and inject as <style>
    // This is more reliable than cloning <link> elements (which may fail to load in PiP)
    for (const sheet of document.styleSheets) {
      try {
        const rules = [...sheet.cssRules].map(r => r.cssText).join('\n');
        const style = targetDoc.createElement('style');
        style.textContent = rules;
        // Track origin for HMR updates
        if (sheet.ownerNode?.dataset?.viteDevId) {
          style.dataset.pipCloneOf = sheet.ownerNode.dataset.viteDevId;
        } else if (sheet.href) {
          style.dataset.pipCloneOf = sheet.href;
        }
        targetDoc.head.appendChild(style);
      } catch {
        // Cross-origin stylesheet — fall back to cloning the <link>
        if (sheet.href) {
          const link = targetDoc.createElement('link');
          link.rel = 'stylesheet';
          link.href = sheet.href;
          if (sheet.ownerNode?.crossOrigin) link.crossOrigin = sheet.ownerNode.crossOrigin;
          targetDoc.head.appendChild(link);
        }
      }
    }
    // Method 2: Also clone <style> tags that might not be in document.styleSheets yet
    // (e.g. Vite HMR injected styles still loading)
    document.querySelectorAll('style').forEach((node) => {
      cloneStyleNode(node, targetDoc);
    });
  }, [cloneStyleNode]);

  // Watch for Vite HMR style additions/changes and sync to PiP window
  const startStyleObserver = useCallback((targetWin) => {
    const targetDoc = targetWin.document;

    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        // New nodes added to <head>
        for (const node of mutation.addedNodes) {
          if (node.nodeType !== 1) continue;
          if (node.tagName === 'STYLE' || (node.tagName === 'LINK' && node.rel === 'stylesheet')) {
            cloneStyleNode(node, targetDoc);
          }
        }
        // Existing <style> text changed (Vite HMR updates textContent)
        if (mutation.type === 'characterData' && mutation.target.parentNode?.tagName === 'STYLE') {
          const srcStyle = mutation.target.parentNode;
          const id = srcStyle.dataset.viteDevId || '';
          if (id) {
            const existing = targetDoc.querySelector(`style[data-pip-clone-of="${CSS.escape(id)}"]`);
            if (existing) existing.textContent = srcStyle.textContent;
          }
        }
        // Handle direct textContent replacement on <style> nodes
        if (mutation.type === 'childList' && mutation.target.tagName === 'STYLE') {
          const srcStyle = mutation.target;
          const id = srcStyle.dataset.viteDevId || '';
          if (id) {
            const existing = targetDoc.querySelector(`style[data-pip-clone-of="${CSS.escape(id)}"]`);
            if (existing) existing.textContent = srcStyle.textContent;
          }
        }
      }
    });

    observer.observe(document.head, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    observerRef.current = observer;
  }, [cloneStyleNode]);

  const openFallback = useCallback(({ width, height }) => {
    const url = new URL(window.location.href);
    url.searchParams.set('popout', 'true');
    const win = window.open(
      url.toString(),
      'telemetry-popout',
      `popup,width=${width},height=${height},left=100,top=100`
    );
    if (!win) {
      // Popup was blocked — open in a new tab instead
      window.open(url.toString(), '_blank');
    }
  }, []);

  const open = useCallback(
    async ({ width = 900, height = 600 } = {}) => {
      if (!isSupported) {
        openFallback({ width, height });
        return null;
      }

      try {
        const pip = await window.documentPictureInPicture.requestWindow({
          width,
          height,
        });

        // Match parent document's <html> attributes (e.g. class="dark")
        pip.document.documentElement.className = document.documentElement.className;

        // Add viewport meta for proper scaling
        const meta = pip.document.createElement('meta');
        meta.name = 'viewport';
        meta.content = 'width=device-width, initial-scale=1.0';
        pip.document.head.appendChild(meta);

        // Copy all current styles into the PiP document
        copyAllStyles(pip.document);

        pip.document.body.style.margin = '0';
        pip.document.body.style.background = '#0a0a0f';
        pip.document.body.style.fontFamily =
          "'SF Mono','Cascadia Code','Fira Code','JetBrains Mono',monospace";
        pip.document.body.style.overflow = 'auto';
        pip.document.body.style.colorScheme = 'dark';

        // Start watching for Vite HMR style updates
        startStyleObserver(pip);

        pipRef.current = pip;
        setPipWindow(pip);

        pip.addEventListener('pagehide', () => {
          observerRef.current?.disconnect();
          observerRef.current = null;
          pipRef.current = null;
          setPipWindow(null);
        });

        // Force a resize event after a short delay so Recharts
        // ResponsiveContainers measure their new parent correctly
        setTimeout(() => {
          pip.dispatchEvent(new Event('resize'));
        }, 100);

        return pip;
      } catch (err) {
        console.error('Document PiP failed, falling back to popup:', err);
        openFallback({ width, height });
        return null;
      }
    },
    [isSupported, copyAllStyles, startStyleObserver, openFallback]
  );

  const close = useCallback(() => {
    observerRef.current?.disconnect();
    observerRef.current = null;
    if (pipRef.current) {
      pipRef.current.close();
      pipRef.current = null;
      setPipWindow(null);
    }
  }, []);

  const resize = useCallback(async (width, height) => {
    if (!pipRef.current) return;
    // Try native resizeTo first (Document PiP spec)
    if (typeof pipRef.current.resizeTo === 'function') {
      pipRef.current.resizeTo(width, height);
      setTimeout(() => pipRef.current?.dispatchEvent(new Event('resize')), 50);
      return;
    }
    // Fallback: close and reopen with new dimensions
    close();
    await open({ width, height });
  }, [close, open]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      observerRef.current?.disconnect();
      if (pipRef.current) {
        pipRef.current.close();
      }
    };
  }, []);

  return { pipWindow, isSupported, isOpen, open, close, resize };
}