'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { useCalendarStore } from '@/store/useCalendarStore';
import { railway } from '@/lib/railway';

interface Message {
  role: 'user' | 'assistant';
  content: string;
}

// ── Lightweight markdown renderer ────────────────────────────────────────────

function renderInline(text: string): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  // Patterns: **bold**, *italic*, `code`
  const re = /(\*\*(.+?)\*\*|\*(.+?)\*|`([^`]+)`)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let key = 0;

  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    if (m[2] !== undefined) parts.push(<strong key={key++}>{m[2]}</strong>);
    else if (m[3] !== undefined) parts.push(<em key={key++}>{m[3]}</em>);
    else if (m[4] !== undefined) parts.push(<code key={key++} className="chat-code-inline">{m[4]}</code>);
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

function MarkdownBlock({ content, isDark }: { content: string; isDark: boolean }) {
  const lines = content.split('\n');
  const nodes: React.ReactNode[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Headings
    const hMatch = line.match(/^(#{1,3})\s+(.+)/);
    if (hMatch) {
      const level = hMatch[1].length;
      const cls = level === 1
        ? 'text-base font-bold mt-2 mb-0.5'
        : level === 2
        ? 'text-sm font-bold mt-2 mb-0.5'
        : 'text-sm font-semibold mt-1.5 mb-0.5';
      nodes.push(<p key={key++} className={cls}>{renderInline(hMatch[2])}</p>);
      i++;
      continue;
    }

    // Bullet list — collect consecutive bullet lines
    if (/^[-*]\s/.test(line)) {
      const items: React.ReactNode[] = [];
      while (i < lines.length && /^[-*]\s/.test(lines[i])) {
        items.push(<li key={i}>{renderInline(lines[i].replace(/^[-*]\s/, ''))}</li>);
        i++;
      }
      nodes.push(<ul key={key++} className="list-disc list-inside space-y-0.5 my-1 pl-1">{items}</ul>);
      continue;
    }

    // Numbered list
    if (/^\d+\.\s/.test(line)) {
      const items: React.ReactNode[] = [];
      while (i < lines.length && /^\d+\.\s/.test(lines[i])) {
        items.push(<li key={i}>{renderInline(lines[i].replace(/^\d+\.\s/, ''))}</li>);
        i++;
      }
      nodes.push(<ol key={key++} className="list-decimal list-inside space-y-0.5 my-1 pl-1">{items}</ol>);
      continue;
    }

    // Horizontal rule
    if (/^---+$/.test(line.trim())) {
      nodes.push(<hr key={key++} className={`my-2 border-t ${isDark ? 'border-gray-600' : 'border-gray-300'}`} />);
      i++;
      continue;
    }

    // Empty line → spacing
    if (line.trim() === '') {
      if (nodes.length > 0) nodes.push(<div key={key++} className="h-1.5" />);
      i++;
      continue;
    }

    // Plain paragraph
    nodes.push(<p key={key++} className="leading-snug">{renderInline(line)}</p>);
    i++;
  }

  return <div className="space-y-0.5">{nodes}</div>;
}

// ── Theme hook ───────────────────────────────────────────────────────────────

function useIsDark() {
  const theme = useCalendarStore(s => s.theme);
  const [sysDark, setSysDark] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    setSysDark(mq.matches);
    const handler = (e: MediaQueryListEvent) => setSysDark(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  return theme === 'dark' || (theme === 'system' && sysDark);
}

// ── Chat component ───────────────────────────────────────────────────────────

export default function AssistantChat() {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const { trayOpen } = useCalendarStore();
  const isDark = useIsDark();

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 50);
  }, [open]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading]);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || loading) return;

    const userMsg: Message = { role: 'user', content: text };
    const nextMessages = [...messages, userMsg];
    setMessages(nextMessages);
    setInput('');
    setLoading(true);

    try {
      // Server (Railway) pulls fresh org data from the DB; we just send chat.
      const res = await railway.rawFetch('POST', '/v1/assistant', { messages: nextMessages });
      if (!res.ok || !res.body) throw new Error('Request failed');

      const assistantMsg: Message = { role: 'assistant', content: '' };
      setMessages(prev => [...prev, assistantMsg]);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        setMessages(prev => {
          const updated = [...prev];
          updated[updated.length - 1] = {
            ...updated[updated.length - 1],
            content: updated[updated.length - 1].content + chunk,
          };
          return updated;
        });
      }
    } catch {
      setMessages(prev => [...prev, { role: 'assistant', content: 'Something went wrong. Please try again.' }]);
    } finally {
      setLoading(false);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [input, loading, messages]);

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  // Theme-derived values
  const panel = isDark
    ? { bg: '#1e1e2e', border: '#3a3a4a', header: '#2563eb', inputBg: '#2a2a3a', inputBorder: '#4a4a5a', text: '#e2e8f0', subtext: '#94a3b8', bubbleAiBg: '#2d2d3f', codeBg: '#1a1a2e', codeText: '#93c5fd' }
    : { bg: '#ffffff', border: '#e2e8f0', header: '#2563eb', inputBg: '#f8fafc', inputBorder: '#cbd5e1', text: '#1e293b', subtext: '#64748b', bubbleAiBg: '#f1f5f9', codeBg: '#e2e8f0', codeText: '#1d4ed8' };

  return (
    <>
      <style>{`
        .chat-code-inline {
          font-family: ui-monospace, monospace;
          font-size: 0.8em;
          padding: 0.1em 0.35em;
          border-radius: 4px;
          background: ${panel.codeBg};
          color: ${panel.codeText};
        }
      `}</style>

      {/* Floating button */}
      <button
        onClick={() => setOpen(o => !o)}
        aria-label="Open dispatch assistant"
        style={{
          position: 'fixed', bottom: 68, right: 20, zIndex: trayOpen ? 30 : 50,
          width: 52, height: 52, borderRadius: '50%',
          background: '#2563eb', color: '#fff', border: 'none',
          boxShadow: '0 4px 14px rgba(37,99,235,0.45)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          cursor: 'pointer', transition: 'transform 0.15s, box-shadow 0.15s',
        }}
        onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.transform = 'scale(1.07)'; }}
        onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.transform = 'scale(1)'; }}
      >
        {open ? (
          <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        ) : (
          <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            <circle cx="9" cy="10" r="1" fill="currentColor" stroke="none" />
            <circle cx="12" cy="10" r="1" fill="currentColor" stroke="none" />
            <circle cx="15" cy="10" r="1" fill="currentColor" stroke="none" />
          </svg>
        )}
      </button>

      {/* Chat panel */}
      {open && (
        <div style={{
          position: 'fixed', bottom: 130, right: 20, zIndex: trayOpen ? 30 : 50,
          width: 368, height: 480,
          display: 'flex', flexDirection: 'column',
          borderRadius: 14,
          boxShadow: '0 8px 32px rgba(0,0,0,0.18)',
          border: `1px solid ${panel.border}`,
          background: panel.bg,
          overflow: 'hidden',
          fontFamily: 'inherit',
        }}>
          {/* Header */}
          <div style={{ background: panel.header, color: '#fff', padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>
            <span style={{ fontWeight: 700, fontSize: 14 }}>Dispatch Assistant</span>
          </div>

          {/* Messages */}
          <div style={{ flex: 1, overflowY: 'auto', padding: '12px 10px', display: 'flex', flexDirection: 'column', gap: 8 }}>
            {messages.length === 0 && (
              <div style={{ textAlign: 'center', color: panel.subtext, marginTop: 32, padding: '0 16px' }}>
                <p style={{ fontWeight: 600, fontSize: 13, marginBottom: 6, color: panel.text }}>Ask me about your loads</p>
                <p style={{ fontSize: 12, lineHeight: 1.5 }}>
                  Try: &ldquo;Which loads pick up tomorrow?&rdquo; or &ldquo;Total revenue this week?&rdquo;
                </p>
              </div>
            )}

            {messages.map((msg, i) => (
              <div key={i} style={{ display: 'flex', justifyContent: msg.role === 'user' ? 'flex-end' : 'flex-start' }}>
                <div style={{
                  maxWidth: '87%',
                  padding: '8px 11px',
                  borderRadius: msg.role === 'user' ? '16px 16px 4px 16px' : '16px 16px 16px 4px',
                  background: msg.role === 'user' ? '#2563eb' : panel.bubbleAiBg,
                  color: msg.role === 'user' ? '#fff' : panel.text,
                  fontSize: 13,
                  lineHeight: 1.5,
                }}>
                  {msg.role === 'assistant' && msg.content === '' ? (
                    <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
                      {[0, 150, 300].map(d => (
                        <span key={d} style={{
                          width: 6, height: 6, borderRadius: '50%',
                          background: panel.subtext,
                          animation: 'bounce 1.2s infinite',
                          animationDelay: `${d}ms`,
                        }} />
                      ))}
                    </span>
                  ) : msg.role === 'assistant' ? (
                    <MarkdownBlock content={msg.content} isDark={isDark} />
                  ) : (
                    msg.content
                  )}
                </div>
              </div>
            ))}
            <div ref={bottomRef} />
          </div>

          {/* Input */}
          <div style={{ borderTop: `1px solid ${panel.border}`, padding: '10px 10px', display: 'flex', gap: 8, alignItems: 'flex-end', flexShrink: 0 }}>
            <textarea
              ref={inputRef}
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Ask about loads…"
              rows={1}
              disabled={loading}
              style={{
                flex: 1, resize: 'none', maxHeight: 88,
                borderRadius: 8, border: `1px solid ${panel.inputBorder}`,
                background: panel.inputBg, color: panel.text,
                padding: '7px 10px', fontSize: 13,
                outline: 'none', fontFamily: 'inherit',
                lineHeight: 1.5,
              }}
              onFocus={e => { e.currentTarget.style.borderColor = '#2563eb'; }}
              onBlur={e => { e.currentTarget.style.borderColor = panel.inputBorder; }}
            />
            <button
              onClick={send}
              disabled={!input.trim() || loading}
              style={{
                width: 34, height: 34, borderRadius: 8,
                background: !input.trim() || loading ? (isDark ? '#3a3a4a' : '#e2e8f0') : '#2563eb',
                color: !input.trim() || loading ? panel.subtext : '#fff',
                border: 'none', cursor: !input.trim() || loading ? 'not-allowed' : 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                transition: 'background 0.15s',
                flexShrink: 0,
              }}
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <line x1="22" y1="2" x2="11" y2="13" />
                <polygon points="22 2 15 22 11 13 2 9 22 2" />
              </svg>
            </button>
          </div>
        </div>
      )}

      <style>{`
        @keyframes bounce {
          0%, 80%, 100% { transform: translateY(0); }
          40% { transform: translateY(-5px); }
        }
      `}</style>
    </>
  );
}
