"use client";

import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { removeLegacyDemoKnowledge, parseKnowledge, serializeKnowledge, validateKnowledge } from "@/lib/knowledge";
import type { ChatMessage, ChatReply, KnowledgeEntry } from "@/lib/types";
import VoicePanel from "@/components/VoicePanel";

type IconName = "wave" | "chat" | "book" | "arrow" | "plus" | "upload" | "download" | "refresh" | "check" | "file" | "chevron" | "close" | "edit" | "trash" | "help" | "spark";
function Icon({ name, size = 20 }: { name: IconName; size?: number }) {
  const paths: Record<IconName, React.ReactNode> = {
    wave: <><path d="M4 10v4M8 6v12M12 3v18M16 7v10M20 10v4" /></>,
    chat: <><path d="M20 11.5a7.8 7.8 0 0 1-.7 3.3 8 8 0 0 1-7.3 4.7 7.8 7.8 0 0 1-3.3-.7L4 20l1.2-4.7a7.8 7.8 0 0 1-.7-3.3 8 8 0 0 1 4.7-7.3 7.8 7.8 0 0 1 3.3-.7h.5a8 8 0 0 1 7 7v.5Z" /><path d="M8 10h8M8 14h5" /></>,
    book: <><path d="M12 5v15M3 4h4a6 6 0 0 1 5 2 6 6 0 0 1 5-2h4v15h-4a6 6 0 0 0-5 2 6 6 0 0 0-5-2H3Z" /></>,
    arrow: <><path d="M12 19V5M5 12l7-7 7 7" /></>,
    plus: <path d="M12 5v14M5 12h14" />,
    upload: <><path d="M12 16V3M7 8l5-5 5 5M4 15v5h16v-5" /></>,
    download: <><path d="M12 3v13M7 11l5 5 5-5M4 16v4h16v-4" /></>,
    refresh: <><path d="M20 7v5h-5M4 17v-5h5" /><path d="M6 7a7 7 0 0 1 12-1l2 3M4 15l2 3a7 7 0 0 0 12-1" /></>,
    check: <path d="m5 12 4 4L19 6" />,
    file: <><path d="M14 3H5v18h14V8Z" /><path d="M14 3v5h5M8 12h8M8 16h6" /></>,
    chevron: <path d="m9 5 7 7-7 7" />,
    close: <path d="m6 6 12 12M18 6 6 18" />,
    edit: <><path d="m15 4 5 5M4 20l5-1L20 8a2 2 0 0 0-4-4L5 15Z" /></>,
    trash: <><path d="M3 6h18M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7M14 10v7" /></>,
    help: <><circle cx="12" cy="12" r="9" /><path d="M9.5 8.5a2.5 2.5 0 1 1 4 2c-1 .5-1.5 1-1.5 2.5M12 16v.1" /></>,
    spark: <><path d="m12 3 2.4 6.6L21 12l-6.6 2.4L12 21l-2.4-6.6L3 12l6.6-2.4Z" /></>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

type DisplayMessage = ChatMessage & { id: string; status?: ChatReply["status"] };
const STORAGE_KEY = "liniya-workspace-v2";

function restoreMessages(value: unknown, entries: KnowledgeEntry[]): DisplayMessage[] {
  if (!Array.isArray(value)) return [];
  const ids = new Set(entries.map((entry) => entry.id));
  return value.slice(-60).filter((item): item is DisplayMessage => Boolean(item && typeof item === "object" && (item.role === "user" || item.role === "assistant") && typeof item.content === "string" && item.content.length <= 6000 && typeof item.id === "string"))
    .map((item) => ({ id: item.id, role: item.role, content: item.content, status: ["answered", "unknown", "clarification"].includes(item.status ?? "") ? item.status : undefined, sourceIds: Array.isArray(item.sourceIds) ? item.sourceIds.filter((id): id is string => typeof id === "string" && ids.has(id)).slice(0, 3) : [] }));
}

export default function Home() {
  const [tab, setTab] = useState<"chat" | "knowledge" | "voice">("chat");
  const [knowledge, setKnowledge] = useState<KnowledgeEntry[]>([]);
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [input, setInput] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [storageWarning, setStorageWarning] = useState("");
  const [hydrated, setHydrated] = useState(false);
  const [mode, setMode] = useState<"local" | "llm">("local");
  const [statusLoaded, setStatusLoaded] = useState(false);
  const [statusFailed, setStatusFailed] = useState(false);
  const [modelReady, setModelReady] = useState<boolean | null>(null);
  const [modelEngine, setModelEngine] = useState<"local" | "remote">("remote");
  const [search, setSearch] = useState("");
  const [editor, setEditor] = useState<KnowledgeEntry | null>(null);
  const [editorError, setEditorError] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const chatScroll = useRef<HTMLDivElement>(null);
  const importInput = useRef<HTMLInputElement>(null);
  const messageInput = useRef<HTMLTextAreaElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const request = useRef<AbortController | null>(null);
  const requestSequence = useRef(0);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        const legacy = !raw && localStorage.getItem("liniya-workspace-v1");
        if (raw || legacy) {
          const saved = JSON.parse(raw || legacy || "null");
          if (!saved || saved.version !== (raw ? 2 : 1) || !Array.isArray(saved.knowledge) || (saved.knowledge.length && validateKnowledge(saved.knowledge))) throw new Error("invalid storage");
          const entries = legacy ? await removeLegacyDemoKnowledge(saved.knowledge) : saved.knowledge;
          if (!cancelled) {
            setKnowledge(entries);
            // Start an English conversation after migration, while keeping company documents.
            setMessages(legacy ? [] : restoreMessages(saved.messages, entries));
          }
        }
      } catch {
        if (!cancelled) setStorageWarning("Saved data could not be restored. Upload your company information to get started.");
      }
      if (!cancelled) setHydrated(true);
    })();
    const controller = new AbortController();
    fetch("/api/status", { signal: controller.signal }).then(async (response) => {
      if (!response.ok) throw new Error("status unavailable");
      const data = await response.json();
      if (data.mode !== "local" && data.mode !== "llm") throw new Error("invalid status");
      setMode(data.mode);
      setModelReady(typeof data.ready === "boolean" ? data.ready : null);
      setModelEngine(data.engine === "local" ? "local" : "remote");
      setStatusLoaded(true);
    }).catch((cause) => { if (cause.name !== "AbortError") { setStatusFailed(true); setStatusLoaded(true); } });
    return () => { cancelled = true; controller.abort(); request.current?.abort(); };
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 2, knowledge, messages: messages.slice(-60) }));
      localStorage.removeItem("liniya-workspace-v1");
    }
    catch { setStorageWarning("Your browser could not save this workspace. Data is available until you close the page."); }
  }, [knowledge, messages, hydrated]);

  useEffect(() => {
    const container = chatScroll.current;
    if (!container || tab !== "chat") return;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    container.scrollTo({ top: container.scrollHeight, behavior: reduceMotion ? "instant" : "smooth" });
  }, [messages, pending, tab]);
  useEffect(() => {
    if (editor && dialog.current && !dialog.current.open) dialog.current.showModal();
    if (!editor && dialog.current?.open) dialog.current.close();
  }, [editor]);

  function clearConversation() {
    requestSequence.current += 1;
    request.current?.abort();
    setPending(false);
    setMessages([]);
    setError("");
  }

  function replaceKnowledge(entries: KnowledgeEntry[], message: string) {
    const validation = entries.length ? validateKnowledge(entries) : null;
    if (validation) { setError(validation); return false; }
    clearConversation();
    setKnowledge(entries);
    setNotice(message);
    return true;
  }

  async function sendMessage(question = input) {
    const text = question.trim();
    if (!text || pending) return;
    if (text.length > 2000) { setError("Questions must be shorter than 2,000 characters."); return; }
    if (!knowledge.length) { setError("Add at least one answer to your knowledge base."); return; }
    const userId = crypto.randomUUID();
    const sequence = ++requestSequence.current;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    const history = messages.slice(-20).map(({ role, content, sourceIds }) => ({ role, content, sourceIds }));
    setMessages((current) => [...current, { id: userId, role: "user", content: text }]);
    setInput("");
    setError("");
    setPending(true);
    try {
      const response = await fetch("/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question: text, history, knowledge }), signal: controller.signal });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not get an answer. Please try again.");
      if (typeof data.answer !== "string" || !Array.isArray(data.sources) || !["local", "llm"].includes(data.mode)) throw new Error("The server returned an invalid answer.");
      if (sequence !== requestSequence.current) return;
      const reply = data as ChatReply;
      setMode(reply.mode);
      if (reply.mode === "llm" && (modelEngine === "local" || reply.sources.length > 0)) setModelReady(true);
      setStatusLoaded(true);
      setStatusFailed(false);
      setMessages((current) => [...current, { id: crypto.randomUUID(), role: "assistant", content: reply.answer, sourceIds: reply.sources.map((source) => source.id), status: reply.status }]);
    } catch (cause) {
      if (sequence !== requestSequence.current || controller.signal.aborted) return;
      setMessages((current) => current.filter((message) => message.id !== userId));
      setInput((current) => current || text);
      setError(cause instanceof Error ? cause.message : "Could not send the message.");
    } finally {
      if (sequence === requestSequence.current) { setPending(false); messageInput.current?.focus({ preventScroll: true }); }
    }
  }

  async function importFile(file?: File) {
    if (!file) return;
    if (importInput.current) importInput.current.value = "";
    setError("");
    setNotice("");
    if (!/\.(txt|md)$/i.test(file.name)) { setError("Choose a .txt or .md text file."); return; }
    if (file.size > 512 * 1024) { setError("The file is too large. The maximum size is 512 KB."); return; }
    try {
      const entries = parseKnowledge(await file.text());
      replaceKnowledge(entries, `Imported ${file.name}. The previous conversation has been cleared.`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not read the file."); }
    if (importInput.current) importInput.current.value = "";
  }

  function exportFile() {
    const blob = new Blob([serializeKnowledge(knowledge)], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "knowledge-base.md";
    link.click();
    URL.revokeObjectURL(url);
  }

  function saveEntry(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editor) return;
    const entry = { ...editor, title: editor.title.trim(), content: editor.content.trim() };
    const entries = knowledge.some((item) => item.id === entry.id) ? knowledge.map((item) => item.id === entry.id ? entry : item) : [...knowledge, entry];
    const validation = validateKnowledge(entries);
    if (validation) { setEditorError(validation); return; }
    replaceKnowledge(entries, "Knowledge base updated. Start a new conversation to test your changes.");
    setEditor(null);
    setEditorError("");
  }

  function handleKey(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void sendMessage(); }
  }

  const filteredKnowledge = knowledge.filter((entry) => `${entry.title} ${entry.content}`.toLocaleLowerCase("en").includes(search.toLocaleLowerCase("en")));
  const modeLabel = !statusLoaded ? "Checking connection" : statusFailed ? "Status unavailable" : mode === "llm" ? modelReady === false ? "Model unavailable" : modelReady === true ? "Model ready" : "Model configured" : "FAQ search";
  const modeDescription = statusFailed
    ? "Could not check the model connection. Send a question to check its availability."
    : mode === "local"
      ? "FAQ search returns the original text from your knowledge base. Connect a language model for conversational answers."
      : modelReady === false
        ? modelEngine === "local"
          ? "The local model is not ready. Finish setting up the models and refresh this page."
          : "The cloud model is unavailable. Check LLM_API_KEY in the server’s .env.local, your model access, and API billing."
        : modelReady === null
          ? "The language model is configured. Send a question to test an answer using your knowledge base."
          : "The model answers using relevant company information and conversation history.";

  return (
    <div className="workspace">
      <aside className="sidebar">
        <a className="brand" href="/" aria-label="Liniya home"><span className="brand-symbol"><Icon name="wave" size={25} /></span>liniya<span className="brand-dot">.</span></a>
        <div className="workspace-picker"><span className="company-avatar">Y</span><div><strong>Your company</strong><span>Support workspace</span></div><span className="picker-mark">⌄</span></div>
        <div className="nav-caption">YOUR AGENT</div>
        <nav aria-label="Main navigation">
          <button className={`nav-link ${tab === "chat" ? "active" : ""}`} aria-current={tab === "chat" ? "page" : undefined} onClick={() => { setTab("chat"); setError(""); setNotice(""); }}><Icon name="chat" /><span>Test chat</span>{tab === "chat" && <span className="nav-dot" />}</button>
          <button className={`nav-link ${tab === "voice" ? "active" : ""}`} aria-current={tab === "voice" ? "page" : undefined} onClick={() => { setTab("voice"); setError(""); setNotice(""); }}><Icon name="wave" /><span>Voice conversation</span>{tab === "voice" && <span className="nav-dot" />}</button>
          <button className={`nav-link ${tab === "knowledge" ? "active" : ""}`} aria-current={tab === "knowledge" ? "page" : undefined} onClick={() => { setTab("knowledge"); setError(""); setNotice(""); }}><Icon name="book" /><span>Knowledge base</span><span className="nav-count">{knowledge.length}</span></button>
        </nav>
        <div className="sidebar-guide"><div className="guide-icon"><Icon name="spark" /></div><strong>From knowledge to conversation</strong><p>Add company information and see how your agent answers customers.</p><span className="prototype-label">PROTOTYPE</span></div>
        <div className="sidebar-footer"><span className="owner-avatar">Y</span><div><strong>Your workspace</strong><span>Browser workspace</span></div><span className="footer-dot" /></div>
      </aside>

      <main className="main">
        <header className="topbar"><div className="breadcrumb"><span>Workspace</span><Icon name="chevron" size={13} /><strong>{tab === "chat" ? "Test chat" : tab === "voice" ? "Voice conversation" : "Knowledge base"}</strong></div><span className="topbar-status"><span />Prototype</span></header>
        <div className="page-content">
          <section className="page-heading"><div><div className="eyebrow">{tab === "chat" ? "AGENT PLAYGROUND" : tab === "voice" ? "VOICE PLAYGROUND" : "ANSWER SOURCES"}</div><h1>{tab === "chat" ? <>Good support<br />starts with knowledge.</> : tab === "voice" ? <>Your agent.<br />Now with a voice.</> : <>Everything your<br />agent needs to know.</>}</h1><p>{tab === "chat" ? "Ask a question as a customer. Check the answer, then try a voice conversation." : tab === "voice" ? "Talk to your agent using your microphone. Test answers, follow-up questions, and interruptions." : "Add company instructions and frequently asked questions. Your agent will use this information to answer."}</p></div><div className="heading-illustration" aria-hidden="true"><div className="orbit orbit-one" /><div className="orbit orbit-two" /><span className="illustration-mark"><Icon name={tab === "knowledge" ? "book" : "wave"} size={42} /></span><span className="illustration-star">✧</span><span className="illustration-dot" /></div></section>

          {storageWarning && <div className="notice warning" role="status">{storageWarning}</div>}
          {notice && <div className="notice success" role="status"><Icon name="check" size={17} />{notice}<button className="icon-button" onClick={() => setNotice("")} aria-label="Dismiss notification"><Icon name="close" size={16} /></button></div>}
          {error && <div className="notice error" role="alert">{error}<button className="icon-button" onClick={() => setError("")} aria-label="Dismiss error"><Icon name="close" size={16} /></button></div>}

          {tab === "chat" ? <>
            <div className="context-strip"><span><Icon name="book" size={16} /><strong>{knowledge.length}</strong> knowledge entries</span><span><span className="language-dot" />English</span><span className="context-mode"><span className={mode === "llm" && modelReady === true && !statusFailed ? "status-dot green" : "status-dot"} />{modeLabel}</span></div>
            <div className="chat-layout">
              <section className="chat-card" aria-label="Test chat with your agent">
                <div className="chat-header"><div className="agent-avatar"><Icon name="wave" size={23} /></div><div><h2>Support assistant</h2><span>Answers using your knowledge base</span></div><button className="icon-button reset-chat" onClick={clearConversation} aria-label="Start a new conversation" title="Start a new conversation" disabled={!messages.length && !pending}><Icon name="refresh" size={18} /></button></div>
                <div ref={chatScroll} className="chat-scroll" role="log" aria-label="Conversation messages" aria-live="polite" aria-relevant="additions text">
                  <div className="conversation-start">START OF CONVERSATION</div>
                  <div className="message-row assistant"><span className="message-avatar"><Icon name="wave" size={16} /></span><div className="message-body"><div className="message-name">Assistant</div><div className="message-bubble">{knowledge.length ? "Hello! Ask me about the company information in your knowledge base." : "Welcome! Upload your company information or add an answer to give your support agent the knowledge it needs."}</div>{!knowledge.length && <button className="text-link empty-knowledge-link" onClick={() => setTab("knowledge")}>Add company information <Icon name="chevron" size={14} /></button>}</div></div>

                  {messages.map((message) => <div className={`message-row ${message.role}`} key={message.id}>{message.role === "assistant" && <span className="message-avatar"><Icon name="wave" size={16} /></span>}<div className="message-body"><div className="message-name">{message.role === "user" ? "You · customer" : "Assistant"}{message.status === "unknown" && <span className="unknown-tag">No answer in the knowledge base</span>}</div><div className="message-bubble">{message.content}</div>{message.sourceIds && message.sourceIds.length > 0 && <div className="message-sources"><span>Answer sources</span>{message.sourceIds.map((id) => { const source = knowledge.find((item) => item.id === id); return source ? <button key={id} onClick={() => { setTab("knowledge"); setExpanded(id); setSearch(""); }}><Icon name="file" size={13} />{source.title}<Icon name="chevron" size={12} /></button> : null; })}</div>}</div></div>)}
                  {pending && <div className="message-row assistant"><span className="message-avatar"><Icon name="wave" size={16} /></span><div className="message-body"><div className="message-name">Assistant</div><div className="message-bubble typing" role="status" aria-label="Preparing an answer"><i /><i /><i /><span className="sr-only">Preparing an answer…</span></div></div></div>}
                </div>
                <form className="chat-composer" onSubmit={(event) => { event.preventDefault(); void sendMessage(); }}><div className="composer-field"><textarea ref={messageInput} aria-label="Customer message" placeholder="Ask a question as a customer…" value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={handleKey} maxLength={2000} rows={2} disabled={!hydrated} /><button className="send-button" type="submit" disabled={!input.trim() || pending || !hydrated || !knowledge.length} aria-label="Send message"><Icon name="arrow" size={20} /></button></div><div className="composer-hint"><span>Enter to send<span className="desktop-hint"> · Shift + Enter for a new line</span></span><span>{input.length > 1700 ? `${input.length}/2000` : "Test conversation"}</span></div></form>
              </section>
              <aside className="insights-panel">
                <section className="knowledge-preview"><div className="section-kicker"><Icon name="book" size={18} />KNOWLEDGE BASE</div><h2>Accurate answers,<br />from your information.</h2><p>Upload your company information to give your agent the facts it needs.</p><div className="preview-entries">{knowledge.slice(0, 4).map((entry) => <button key={entry.id} onClick={() => { setTab("knowledge"); setExpanded(entry.id); setSearch(""); }}><span className="file-icon"><Icon name="file" size={17} /></span><span>{entry.title}</span><Icon name="chevron" size={13} /></button>)}{!knowledge.length && <p>No information yet. Upload a document or add your first answer.</p>}</div><button className="text-link" onClick={() => setTab("knowledge")}>Open knowledge base <Icon name="chevron" size={14} /></button></section>
                <section className="mode-card"><span className="mode-icon"><Icon name={mode === "llm" ? "spark" : "help"} size={18} /></span><h3>{modeLabel}</h3><p>{modeDescription}</p></section>
                <div className="next-step"><span className="next-step-number">NEXT STEP</span><p>Once the answers are accurate,<br />try a voice conversation.</p><div className="tiny-wave" aria-hidden="true"><i /><i /><i /><i /><i /><i /><i /><i /><i /></div></div>
              </aside>
            </div>
          </> : tab === "voice" ? <VoicePanel knowledge={knowledge} /> : <section className="knowledge-workspace" aria-label="Knowledge base editor">
            <div className="knowledge-toolbar"><div className="knowledge-total"><span className="document-count">{knowledge.length}</span><div><strong>Company information</strong><span>Information your agent can use</span></div></div><div className="toolbar-actions"><button className="button secondary" onClick={() => importInput.current?.click()}><Icon name="upload" size={16} />Upload file</button><button className="button primary" onClick={() => { setEditorError(""); setEditor({ id: crypto.randomUUID(), title: "", content: "" }); }}><Icon name="plus" size={16} />Add answer</button></div></div>
            <input className="sr-only" type="file" ref={importInput} accept=".txt,.md,text/plain,text/markdown" onChange={(event) => void importFile(event.target.files?.[0])} aria-label="Upload knowledge base file" />
            <div className="knowledge-note"><Icon name="help" size={17} /><p>Upload <strong>.txt</strong> or <strong>.md</strong>: a question heading followed by its answer. Start each section with <code>##</code>. Import replaces the current knowledge base and clears the conversation.</p></div>
            <div className="knowledge-list-toolbar"><input className="search-field" aria-label="Search knowledge base" placeholder="Find a question or instruction…" value={search} onChange={(event) => setSearch(event.target.value)} /><button className="text-link" onClick={exportFile} disabled={!knowledge.length}><Icon name="download" size={16} />Export .md</button></div>
            <div className="knowledge-list">{filteredKnowledge.map((entry, index) => <article className={`knowledge-entry ${expanded === entry.id ? "expanded" : ""}`} key={entry.id}><div className="entry-heading"><button className="entry-toggle" aria-expanded={expanded === entry.id} aria-controls={`entry-${entry.id}`} onClick={() => setExpanded(expanded === entry.id ? null : entry.id)}><span className="entry-number">{String(index + 1).padStart(2, "0")}</span><span><strong>{entry.title}</strong>{expanded !== entry.id && <span className="entry-preview">{entry.content}</span>}</span><Icon name="chevron" size={16} /></button><button className="icon-button" aria-label={`Edit: ${entry.title}`} title="Edit" onClick={() => { setEditorError(""); setEditor({ ...entry }); }}><Icon name="edit" size={16} /></button><button className="icon-button delete-button" aria-label={`Delete: ${entry.title}`} title="Delete" onClick={() => { if (window.confirm(`Delete ${entry.title}? The conversation will be cleared.`)) replaceKnowledge(knowledge.filter((item) => item.id !== entry.id), "Entry deleted."); }}><Icon name="trash" size={16} /></button></div>{expanded === entry.id && <div id={`entry-${entry.id}`} className="entry-content">{entry.content}</div>}</article>)}{filteredKnowledge.length === 0 && <div className="empty-state"><Icon name="book" size={32} /><h3>{search ? "No results found" : "Add your first answer"}</h3><p>{search ? "Try another search or add more information." : "Upload a .txt or .md document, or add a question and verified answer for your agent."}</p></div>}</div>
            <div className="knowledge-bottom"><span><Icon name="check" size={15} />Changes are saved in this browser</span></div>
          </section>}
          <footer className="page-footer"><span>Liniya · Your voice support</span><span><span className="privacy-dot" />Workspace saved in this browser</span></footer>
        </div>
      </main>
      <dialog ref={dialog} className="entry-dialog" aria-labelledby="editor-heading" onCancel={() => { setEditor(null); setEditorError(""); }} onClose={() => setEditor(null)}>
        {editor && <form onSubmit={saveEntry}><div className="dialog-heading"><div><div className="eyebrow">KNOWLEDGE BASE</div><h2 id="editor-heading">{knowledge.some((entry) => entry.id === editor.id) ? "Edit entry" : "New answer"}</h2></div><button type="button" className="icon-button" aria-label="Close editor" onClick={() => setEditor(null)}><Icon name="close" /></button></div><label htmlFor="entry-title">Question or instruction title</label><input autoFocus id="entry-title" placeholder="Enter the question or topic this answer covers" value={editor.title} onChange={(event) => setEditor({ ...editor, title: event.target.value })} maxLength={200} required /><label htmlFor="entry-answer">Verified answer</label><textarea id="entry-answer" placeholder="Add accurate company information. Use numbered steps for instructions." value={editor.content} onChange={(event) => setEditor({ ...editor, content: event.target.value })} maxLength={4000} rows={9} required /><p className="editor-hint">Saving clears the current conversation so your agent uses the updated information.</p>{editorError && <div className="notice error" role="alert">{editorError}</div>}<div className="dialog-actions"><button className="button secondary" type="button" onClick={() => setEditor(null)}>Cancel</button><button className="button primary" type="submit">Save entry</button></div></form>}
      </dialog>
    </div>
  );
}
