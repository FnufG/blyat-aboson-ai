"use client";

import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { demoKnowledge, parseKnowledge, serializeKnowledge, validateKnowledge } from "@/lib/knowledge";
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
const STORAGE_KEY = "liniya-workspace-v1";
const examples = ["На роутере мигает красный индикатор", "Какие условия гарантии?", "Как связаться с поддержкой?"];

function restoreMessages(value: unknown, entries: KnowledgeEntry[]): DisplayMessage[] {
  if (!Array.isArray(value)) return [];
  const ids = new Set(entries.map((entry) => entry.id));
  return value.slice(-60).filter((item): item is DisplayMessage => Boolean(item && typeof item === "object" && (item.role === "user" || item.role === "assistant") && typeof item.content === "string" && item.content.length <= 6000 && typeof item.id === "string"))
    .map((item) => ({ id: item.id, role: item.role, content: item.content, status: ["answered", "unknown", "clarification"].includes(item.status ?? "") ? item.status : undefined, sourceIds: Array.isArray(item.sourceIds) ? item.sourceIds.filter((id): id is string => typeof id === "string" && ids.has(id)).slice(0, 3) : [] }));
}

export default function Home() {
  const [tab, setTab] = useState<"chat" | "knowledge" | "voice">("chat");
  const [knowledge, setKnowledge] = useState<KnowledgeEntry[]>(demoKnowledge);
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
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const saved = JSON.parse(raw);
        if (saved.version !== 1 || !Array.isArray(saved.knowledge) || validateKnowledge(saved.knowledge)) throw new Error("invalid storage");
        setKnowledge(saved.knowledge);
        setMessages(restoreMessages(saved.messages, saved.knowledge));
      }
    } catch { setStorageWarning("Не удалось восстановить сохранённые данные. Открыта демобаза."); }
    setHydrated(true);
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
    return () => { controller.abort(); request.current?.abort(); };
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, knowledge, messages: messages.slice(-60) })); }
    catch { setStorageWarning("Браузер не разрешил сохранение. Данные доступны до закрытия страницы."); }
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
    const validation = validateKnowledge(entries);
    if (validation) { setError(validation); return false; }
    clearConversation();
    setKnowledge(entries);
    setNotice(message);
    return true;
  }

  async function sendMessage(question = input) {
    const text = question.trim();
    if (!text || pending) return;
    if (text.length > 2000) { setError("Вопрос должен быть короче 2 000 символов."); return; }
    if (!knowledge.length) { setError("Добавьте хотя бы один ответ в базу знаний."); return; }
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
      if (!response.ok) throw new Error(data.error || "Не удалось получить ответ. Попробуйте ещё раз.");
      if (typeof data.answer !== "string" || !Array.isArray(data.sources) || !["local", "llm"].includes(data.mode)) throw new Error("Сервер вернул некорректный ответ.");
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
      setError(cause instanceof Error ? cause.message : "Не удалось отправить сообщение.");
    } finally {
      if (sequence === requestSequence.current) { setPending(false); messageInput.current?.focus({ preventScroll: true }); }
    }
  }

  async function importFile(file?: File) {
    if (!file) return;
    if (importInput.current) importInput.current.value = "";
    setError("");
    setNotice("");
    if (!/\.(txt|md)$/i.test(file.name)) { setError("Выберите текстовый файл .txt или .md."); return; }
    if (file.size > 512 * 1024) { setError("Файл слишком большой. Максимальный размер — 512 КБ."); return; }
    try {
      const entries = parseKnowledge(await file.text());
      replaceKnowledge(entries, `Загружен файл «${file.name}». Предыдущий диалог очищен.`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Не удалось прочитать файл."); }
    if (importInput.current) importInput.current.value = "";
  }

  function exportFile() {
    const blob = new Blob([serializeKnowledge(knowledge)], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "baza-znaniy.md";
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
    replaceKnowledge(entries, "База знаний обновлена. Начните новый диалог, чтобы проверить изменения.");
    setEditor(null);
    setEditorError("");
  }

  function handleKey(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void sendMessage(); }
  }

  const filteredKnowledge = knowledge.filter((entry) => `${entry.title} ${entry.content}`.toLocaleLowerCase("ru").includes(search.toLocaleLowerCase("ru")));
  const modeLabel = !statusLoaded ? "Проверяем подключение" : statusFailed ? "Статус неизвестен" : mode === "llm" ? modelReady === false ? "Модель не готова" : modelReady === true ? "Модель готова" : "Модель настроена" : "Поиск по FAQ";
  const modeDescription = statusFailed
    ? "Не удалось проверить подключение модели. Попробуйте отправить вопрос — режим отобразится после ответа."
    : mode === "local"
      ? "Без языковой модели: ответы дословно из базы. Для свободного диалога подключите модель."
      : modelReady === false
        ? modelEngine === "local"
          ? "Локальная языковая модель пока не готова. Завершите загрузку моделей и обновите страницу перед тестовым разговором."
          : "Языковая модель пока недоступна. Проверьте настройки сервиса и повторите попытку."
        : modelReady === null
          ? "Языковая модель настроена. Отправьте тестовый вопрос, чтобы проверить ответ по вашей базе знаний."
          : "Модель формулирует ответы по найденным материалам и учитывает историю разговора.";

  return (
    <div className="workspace">
      <aside className="sidebar">
        <a className="brand" href="/" aria-label="Линия — главная"><span className="brand-symbol"><Icon name="wave" size={25} /></span>линия<span className="brand-dot">.</span></a>
        <div className="workspace-picker"><span className="company-avatar">Т</span><div><strong>ТехноЛиния</strong><span>Демокомпания</span></div><span className="picker-mark">⌄</span></div>
        <div className="nav-caption">ВАШ АГЕНТ</div>
        <nav aria-label="Основная навигация">
          <button className={`nav-link ${tab === "chat" ? "active" : ""}`} aria-current={tab === "chat" ? "page" : undefined} onClick={() => { setTab("chat"); setError(""); setNotice(""); }}><Icon name="chat" /><span>Тестовый диалог</span>{tab === "chat" && <span className="nav-dot" />}</button>
          <button className={`nav-link ${tab === "voice" ? "active" : ""}`} aria-current={tab === "voice" ? "page" : undefined} onClick={() => { setTab("voice"); setError(""); setNotice(""); }}><Icon name="wave" /><span>Голосовой диалог</span>{tab === "voice" && <span className="nav-dot" />}</button>
          <button className={`nav-link ${tab === "knowledge" ? "active" : ""}`} aria-current={tab === "knowledge" ? "page" : undefined} onClick={() => { setTab("knowledge"); setError(""); setNotice(""); }}><Icon name="book" /><span>База знаний</span><span className="nav-count">{knowledge.length}</span></button>
        </nav>
        <div className="sidebar-guide"><div className="guide-icon"><Icon name="spark" /></div><strong>От знаний — к разговору</strong><p>Добавьте информацию о компании и посмотрите, как ваш агент отвечает клиентам.</p><span className="prototype-label">ПЕРВЫЙ ПРОТОТИП</span></div>
        <div className="sidebar-footer"><span className="owner-avatar">В</span><div><strong>Ваше пространство</strong><span>Браузерный прототип</span></div><span className="footer-dot" /></div>
      </aside>

      <main className="main">
        <header className="topbar"><div className="breadcrumb"><span>Рабочее пространство</span><Icon name="chevron" size={13} /><strong>{tab === "chat" ? "Тестовый диалог" : tab === "voice" ? "Голосовой диалог" : "База знаний"}</strong></div><span className="topbar-status"><span />Прототип</span></header>
        <div className="page-content">
          <section className="page-heading"><div><div className="eyebrow">{tab === "chat" ? "ПЕСОЧНИЦА АГЕНТА" : tab === "voice" ? "ГОЛОСОВОЙ ПРОТОТИП" : "ИСТОЧНИКИ ОТВЕТОВ"}</div><h1>{tab === "chat" ? <>Хорошая поддержка<br />начинается со знаний.</> : tab === "voice" ? <>Ваш агент.<br />Теперь голосом.</> : <>Всё, что нужно знать<br />вашему агенту.</>}</h1><p>{tab === "chat" ? "Задайте вопрос от лица клиента. Проверьте точность ответа, затем попробуйте голосовой разговор." : tab === "voice" ? "Поговорите с агентом через микрофон. Проверьте ответы, уточнения и перебивания в реальном разговоре." : "Добавляйте инструкции и ответы на частые вопросы. Агент будет опираться на эту информацию."}</p></div><div className="heading-illustration" aria-hidden="true"><div className="orbit orbit-one" /><div className="orbit orbit-two" /><span className="illustration-mark"><Icon name={tab === "knowledge" ? "book" : "wave"} size={42} /></span><span className="illustration-star">✧</span><span className="illustration-dot" /></div></section>

          {storageWarning && <div className="notice warning" role="status">{storageWarning}</div>}
          {notice && <div className="notice success" role="status"><Icon name="check" size={17} />{notice}<button className="icon-button" onClick={() => setNotice("")} aria-label="Закрыть уведомление"><Icon name="close" size={16} /></button></div>}
          {error && <div className="notice error" role="alert">{error}<button className="icon-button" onClick={() => setError("")} aria-label="Закрыть сообщение об ошибке"><Icon name="close" size={16} /></button></div>}

          {tab === "chat" ? <>
            <div className="context-strip"><span><Icon name="book" size={16} /><strong>{knowledge.length}</strong> материалов в базе</span><span><span className="language-dot" />Русский язык</span><span className="context-mode"><span className={mode === "llm" && modelReady === true && !statusFailed ? "status-dot green" : "status-dot"} />{modeLabel}</span></div>
            <div className="chat-layout">
              <section className="chat-card" aria-label="Тестовый диалог с агентом">
                <div className="chat-header"><div className="agent-avatar"><Icon name="wave" size={23} /></div><div><h2>Помощник ТехноЛинии</h2><span>Отвечает по вашей базе знаний</span></div><button className="icon-button reset-chat" onClick={clearConversation} aria-label="Начать новый диалог" title="Начать новый диалог" disabled={!messages.length && !pending}><Icon name="refresh" size={18} /></button></div>
                <div ref={chatScroll} className="chat-scroll" role="log" aria-label="Сообщения диалога" aria-live="polite" aria-relevant="additions text">
                  <div className="conversation-start">НАЧАЛО ДИАЛОГА</div>
                  <div className="message-row assistant"><span className="message-avatar"><Icon name="wave" size={16} /></span><div className="message-body"><div className="message-name">Помощник</div><div className="message-bubble">Здравствуйте! Я помогу разобраться в услугах и инструкциях ТехноЛинии. Что вы хотите узнать?</div></div></div>
                  {messages.length === 0 && <div className="example-questions"><span>Например, спросите</span>{examples.map((question) => <button key={question} onClick={() => void sendMessage(question)} disabled={pending || !hydrated}><span>{question}</span><Icon name="chevron" size={14} /></button>)}</div>}
                  {messages.map((message) => <div className={`message-row ${message.role}`} key={message.id}>{message.role === "assistant" && <span className="message-avatar"><Icon name="wave" size={16} /></span>}<div className="message-body"><div className="message-name">{message.role === "user" ? "Вы · клиент" : "Помощник"}{message.status === "unknown" && <span className="unknown-tag">Нет ответа в базе</span>}</div><div className="message-bubble">{message.content}</div>{message.sourceIds && message.sourceIds.length > 0 && <div className="message-sources"><span>Источники ответа</span>{message.sourceIds.map((id) => { const source = knowledge.find((item) => item.id === id); return source ? <button key={id} onClick={() => { setTab("knowledge"); setExpanded(id); setSearch(""); }}><Icon name="file" size={13} />{source.title}<Icon name="chevron" size={12} /></button> : null; })}</div>}</div></div>)}
                  {pending && <div className="message-row assistant"><span className="message-avatar"><Icon name="wave" size={16} /></span><div className="message-body"><div className="message-name">Помощник</div><div className="message-bubble typing" role="status" aria-label="Подбираем ответ"><i /><i /><i /><span className="sr-only">Подбираем ответ…</span></div></div></div>}
                </div>
                <form className="chat-composer" onSubmit={(event) => { event.preventDefault(); void sendMessage(); }}><div className="composer-field"><textarea ref={messageInput} aria-label="Сообщение клиента" placeholder="Задайте вопрос от лица клиента…" value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={handleKey} maxLength={2000} rows={2} disabled={!hydrated} /><button className="send-button" type="submit" disabled={!input.trim() || pending || !hydrated || !knowledge.length} aria-label="Отправить сообщение"><Icon name="arrow" size={20} /></button></div><div className="composer-hint"><span>Enter — отправить<span className="desktop-hint"> · Shift + Enter — новая строка</span></span><span>{input.length > 1700 ? `${input.length}/2000` : "Тестовый разговор"}</span></div></form>
              </section>
              <aside className="insights-panel">
                <section className="knowledge-preview"><div className="section-kicker"><Icon name="book" size={18} />БАЗА ЗНАНИЙ</div><h2>Точные ответы —<br />из ваших материалов.</h2><p>Для примера мы добавили инструкции вымышленной компании.</p><div className="preview-entries">{knowledge.slice(0, 4).map((entry) => <button key={entry.id} onClick={() => { setTab("knowledge"); setExpanded(entry.id); setSearch(""); }}><span className="file-icon"><Icon name="file" size={17} /></span><span>{entry.title}</span><Icon name="chevron" size={13} /></button>)}{!knowledge.length && <p>Материалов пока нет. Добавьте первый ответ.</p>}</div><button className="text-link" onClick={() => setTab("knowledge")}>Открыть базу знаний <Icon name="chevron" size={14} /></button></section>
                <section className="mode-card"><span className="mode-icon"><Icon name={mode === "llm" ? "spark" : "help"} size={18} /></span><h3>{modeLabel}</h3><p>{modeDescription}</p></section>
                <div className="next-step"><span className="next-step-number">ДАЛЬШЕ</span><p>Когда ответы будут точными,<br />проверьте их голосом.</p><div className="tiny-wave" aria-hidden="true"><i /><i /><i /><i /><i /><i /><i /><i /><i /></div></div>
              </aside>
            </div>
          </> : tab === "voice" ? <VoicePanel knowledge={knowledge} /> : <section className="knowledge-workspace" aria-label="Редактор базы знаний">
            <div className="knowledge-toolbar"><div className="knowledge-total"><span className="document-count">{knowledge.length}</span><div><strong>Материалы компании</strong><span>Знания для ответов на вопросы</span></div></div><div className="toolbar-actions"><button className="button secondary" onClick={() => importInput.current?.click()}><Icon name="upload" size={16} />Загрузить файл</button><button className="button primary" onClick={() => { setEditorError(""); setEditor({ id: crypto.randomUUID(), title: "", content: "" }); }}><Icon name="plus" size={16} />Добавить ответ</button></div></div>
            <input className="sr-only" type="file" ref={importInput} accept=".txt,.md,text/plain,text/markdown" onChange={(event) => void importFile(event.target.files?.[0])} aria-label="Загрузить базу знаний из файла" />
            <div className="knowledge-note"><Icon name="help" size={17} /><p>Загрузите <strong>.txt</strong> или <strong>.md</strong>: заголовок вопроса, затем ответ. Каждый новый раздел начинайте с <code>##</code>. Импорт заменяет текущую базу и очищает диалог.</p></div>
            <div className="knowledge-list-toolbar"><input className="search-field" aria-label="Поиск по базе знаний" placeholder="Найти вопрос или инструкцию…" value={search} onChange={(event) => setSearch(event.target.value)} /><button className="text-link" onClick={exportFile} disabled={!knowledge.length}><Icon name="download" size={16} />Скачать .md</button></div>
            <div className="knowledge-list">{filteredKnowledge.map((entry, index) => <article className={`knowledge-entry ${expanded === entry.id ? "expanded" : ""}`} key={entry.id}><div className="entry-heading"><button className="entry-toggle" aria-expanded={expanded === entry.id} aria-controls={`entry-${entry.id}`} onClick={() => setExpanded(expanded === entry.id ? null : entry.id)}><span className="entry-number">{String(index + 1).padStart(2, "0")}</span><span><strong>{entry.title}</strong>{expanded !== entry.id && <span className="entry-preview">{entry.content}</span>}</span><Icon name="chevron" size={16} /></button><button className="icon-button" aria-label={`Редактировать: ${entry.title}`} title="Редактировать" onClick={() => { setEditorError(""); setEditor({ ...entry }); }}><Icon name="edit" size={16} /></button><button className="icon-button delete-button" aria-label={`Удалить: ${entry.title}`} title="Удалить" onClick={() => { if (window.confirm(`Удалить материал «${entry.title}»? Диалог будет очищен.`)) replaceKnowledge(knowledge.filter((item) => item.id !== entry.id), "Материал удалён."); }}><Icon name="trash" size={16} /></button></div>{expanded === entry.id && <div id={`entry-${entry.id}`} className="entry-content">{entry.content}</div>}</article>)}{filteredKnowledge.length === 0 && <div className="empty-state"><Icon name="book" size={32} /><h3>{search ? "Ничего не найдено" : "Начните с первого ответа"}</h3><p>{search ? "Попробуйте другое слово или добавьте новый материал." : "Добавьте вопрос и проверенную информацию, которую агент сможет сообщить клиенту."}</p></div>}</div>
            <div className="knowledge-bottom"><span><Icon name="check" size={15} />Изменения сохраняются в этом браузере</span><button className="text-link muted" onClick={() => { if (window.confirm("Восстановить демобазу? Ваши материалы и текущий диалог будут заменены.")) { replaceKnowledge(demoKnowledge.map((entry) => ({ ...entry })), "Демобаза восстановлена."); setSearch(""); } }}><Icon name="refresh" size={14} />Восстановить демобазу</button></div>
          </section>}
          <footer className="page-footer"><span>Линия · Ваша голосовая поддержка</span><span><span className="privacy-dot" />Данные сохраняются в этом браузере</span></footer>
        </div>
      </main>
      <dialog ref={dialog} className="entry-dialog" aria-labelledby="editor-heading" onCancel={() => { setEditor(null); setEditorError(""); }} onClose={() => setEditor(null)}>
        {editor && <form onSubmit={saveEntry}><div className="dialog-heading"><div><div className="eyebrow">БАЗА ЗНАНИЙ</div><h2 id="editor-heading">{knowledge.some((entry) => entry.id === editor.id) ? "Редактировать материал" : "Новый ответ"}</h2></div><button type="button" className="icon-button" aria-label="Закрыть редактор" onClick={() => setEditor(null)}><Icon name="close" /></button></div><label htmlFor="entry-title">Вопрос или название инструкции</label><input autoFocus id="entry-title" placeholder="Например: Какие условия гарантии?" value={editor.title} onChange={(event) => setEditor({ ...editor, title: event.target.value })} maxLength={200} required /><label htmlFor="entry-answer">Проверенный ответ</label><textarea id="entry-answer" placeholder="Добавьте точную информацию. Для инструкций используйте пошаговый список." value={editor.content} onChange={(event) => setEditor({ ...editor, content: event.target.value })} maxLength={4000} rows={9} required /><p className="editor-hint">После сохранения текущий диалог очистится, чтобы агент использовал новые сведения.</p>{editorError && <div className="notice error" role="alert">{editorError}</div>}<div className="dialog-actions"><button className="button secondary" type="button" onClick={() => setEditor(null)}>Отмена</button><button className="button primary" type="submit">Сохранить материал</button></div></form>}
      </dialog>
    </div>
  );
}
